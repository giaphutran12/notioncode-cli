# NotionCode

NotionCode turns a Notion ticket into an AI coding run, then writes the result back to the same card.

It supports two paths:
- `notioncode listen`, which starts the local listener for Notion webhooks and link clicks
- `notioncode run` and `notioncode start <page_id>`, which are the manual fallback flows

## What it does now

- Watches for `comment.created` webhook events at `POST /webhook`
- Accepts local link starts at `GET /start?page=...`
- Exposes `GET /health` and `GET /status`
- Auto-creates the `NotionCode Link` URL property when the listener starts
- Runs one ticket at a time and writes status updates and PR links back to Notion
- Falls back across providers in this order: OpenAI, Anthropic, Gemini

## Setup

1. Copy `.env.example` to `.env`
2. Set the required values:
   - `NOTION_TOKEN`
   - `NOTION_DATABASE_ID`
   - `TARGET_REPO_PATH`
3. Set one agent key:
   - `OPENAI_API_KEY`, or
   - `ANTHROPIC_API_KEY`, or
   - `GEMINI_API_KEY`
4. Optional overrides:
   - `NOTIONCODE_PORT` or `PORT`
   - `NOTIONCODE_WEBHOOK_PATH` or `/webhook`
   - `NOTION_API_BASE_URL`
   - `AGENT_PROVIDER`
   - `AGENT_RUNNER`

Run setup check:

```bash
bun run src/index.ts setup
```

That command validates the required env vars, checks the agent configuration, probes Notion, and prints the local listener and ngrok guidance.

## Demo flow

1. Start the listener:

```bash
bun run src/index.ts listen
```

2. If you are demoing webhooks, expose the local port with ngrok and point Notion to `POST /webhook`.
3. If you are demoing the fallback path, use `bun run src/index.ts run` or `bun run src/index.ts start <page_id>`.
4. Show the Notion card move through In progress, then Done or Failed.

## Demo GIF

![Demo GIF placeholder](docs/demo.gif)

## Docs

- [Notion database template](docs/notion-database-template.md)
- [Sample demo tickets](docs/demo-sample-tickets.md)
- [Demo script](docs/demo-script.md)
