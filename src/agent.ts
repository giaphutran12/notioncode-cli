import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

export type AgentRunner = "claude" | "opencode";

export interface SpawnAgentConfig {
  prompt: string;
  workDir: string;
  apiKey: string;
  baseUrl?: string;
  runner?: AgentRunner;
  signal?: AbortSignal;
}

export interface SpawnAgentResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  duration: number;
}

function resolveCommand(runner: AgentRunner): [string, string[]] {
  if (runner === "opencode") {
    return ["opencode", ["run"]];
  }

  return ["claude", ["-p"]];
}

function createCanceledResult(startTime: number, stdout = "", stderr = ""): SpawnAgentResult {
  return {
    exitCode: null,
    stdout,
    stderr,
    duration: Date.now() - startTime,
  };
}

export function renderAgentPrompt(template: string, values: Record<string, string> = {}): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] ?? match : match;
  });
}

export async function spawnAgent(config: SpawnAgentConfig): Promise<SpawnAgentResult> {
  const startTime = Date.now();

  if (config.signal?.aborted) {
    return createCanceledResult(startTime);
  }

  await access(config.workDir);

  const runner = config.runner ?? "claude";
  const [command, args] = resolveCommand(runner);
  const childArgs = [...args, config.prompt];
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: config.apiKey,
    ...(config.baseUrl ? { ANTHROPIC_BASE_URL: config.baseUrl } : {}),
  };

  const child = spawn(command, childArgs, {
    cwd: config.workDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let aborted = false;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });

  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const abortHandler = () => {
    aborted = true;
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };

  config.signal?.addEventListener("abort", abortHandler, { once: true });

  return await new Promise<SpawnAgentResult>((resolve, reject) => {
    let settled = false;

    const finish = (value: SpawnAgentResult) => {
      if (settled) {
        return;
      }
      settled = true;
      config.signal?.removeEventListener("abort", abortHandler);
      resolve(value);
    };

    child.once("error", (error) => {
      if (aborted) {
        finish(createCanceledResult(startTime, stdout, stderr));
        return;
      }

      config.signal?.removeEventListener("abort", abortHandler);
      reject(error);
    });

    child.once("close", (exitCode) => {
      if (aborted) {
        finish(createCanceledResult(startTime, stdout, stderr));
        return;
      }

      finish({
        exitCode,
        stdout,
        stderr,
        duration: Date.now() - startTime,
      });
    });
  });
}
