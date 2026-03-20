# Demo script

## Goal

Show the full path from Notion ticket to agent run to PR link, then show the manual fallback path as backup.

## Timing

### 0:00 to 0:30, setup
- Say: "NotionCode uses Notion as the queue, then hands the ticket to an AI coding agent."
- Open the README and point out the listener, webhook path, and fallback commands.

### 0:30 to 1:30, database and tickets
- Say: "This database has five columns and the demo tickets are ready to paste."
- Show `docs/notion-database-template.md` and `docs/demo-sample-tickets.md`.
- Paste the three sample tickets into Notion if needed.

### 1:30 to 2:15, setup check
- Say: "Setup validates the environment and then checks the Notion connection."
- Run `bun run src/index.ts setup`.
- Call out the printed localhost and ngrok instructions.

### 2:15 to 3:15, primary flow
- Say: "The primary path is a webhook at `/webhook`."
- Start `bun run src/index.ts listen`.
- Show `/health` or `/status` if you want a quick proof the listener is alive.
- Trigger a ticket and point to the status change and PR link.

### 3:15 to 4:00, fallback flow
- Say: "If the webhook is not available, the CLI still supports manual runs."
- Show `bun run src/index.ts run` or `bun run src/index.ts start <page_id>`.
- Emphasize that provider selection falls back from OpenAI to Anthropic to Gemini.

## Talk track

- Notion is the control plane.
- The listener owns webhook and link starts.
- The CLI can still run manually when the webhook path is not available.
- The demo is set up around three tickets so the audience can see one easy win, one bug fix, and one UI polish task.
