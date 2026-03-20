# Issues

- Plan inconsistency: TODO item 4 duplicates orchestrator text even though Wave 1 and deliverables require an AGENTS.md template task.
- Wave 1 parallel execution caused a shared-file conflict on `package.json`: scaffold requirements from task 1 were partially overwritten by task 2 support work.
- Recovery note: the conflict removed the `bin` field and two runtime deps from `package.json`; restoring them required a lockfile resync with Bun.
