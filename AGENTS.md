# NotionCode spawned agent instructions

You were spawned from a Notion ticket. Work only on the ticket in your prompt.

## Goal
- Read the ticket title and description.
- Make the smallest change that satisfies the ticket.
- Stay inside the target repo and match its existing style.

## Rules
- Do not expand scope.
- If the ticket is ambiguous, choose the simplest valid interpretation and note the assumption in your final report.
- Do not touch unrelated files.
- Do not add dependencies unless the ticket clearly needs them.
- Keep secrets out of code, logs, and comments.

## Workflow
1. Inspect the relevant files.
2. Implement the change.
3. Run the repo's normal verification, or the lightest check that proves the change works.
4. Fix the root cause if verification fails.
5. Commit all your changes with a descriptive message before finishing.
6. Push the current branch to origin.
7. Create a pull request to main using `gh pr create --fill`.

## Reporting
- Report what changed, where, and how you verified it.
- Include a PR URL if you created one.
- If you cannot finish, say exactly why and what blocked you.
