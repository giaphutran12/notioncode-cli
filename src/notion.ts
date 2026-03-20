import { Client, LogLevel } from "@notionhq/client";

const MAX_RICH_TEXT_LENGTH = 2000;
const STATUS_PROPERTY_NAME = "Status";
const NOTION_LOG_PREFIX = "[NOTION]";
let notionClient: Client | null = null;

export interface TicketSummary {
  id: string;
  title: string;
  description: string;
  status: string | null;
}

export interface CommentDetails {
  id: string;
  pageId: string | null;
  parentType: "page_id" | "block_id" | "unknown";
  text: string;
}

export type Ticket = TicketSummary & Record<string, unknown>;

type NotionProperty = {
  type: string;
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  number?: number | null;
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  checkbox?: boolean;
};

type NotionPage = {
  id: string;
  properties: Record<string, NotionProperty>;
};

type NotionComment = {
  id: string;
  parent?: {
    type?: string;
    page_id?: string;
    block_id?: string;
  };
  rich_text?: Array<{ plain_text?: string }>;
};

type StatusProperty = {
  name: string;
  type: "status" | "select";
};

type DataSourcePropertyMap = Record<string, { type: string }>;

type NotionSdkLogInfo = {
  method?: string;
  path?: string;
  attempt?: number;
  delayMs?: number;
  code?: string;
  message?: string;
};

function logNotion(message: string): void {
  console.log(`${NOTION_LOG_PREFIX} ${message}`);
}

function logNotionWarn(message: string): void {
  console.warn(`${NOTION_LOG_PREFIX} ${message}`);
}

function logNotionError(message: string): void {
  console.error(`${NOTION_LOG_PREFIX} ${message}`);
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
      logNotionWarn(
        `sdk retry method=${extraInfo?.method ?? "unknown"} path=${quote(extraInfo?.path ?? "unknown")} attempt=${extraInfo?.attempt ?? 0} delayMs=${extraInfo?.delayMs ?? 0}`
      );
      return;
    }

    if (message === "request fail" && extraInfo?.code === "rate_limited") {
      logNotionWarn(
        `sdk request-fail code=rate_limited attempt=${extraInfo?.attempt ?? 0} message=${quote(
          extraInfo?.message ?? "unknown"
        )}`
      );
    }
  };
}

async function withRetry<T>(
  operationName: string,
  details: string,
  operation: () => Promise<T>
): Promise<T> {
  logNotion(`${operationName} start ${details}`);

  try {
    const result = await operation();
    logNotion(`${operationName} ok ${details}`);
    return result;
  } catch (error) {
    if (isRateLimited(error)) {
      logNotionWarn(`${operationName} rate-limited ${details} retryInMs=1000`);
      await sleep(1000);
      logNotion(`${operationName} retry ${details}`);

      try {
        const retryResult = await operation();
        logNotion(`${operationName} ok ${details} retry=1`);
        return retryResult;
      } catch (retryError) {
        logNotionError(
          `${operationName} failed ${details} retry=1 message=${quote(getErrorMessage(retryError))}`
        );
        throw retryError;
      }
    }

    logNotionError(`${operationName} failed ${details} message=${quote(getErrorMessage(error))}`);
    throw error;
  }
}

function getDatabaseDataSourceId(
  database: Awaited<ReturnType<Client["databases"]["retrieve"]>>
): string {
  if ("data_sources" in database && database.data_sources.length > 0) {
    return database.data_sources[0].id;
  }

  return database.id;
}

function getNotionToken(): string {
  const token = process.env.NOTION_TOKEN;

  if (!token) {
    throw new Error("NOTION_TOKEN is required to use src/notion.ts");
  }

  return token;
}

function getNotionDatabaseId(): string {
  const databaseId = process.env.NOTION_DATABASE_ID;

  if (!databaseId) {
    throw new Error("NOTION_DATABASE_ID is required to use src/notion.ts");
  }

  return databaseId;
}

function getNotionBaseUrl(): string | undefined {
  const baseUrl = process.env.NOTION_API_BASE_URL?.trim();
  return baseUrl ? baseUrl : undefined;
}

function getNotionClient(): Client {
  if (!notionClient) {
    logNotion("client init authEnv=NOTION_TOKEN retryMode=sdk-default+wrapper");
    notionClient = new Client({
      auth: getNotionToken(),
      baseUrl: getNotionBaseUrl(),
      logLevel: LogLevel.INFO,
      logger: createSdkLogger(),
    });
  }

  return notionClient;
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

function capRichText(text: string): string {
  if (text.length <= MAX_RICH_TEXT_LENGTH) {
    return text;
  }

  return `...${text.slice(-(MAX_RICH_TEXT_LENGTH - 3))}`;
}

function toRichText(text: string) {
  return [
    {
      type: "text" as const,
      text: {
        content: capRichText(text),
      },
    },
  ];
}

function flattenProperties(page: NotionPage): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(page.properties)) {
    switch (value.type) {
      case "title":
        flattened[key] = value.title?.[0]?.plain_text ?? "";
        break;
      case "rich_text":
        flattened[key] = value.rich_text?.[0]?.plain_text ?? "";
        break;
      case "number":
        flattened[key] = value.number ?? null;
        break;
      case "select":
        flattened[key] = value.select?.name ?? null;
        break;
      case "status":
        flattened[key] = value.status?.name ?? null;
        break;
      case "checkbox":
        flattened[key] = Boolean(value.checkbox);
        break;
      default:
        break;
    }
  }

  return flattened;
}

function getStatus(page: NotionPage): string | null {
  const props = page.properties;

  if (STATUS_PROPERTY_NAME in props) {
    const statusProp = props[STATUS_PROPERTY_NAME];

    if (statusProp.type === "status") {
      return statusProp.status?.name ?? null;
    }

    if (statusProp.type === "select") {
      return statusProp.select?.name ?? null;
    }
  }

  for (const prop of Object.values(props)) {
    if (prop.type === "status") {
      return prop.status?.name ?? null;
    }

    if (prop.type === "select") {
      return prop.select?.name ?? null;
    }
  }

  return null;
}

function getTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title") {
      return prop.title?.[0]?.plain_text ?? "";
    }
  }

  return "";
}

function getDescription(page: NotionPage): string {
  const props = page.properties;
  const preferred = props.Description ?? props.description;

  if (preferred?.type === "rich_text") {
    return preferred.rich_text?.[0]?.plain_text ?? "";
  }

  for (const prop of Object.values(props)) {
    if (prop.type === "rich_text") {
      return prop.rich_text?.[0]?.plain_text ?? "";
    }
  }

  return "";
}

function findStatusProperty(page: NotionPage): StatusProperty {
  const props = page.properties;

  if (STATUS_PROPERTY_NAME in props) {
    const statusProp = props[STATUS_PROPERTY_NAME];

    if (statusProp.type === "status" || statusProp.type === "select") {
      return { name: STATUS_PROPERTY_NAME, type: statusProp.type };
    }
  }

  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === "status" || prop.type === "select") {
      return { name, type: prop.type };
    }
  }

  throw new Error("Could not find a status/select property on the page");
}

async function getDatabaseStatusProperty(): Promise<StatusProperty> {
  const notion = getNotionClient();
  const databaseId = getNotionDatabaseId();
  const database = await withRetry(
    "databases.retrieve",
    `database=${databaseId} purpose=status-property`,
    () => notion.databases.retrieve({ database_id: databaseId })
  );

  const dataSourceId = getDatabaseDataSourceId(database);

  const dataSource = await withRetry(
    "dataSources.retrieve",
    `dataSource=${dataSourceId} purpose=status-property`,
    () => notion.dataSources.retrieve({ data_source_id: dataSourceId })
  );
  const properties = dataSource.properties as DataSourcePropertyMap;

  if (STATUS_PROPERTY_NAME in properties) {
    const prop = properties[STATUS_PROPERTY_NAME];

    if (prop.type === "status" || prop.type === "select") {
      logNotion(
        `status-property resolved database=${databaseId} dataSource=${dataSourceId} property=${quote(
          STATUS_PROPERTY_NAME
        )} type=${prop.type}`
      );
      return { name: STATUS_PROPERTY_NAME, type: prop.type };
    }
  }

  for (const [name, prop] of Object.entries(properties)) {
    if (prop.type === "status" || prop.type === "select") {
      logNotion(
        `status-property resolved database=${databaseId} dataSource=${dataSourceId} property=${quote(name)} type=${prop.type}`
      );
      return { name, type: prop.type };
    }
  }

  throw new Error("Could not find a status/select property on the database");
}

function toTicket(page: NotionPage): Ticket {
  const flattened = flattenProperties(page);

  return {
    ...flattened,
    id: page.id,
    title: getTitle(page),
    description: getDescription(page),
    status: getStatus(page),
  };
}

function plainTextFromRichText(richText: Array<{ plain_text?: string }> | undefined): string {
  if (!Array.isArray(richText) || richText.length === 0) {
    return "";
  }

  return richText.map((item) => item.plain_text ?? "").join("").trim();
}

export async function listTickets(status?: string): Promise<TicketSummary[]> {
  const notion = getNotionClient();
  const databaseId = getNotionDatabaseId();
  logNotion(`listTickets start database=${databaseId} status=${quote(status ?? "any")}`);
  const database = await withRetry(
    "databases.retrieve",
    `database=${databaseId} purpose=listTickets`,
    () => notion.databases.retrieve({ database_id: databaseId })
  );
  const dataSourceId = getDatabaseDataSourceId(database);

  const statusProperty = status ? await getDatabaseStatusProperty() : null;

  const filter = statusProperty && status
    ? statusProperty.type === "status"
      ? {
          property: statusProperty.name,
          status: {
            equals: status,
          },
        }
      : {
          property: statusProperty.name,
          select: {
            equals: status,
          },
        }
    : undefined;

  const response = (await withRetry(
    "dataSources.query",
    `dataSource=${dataSourceId} purpose=listTickets status=${quote(status ?? "any")}`,
    () =>
      notion.dataSources.query({
        data_source_id: dataSourceId,
        filter,
      })
  )) as { results: NotionPage[] };

  logNotion(
    `listTickets ok database=${databaseId} dataSource=${dataSourceId} status=${quote(status ?? "any")} count=${response.results.length}`
  );

  return response.results.map((page) => ({
    id: page.id,
    title: getTitle(page),
    description: getDescription(page),
    status: getStatus(page),
  }));
}

export async function getTicket(pageId: string): Promise<Ticket> {
  logNotion(`getTicket start page=${pageId}`);
  const page = (await withRetry(
    "pages.retrieve",
    `page=${pageId} purpose=getTicket`,
    () => getNotionClient().pages.retrieve({ page_id: pageId })
  )) as NotionPage;

  const ticket = toTicket(page);

  logNotion(
    `getTicket ok page=${pageId} status=${quote(ticket.status ?? "null")} titleChars=${ticket.title.length} descriptionChars=${ticket.description.length}`
  );

  return ticket;
}

export async function updateStatus(pageId: string, status: string): Promise<void> {
  const notion = getNotionClient();
  logNotion(`updateStatus start page=${pageId} status=${quote(status)}`);
  const page = (await withRetry(
    "pages.retrieve",
    `page=${pageId} purpose=updateStatus`,
    () => notion.pages.retrieve({ page_id: pageId })
  )) as NotionPage;
  const { name, type } = findStatusProperty(page);

  await withRetry(
    "pages.update",
    `page=${pageId} purpose=updateStatus property=${quote(name)} propertyType=${type} status=${quote(status)}`,
    () =>
      notion.pages.update({
        page_id: pageId,
        properties: {
          [name]:
            type === "status"
              ? {
                  status: {
                    name: status,
                  },
                }
              : {
                  select: {
                    name: status,
                  },
                },
        },
      })
  );

  logNotion(
    `updateStatus ok page=${pageId} status=${quote(status)} property=${quote(name)} propertyType=${type}`
  );
}

export async function postComment(pageId: string, text: string): Promise<void> {
  logNotion(`postComment start page=${pageId} textChars=${text.length}`);
  await withRetry(
    "comments.create",
    `page=${pageId} purpose=postComment textChars=${text.length}`,
    () =>
      getNotionClient().comments.create({
        parent: { page_id: pageId },
        rich_text: toRichText(text),
      })
  );

  logNotion(`postComment ok page=${pageId} textChars=${text.length}`);
}

export async function updateProperty(
  pageId: string,
  propName: string,
  value: string
): Promise<void> {
  logNotion(`updateProperty start page=${pageId} property=${quote(propName)} valueChars=${value.length}`);
  await withRetry(
    "pages.update",
    `page=${pageId} purpose=updateProperty property=${quote(propName)} valueChars=${value.length}`,
    () =>
      getNotionClient().pages.update({
        page_id: pageId,
        properties: {
          [propName]: {
            rich_text: toRichText(value),
          },
        },
      })
  );

  logNotion(`updateProperty ok page=${pageId} property=${quote(propName)} valueChars=${value.length}`);
}

export async function getCommentDetails(commentId: string): Promise<CommentDetails> {
  logNotion(`getCommentDetails start comment=${commentId}`);
  const comment = (await withRetry(
    "comments.retrieve",
    `comment=${commentId} purpose=getCommentDetails`,
    () => getNotionClient().comments.retrieve({ comment_id: commentId })
  )) as NotionComment;

  const parentType = comment.parent?.type;
  const pageId = parentType === "page_id" ? comment.parent?.page_id ?? null : null;
  const details: CommentDetails = {
    id: comment.id,
    pageId,
    parentType:
      parentType === "page_id" || parentType === "block_id"
        ? parentType
        : "unknown",
    text: plainTextFromRichText(comment.rich_text),
  };

  logNotion(
    `getCommentDetails ok comment=${commentId} parentType=${quote(details.parentType)} page=${quote(
      details.pageId ?? "null"
    )} textChars=${details.text.length}`
  );

  return details;
}
