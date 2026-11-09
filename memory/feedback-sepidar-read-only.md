---
name: feedback-sepidar-read-only
description: Sepidar ERP database must never be modified — read-only queries only
type: feedback
---

Never run INSERT/UPDATE/DELETE/DDL against the Sepidar SQL Server database.
Only SELECT queries.

**Why:** Sepidar is the company's live accounting/ERP system; the operator explicitly
does not want any changes made to it.

**How to apply:** Applies to the sqlserver MCP connector and to any code in this app
(e.g. the /api/sync/* and /api/bom/sync-from-sepidar paths) — keep Sepidar access read-only.
