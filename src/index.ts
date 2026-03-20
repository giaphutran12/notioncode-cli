#!/usr/bin/env bun

import "dotenv/config";
import { Command } from "commander";
import { resolveAgentExecution } from "./agent";
import { startListener } from "./listener";
import { processAllTickets, processTicket } from "./orchestrator";
import { listTickets } from "./notion";

const program = new Command();

const REQUIRED_SETUP_ENV_VARS = ["NOTION_TOKEN", "NOTION_DATABASE_ID", "TARGET_REPO_PATH"] as const;

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function statusLabel(status: string | null | undefined): string {
  if (!status) {
    return "○ unknown";
  }

  const normalized = status.toLowerCase();

  if (normalized === "done" || normalized === "completed" || normalized === "in progress") {
    return `● ${status}`;
  }

  if (normalized === "failed") {
    return `! ${status}`;
  }

  return `○ ${status}`;
}

function printSetupGuide(): void {
  const port = process.env.NOTIONCODE_PORT?.trim() || process.env.PORT?.trim() || "3210";
  const webhookPathRaw = process.env.NOTIONCODE_WEBHOOK_PATH?.trim() || "/webhook";
  const webhookPath = webhookPathRaw.startsWith("/") ? webhookPathRaw : `/${webhookPathRaw}`;

  console.log("\nSetup:");
  console.log("- Configure the required env vars in .env");
  console.log(`- Run \`notioncode listen\` to start the local listener on http://localhost:${port}`);
  console.log(`- Notion webhook endpoint: http://localhost:${port}${webhookPath}`);
  console.log(`- Optional: expose localhost with \`ngrok http ${port}\` for webhook access`);
  console.log(
    `- In Notion integration settings, set webhook URL to https://<ngrok-host>${webhookPath} and subscribe to comment.created`
  );
}

async function validateSetup(): Promise<void> {
  console.log("Checking required environment variables...");

  for (const name of REQUIRED_SETUP_ENV_VARS) {
    getRequiredEnv(name);
  }

  const agentExecution = resolveAgentExecution();
  console.log(
    `Agent configuration OK (provider: ${agentExecution.provider} via ${agentExecution.apiKeyEnvVar}, runner: ${agentExecution.runner})`
  );

  console.log("Checking Notion connection...");
  const tickets = await listTickets();
  console.log(`Notion connection OK (${tickets.length} ticket${tickets.length === 1 ? "" : "s"} found)`);
}

async function runCommand(name: string, handler: () => Promise<void>): Promise<void> {
  try {
    await handler();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${name}] ${message}`);
    process.exitCode = 1;
  }
}

program
  .name("notioncode")
  .description("NotionCode CLI");

program
  .command("listen")
  .description("Start the listener server")
  .action(() =>
    runCommand("listen", async () => {
      console.log("Listening for @NotionCode mentions... (press Ctrl+C to stop)");
      await startListener();
    })
  );

program
  .command("run")
  .description("Process all Not started tickets")
  .action(() =>
    runCommand("run", async () => {
      await processAllTickets();
    })
  );

program
  .command("start")
  .argument("<page_id>")
  .description("Process a single ticket")
  .action((pageId: string) =>
    runCommand("start", async () => {
      await processTicket(pageId);
    })
  );

program
  .command("setup")
  .description("Validate configuration")
  .action(() =>
    runCommand("setup", async () => {
      await validateSetup();
      printSetupGuide();
    })
  );

program
  .command("list")
  .description("List tickets with status")
  .action(() =>
    runCommand("list", async () => {
      const tickets = await listTickets();

      if (tickets.length === 0) {
        console.log("No tickets found.");
        return;
      }

      for (const ticket of tickets) {
        console.log(`${statusLabel(ticket.status)} ${ticket.title || "(untitled)"} [${ticket.id}]`);
      }
    })
  );

await program.parseAsync();
