# Migrations

`schema.sql` creates a brand-new database. When you later change the schema, add a file here named
`NNN_description.sql` (for example `002_add_asset_table.sql`), where NNN is the next number after the current
`SCHEMA_VERSION` in `src/server/db.ts`. On start-up the server applies every file newer than the database's
`PRAGMA user_version`, in order, each in its own transaction, then records the new version.

Also bump `SCHEMA_VERSION` in `db.ts` and update `schema.sql` so fresh installs match.
