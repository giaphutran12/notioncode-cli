import { execSync } from "node:child_process";
import { access, readFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAgentExecution, spawnAgent } from "./agent";
import { getTicket, listTickets, postComment, updateProperty, updateStatus } from "./notion";

const AGENTS_TEMPLATE_PATH = fileURLToPath(new URL("../AGENTS.md", import.meta.url));
const PR_URL_REGEX = /https:\/\/github.com\/.+\/pull\/\d+/;
const PR_LINK_PROPERTY_NAME = "PR Link";
const ORCHESTRATOR_LOG_PREFIX = "[ORCHESTRATOR]";
const WORKTREE_DIR_NAME = ".notioncode-worktrees";

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

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", timeout: 30_000 }).trim();
}

function gitSilent(args: string, cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function getDefaultBranch(repoPath: string): string {
  const symbolic = gitSilent("symbolic-ref refs/remotes/origin/HEAD --short", repoPath);
  if (symbolic) {
    return symbolic.replace("origin/", "");
  }
  return "main";
}

interface WorktreeContext {
  worktreePath: string;
  branchName: string;
  baseBranch: string;
}

async function createWorktree(targetRepoPath: string, pageId: string): Promise<WorktreeContext> {
  const shortId = pageId.replace(/-/g, "").slice(0, 12);
  const timestamp = Date.now();
  const branchName = `notioncode/${shortId}-${timestamp}`;
  const safeDirName = `${shortId}-${timestamp}`;
  const worktreeBase = join(dirname(targetRepoPath), WORKTREE_DIR_NAME);
  const worktreePath = join(worktreeBase, safeDirName);

  await mkdir(worktreeBase, { recursive: true });

  gitSilent(`worktree remove ${JSON.stringify(worktreePath)} --force`, targetRepoPath);

  const baseBranch = getDefaultBranch(targetRepoPath);
  logOrchestrator(`worktree create start page=${pageId} branch=${quote(branchName)} base=${quote(baseBranch)} path=${quote(worktreePath)}`);

  git(`worktree add ${JSON.stringify(worktreePath)} -b ${branchName} ${baseBranch}`, targetRepoPath);
  logOrchestrator(`worktree create ok page=${pageId} branch=${quote(branchName)}`);

  return { worktreePath, branchName, baseBranch };
}

function autoCommitStragglers(worktreePath: string, pageId: string): boolean {
  const status = gitSilent("status --porcelain", worktreePath);
  if (!status) {
    logOrchestrator(`auto-commit skip page=${pageId} reason=clean-tree`);
    return false;
  }

  logOrchestrator(`auto-commit start page=${pageId} dirtyFiles=${status.split("\n").length}`);
  git("add -A", worktreePath);
  git(`commit -m "chore(notioncode): auto-commit agent changes for ${pageId}"`, worktreePath);
  logOrchestrator(`auto-commit ok page=${pageId}`);
  return true;
}

function pushBranch(worktreePath: string, branchName: string, pageId: string): boolean {
  try {
    git(`push -u origin ${branchName}`, worktreePath);
    logOrchestrator(`push ok page=${pageId} branch=${quote(branchName)}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logOrchestratorError(`push failed page=${pageId} branch=${quote(branchName)} message=${quote(message)}`);
    return false;
  }
}

function hasCommitsOnBranch(worktreePath: string, baseBranch: string): boolean {
  const log = gitSilent(`log ${baseBranch}..HEAD --oneline`, worktreePath);
  return Boolean(log);
}

async function removeWorktree(targetRepoPath: string, ctx: WorktreeContext): Promise<void> {
  gitSilent(`worktree remove ${JSON.stringify(ctx.worktreePath)} --force`, targetRepoPath);

  if (!hasCommitsOnBranch(ctx.worktreePath, ctx.baseBranch)) {
    gitSilent(`branch -D ${ctx.branchName}`, targetRepoPath);
  }

  logOrchestrator(`worktree remove ok branch=${quote(ctx.branchName)}`);
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
  let worktree: WorktreeContext | null = null;

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

    stage = "create-worktree";
    worktree = await createWorktree(targetRepoPath, pageId);

    stage = "load-agent-template";
    logOrchestrator(`prompt template load start path=${quote(AGENTS_TEMPLATE_PATH)}`);
    const agentTemplate = await readFile(AGENTS_TEMPLATE_PATH, "utf8");

    stage = "prepare-prompt";
    const prompt = buildPrompt(agentTemplate, ticket.title, ticket.description);
    logOrchestrator(`prompt prepared page=${pageId} promptChars=${prompt.length}`);

    stage = "launch-agent";
    logOrchestrator(
      `agent launch start page=${pageId} provider=${agentExecution.provider} runner=${agentExecution.runner} workDir=${quote(worktree.worktreePath)}`
    );
    const result = await spawnAgent({
      prompt,
      workDir: worktree.worktreePath,
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

    stage = "auto-commit";
    autoCommitStragglers(worktree.worktreePath, pageId);

    stage = "push-branch";
    const pushed = hasCommitsOnBranch(worktree.worktreePath, worktree.baseBranch)
      ? pushBranch(worktree.worktreePath, worktree.branchName, pageId)
      : false;

    const prUrl = extractPrUrl(result.stdout);
    logOrchestrator(`pr detection page=${pageId} detected=${prUrl ? "true" : "false"} pushed=${pushed}`);

    stage = "cleanup-worktree";
    await removeWorktree(targetRepoPath, worktree);
    worktree = null;

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

    if (worktree) {
      try {
        autoCommitStragglers(worktree.worktreePath, pageId);
        await removeWorktree(targetRepoPath, worktree);
      } catch (cleanupError) {
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        logOrchestratorError(`worktree cleanup failed page=${pageId} message=${quote(cleanupMessage)}`);
      }
    }

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
