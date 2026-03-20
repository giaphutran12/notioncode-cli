# NotionCode CLI — Notion Tickets → AI Agent → PR

## TL;DR

> **Quick Summary**: Build a TypeScript CLI (`notioncode`) that listens for "@NotionCode start" comments in Notion via webhooks, spawns AI coding agents, and writes results (PR link, status update) back to Notion. Also supports manual `notioncode run` as fallback.
> 
> **Deliverables**:
> - `notioncode listen` — daemon that receives Notion webhooks, triggers agents on @mention (PRIMARY)
> - `notioncode run` — manual fallback, processes all "Not started" tickets
> - `notioncode start <page_id>` — manual fallback, processes a single ticket
> - AGENTS.md that teaches spawned agents how to work
> 
> **Estimated Effort**: Medium (12-16 hours of agent work)
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 1 → Task 4 → Task 5 → Task 8 → Task 9

---

## Context

### Original Request
Build "NotionCode" — a tool where Notion is the control plane for AI coding agents. User has tickets in Notion, AI agents pick them up, code the solution, create PRs, and update the Notion card. 36-hour hackathon, team of 2.

### Division of Labor
- **Edward (this plan)**: CLI that works standalone — the engine
- **Kien**: Desktop app (Antigravity-Manager fork) — the dashboard with API rotation

### Key Research Findings
- No competitor does "Notion → AI coding agent → PR" well (ticket-to-pr has 3★, proof-of-concept only)
- Notion Developer API webhooks work on ALL plans including free
- CLI is more token-efficient than MCP server for agent tooling
- `claude -p` or `opencode run` can spawn agents headlessly

### Metis Review Findings (addressed)
- Sidecar architecture recommended (all logic in TypeScript, no Rust) — ADOPTED
- Decision gate for fork vs fresh build — N/A, CLI is standalone
- localhost links don't need webhooks/SSL — ADOPTED for serve mode
- Rate limiting: max 2 Notion API calls per agent lifecycle — ADOPTED

---

## Work Objectives

### Core Objective
A TypeScript CLI that turns Notion tickets into GitHub PRs via AI coding agents, with zero manual intervention after trigger.

### Concrete Deliverables
- `notioncode` CLI binary (TypeScript, runs with bun/node)
- Webhook listener — Express server that receives Notion `comment.created` webhooks
- @mention parser — detects "@NotionCode start" in comments, extracts page_id
- Notion API client module (read tickets, update status, post comments)
- Agent spawner module (shell out to `claude -p` or `opencode run`)
- Orchestrator that wires: webhook trigger → fetch ticket → spawn agent → collect result → update Notion
- AGENTS.md template for spawned agents

### Definition of Done
- [ ] `notioncode listen` starts webhook server, exposed via ngrok
- [ ] User comments "@NotionCode start" on a Notion ticket → agent kicks off within 10 seconds
- [ ] Agent creates a PR in the target repo
- [ ] Notion card updates to "Done" with PR link
- [ ] `notioncode run` still works as manual fallback
- [ ] Works with a plain Anthropic API key (no Antigravity-Manager needed)

### Must Have
- **Listen mode**: `notioncode listen` — daemon that receives webhooks and auto-triggers agents
- **@mention detection**: parse `comment.created` webhook for "@NotionCode" mention
- Single ticket flow works end-to-end (trigger → code → PR → Notion update)
- Status transitions: Not started → In progress → Done/Failed
- PR link appears on Notion card after agent finishes
- Error handling: if agent fails, card goes to "Failed" with error info
- Manual fallback: `notioncode run` still processes all tickets without webhooks

### Must NOT Have (Guardrails)
- NO Rust code — everything is TypeScript
- NO desktop app / Tauri / Electron — pure CLI
- NO MCP server — agents use bash commands
- NO over-engineering — this ships in hours, not days
- NO interactive prompts — everything is flags/env vars
- NO tests — hackathon speed, verify by running

---

## Verification Strategy

> **ZERO TESTS** — Hackathon mode. Verify by running the actual CLI.

### QA Policy
Every task verified by actually running the command and checking Notion.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — start immediately):
├── Task 1: Project scaffold + CLI framework [quick]
├── Task 2: Notion API client module [quick]
├── Task 3: Agent spawner module [quick]
└── Task 4: AGENTS.md template for spawned agents [writing]

Wave 2 (Core logic — after Wave 1):
├── Task 5: Orchestrator (wire trigger→agent→result→Notion) [deep]
├── Task 6: Webhook listener + @mention detection (PRIMARY FEATURE) [deep]
└── Task 7: CLI commands (listen, run, start, setup) [quick]

Wave 3 (Integration + Demo):
├── Task 8: End-to-end integration test (ngrok + real Notion + real agent) [deep]
└── Task 9: Demo prep (Notion template, sample repo, README) [quick]
```

### Dependency Matrix
- **1**: None — start immediately
- **2**: None — start immediately
- **3**: None — start immediately
- **4**: None — can start anytime
- **5**: Depends on 2, 3
- **6**: Depends on 2 (needs Notion client for comment parsing)
- **7**: Depends on 1, 5, 6
- **8**: Depends on 7
- **9**: Depends on 8

### Agent Dispatch Summary
- **Wave 1**: 4 tasks → T1 `quick`, T2 `quick`, T3 `quick`, T4 `writing`
- **Wave 2**: 3 tasks → T5 `deep`, T6 `deep`, T7 `quick`
- **Wave 3**: 2 tasks → T8 `deep`, T9 `quick`

---

## TODOs

- [x] 1. Project Scaffold + CLI Framework

  **What to do**:
  - `bun init` in the notioncode directory
  - Install deps: `commander` (CLI framework), `@notionhq/client` (Notion SDK), `dotenv`
  - Create `src/index.ts` as entry point with commander setup
  - Add commands: `run`, `start <page_id>`, `setup`, `serve`
  - Add `bin` field to package.json so `notioncode` works as a command
  - Create `.env.example` with: NOTION_TOKEN, NOTION_DATABASE_ID, ANTHROPIC_API_KEY, TARGET_REPO_PATH

  **Must NOT do**: No interactive setup wizard. Just env vars.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**: Wave 1 — can start immediately. Blocks: Task 5.

  **References**:
  - `notion_listener.py` lines 14-20 — config pattern to replicate in TypeScript
  - ticket-to-pr uses commander + @notionhq/client — same stack

  **Acceptance Criteria**:
  - `bun run src/index.ts --help` shows commands
  - `bun run src/index.ts run` prints "not implemented yet" (stub)

  **Commit**: YES — `feat: scaffold notioncode CLI with bun + commander`

- [x] 2. Notion API Client Module

  **What to do**:
  - Create `src/notion.ts`
  - `listTickets(status?: string)` — query database, filter by status, return array of {id, title, description, status}
  - `getTicket(pageId)` — fetch single page properties, flatten them (same logic as `flatten_properties` in notion_listener.py lines 145-170)
  - `updateStatus(pageId, status)` — update the Status property (handle both "status" and "select" types, see notion_listener.py lines 126-142)
  - `postComment(pageId, text)` — post a comment on the page
  - `updateProperty(pageId, propName, value)` — write a rich_text property (for PR link)
  - Handle rate limiting: simple retry with 1s delay on 429
  - Rich text content capped at 2000 chars (Notion API limit)

  **Must NOT do**: No webhook handling. No polling. Just CRUD operations.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**: Wave 1 — can start immediately. Blocks: Task 4.

  **References**:
  - `notion_listener.py` lines 126-170 — get_status and flatten_properties logic to port to TypeScript
  - `notion_listener.py` lines 202-229 — update_page_with_result pattern
  - @notionhq/client SDK docs: https://github.com/makenotion/notion-sdk-js

  **Acceptance Criteria**:
  - `listTickets()` returns real tickets from a Notion database
  - `updateStatus(id, "In progress")` changes the card status in Notion
  - `postComment(id, "Agent started")` appears as a comment on the card

  **Commit**: YES — `feat(notion): add Notion API client module`

- [x] 3. Agent Spawner Module

  **What to do**:
  - Create `src/agent.ts`
  - `spawnAgent(config)` where config = { prompt, workDir, apiKey, baseUrl? }
  - Spawn `claude -p "prompt"` as a child process (or `opencode run "prompt"` based on config)
  - Capture stdout/stderr
  - Return: { exitCode, stdout, stderr, duration }
  - Support cancellation via AbortController
  - If baseUrl is provided, set ANTHROPIC_BASE_URL env var (for Antigravity-Manager proxy)
  - Agent prompt template: inject ticket title + description + instructions

  **Must NOT do**: No agent SDK. Just subprocess spawn. Keep it dead simple.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**: Wave 1 — can start immediately. Blocks: Task 4.

  **References**:
  - `notion_listener.py` lines 173-200 — launch_opencode pattern to port
  - ticket-to-pr uses @anthropic-ai/claude-agent-sdk but we use simpler subprocess approach

  **Acceptance Criteria**:
  - `spawnAgent({ prompt: "echo hello", workDir: "/tmp" })` runs and returns output
  - Process can be cancelled mid-run

  **Commit**: YES — `feat(agent): add agent spawner module`

- [x] 4. Orchestrator — Wire Trigger → Agent → Notion

  **What to do**:
  - Create `src/orchestrator.ts`
  - `processTicket(pageId)`:
    1. Fetch ticket details via Notion client
    2. Update status to "In progress" + post comment "Agent started working"
    3. Build agent prompt from ticket title + description + AGENTS.md template
    4. Spawn agent in the target repo directory
    5. On success: extract PR URL from stdout, update Notion (status="Done", post PR link)
    6. On failure: update Notion (status="Failed", post error comment)
  - `processAllTickets()`:
    1. List all tickets with status "Not started"
    2. Process each one sequentially (not parallel — stay under rate limits)
    3. Log progress to console
  - PR detection: parse agent stdout for GitHub PR URLs (regex: `https://github.com/.+/pull/\d+`)

  **Must NOT do**: No parallel agent execution (rate limits). No retry on failure. No fancy queue.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**: Wave 2 — depends on Tasks 2 and 3. Blocks: Task 5, 7.

  **References**:
  - `notion_listener.py` lines 302-362 — process_page function is the same concept
  - ticket-to-pr's executeAgent function: spawns agent, captures output, writes back

  **Acceptance Criteria**:
  - `processTicket(pageId)` takes a real ticket through the full lifecycle
  - Notion card ends up at "Done" or "Failed" with appropriate info
  - PR URL extracted and posted to card (if agent creates one)

  **Commit**: YES — `feat(orchestrator): wire trigger→agent→notion pipeline`

- [x] 5. Orchestrator — Wire Trigger → Agent → Notion

  **What to do**:
  - Create `src/orchestrator.ts`
  - `processTicket(pageId)`:
    1. Fetch ticket details via Notion client
    2. Update status to "In progress" + post comment "Agent started working"
    3. Build agent prompt from ticket title + description + AGENTS.md template
    4. Spawn agent in the target repo directory
    5. On success: extract PR URL from stdout, update Notion (status="Done", post PR link)
    6. On failure: update Notion (status="Failed", post error comment)
  - `processAllTickets()`:
    1. List all tickets with status "Not started"
    2. Process each one sequentially
    3. Log progress to console
  - PR detection: parse agent stdout for GitHub PR URLs (regex: `https://github.com/.+/pull/\d+`)

  **Must NOT do**: No parallel agent execution. No retry on failure. No fancy queue.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**: Wave 2 — depends on Tasks 2 and 3. Blocks: Task 7.

  **References**:
  - `notion_listener.py` lines 302-362 — process_page function is the same concept

  **Acceptance Criteria**:
  - `processTicket(pageId)` takes a real ticket through the full lifecycle
  - Notion card ends up at "Done" or "Failed" with appropriate info

  **Commit**: YES — `feat(orchestrator): wire trigger→agent→notion pipeline`

- [x] 6. Listen Server + Auto Link Generation (PRIMARY FEATURE)

  **What to do**:
  - Create `src/listener.ts`
  - Express HTTP server on configurable port (default 3210)
  - **On startup**:
    1. Connect to Notion database
    2. Check if "NotionCode Link" column exists (type: `url`)
    3. If not → create it via `databases.update()` with `url` property type
    4. Query all tickets → for any ticket missing a link, write `http://localhost:3210/start?page={PAGE_ID}`
    5. Start background poll (every 5 seconds): find tickets without links, fill them in
    6. Print: "Ready! Click any 'NotionCode Link' in your Notion board to start an agent."
  - **Endpoints**:
    - `GET /start?page=PAGE_ID` — THE trigger. User clicks link in Notion → browser hits this → CLI calls `processTicket(pageId)` in background → returns HTML page saying "Agent started for [ticket title]! You can close this tab."
    - `GET /status` — returns active/completed runs as JSON
    - `GET /health` — returns OK + uptime
  - **Link polling loop** (every 3 seconds):
    1. Query database for tickets where "NotionCode Link" is empty
    2. For each: write `http://localhost:3210/start?page={PAGE_ID}`
    3. This ensures new tickets get links within 3 seconds of creation
    4. Uses 0.33 req/s of the 3 req/s budget — leaves 2.67 req/s for agent operations
  - **Future: webhook auto-trigger** (Kien is getting public integration approved):
    - If webhook subscription exists → get instant `comment.created` / `page.properties_updated` notifications
    - If not → graceful fallback to 3-second polling (what we build now)
    - OAuth-based public integration would let users install with one click and auto-configure webhooks
  - NOTE: Notion API cannot create formula columns programmatically, so we use a `url` column and write links. For zero-polling, user can manually add a formula column instead: `"http://localhost:3210/start?page=" + replaceAll(id(), "-", "")`

  **Must NOT do**: No SSL. No ngrok. Localhost only. No formula columns via API (not supported). Webhook is a future enhancement, not hackathon scope.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**: Wave 2 — depends on Task 2 (needs Notion client). Can run parallel with Task 5.

  **References**:
  - Notion API: `databases.update()` can create `url` type properties but NOT `formula` type
  - `notion_listener.py` lines 33-63 — ensure_notion_code_column pattern (creates column if missing)
  - Rate limit: 5s poll = 12 calls/min, well under 3 req/s limit

  **Acceptance Criteria**:
  - Server starts on port 3210
  - "NotionCode Link" column auto-created in Notion database
  - Every existing ticket gets a link automatically
  - New tickets get links within 5 seconds
  - Clicking a link in Notion triggers the agent for that ticket

  **Commit**: YES — `feat(listener): HTTP trigger server + auto link generation`

- [x] 7. CLI Commands — listen, run, start, setup

  **What to do**:
  - Wire commander commands:
    - `notioncode listen` → starts webhook listener server (PRIMARY command)
    - `notioncode run` → calls `processAllTickets()` (manual fallback)
    - `notioncode start <page_id>` → calls `processTicket(pageId)` (manual fallback)
    - `notioncode setup` → validates env vars, tests Notion connection, prints ngrok instructions
    - `notioncode list` → lists all tickets with status
  - Load config from .env file via dotenv
  - Pretty console output with status indicators
  - `listen` mode prints: "Listening for @NotionCode mentions... (press Ctrl+C to stop)"

  **Must NOT do**: No interactive prompts. No TUI.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**: Wave 2 — depends on Tasks 1, 5, 6. Blocks: Task 8.

  **Acceptance Criteria**:
  - `notioncode listen` starts the webhook server
  - `notioncode run` processes tickets end-to-end
  - `notioncode setup` prints connection status + ngrok instructions

  **Commit**: YES — `feat(cli): add listen, run, start, setup, list commands`

- [ ] 8. End-to-End Integration (ngrok + real Notion + real agent)

  **What to do**:
  - Set up ngrok: `ngrok http 3210`
  - Register webhook in Notion integration settings (point to ngrok URL)
  - Subscribe to `comment.created` events
  - Create a real Notion database with 5 columns
  - Create a test ticket: "Add a hello world endpoint"
  - Comment "@NotionCode start" on the ticket
  - Verify: webhook fires → agent spawns → PR created → Notion updated
  - Fix any bugs found
  - Test error path: impossible ticket → "Failed" status
  - Test manual fallback: `notioncode run` still works

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**: Wave 3 — depends on Task 7.

  **Acceptance Criteria**:
  - "@NotionCode start" comment → agent works → PR created → card updated (full loop)
  - Manual `notioncode run` also works as fallback
  - Error tickets marked as Failed

  **Commit**: YES — `fix: integration fixes from e2e testing`

- [ ] 9. Demo Prep — Notion Template, README, Demo Script

  **What to do**:
  - Create a Notion database template (5 columns: Name, Status, Description, Priority, PR Link)
  - Write README.md with: what it does, setup instructions, demo GIF placeholder
  - Create 3 sample tickets for the demo:
    1. "Add a /health endpoint" (easy — guaranteed win)
    2. "Fix the login validation bug" (medium)
    3. "Add dark mode toggle" (visual — impressive for judges)
  - Write a demo script (what to show, what to say, timing)
  - Ensure `notioncode setup` gives a clean "ready to go" output

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**: Wave 3 — depends on Task 7.

  **Acceptance Criteria**:
  - README exists with clear setup instructions
  - 3 sample tickets ready in Notion
  - Demo script written and rehearsed

  **Commit**: YES — `chore: demo prep, README, Notion template`

---

## Final Verification Wave

- [ ] F1. **Webhook flow**: Comment "@NotionCode start" on Notion ticket → verify agent kicks off within 10s → PR created → card updated to Done
- [ ] F2. **Manual fallback**: Run `notioncode run` → verify it processes "Not started" tickets without webhooks
- [ ] F3. **Error path**: Create impossible ticket → "@NotionCode start" → verify card goes to "Failed" with error info

---

## Commit Strategy

- **1**: `feat: scaffold notioncode CLI with bun + commander` — package.json, src/index.ts, src/cli.ts
- **2**: `feat(notion): add Notion API client` — src/notion.ts
- **3**: `feat(agent): add agent spawner module` — src/agent.ts
- **4**: `feat: add AGENTS.md template for spawned agents` — templates/AGENTS.md
- **5**: `feat(orchestrator): wire trigger→agent→notion pipeline` — src/orchestrator.ts
- **6**: `feat(listener): webhook server + @mention detection` — src/listener.ts
- **7**: `feat(cli): add listen, run, start, setup, list commands` — src/cli.ts
- **8**: `fix: integration fixes from e2e testing` — various
- **9**: `chore: demo prep, README, Notion template` — README.md

---

## Success Criteria

### Verification Commands
```bash
# Setup
export NOTION_TOKEN=ntn_xxx
export NOTION_DATABASE_ID=xxx
export ANTHROPIC_API_KEY=sk-xxx
export TARGET_REPO_PATH=/path/to/repo

# Primary: listen mode (webhook-triggered)
notioncode listen       # Starts webhook server on :3210
# Then in another terminal:
ngrok http 3210         # Exposes to internet
# Add ngrok URL to Notion integration webhook settings
# Comment "@NotionCode start" on a ticket → agent kicks off

# Fallback: manual mode
notioncode run          # Processes all "Not started" tickets
notioncode start <id>   # Processes single ticket
```

### Final Checklist
- [ ] `notioncode listen` receives webhooks and triggers agents on @mention
- [ ] "@NotionCode start" comment → agent works → PR created → Notion card updated
- [ ] `notioncode run` works as manual fallback
- [ ] PR link appears on Notion card
- [ ] Works with plain API key (no Antigravity-Manager dependency)
- [ ] Failing tickets marked as "Failed" with error info
