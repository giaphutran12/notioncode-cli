import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { resolveAgentExecution, spawnAgent } from "./agent";
import { getTicket, listTickets, postComment, updateProperty, updateStatus } from "./notion";

const AGENTS_TEMPLATE_PATH = fileURLToPath(new URL("../AGENTS.md", import.meta.url));
const PR_URL_REGEX = /https:\/\/github.com\/.+\/pull\/\d+/;
const PR_LINK_PROPERTY_NAME = "PR Link";
const ORCHESTRATOR_LOG_PREFIX = "[ORCHESTRATOR]";

function logOrchestrator(message: string): void {
  console.log(`${ORCHESTRATOR_LOG_PREFIX} ${message}`);
}

function logOrchestratorError(message: string): void {
  console.error(`${ORCHESTRATOR_LOG_PREFIX} ${message}`);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function buildPrompt(agentTemplate: string, title: string, description: string): string {
  return `${agentTemplate}\n\n## Ticket\n- Title: ${title || "(untitled)"}\n- Description: ${description || "(no description provided)"}`;
}

function extractPrUrl(stdout: string): string | null {
  const match = stdout.match(PR_URL_REGEX);
  return match ? match[0] : null;
}

export async function processTicket(pageId: string): Promise<void> {
  const processStartedAt = Date.now();
  const targetRepoPath = getRequiredEnv("TARGET_REPO_PATH");
  const agentExecution = resolveAgentExecution();
  let stage = "validate-target-repo";

  logOrchestrator(
    `ticket start page=${pageId} repoPath=${quote(targetRepoPath)} provider=${agentExecution.provider} runner=${agentExecution.runner}`
  );
  await access(targetRepoPath);

  let lastOutput = "";

  try {
    stage = "fetch-ticket";
    logOrchestrator(`ticket fetch start page=${pageId}`);
    const ticket = await getTicket(pageId);
    logOrchestrator(
      `ticket fetch ok page=${pageId} status=${quote(ticket.status ?? "null")} titleChars=${ticket.title.length} descriptionChars=${ticket.description.length}`
    );

    stage = "write-in-progress-status";
    logOrchestrator(`status write start page=${pageId} status=${quote("In progress")}`);
    await updateStatus(pageId, "In progress");

    stage = "write-start-comment";
    logOrchestrator(`comment write start page=${pageId} kind=start`);
    await postComment(pageId, "Agent started working");

    stage = "load-agent-template";
    logOrchestrator(`prompt template load start path=${quote(AGENTS_TEMPLATE_PATH)}`);
    const agentTemplate = await readFile(AGENTS_TEMPLATE_PATH, "utf8");

    stage = "prepare-prompt";
    const prompt = buildPrompt(agentTemplate, ticket.title, ticket.description);
    logOrchestrator(`prompt prepared page=${pageId} promptChars=${prompt.length}`);

    stage = "launch-agent";
    logOrchestrator(
      `agent launch start page=${pageId} provider=${agentExecution.provider} runner=${agentExecution.runner} workDir=${quote(targetRepoPath)}`
    );
    const result = await spawnAgent({
      prompt,
      workDir: targetRepoPath,
      provider: agentExecution.provider,
      apiKey: agentExecution.apiKey,
      baseUrl: agentExecution.baseUrl,
      runner: agentExecution.runner,
    });

    logOrchestrator(
      `agent launch resolved page=${pageId} exitCode=${result.exitCode ?? "null"} durationMs=${result.duration} stdoutChars=${result.stdout.length} stderrChars=${result.stderr.length}`
    );

    lastOutput = result.stderr.trim() || result.stdout.trim();

    if (result.exitCode !== 0) {
      stage = "agent-nonzero-exit";
      throw new Error(`Agent exited with code ${result.exitCode}`);
    }

    const prUrl = extractPrUrl(result.stdout);
    logOrchestrator(`pr detection page=${pageId} detected=${prUrl ? "true" : "false"}`);

    stage = "write-done-status";
    logOrchestrator(`status write start page=${pageId} status=${quote("Done")}`);
    await updateStatus(pageId, "Done");

    if (prUrl) {
      stage = "write-pr-link";
      logOrchestrator(`property write start page=${pageId} property=${quote(PR_LINK_PROPERTY_NAME)} valueType=pr-url`);
      await updateProperty(pageId, PR_LINK_PROPERTY_NAME, prUrl);

      stage = "write-success-comment";
      logOrchestrator(`comment write start page=${pageId} kind=success-with-pr`);
      await postComment(pageId, `Done. Pull request: ${prUrl}`);
      logOrchestrator(
        `ticket complete page=${pageId} outcome=done-with-pr durationMs=${Date.now() - processStartedAt} prDetected=true`
      );
    } else {
      stage = "write-success-comment";
      logOrchestrator(`comment write start page=${pageId} kind=success-without-pr`);
      await postComment(pageId, "Done. Agent finished successfully, but no PR URL was detected.");
      logOrchestrator(
        `ticket complete page=${pageId} outcome=done-without-pr durationMs=${Date.now() - processStartedAt} prDetected=false`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rethrowError = error instanceof Error ? error : new Error(message);
    const failureDetails = lastOutput
      ? `${message}\n\nOutput:\n${truncate(lastOutput, 1200)}`
      : message;

    logOrchestratorError(
      `ticket failed page=${pageId} stage=${stage} durationMs=${Date.now() - processStartedAt} message=${quote(message)}`
    );

    try {
      stage = "write-failed-status";
      logOrchestrator(`status write start page=${pageId} status=${quote("Failed")}`);
      await updateStatus(pageId, "Failed");

      stage = "write-failure-comment";
      logOrchestrator(`comment write start page=${pageId} kind=failure`);
      await postComment(pageId, `Failed. ${failureDetails}`);
      logOrchestrator(
        `failure state recorded page=${pageId} durationMs=${Date.now() - processStartedAt} outputIncluded=${lastOutput ? "true" : "false"}`
      );
    } catch (notionError) {
      const notionMessage = notionError instanceof Error ? notionError.message : String(notionError);
      logOrchestratorError(
        `failure-state write failed page=${pageId} stage=${stage} message=${quote(notionMessage)}`
      );
    }

    throw rethrowError;
  }
}

export async function processAllTickets(): Promise<void> {
  const tickets = await listTickets("Not started");
  logOrchestrator(`ticket scan count=${tickets.length} status=${quote("Not started")}`);

  for (let index = 0; index < tickets.length; index += 1) {
    const ticket = tickets[index];
    logOrchestrator(
      `ticket queue index=${index + 1}/${tickets.length} page=${ticket.id} titleChars=${ticket.title.length}`
    );
    try {
      await processTicket(ticket.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logOrchestratorError(`ticket continue-after-failure page=${ticket.id} message=${quote(message)}`);
    }
  }

  logOrchestrator(`ticket scan complete processed=${tickets.length}`);
}
