# Notion database template

Use these 5 columns in the demo database:

| Column | Type | Purpose |
| --- | --- | --- |
| Name | Title | Ticket title |
| Status | Status | Track Not started, In progress, Done, Failed |
| Description | Text | Ticket details for the agent |
| Priority | Select | Demo priority label |
| PR Link | Rich text | Link back to the finished pull request |

## Setup steps

1. Create a new Notion database.
2. Add the 5 columns above.
3. Make sure `Status` includes the values `Not started`, `In progress`, `Done`, and `Failed`.
4. Put the database ID into `NOTION_DATABASE_ID`.
5. Add the integration token to `NOTION_TOKEN` and share the database with that integration.
6. Start the listener with `bun run src/index.ts listen`.
7. Use `bun run src/index.ts setup` to confirm the CLI can see the database.

## Notes

- The listener also manages the `NotionCode Link` URL property at runtime.
- The README and demo script assume the current `/webhook` path.
