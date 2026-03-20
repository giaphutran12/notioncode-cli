import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

export type AgentProvider = "openai" | "anthropic" | "gemini";
export type AgentRunner = "claude" | "opencode";

type AgentApiKeyEnvVar = "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY";
type AgentBaseUrlEnvVar = "OPENAI_BASE_URL" | "ANTHROPIC_BASE_URL" | "GEMINI_BASE_URL";
type AgentEnv = Record<string, string | undefined>;

const AGENT_LOG_PREFIX = "[AGENT]";
const OPENCODE_ENV_PREFIX = "OPENCODE";
const HEARTBEAT_INTERVAL_MS = 15_000;
const activeChildPids = new Set<number>();

const AGENT_PROVIDER_ORDER: readonly AgentProvider[] = ["openai", "anthropic", "gemini"];
const AGENT_API_KEY_ENV_VARS: Record<AgentProvider, AgentApiKeyEnvVar> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};
const AGENT_BASE_URL_ENV_VARS: Record<AgentProvider, AgentBaseUrlEnvVar> = {
  openai: "OPENAI_BASE_URL",
  anthropic: "ANTHROPIC_BASE_URL",
  gemini: "GEMINI_BASE_URL",
};

export interface SpawnAgentConfig {
  prompt: string;
  workDir: string;
  provider: AgentProvider;
  apiKey: string;
  baseUrl?: string;
  runner?: AgentRunner;
  signal?: AbortSignal;
}

export interface ResolvedAgentExecution {
  provider: AgentProvider;
  providerSource: "override" | "fallback";
  apiKey: string;
  apiKeyEnvVar: AgentApiKeyEnvVar;
  baseUrl?: string;
  baseUrlEnvVar?: AgentBaseUrlEnvVar;
  runner: AgentRunner;
  runnerSource: "override" | "default";
}

export interface SpawnAgentResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  duration: number;
}

function logAgent(message: string): void {
  console.log(`${AGENT_LOG_PREFIX} ${message}`);
}

function logAgentError(message: string): void {
  console.error(`${AGENT_LOG_PREFIX} ${message}`);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function resolveCommand(runner: AgentRunner): [string, string[]] {
  if (runner === "opencode") {
    return ["opencode", ["run", "--print-logs"]];
  }

  return ["claude", ["-p"]];
}

function readOptionalEnv(env: AgentEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function getConfiguredProvider(env: AgentEnv): AgentProvider | undefined {
  const value = readOptionalEnv(env, "AGENT_PROVIDER");

  if (!value) {
    return undefined;
  }

  if (value === "openai" || value === "anthropic" || value === "gemini") {
    return value;
  }

  throw new Error(
    `AGENT_PROVIDER must be one of "openai", "anthropic", or "gemini" (received: ${value})`
  );
}

function getConfiguredRunner(env: AgentEnv): AgentRunner | undefined {
  const value = readOptionalEnv(env, "AGENT_RUNNER");

  if (!value) {
    return undefined;
  }

  if (value === "claude" || value === "opencode") {
    return value;
  }

  throw new Error(`AGENT_RUNNER must be either "claude" or "opencode" (received: ${value})`);
}

export function getAgentApiKeyEnvVar(provider: AgentProvider): AgentApiKeyEnvVar {
  return AGENT_API_KEY_ENV_VARS[provider];
}

function getAgentBaseUrlEnvVar(provider: AgentProvider): AgentBaseUrlEnvVar {
  return AGENT_BASE_URL_ENV_VARS[provider];
}

export function getDefaultAgentRunner(provider: AgentProvider): AgentRunner {
  return provider === "anthropic" ? "claude" : "opencode";
}

export function isRunnerCompatibleWithProvider(runner: AgentRunner, provider: AgentProvider): boolean {
  return runner === "opencode" || provider === "anthropic";
}

function getSupportedRunners(provider: AgentProvider): AgentRunner[] {
  return provider === "anthropic" ? ["claude", "opencode"] : ["opencode"];
}

export function assertRunnerSupportsProvider(runner: AgentRunner, provider: AgentProvider): void {
  if (isRunnerCompatibleWithProvider(runner, provider)) {
    return;
  }

  throw new Error(
    `Runner "${runner}" does not support provider "${provider}". Supported runners for ${provider}: ${getSupportedRunners(
      provider
    ).join(", ")}.`
  );
}

function getEligibleProviders(runner?: AgentRunner): AgentProvider[] {
  if (!runner) {
    return [...AGENT_PROVIDER_ORDER];
  }

  return AGENT_PROVIDER_ORDER.filter((provider) => isRunnerCompatibleWithProvider(runner, provider));
}

export function resolveAgentExecution(env: AgentEnv = process.env): ResolvedAgentExecution {
  const providerOverride = getConfiguredProvider(env);
  const runnerOverride = getConfiguredRunner(env);

  if (providerOverride && runnerOverride) {
    assertRunnerSupportsProvider(runnerOverride, providerOverride);
  }

  const candidateProviders = providerOverride ? [providerOverride] : getEligibleProviders(runnerOverride);

  for (const provider of candidateProviders) {
    const apiKeyEnvVar = getAgentApiKeyEnvVar(provider);
    const apiKey = readOptionalEnv(env, apiKeyEnvVar);

    if (!apiKey) {
      if (providerOverride) {
        logAgentError(
          `resolution failed provider=${provider} providerSource=override missingApiKeyEnvVar=${apiKeyEnvVar}`
        );
        throw new Error(`AGENT_PROVIDER="${provider}" requires ${apiKeyEnvVar}.`);
      }

      logAgent(
        `resolution skipped provider=${provider} providerSource=fallback missingApiKeyEnvVar=${apiKeyEnvVar}`
      );
      continue;
    }

    const baseUrlEnvVar = getAgentBaseUrlEnvVar(provider);
    const baseUrl = readOptionalEnv(env, baseUrlEnvVar);

    const resolvedExecution: ResolvedAgentExecution = {
      provider,
      providerSource: providerOverride ? "override" : "fallback",
      apiKey,
      apiKeyEnvVar,
      ...(baseUrl ? { baseUrl, baseUrlEnvVar } : {}),
      runner: runnerOverride ?? getDefaultAgentRunner(provider),
      runnerSource: runnerOverride ? "override" : "default",
    };

    logAgent(
      `resolved provider=${resolvedExecution.provider} providerSource=${resolvedExecution.providerSource} runner=${resolvedExecution.runner} runnerSource=${resolvedExecution.runnerSource} apiKeyEnvVar=${resolvedExecution.apiKeyEnvVar} baseUrlEnvVar=${resolvedExecution.baseUrlEnvVar ?? "none"} baseUrlConfigured=${resolvedExecution.baseUrl ? "true" : "false"}`
    );

    return resolvedExecution;
  }

  if (providerOverride) {
    logAgentError(
      `resolution failed provider=${providerOverride} providerSource=override missingApiKeyEnvVar=${getAgentApiKeyEnvVar(providerOverride)}`
    );
    throw new Error(`AGENT_PROVIDER="${providerOverride}" requires ${getAgentApiKeyEnvVar(providerOverride)}.`);
  }

  if (runnerOverride) {
    const supportedEnvVars = getEligibleProviders(runnerOverride).map(getAgentApiKeyEnvVar);

    logAgentError(
      `resolution failed runner=${runnerOverride} runnerSource=override missingCompatibleApiKeyEnvVars=${supportedEnvVars.join(",")}`
    );
    throw new Error(
      `No compatible API key found for runner "${runnerOverride}". Set ${supportedEnvVars.join(" or ")}.`
    );
  }

  logAgentError(
    "resolution failed providerSource=fallback runnerSource=default missingApiKeyEnvVars=OPENAI_API_KEY,ANTHROPIC_API_KEY,GEMINI_API_KEY"
  );
  throw new Error("One agent API key is required. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY.");
}

function createAgentEnv(config: Pick<SpawnAgentConfig, "provider" | "apiKey" | "baseUrl">): AgentEnv {
  const env: AgentEnv = { ...process.env };
  const strippedKeys: string[] = [];

  for (const apiKeyEnvVar of Object.values(AGENT_API_KEY_ENV_VARS)) {
    if (env[apiKeyEnvVar]) {
      strippedKeys.push(apiKeyEnvVar);
    }
    delete env[apiKeyEnvVar];
  }

  for (const baseUrlEnvVar of Object.values(AGENT_BASE_URL_ENV_VARS)) {
    if (env[baseUrlEnvVar]) {
      strippedKeys.push(baseUrlEnvVar);
    }
    delete env[baseUrlEnvVar];
  }

  // Strip all OPENCODE* env vars so the child does not attach to the parent
  // server or inherit parent session state (OPENCODE=1, OPENCODE_PID, etc.)
  for (const key of Object.keys(env)) {
    if (key.startsWith(OPENCODE_ENV_PREFIX)) {
      strippedKeys.push(key);
      delete env[key];
    }
  }

  logAgent(`env stripped keys=[${strippedKeys.join(",")}]`);

  env[getAgentApiKeyEnvVar(config.provider)] = config.apiKey;

  if (config.baseUrl) {
    env[getAgentBaseUrlEnvVar(config.provider)] = config.baseUrl;
  }

  return env;
}

function createCanceledResult(startTime: number, stdout = "", stderr = ""): SpawnAgentResult {
  return {
    exitCode: null,
    stdout,
    stderr,
    duration: Date.now() - startTime,
  };
}

export function killAllAgents(): number {
  let killed = 0;
  for (const pid of activeChildPids) {
    try {
      process.kill(pid, "SIGTERM");
      killed += 1;
      logAgent(`kill pid=${pid}`);
    } catch {
      logAgent(`kill skip pid=${pid} reason=already-exited`);
    }
  }
  activeChildPids.clear();
  logAgent(`kill complete killed=${killed}`);
  return killed;
}

export function renderAgentPrompt(template: string, values: Record<string, string> = {}): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] ?? match : match;
  });
}

export async function spawnAgent(config: SpawnAgentConfig): Promise<SpawnAgentResult> {
  const startTime = Date.now();
  const runner = config.runner ?? getDefaultAgentRunner(config.provider);
  const apiKeyEnvVar = getAgentApiKeyEnvVar(config.provider);
  const baseUrlEnvVar = config.baseUrl ? getAgentBaseUrlEnvVar(config.provider) : undefined;

  if (config.signal?.aborted) {
    logAgent(
      `spawn canceled-before-start provider=${config.provider} runner=${runner} workDir=${quote(config.workDir)} reason=signal-aborted`
    );
    return createCanceledResult(startTime);
  }

  logAgent(
    `spawn preparing provider=${config.provider} runner=${runner} workDir=${quote(config.workDir)} apiKeyEnvVar=${apiKeyEnvVar} baseUrlEnvVar=${baseUrlEnvVar ?? "none"} baseUrlConfigured=${config.baseUrl ? "true" : "false"}`
  );
  await access(config.workDir);

  assertRunnerSupportsProvider(runner, config.provider);
  const [command, args] = resolveCommand(runner);
  const childArgs = [...args, config.prompt];
  const env = createAgentEnv(config);

  logAgent(
    `spawn env provider=${config.provider} runner=${runner} envKeys=${Object.keys(env).filter(k => k.includes("KEY") || k.includes("OPENCODE")).join(",") || "none"}`
  );

  const child = spawn(command, childArgs, {
    cwd: config.workDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (child.pid) {
    activeChildPids.add(child.pid);
  }

  logAgent(
    `spawn started provider=${config.provider} runner=${runner} command=${command} pid=${child.pid ?? "unknown"} cwd=${quote(config.workDir)} promptChars=${config.prompt.length} tracked=${activeChildPids.size}`
  );

  let stdout = "";
  let stderr = "";
  let aborted = false;
  let stderrFirstChunkLogged = false;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });

  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    if (!stderrFirstChunkLogged) {
      stderrFirstChunkLogged = true;
      const preview = chunk.slice(0, 500).replace(/\n/g, "\\n");
      logAgent(`spawn stderr-first-chunk pid=${child.pid ?? "unknown"} preview=${quote(preview)}`);
    }
  });

  const abortHandler = () => {
    aborted = true;
    logAgent(
      `spawn abort requested provider=${config.provider} runner=${runner} pid=${child.pid ?? "unknown"} workDir=${quote(config.workDir)}`
    );
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };

  config.signal?.addEventListener("abort", abortHandler, { once: true });

  const heartbeat = setInterval(() => {
    logAgent(
      `spawn heartbeat pid=${child.pid ?? "unknown"} aliveMs=${Date.now() - startTime} stdoutChars=${stdout.length} stderrChars=${stderr.length}`
    );
  }, HEARTBEAT_INTERVAL_MS);

  return await new Promise<SpawnAgentResult>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearInterval(heartbeat);
      config.signal?.removeEventListener("abort", abortHandler);
      if (child.pid) {
        activeChildPids.delete(child.pid);
      }
    };

    const finish = (value: SpawnAgentResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    child.once("error", (error) => {
      if (aborted) {
        logAgent(
          `spawn completed provider=${config.provider} runner=${runner} pid=${child.pid ?? "unknown"} exitCode=null durationMs=${Date.now() - startTime} aborted=true stdoutChars=${stdout.length} stderrChars=${stderr.length}`
        );
        finish(createCanceledResult(startTime, stdout, stderr));
        return;
      }

      logAgentError(
        `spawn failed provider=${config.provider} runner=${runner} pid=${child.pid ?? "unknown"} message=${quote(
          error.message
        )}`
      );
      fail(error);
    });

    child.once("close", (exitCode) => {
      const duration = Date.now() - startTime;

      if (aborted) {
        logAgent(
          `spawn completed provider=${config.provider} runner=${runner} pid=${child.pid ?? "unknown"} exitCode=null durationMs=${duration} aborted=true stdoutChars=${stdout.length} stderrChars=${stderr.length}`
        );
        finish(createCanceledResult(startTime, stdout, stderr));
        return;
      }

      logAgent(
        `spawn completed provider=${config.provider} runner=${runner} pid=${child.pid ?? "unknown"} exitCode=${exitCode ?? "null"} durationMs=${duration} aborted=false stdoutChars=${stdout.length} stderrChars=${stderr.length}`
      );

      if (stderr.length > 0) {
        const tail = stderr.slice(-800).replace(/\n/g, "\\n");
        logAgent(`spawn stderr-tail pid=${child.pid ?? "unknown"} tail=${quote(tail)}`);
      }

      finish({
        exitCode,
        stdout,
        stderr,
        duration,
      });
    });
  });
}
