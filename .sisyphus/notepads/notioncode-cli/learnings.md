# Learnings

- `src/agent.ts` can stay self-contained with `node:child_process`; Bun 1.3.5 ran the module directly and captured both stdout and stderr from a fake `claude` executable.
- AbortController cancellation works cleanly by listening for `signal.abort` and terminating the child process; the focused runtime check returned `exitCode: null` on abort.

- Bun init creates a root `index.ts`, `package.json`, `tsconfig.json`, and `bun.lock`; for this scaffold I redirected the CLI entry to `src/index.ts` and kept the generated lockfile.
- Commander works cleanly with Bun via a plain `src/index.ts` entrypoint and a `bin` map in `package.json`.

- Root-level `AGENTS.md` is the simplest placement for spawned agents because downstream tooling can read it without extra path handling.
- Keep the template short and ticket-focused so subprocess agents stay inside scope and report back clearly.
- `src/notion.ts` uses a single 1s retry on 429 responses, which is enough for the CRUD-only client surface in this task.
- Live Notion verification needs both `NOTION_TOKEN` and `NOTION_DATABASE_ID`; `listTickets()` cannot run without the database id.
- Rich text writes are capped at 2000 chars by trimming to the latest content with a leading ellipsis, matching the Python reference.
- For the scaffold, `package.json` needs the `bin` map plus the three declared runtime deps, and `bun install` keeps `bun.lock` as the minimal generated support file.
- The installed Notion SDK exposes database queries through `dataSources.query()`, while `databases.retrieve()` may return a partial response that needs a `"data_sources" in database` guard.
- Lazy client creation avoids import-time crashes, so unrelated CLI commands can import `src/notion.ts` without `NOTION_TOKEN` being set yet.
- `src/orchestrator.ts` can safely read the root `AGENTS.md` at runtime via `new URL("../AGENTS.md", import.meta.url)`, which keeps prompt template lookup stable regardless of the caller's current working directory.
- Sequential `for ... await` ticket processing keeps agent execution strictly one-at-a-time while still allowing simple per-ticket console progress output.
- `src/listener.ts` can ensure `NotionCode Link` as a URL property by checking the resolved data source schema first, then writing only to pages returned by an `is_empty` URL filter.
- `/start` can return HTML immediately and still trigger work by tracking runs in memory (`activeRuns` + capped `completedRuns`) while `processTicket(pageId)` executes in a detached async flow.
- Listener run tracking depends on `processTicket(pageId)` rethrowing after it writes `Failed` to Notion; swallowing errors makes `/status` misreport failures as completed.
- `processAllTickets()` should catch per-ticket failures around `await processTicket(...)` so sequential execution continues across the remaining backlog.
- Commander async actions work cleanly with `await program.parseAsync()`, which keeps the CLI help flow and the real handlers aligned.
- `setup` can validate env vars first and then use `listTickets()` as a live Notion connectivity probe, which surfaces auth/database issues without adding extra commands.
- The `list` command can stay thin by printing status labels directly from `listTickets()` results, so the CLI stays readable and hackathon-simple.
- A single `resolveAgentExecution()` helper in `src/agent.ts` keeps fallback order (`OPENAI_API_KEY` → `ANTHROPIC_API_KEY` → `GEMINI_API_KEY`), explicit overrides, and runner compatibility in one place so CLI/setup/orchestration cannot drift.
- When multiple provider keys exist locally, the child process should receive only the selected provider key (and matching base URL env if present); leaving all keys in the spawned env makes provider selection ambiguous for downstream runners.
- The installed `@notionhq/client` retries some 429 responses internally before wrapper code sees the failure, so stable retry instrumentation needs the SDK `logger` hook as well as local `withRetry(...)` logging.
- A focused live-flow harness can prove the new logs without adding repo tests: fake `opencode`, mocked Notion HTTP responses, real listener startup, one successful `/start`, one failing `/start`, and a `/status` wait are enough to cover the debugging path.
- Notion `comment.created` webhook payloads are sufficient to bootstrap a trigger with `entity.id` (comment ID) and `data.page_id`; fetching `comments.retrieve(comment_id)` is a reliable way to read plain-text comment content for `@NotionCode start` detection.
- For local/hackathon webhook setup, handling one-time `verification_token` payloads and logging webhook decisions is enough; signature verification remains optional per Notion docs and can be deferred.
- Reusing listener in-memory run tracking for webhook starts works cleanly when deduping by page ID (`activeRuns`) so duplicate webhook deliveries do not double-start active work.
- For this live integration blocker, forcing `OPENCODE_PERMISSION=allow` in `spawnAgent()` for `runner="opencode"` is enough to make the non-interactive permission mode explicit at child-process level.
- A focused fake-binary spawn check confirms the env split: `opencode` child saw `opencode permission=allow`, while `claude` child saw empty permission and agent logs reported `nonInteractivePermission="n/a"`.
- Child-only `OPENCODE_CONFIG_CONTENT` injection works for delegation control: a minimal JSON payload with `permission.task="deny"` and `permission.call_omo_agent="deny"` reached the spawned `opencode` process exactly as expected.
- Keeping delegation restrictions in the `runner === "opencode"` path avoids unnecessary config/env changes for `claude` runs while still making restriction state visible through concise spawn logs.
- `README.md` should reflect the real listener surface, which now includes `POST /webhook`, `GET /start`, `GET /status`, and `GET /health`, plus the manual `run` and `start` fallback commands.
- Demo prep docs are better as separate markdown files under `docs/`, because the template, ticket seed content, and script each have a different audience.
- The sample ticket doc should stay paste-ready for Notion since this shell session cannot create the demo cards in a live workspace.
- `OPENCODE_PERMISSION` must be passed as inline JSON for OpenCode child boots; JSON-stringifying `"allow"` avoids the bootstrap parse crash while keeping `task` and `call_omo_agent` denied via `OPENCODE_CONFIG_CONTENT`.
