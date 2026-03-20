import { Client, LogLevel } from "@notionhq/client";
import { getCommentDetails, getTicket } from "./notion";

const DEFAULT_PORT = 3210;
const POLL_INTERVAL_MS = 3000;
const LINK_PROPERTY_NAME = "NotionCode Link";
const WEBHOOK_PATH_DEFAULT = "/webhook";
const LISTENER_LOG_PREFIX = "[LISTENER]";
const READY_MESSAGE = `${LISTENER_LOG_PREFIX} Ready! Click any 'NotionCode Link' in your Notion board to start an agent.`;
const START_TRIGGER_PATTERN = /\b@?notioncode\s+start\b/i;

type DatabaseResponse = {
  id: string;
  properties?: Record<string, { type: string }>;
  data_sources?: Array<{ id: string }>;
};

type DataSourceResponse = {
  id: string;
  properties?: Record<string, { type: string }>;
};

type NotionPage = {
  id: string;
  properties: Record<string, { type: string; url?: string | null }>;
};

type NotionWebhookPayload = {
  id?: string;
  type?: string;
  verification_token?: string;
  entity?: {
    id?: string;
    type?: string;
  };
  data?: {
    page_id?: string;
  };
};

type RunStatus = "active" | "completed" | "failed";

interface RunRecord {
  runId: string;
  pageId: string;
  title: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  error?: string;
}

interface StartListenerOptions {
  port?: number;
}

interface DatabaseTarget {
  kind: "database" | "data_source";
  id: string;
}

type NotionSdkLogInfo = {
  method?: string;
  path?: string;
  attempt?: number;
  delayMs?: number;
  code?: string;
  message?: string;
};

const activeRuns = new Map<string, RunRecord>();
const completedRuns: RunRecord[] = [];

function logListener(message: string): void {
  console.log(`${LISTENER_LOG_PREFIX} ${message}`);
}

function logListenerWarn(message: string): void {
  console.warn(`${LISTENER_LOG_PREFIX} ${message}`);
}

function logListenerError(message: string): void {
  console.error(`${LISTENER_LOG_PREFIX} ${message}`);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createSdkLogger() {
  return (_level: string, message: string, extraInfo?: NotionSdkLogInfo) => {
    if (message === "retrying request") {
      logListenerWarn(
        `sdk retry method=${extraInfo?.method ?? "unknown"} path=${quote(extraInfo?.path ?? "unknown")} attempt=${extraInfo?.attempt ?? 0} delayMs=${extraInfo?.delayMs ?? 0}`
      );
      return;
    }

    if (message === "request fail" && extraInfo?.code === "rate_limited") {
      logListenerWarn(
        `sdk request-fail code=rate_limited attempt=${extraInfo?.attempt ?? 0} message=${quote(
          extraInfo?.message ?? "unknown"
        )}`
      );
    }
  };
}

function getRunDurationMs(run: Pick<RunRecord, "startedAt">): number {
  return Date.now() - new Date(run.startedAt).getTime();
}

function formatTarget(target: DatabaseTarget): string {
  return `${target.kind}:${target.id}`;
}

function getPort(explicitPort?: number): number {
  if (explicitPort && Number.isFinite(explicitPort) && explicitPort > 0) {
    return explicitPort;
  }

  const fromEnv = Number.parseInt(
    process.env.NOTIONCODE_PORT ?? process.env.PORT ?? "",
    10
  );

  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }

  return DEFAULT_PORT;
}

function getRequiredEnv(name: "NOTION_TOKEN" | "NOTION_DATABASE_ID"): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required for listener startup`);
  }

  return value;
}

function getNotionBaseUrl(): string | undefined {
  const baseUrl = process.env.NOTION_API_BASE_URL?.trim();
  return baseUrl ? baseUrl : undefined;
}

function getWebhookPath(): string {
  const configured = process.env.NOTIONCODE_WEBHOOK_PATH?.trim();

  if (!configured) {
    return WEBHOOK_PATH_DEFAULT;
  }

  return configured.startsWith("/") ? configured : `/${configured}`;
}

function createNotionClient(): Client {
  logListener("client init authEnv=NOTION_TOKEN retryMode=sdk-default+wrapper");
  return new Client({
    auth: getRequiredEnv("NOTION_TOKEN"),
    baseUrl: getNotionBaseUrl(),
    logLevel: LogLevel.INFO,
    logger: createSdkLogger(),
  });
}

async function withRetry<T>(
  operationName: string,
  details: string,
  operation: () => Promise<T>
): Promise<T> {
  logListener(`${operationName} start ${details}`);

  try {
    const result = await operation();
    logListener(`${operationName} ok ${details}`);
    return result;
  } catch (error) {
    if (isRateLimited(error)) {
      logListenerWarn(`${operationName} rate-limited ${details} retryInMs=1000`);
      await sleep(1000);
      logListener(`${operationName} retry ${details}`);

      try {
        const retryResult = await operation();
        logListener(`${operationName} ok ${details} retry=1`);
        return retryResult;
      } catch (retryError) {
        logListenerError(
          `${operationName} failed ${details} retry=1 message=${quote(getErrorMessage(retryError))}`
        );
        throw retryError;
      }
    }

    logListenerError(`${operationName} failed ${details} message=${quote(getErrorMessage(error))}`);
    throw error;
  }
}

function isRateLimited(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { status?: number; code?: string };
  return candidate.status === 429 || candidate.code === "rate_limited";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildStartLink(pageId: string, port: number): string {
  return `http://localhost:${port}/start?page=${encodeURIComponent(pageId)}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parsePageId(request: Request): string | null {
  const pageId = new URL(request.url).searchParams.get("page");
  return pageId?.trim() ? pageId.trim() : null;
}

async function getDatabaseTarget(notion: Client, databaseId: string): Promise<DatabaseTarget> {
  const database = (await withRetry(
    "databases.retrieve",
    `database=${databaseId} purpose=listener-target`,
    () => notion.databases.retrieve({ database_id: databaseId })
  )) as DatabaseResponse;

  if (Array.isArray(database.data_sources) && database.data_sources.length > 0) {
    logListener(`database target resolved database=${databaseId} kind=data_source id=${database.data_sources[0].id}`);
    return {
      kind: "data_source",
      id: database.data_sources[0].id,
    };
  }

  logListener(`database target resolved database=${databaseId} kind=database id=${database.id}`);
  return {
    kind: "database",
    id: database.id,
  };
}

async function ensureLinkColumn(notion: Client, databaseId: string): Promise<DatabaseTarget> {
  const target = await getDatabaseTarget(notion, databaseId);

  if (target.kind === "data_source") {
    const dataSource = (await withRetry(
      "dataSources.retrieve",
      `dataSource=${target.id} purpose=ensure-link-column`,
      () => notion.dataSources.retrieve({ data_source_id: target.id })
    )) as DataSourceResponse;

    if (!(LINK_PROPERTY_NAME in (dataSource.properties ?? {}))) {
      logListener(`link column missing target=${formatTarget(target)} property=${quote(LINK_PROPERTY_NAME)} action=create`);
      await withRetry(
        "dataSources.update",
        `dataSource=${target.id} purpose=create-link-column property=${quote(LINK_PROPERTY_NAME)}`,
        () =>
          notion.dataSources.update({
            data_source_id: target.id,
            properties: {
              [LINK_PROPERTY_NAME]: {
                url: {},
              },
            },
          })
      );
      logListener(`link column ready target=${formatTarget(target)} property=${quote(LINK_PROPERTY_NAME)} created=true`);
    } else {
      logListener(`link column ready target=${formatTarget(target)} property=${quote(LINK_PROPERTY_NAME)} created=false`);
    }

    return target;
  }

  const database = (await withRetry(
    "databases.retrieve",
    `database=${target.id} purpose=ensure-link-column`,
    () => notion.databases.retrieve({ database_id: target.id })
  )) as DatabaseResponse;

  if (!(LINK_PROPERTY_NAME in (database.properties ?? {}))) {
    logListener(`link column missing target=${formatTarget(target)} property=${quote(LINK_PROPERTY_NAME)} action=create`);
    await withRetry(
      "databases.update",
      `database=${target.id} purpose=create-link-column property=${quote(LINK_PROPERTY_NAME)}`,
      () =>
        (notion as unknown as {
          databases: {
            update: (args: {
              database_id: string;
              properties: Record<string, { url: Record<string, never> }>;
            }) => Promise<unknown>;
          };
        }).databases.update({
          database_id: target.id,
          properties: {
            [LINK_PROPERTY_NAME]: {
              url: {},
            },
          },
        })
    );
    logListener(`link column ready target=${formatTarget(target)} property=${quote(LINK_PROPERTY_NAME)} created=true`);
  } else {
    logListener(`link column ready target=${formatTarget(target)} property=${quote(LINK_PROPERTY_NAME)} created=false`);
  }

  return target;
}

async function queryPagesMissingLink(notion: Client, target: DatabaseTarget): Promise<NotionPage[]> {
  if (target.kind === "data_source") {
    const response = (await withRetry(
      "dataSources.query",
      `dataSource=${target.id} purpose=fill-missing-links property=${quote(LINK_PROPERTY_NAME)}`,
      () =>
        notion.dataSources.query({
          data_source_id: target.id,
          filter: {
            property: LINK_PROPERTY_NAME,
            url: {
              is_empty: true,
            },
          },
        })
    )) as { results: NotionPage[] };

    logListener(`missing-link query target=${formatTarget(target)} count=${response.results.length}`);

    return response.results;
  }

  const response = (await withRetry(
    "databases.query",
    `database=${target.id} purpose=fill-missing-links property=${quote(LINK_PROPERTY_NAME)}`,
    () =>
      (notion as unknown as {
        databases: {
          query: (args: {
            database_id: string;
            filter: {
              property: string;
              url: { is_empty: boolean };
            };
          }) => Promise<{ results: NotionPage[] }>;
        };
      }).databases.query({
        database_id: target.id,
        filter: {
          property: LINK_PROPERTY_NAME,
          url: {
            is_empty: true,
          },
        },
      })
  )) as { results: NotionPage[] };

  logListener(`missing-link query target=${formatTarget(target)} count=${response.results.length}`);

  return response.results;
}

async function fillMissingLinks(notion: Client, target: DatabaseTarget, port: number): Promise<number> {
  const startedAt = Date.now();
  logListener(`link fill start target=${formatTarget(target)} port=${port}`);
  const pages = await queryPagesMissingLink(notion, target);

  for (const page of pages) {
    await withRetry(
      "pages.update",
      `page=${page.id} purpose=fill-missing-links property=${quote(LINK_PROPERTY_NAME)} port=${port}`,
      () =>
        notion.pages.update({
          page_id: page.id,
          properties: {
            [LINK_PROPERTY_NAME]: {
              url: buildStartLink(page.id, port),
            },
          },
        })
    );
  }

  logListener(
    `link fill complete target=${formatTarget(target)} filled=${pages.length} durationMs=${Date.now() - startedAt}`
  );

  return pages.length;
}

function recordRunCompletion(record: RunRecord): void {
  activeRuns.delete(record.runId);
  completedRuns.unshift(record);
  if (completedRuns.length > 50) {
    completedRuns.length = 50;
  }
}

function createRunRecord(pageId: string, title: string): RunRecord {
  return {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    pageId,
    title,
    status: "active",
    startedAt: new Date().toISOString(),
  };
}

function getCommentIdFromWebhook(payload: NotionWebhookPayload): string | null {
  const entityId = payload.entity?.id?.trim();
  if (entityId && payload.entity?.type === "comment") {
    return entityId;
  }

  return null;
}

function containsStartTrigger(commentText: string): boolean {
  return START_TRIGGER_PATTERN.test(commentText);
}

function findActiveRunForPage(pageId: string): RunRecord | undefined {
  for (const run of activeRuns.values()) {
    if (run.pageId === pageId) {
      return run;
    }
  }

  return undefined;
}

function startRunInBackground(runRecord: RunRecord): void {
  activeRuns.set(runRecord.runId, runRecord);
  logListener(
    `run queued runId=${runRecord.runId} page=${runRecord.pageId} titleChars=${runRecord.title.length} activeRuns=${activeRuns.size}`
  );

  void (async () => {
    logListener(`run started runId=${runRecord.runId} page=${runRecord.pageId}`);
    try {
      await runProcessTicket(runRecord.pageId);
      const completedRecord = {
        ...runRecord,
        status: "completed",
        endedAt: new Date().toISOString(),
      } as const;

      recordRunCompletion(completedRecord);
      logListener(
        `run completed runId=${runRecord.runId} page=${runRecord.pageId} durationMs=${getRunDurationMs(completedRecord)} activeRuns=${activeRuns.size} completedRuns=${completedRuns.length}`
      );
    } catch (error) {
      const failedRecord = {
        ...runRecord,
        status: "failed",
        endedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      } as const;

      recordRunCompletion(failedRecord);
      logListenerError(
        `run failed runId=${runRecord.runId} page=${runRecord.pageId} durationMs=${getRunDurationMs(failedRecord)} activeRuns=${activeRuns.size} completedRuns=${completedRuns.length} message=${quote(
          failedRecord.error
        )}`
      );
    }
  })();
}

async function resolveTicketTitle(pageId: string): Promise<string> {
  try {
    const ticket = await getTicket(pageId);
    if (ticket.title?.trim()) {
      return ticket.title.trim();
    }
  } catch {
    logListenerWarn(`ticket title resolve failed page=${pageId} fallbackTitle=true`);
  }

  return pageId;
}

async function runProcessTicket(pageId: string): Promise<void> {
  logListener(`orchestrator import start page=${pageId}`);
  const dynamicImport = (specifier: string) => import(specifier);
  const orchestratorModule = (await dynamicImport("./orchestrator.ts")) as {
    processTicket?: (id: string) => Promise<void>;
  };

  if (typeof orchestratorModule.processTicket !== "function") {
    throw new Error("processTicket(pageId) is unavailable in ./orchestrator.ts");
  }

  logListener(`orchestrator import ok page=${pageId}`);
  await orchestratorModule.processTicket(pageId);
}

function statusPayload(startedAt: number) {
  return {
    active: [...activeRuns.values()],
    completed: completedRuns,
    counts: {
      active: activeRuns.size,
      completed: completedRuns.filter((run) => run.status === "completed").length,
      failed: completedRuns.filter((run) => run.status === "failed").length,
    },
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  };
}

async function enqueueRunForPage(pageId: string, reason: "link" | "webhook", details: string): Promise<{
  run: RunRecord;
  deduped: boolean;
}> {
  const activeRun = findActiveRunForPage(pageId);

  if (activeRun) {
    logListenerWarn(
      `run deduped reason=${reason} page=${pageId} existingRunId=${activeRun.runId} decision=skip-active details=${details}`
    );
    return { run: activeRun, deduped: true };
  }

  const title = await resolveTicketTitle(pageId);
  const runRecord = createRunRecord(pageId, title);
  startRunInBackground(runRecord);
  logListener(
    `run triggered reason=${reason} page=${pageId} runId=${runRecord.runId} titleResolved=${title !== pageId ? "true" : "false"} details=${details}`
  );

  return { run: runRecord, deduped: false };
}

async function handleLinkStart(pageId: string): Promise<Response> {
  const result = await enqueueRunForPage(pageId, "link", "route=/start");
  const safeTitle = escapeHtml(result.run.title);

  if (result.deduped) {
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>NotionCode</title></head><body><h1>Agent is already running for ${safeTitle}.</h1><p>Run ID: ${escapeHtml(result.run.runId)}</p><p>You can close this tab.</p></body></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      }
    );
  }

  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>NotionCode</title></head><body><h1>Agent started for ${safeTitle}!</h1><p>Run ID: ${escapeHtml(result.run.runId)}</p><p>You can close this tab.</p></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    }
  );
}

async function handleWebhookRequest(request: Request, webhookPath: string): Promise<Response> {
  let payload: NotionWebhookPayload;

  try {
    payload = (await request.json()) as NotionWebhookPayload;
  } catch {
    logListenerWarn(`webhook rejected path=${webhookPath} status=400 reason=invalid-json`);
    return Response.json({ ok: false, error: "invalid-json" }, { status: 400 });
  }

  const eventType = payload.type ?? "unknown";
  const eventId = payload.id ?? "unknown";
  logListener(`webhook received path=${webhookPath} eventId=${eventId} type=${quote(eventType)}`);

  if (payload.verification_token && !payload.type) {
    logListener(`webhook verification received eventId=${eventId} tokenPresent=true`);
    return Response.json({ ok: true, verification_token: payload.verification_token });
  }

  if (payload.type !== "comment.created") {
    logListener(`webhook ignored eventId=${eventId} reason=event-type type=${quote(eventType)}`);
    return Response.json({ ok: true, ignored: true, reason: "event-type" });
  }

  try {
    const commentId = getCommentIdFromWebhook(payload);

    if (!commentId) {
      logListenerWarn(`webhook ignored eventId=${eventId} reason=missing-comment-id`);
      return Response.json({ ok: true, ignored: true, reason: "missing-comment-id" }, { status: 202 });
    }

    const comment = await getCommentDetails(commentId);
    const hasTrigger = containsStartTrigger(comment.text);
    logListener(
      `webhook comment parsed eventId=${eventId} comment=${commentId} textChars=${comment.text.length} trigger=${hasTrigger ? "true" : "false"}`
    );

    if (!hasTrigger) {
      logListener(`webhook ignored eventId=${eventId} comment=${commentId} reason=missing-trigger`);
      return Response.json({ ok: true, ignored: true, reason: "missing-trigger" });
    }

    const pageId = payload.data?.page_id?.trim() || comment.pageId;

    if (!pageId) {
      logListenerWarn(
        `webhook ignored eventId=${eventId} comment=${commentId} reason=missing-page parentType=${quote(comment.parentType)}`
      );
      return Response.json({ ok: true, ignored: true, reason: "missing-page" }, { status: 202 });
    }

    const queued = await enqueueRunForPage(
      pageId,
      "webhook",
      `eventId=${eventId} comment=${commentId} parentType=${comment.parentType}`
    );

    return Response.json({
      ok: true,
      started: !queued.deduped,
      deduped: queued.deduped,
      runId: queued.run.runId,
      pageId,
      commentId,
      eventId,
    });
  } catch (error) {
    logListenerError(`webhook failed eventId=${eventId} message=${quote(getErrorMessage(error))}`);
    return Response.json({ ok: false, error: "webhook-processing-failed" }, { status: 500 });
  }
}

export async function startListener(options: StartListenerOptions = {}): Promise<void> {
  const notion = createNotionClient();
  const databaseId = getRequiredEnv("NOTION_DATABASE_ID");
  const port = getPort(options.port);
  const webhookPath = getWebhookPath();
  const startedAt = Date.now();
  let pollCount = 0;

  logListener(
    `startup begin database=${databaseId} port=${port} webhookPath=${quote(webhookPath)} pollIntervalMs=${POLL_INTERVAL_MS} activeRuns=${activeRuns.size} completedRuns=${completedRuns.length}`
  );
  const target = await ensureLinkColumn(notion, databaseId);

  logListener(`startup target ready target=${formatTarget(target)}`);
  await fillMissingLinks(notion, target, port);
  logListener(`startup initial-link-fill complete target=${formatTarget(target)}`);

  setInterval(async () => {
    const pollId = ++pollCount;
    const pollStartedAt = Date.now();

    logListener(`poll start pollId=${pollId} target=${formatTarget(target)} port=${port}`);
    try {
      const filled = await fillMissingLinks(notion, target, port);
      logListener(
        `poll complete pollId=${pollId} target=${formatTarget(target)} filled=${filled} durationMs=${Date.now() - pollStartedAt}`
      );
    } catch (error) {
      logListenerError(
        `poll failed pollId=${pollId} target=${formatTarget(target)} durationMs=${Date.now() - pollStartedAt} message=${quote(
          getErrorMessage(error)
        )}`
      );
    }
  }, POLL_INTERVAL_MS);

  logListener(`server starting port=${port}`);

  Bun.serve({
    port,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);

      if (request.method === "POST" && pathname === webhookPath) {
        return handleWebhookRequest(request, webhookPath);
      }

      if (request.method !== "GET") {
        logListenerWarn(`request rejected method=${request.method} path=${pathname} status=405`);
        return new Response("Method Not Allowed", { status: 405 });
      }

      if (pathname === "/health") {
        return Response.json({
          ok: true,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        });
      }

      if (pathname === "/status") {
        return Response.json(statusPayload(startedAt));
      }

      if (pathname === "/start") {
        const pageId = parsePageId(request);

        if (!pageId) {
          logListenerWarn(`start request rejected path=/start status=400 reason=missing-page`);
          return new Response("Missing required query parameter: page", { status: 400 });
        }

        logListener(`start request received page=${pageId}`);
        return handleLinkStart(pageId);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(READY_MESSAGE);
  console.log(`${LISTENER_LOG_PREFIX} Webhook endpoint: http://localhost:${port}${webhookPath}`);
  console.log(
    `${LISTENER_LOG_PREFIX} Webhook test: run \`ngrok http ${port}\`, then set Notion webhook URL to \`https://<ngrok-host>${webhookPath}\` and subscribe to \`comment.created\`.`
  );
}
