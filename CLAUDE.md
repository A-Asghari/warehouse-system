# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For the deployment picture (ports, shadow trial, external systems, what is not in git, rebuilding on a new server) see `ARCHITECTURE.md`.

## Commands

```powershell
npm start            # = node server.js — serves API + SPA on 0.0.0.0:3000 (override with $env:PORT)
node server.js       # same thing
.\warehouse-menu.bat # interactive menu: clear docs / npm start / node server.js
```

There is no build step, no linter, and no test suite — `npm start` is the whole dev loop. The UI is a
single static file, so a change to `public/index.html` only needs a browser refresh; a change to
`server.js` needs a restart.

**Testing against a live server has side effects.** Creating an `output` doc sends a real Output
Messenger message (`notifyOutputMessengerForOutputDoc`) and Web Push notifications
(`sendPushToUsernames`), and `rearmAutoBackup()` may start a backup timer. To exercise endpoints
safely, copy `server.js`/`db.json`/`package.json`/`public` to a scratch dir, stub those two functions
to `return;`, and run the copy with `NODE_PATH=<repo>/node_modules PORT=3999`.

Maintenance scripts (all operate directly on `db.json`, all destructive, no confirmation prompt —
back up `db.json` first):

| Script | Effect |
| --- | --- |
| `node clear-docs-only.js` | wipes `docs`, `transactions`, `initialInventory`, all `inventory`; resets `seq`. Keeps items/users/products |
| `node clear.js` | same as above, quieter output |
| `node clear-db.js` | the above **plus** wipes `productDefinitions`; recreates `db.json` from defaults if missing |
| `node fix-db.js` / `node fix-db-direct.js` | inject dummy test products into `productDefinitions` (dev fixtures only) |

`node clear.js.txt` is a stray scratch file; `public/images/index.html` and
`public/images/New folder/` are **stale older copies of the whole app** — only `public/index.html`
(desktop) and `public/mobile/` (mobile PWA) are live. Don't edit the copies.

`start.bat` launches a *separate deployed copy* at `C:\Program Files (x86)\WarehouseSystem` (that
install is what wrote `Logs/`), not this working directory.

## Architecture

Three files hold essentially all the code: `server.js` (~5700 lines, Express API + JSON persistence),
`public/index.html` (~10000 lines: markup, inline `<style>`, and the entire desktop client in one
inline `<script>` starting around line 1435), and `public/mobile/index.html` (a smaller mobile PWA
with its own `sw.js`/manifest that calls the same API). CommonJS, no bundler, no framework. UI,
identifiers, messages, and code comments are Persian/RTL — keep new comments and user-facing strings
in Persian to match.

### Persistence: whole-file JSON with module-level globals

`db.json` (~880KB) is the database. `server.js` holds the parsed contents in module-level mutable
globals (`items`, `users`, `inventory`, `transactions`, `docs`, `productDefinitions`,
`materialClassification`, `bomFormulas`, `productionOrders`, `appSettings`, `activityLog`,
`pushSubscriptions`, `seqId`, `docSeq`, `batchCounter`, `orderSeq`). The contract every handler follows:

1. `loadData()` at the top — re-reads `db.json` and rebinds every global (via `applyLoadedData()`,
   which backup-restore also uses).
2. mutate the globals.
3. `saveData()` — copies the globals back into `data` and rewrites the whole file.

Skipping step 1 works against stale globals; skipping step 3 silently discards the change. `writeDB()`
is atomic (temp file + fsync + rename) and keeps `db.json.prev`; `readDB()` falls back to it if
`db.json` is corrupt. Single process, no locking; assume one writer. `loadData()` skips re-parsing
when the file's mtime+size stamp is unchanged.

`saveData()` only persists the keys it explicitly assigns — a new top-level field must be added to
`getDefaultData()`, `applyLoadedData()`, **and** `saveData()` or it will not survive a restart.
Settings (Sepidar connection, port, backup, role permissions, Output Messenger, warehouse gate, VAPID
keys) live under `appSettings`, not in source.

### Item identity (کدِ موجودی) — the rule every stock feature must follow

`inventory` is `{ [deptId]: { [itemKey]: qty } }`, and `transactions`/`docs` reference items by the
same key («کدِ موجودی»). Raw materials use their Sepidar item code (e.g. `333000001`). Each
production stage has its **own** key for its product, always `productDefinitions[dept][i].code`:

| Stage | Stock key (`code`) | Display name | Source |
| --- | --- | --- | --- |
| برش `cut` | `CUT-{matCode}-{lengthCm}` | `{مادّه} - {طول} سانت` | auto (rebuild) |
| لحیم `solder` | `SOL-{Sepidar code}` | `{نام سپیدار} (لحیم‌شده)` | auto (rebuild) |
| تزریق `inject` | `INJ-{Sepidar code}` | `{نام سپیدار} (تزریق‌شده)` | auto (rebuild) |
| لیزر `laser` | `LASER-{Sepidar code}-{brand}` | `{نام سپیدار} - {برند}` | created at first production (brand chosen in the form) |
| بسته‌بندی `pack` | `PACK-{Sepidar code}-{laser brand}-{pack brand}` | `{نام سپیدار} - {برند}` or `… - {برند} (پک {برند پک})` | created at first production (pack brand chosen, defaults to the laser brand) |

Rules (decided with the owner on 1405/07/26 — do not change without asking):

- **The stock key is `code`, never `productCode`.** `productCode` is the Sepidar item code, kept on
  every stage definition only for display (`getRealProductCode()` → «کد اصلی») and for comparing
  with Sepidar (`sepidarCodeOfKey()`, used by `/api/sepidar/reconcile` to sum e.g. A2 and ANKER packs
  of one Sepidar item). Before this rule, `resolveInventoryKey()` preferred `productCode`, so solder,
  inject and both laser brands collapsed onto one key.
- **One stage product per Sepidar code, not per formula.** 65 Sepidar items have 2+ active formulas
  (domestic vs imported cable). They share `SOL-/INJ-/LASER-/PACK-{code}`; the definition lists them
  in `formulaKeys`. The formula is chosen per production (`?formula=` on suggest; otherwise the server
  picks the first formula whose materials are in stock in that dept) and saved on the doc as
  `formulaKey` (statistics only; stock does not depend on it).
- **Brand survives to the finished warehouse.** A2 and ANKER are one item in Sepidar but two keys
  here. Packs take their brand from the laser product they are made from.
- **Brand / pack type are chosen at production, not predefined.** Lists live in
  `appSettings.brands` / `appSettings.packTypes` (`/api/settings/brands`, admin; an entry already used
  by a definition cannot be removed). Laser form: pick an `INJ-` item in laser stock + brand; pack form:
  pick a `LASER-` item in pack stock + «برند پک» (from `brands` — plus legacy `packTypes` — via `packBrandList()`; the form preselects the laser item's brand, the user changes it only for the exceptional case of another brand's packaging). Packaging materials are editable by pack staff (✕ / add row); the `LASER-` input row stays locked (`MATERIAL_EDIT_DEPTS`). Until first produced the code is *virtual*
  (`virtualStageDef()`); suggest and the stale-tab guard accept it; `materializeStageDef()` adds the
  definition at the start of `/api/doc/production*`. `migrateBrandOnDemand()` (flag
  `appSettings.brandOnDemand`) seeded the lists and deleted every laser/pack definition with no stock,
  doc, transaction or other reference. There is no product-definition tab anymore (removed with
  `POST /api/products/copy`); `POST /api/data` returns 410.
- **Cable colour is part of the stock key** (decided 1405/07/27). Chosen only in the cut production
  form (`appSettings.colors`, default `سفید`, editable with brands in Settings); every later stage
  inherits it from its input. Coloured key = normal key + `@` + colour slug
  (`CUT-…-97@مشکی`, `SOL-…@طوسی`, `PACK-…-A2-سفارشی@مشکی`). **White has no suffix**, so every key
  that existed before colours is white. Coloured definitions are never stored: `findDefByCode()` /
  `stageDefFor()` build them from the base definition (`colorizeDef()`, name + « - {رنگ}»), so a BOM
  rebuild cannot lose them. Suggest takes the coloured code, returns chain inputs in the same colour
  and `colorAvailability`; `colorProblem()` rejects unknown colours and a stage input whose colour
  differs from the product. Helpers `splitColor/withColor/colorOfKey` (server), `splitColorKey/
  withColorKey/colorOfKeyClient/baseKey` (desktop) and the mobile twins must stay identical. A colour
  used by any stock/doc/transaction cannot be removed. Sepidar reconcile sums all colours.
- Code slugs (`codeSlug()` server / `stageCodeSlug()` client) must stay identical: Arabic ي/ك →
  Persian, leading «پک » dropped, spaces and `-` → `_`.
- Chain inputs come only from `/api/bom/suggest` (`materials[].code` is the exact stock key):
  solder ← `CUT-…`, inject ← `SOL-…`, laser ← `INJ-…`, pack ← `LASER-{code}-{same brand}`.
  Clients use `resolveMaterialCode()` / mobile `materialCode()`, which trust that code; the old
  name-based guessing is only a fallback.
- Stage keys allowed per dept (`STAGE_PREFIX_ALLOWED`, server + desktop + mobile): own product + the
  immediately previous stage only (laser ← INJ, never SOL). Enforced on initial inventory (single, batch,
  group edit) and `excess`; the initial-inventory and excess pick lists use the same rule.
  Because laser/pack products are created on demand, `initialCandidates()` also offers every
  «INJ product × brand» as `LASER-…` (laser, pack) and `PACK-…-{b}-{b}` (pack, finished); the server
  `materializeForStock()` creates the definition when such a code is registered (initial / excess).
- `getDeptTargetCodes()` (desktop) and its mobile twin decide what may be sent to a dept; keep both
  in sync with this table.
- `migrateStageCodesV2()` converted old definitions once (flag `appSettings.stageCodesV2`). It
  remaps old laser/pack codes everywhere, but only *reports* old bare solder/inject keys (ambiguous).
- `migrateItemRename()` still exists for legacy name-keyed raw entries. Use `resolveItemName()`
  (server) / `getItemName()` (client) for display.

### Documents vs transactions vs inventory

Three parallel structures that are kept consistent *by hand*, not derived from each other:

- `docs` — user-facing documents with a status lifecycle and `parentDocId` links.
- `transactions` — ledger rows (`production`, `consume`, `waste`, `shortage`, `excess`, `output`,
  `input`, `return`), created only when a document actually takes effect.
- `inventory` — a materialized running total, mutated directly by each endpoint.

Because inventory is not recomputed from transactions, every reversal path (`POST /api/doc/:id/cancel`,
`POST /api/doc/return/approve`) hand-reverses the arithmetic per transaction type and then deletes the
transaction rows. If you add a new document type, you must also add its reversal branch in the cancel
handler.

Status lifecycle:

- `production` / `consume` → created `approved`, inventory hits immediately.
- `waste` / `shortage` / `excess` → `approved` immediately **only if** the actor is an adjustment
  approver (`admin`/`supervisor`, `isAdjustmentApprover`); otherwise created `pending_approval` with
  no inventory effect → `POST /api/doc/pending-adjustment/approve|reject`.
- `output` → created `pending`, **or `pending_warehouse`** if the dept pair is in
  `appSettings.warehouseGate.pairs` (`isDeptPairGated`, keys are sorted `a|b` so both directions are
  gated). `pending_warehouse` → `POST /api/doc/output/warehouse-approve` (role `warehouse`/`admin`;
  sets `warehouseApprovedBy`, status back to `pending`, no stock move) or `warehouse-reject`
  (`rejected`). `pending` → `POST /api/doc/output/approve` by the receiving dept moves stock and writes
  the `output`+`input` transaction pair (`transactionId` / `transactionId2`) → `approved`.
  **Usable stock = stock − in-transit** (`availableQty()` / `pendingOutQty()` server,
  `usableQty()` client): outputs still `pending`/`pending_warehouse` are subtracted in every check that
  takes stock out (output create, consume, waste, shortage, production materials, pending approvals,
  Sepidar inbox), because the goods have physically left. Receiver approval checks raw stock only.
- "Return to previous unit" on the desktop is just a new ordinary `output` doc in the reverse
  direction. The older return flow (`POST /api/doc/output/request-return` → `return_pending` →
  `return/approve` sets `return_approved` and the parent `returned`, or `return/reject`) is still used
  by the mobile app.
- **Initial-inventory documents are grouped**: one list registration (`initial-batch`) = one document to the
  user, `groupId` = id of its first line (stored on every line doc and `initialInventory` row; older lines were
  grouped once by `migrateInitialGroups()`, flag `appSettings.initialGroupsV1`). The ledger is still one
  doc + transaction per item. `renderDocuments()` collapses a group into one row; «✏️ ویرایش» reopens the
  list form (`openInitialGroupEdit()`, `initialEditGroup`) and saves through
  `POST /api/doc/initial-group/:gid/edit` {rows,date} — all-or-nothing diff: changed qty, new lines, removed
  lines (cancelled); «↩️ لغو سند» = `POST /api/doc/initial-group/:gid/cancel`. Reductions beyond usable stock
  are refused. Sepidar-sync lines are shown as one read-only group per dept.
- `initial` docs can be edited (qty, date, note; not item/unit) via `POST /api/doc/initial/:id/edit`
  (admin or `sec-initial-inv` permission): the qty difference is applied to stock and mirrored to the
  `initialInventory` row and the transaction; a decrease beyond usable stock is refused; each edit is kept in
  `doc.editHistory`. Docs with `source: 'sepidar-sync'` are not editable (the next sync overwrites them).
- `DELETE /api/doc/:id` hard-removes `pending`/`pending_warehouse` docs only — including `pending`
  docs that already carry `warehouseApprovedBy`. It writes an `activityLog` entry (doc id, type, item,
  qty, route, status, warehouse approval, creator, deleting user from body `actorUsername`).
  Everything else is cancelled, never deleted.
- Cancelling a `production` (or an `output`) is refused only when the goods are really gone: there is a later
  output/consume of the item **and** usable stock (`availableQty`, i.e. minus pending/pending_warehouse outputs)
  in that dept is below the doc qty. Goods that came back with a reverse output can be cancelled. The final
  drain check also uses usable stock.
- Cancel refuses when `findChainForDoc()`/`findRelatedDocs()` find dependent downstream docs (matched
  on item + dept + `batchNumber`), and reports the chain to the user. Cancelling a `production` doc
  also cascades to the `consume` docs that point at it via `parentDocId`.

`createdBy` is the username for `output` docs (sent by the client) and for pending adjustments;
several other creators still hard-code `'سیستم'`. `renderDocuments()` shows sender-only buttons by
comparing `d.createdBy === currentUser.username`. Output docs also carry `createdAt` (ISO) and
`submissionId`.

"Production from materials" is one atomic request, `POST /api/doc/production-with-materials`
(production doc + one `consume` doc per material, all or nothing; both desktop and mobile use it).
Multi-row output (`registerOutput()`) is still one POST per row.

Hidden behaviour: `index.html` wraps `window.fetch` (`installActorFetch`) and silently adds
`actorUsername` to every `/api/doc/*` request body. Server role checks rely on it.

### Double-submit protection

A 10-row output was once registered twice by a second click (docs 123–142). Two layers now guard
against this:

- **Client**: every function that calls `/api/doc/*` is a thin wrapper
  `withDocLock(key, btn, () => fooImpl(...))`. The key is fixed per form (`'output'`, `'production'`…)
  or `doc-{id}` for row buttons, and is taken synchronously before the first `await`, so a click queued
  behind a `confirm()` is dropped too. Buttons pass `this` so they are disabled while in flight. New
  doc actions should follow the same wrapper pattern.
- **Server**: `POST /api/doc/output` returns 409 if a non-rejected output with the same
  from/to/item/qty has a `createdAt` within `DUPLICATE_OUTPUT_WINDOW_MS` (10s), unless it has the same
  `submissionId`. That exemption exists because one submission may legitimately contain identical rows.
  The mobile app sends no `submissionId`, so it is always guarded.

### Stock count (انبارگردانی)

`POST /api/stock-counts/:id/entries` snapshots, per counted line, `expectedAtCount` = stock −
in-transit at the moment the count is saved. Finalize creates `excess`/`shortage` docs for
`counted − expectedAtCount` and applies that difference to the *current* stock, so movements between
counting and finalizing are not absorbed, and goods in transit are not booked as shortage. Finalize
refuses if a correction would make stock negative. Entries without a `counted` key only change the note.

### Dates

All doc/transaction dates are `YYYY/MM/DD` with Latin digits (`todayJalali()`, `normalizeJalaliDate()`;
a one-time pass `appSettings.datesNormalized` converted old `۱۴۰۵/۷/۲` values). Docs created from the
Sepidar inbox use the Sepidar document date (`sepidarDateToJalali()`, read in UTC because mssql returns
wall-clock time), falling back to today with the original date in the note if it is outside the
active fiscal year.

### Stale browser tabs

After the stage-code change, old open pages would send bare Sepidar codes. `staleStageProduct()` /
`staleStageMaterial()` reject such production/consume/output requests in solder…pack with
`STALE_CLIENT_ERROR` (asks the user to press Ctrl+F5).

### activityLog

`logActivity(username, action, details)` appends `{id, timestamp, username, action, details}`, keeps
the last 2000 entries, and **calls `saveData()` itself**. Ids continue from the max existing id; they
used to reset to 1 on every restart, so older entries have duplicate ids. Actions that go through the
bulk `POST /api/data` path (user/fiscal-year CRUD) are logged by the client via `POST /api/activity/log`.
Read it with `GET /api/activity-log?limit=`. Output-doc creation is not logged there. Use `docs` or
backups to reconstruct that.

### Backups

`createBackupFile()` writes the full `data` object to `backups/backup_<ISO>.json`, or to
`appSettings.backup.folder` if that is set, and prunes to `keepCount`. `rearmAutoBackup()` runs it
every `autoIntervalHours` when auto backup is enabled. `/api/backup/{create,list,download,restore,
settings}` expose it; every mutating backup endpoint requires an admin `actorUsername` (body or query).
Restore goes through `applyLoadedData()` + `saveData()` and always writes a safety backup of the current
state first; backup filenames never overwrite each other (`-2`, `-3` suffix). Ad-hoc manual copies
live in the repo root as `db.backup-*.json`.

### productionOrders (production forecast tab)

`POST /api/production-orders` creates a lightweight tracking record and an `orderBatchId`
(`startForecastOrder()` then POSTs a `cut` production doc). `orderBatchId` is optionally stored on
docs, but nothing in inventory, cancel, or chain logic depends on it. Stage progress is computed
client-side from item codes (`computeStageQtyForFormula`).

### Sepidar (SQL Server) integration

Read-only pulls from an external ERP. Connection defaults are `DEFAULT_SEPIDAR_CONFIG` in `server.js`
(plaintext credentials). The live config is in `appSettings.sepidar` and is editable via
`/api/settings/sepidar`. Views used:

- `INV.vwItemStockSummary` → inventory sync (`GET /api/sync/sepidar`). Hardcoded to the stock named
  `انبار توليد - مواد اوليه` and written **only into the `raw` dept**. Its `?year=` is Sepidar's
  `FiscalYearRef` (default `13`) — unrelated to the app's own `fiscalYears` (`'1405'`).
- `INV.vwItem` → item catalog sync (`GET /api/sync/sepidar-items`).
- `WKO.vwProductFormula` ⨝ `WKO.vwFormulaBomItem` → BOM sync (`POST /api/bom/sync-from-sepidar`).

### BOM → per-stage product definitions (the subtlest part of the system)

Sepidar supplies flat formulas with no notion of production stage. The system layers stages on top:

1. **Ingest** — `ingestBomRows()` is shared by the Excel upload (`POST /api/bom/upload`, Persian
   column headers, normalized for Arabic ك/ي and ZWNJ) and the direct SQL sync. Both **replace**
   `bomFormulas` wholesale. Formulas are keyed by `formulaKey`: the official Sepidar BOM code when
   present, otherwise a guessed `code`, `code-2`, `code-3`… per distinct product name. Every endpoint
   downstream (`/api/bom/:code`, `/api/bom/suggest/...`) looks formulas up by this key, so changing the
   keying scheme breaks BOM suggestions.
2. **Classify** — `materialClassification` maps a material code to one of `STAGE_DEPTS`
   (`cut`, `solder`, `inject`, `laser`, `pack`). This mapping exists only in this system and is
   maintained by hand via `/api/materials/classification`; unclassified materials show as `نامشخص`.
3. **Rebuild** — `rebuildProductDefinitionsFromBOM()` regenerates `cut`, `solder`, `inject` (see
   «Item identity» above for the code scheme) and only refreshes `formulaKeys`/`sepidarName` on the
   production-created `laser`/`pack` products (matched by `productCode`, so they survive formula
   changes in Sepidar).
4. **Suggest** — `GET /api/bom/suggest/:dept/:code[?qty=&formula=]` takes the stage product code
   (a formula key is still accepted for old clients) and returns `materials` (stage materials of the
   chosen formula + the chain input), `formulaKey`, `formulaOptions [{key,name,ready}]` and
   `productStockKey`. Changes to the code scheme must be mirrored here and in both clients.

**Formulas deactivated/removed in Sepidar.** Both BOM ingest paths call `replaceBomFormulas()`, which archives
any removed formula still referenced by a definition into `appSettings.archivedFormulas` (`getFormula()` reads
active then archived — use it instead of `bomFormulas[k]`). `rebuildProductDefinitionsFromBOM()` keeps an old
cut/solder/inject definition that is still needed (own stock or open doc via `stageCodeInUse()`, or — solder —
its CUT input, or — inject — its SOL input, still in the line) with `inactive: true`; laser/pack definitions with
no active formula get `inactive: true` too. Inactive cut products are hidden from new production; others are
labelled «غیرفعال در سپیدار». Once the leftover is gone, the next sync drops the definition and prunes the archive;
re-activating the formula in Sepidar clears the flag.

`POST /api/bom/clear-all` tears down formulas, classifications, the five stage product lists, and any
items tagged `groupName === 'مواد اولیه (فرمول سپیدار)'`.

### WIP raw-material report

`GET /api/reports/wip-materials` (tab «🧮 مواد اولیه‌ی در جریان» in sec-forecast) explodes every stock line of
cut…pack, qc and finished into raw materials: loose material = itself; `CUT-` = raw cable × length; a stage
product = all formula materials whose stage ≤ its stage (`WIP_STAGE_IDX`). Multi-formula products are split by
the share of `formulaKey` in their approved production docs (`wipFormulaWeights()`), else the first formula.
Unclassified materials are left out. The raw warehouse is included as its own column (loose stock).

### Notifications

Fire-and-forget, called after `res.json()` so they never block or fail a request:
`notifyOutputMessengerForOutputDoc()` (Output Messenger chat, config in `appSettings.outputMessenger`)
and `sendPushToUsernames()` (Web Push via `web-push`; VAPID keys auto-generated into
`appSettings.push` by `ensurePushKeys()`, subscriptions in `pushSubscriptions`). Targets are resolved
with `usersInDeptId()` / `usersWithRoles()`.

### Client app

- `API_URL = window.location.origin` (desktop) / `API` (mobile). The stale copy under
  `public/images/` still hardcodes `192.168.0.10`.
- The client mirrors server state into globals of the same names and into `localStorage`
  (`warehouseData`) as an offline fallback. `updateConnectionStatus()` drives the online/offline badge.
  Clients poll `GET /api/data-version` and refetch `/api/data` only when it changes.
- There is no client bulk save anymore (`saveData()` removed, `POST /api/data` → 410). Every change
  goes through a dedicated endpoint followed by `loadData()`; `productDefinitions` are server-owned
  (cut/solder/inject from BOM rebuild, laser/pack on first production). User edits go
  through `POST /api/users/:username/update` (admin only); «بازیابی از فایل» through
  `POST /api/backup/restore-upload` (admin only, takes a safety backup first, keys missing from the
  file keep their current values); «دریافت بکاپ به فایل» downloads the full `GET /api/data`.
- Navigation is `buildNav()` + `switchTab()` over `<section id="sec-*">` elements. Roles are `admin`,
  `supervisor`, `warehouse`, `user`. Admin sees everything; other roles see the sections listed in the
  editable `appSettings.rolePermissions` matrix (defaults in `DEFAULT_ROLE_PERMISSIONS`, checked with
  `canAccessSection()`). Role helpers `isPrivilegedRole()`, `isApproverRole()`, and
  `isWarehouseKeeperRole()` must match their server-side counterparts.
- `DEPTS` and `DEFAULT_USERS` are **duplicated** in `server.js`, `public/index.html`, and
  `clear-db.js`. Adding a department means editing all of them.
- Users are matched to a department by **name** (`currentUser.unit` → `DEPTS[].name` →
  `getUserDeptId()`), while documents and inventory use dept **ids**, so permission checks throughout
  compare against both forms.

### Security (since 1405/07/27)

- Login is server-side: `POST /api/auth/login` takes `Authorization: Basic` (not a body) and returns the token in
  the `X-Auth-Token` **header** (the shadow-trial tee stores request/response bodies, not headers). Sessions live
  in `sessions.json` next to db.json (30-day sliding TTL), so a restart does not log people out.
- Every `/api/*` route except `PUBLIC_API` needs `Authorization: Bearer <token>` (or `?token=` for download links,
  see `withToken()`). The auth middleware **overwrites** `actorUsername`, `createdBy` (and `username` on
  activity/login and push/subscribe) with the session user, so role checks are real now.
- Passwords are scrypt hashes (`passwordHash`, `s1$salt$hash`); plaintext `password` fields are hashed on load (also
  after restoring an old backup). `/api/data` and `/api/users` never send password fields; `sanitizedData()` also
  strips the Sepidar password, VAPID private key and Output Messenger secrets. Sepidar/OM settings GETs are admin-only.
- Clients: desktop `installActorFetch` adds the Bearer header to every `/api/` call and returns to the login page
  on 401; mobile `api()` does the same (`warehouseMobileToken` in localStorage).
- Cancel / reject / delete of a doc need `reason` (≥ 3 chars, `REASON_ROUTES` middleware): stored as
  `cancelReason` / in the note / in activityLog. Desktop asks with `askReason()`, mobile with `prompt`.
- Abnormal quantities (`abnormalQtyWarning`: > 10× the largest stock/doc qty ever seen for the item, or > 100000
  for a new item) on stock-increasing routes get 409 `needsConfirm`; both clients confirm and resend with
  `confirmLarge:true`.
- `GET /api/backup/preview/:filename` lists the docs a restore would lose; the restore dialogs show it.
- A one-time `purgeInertCancelledDocs()` (flag `purgeCancelledV1`) deleted cancelled docs with no transaction and no
  active child, archiving them to `backups/purged-cancelled-*.json`.
- CORS is still `*` and HTTP is still allowed; it's a LAN tool.

## Project memory

Structured memory lives in `memory/` (typed files: user, feedback, project, reference).
Follow the rules below for when to read and save, and keep `memory/MEMORY.md` updated.

@memory/RULES.md
@memory/MEMORY.md

## Documents view: inbox, detail, print (since 1405/07/27, desktop only)
- Chips above the documents list: «کارتابل من» (docs from getPendingDocsForCurrentUser — waiting for this user's action), «ثبت‌شده‌های من» (createdBy = me), «همه». Search box matches id/groupId, item code/name, note, batch, creator name. Sort: date desc, then id desc.
- renderDocuments caches each row in `docUiCache[key]` (`key` = id, or 'g'+groupId for initial groups) together with its action buttons; clicking the doc number calls `openDocDetail(key)`, a modal with header, lines (production + consume/waste children; output + same-submissionId siblings; initial group lines), timeline (created/warehouse/edits/approved/rejected/cancelled+reason), related docs (parent, same batch, returns) and the same actions.
- `printDocDetail(key)` opens an A5 print window with signature boxes (output/return: deliverer / warehouse keeper / receiver).

## Multi-row documents (phase 3, since 1405/07/27)
- Storage is unchanged: every line is still its own doc. Grouping happens only in the UI plus one atomic server endpoint.
- **Production + materials:** consume/waste docs with `parentDocId` → production are folded into the production row. Desktop `groupDocsForList(list, foldChildren)` folds them only when the type filter is «همه». Mobile `groupDocsM` always folds them.
  - The production row shows «+ n ردیف مصرف مواد», and the detail view lists the materials.
  - Approve/reject/delete/cancel of a production already cascades to its children on the server.
- **Multi-row output:** docs with the same `submissionId` and the same status (2+ lines) form one row/card: `isOutputGroup`, `lines`, uiKey 's'+firstId.
  - Group buttons call `POST /api/doc/batch`.
  - Returning a single line of an approved group is done per line from the detail view on desktop, or from the per-item buttons on mobile.
  - `printOutputGroupFromList(firstId)` prints all lines on one voucher.
- **`POST /api/doc/batch {action, docIds[], reason}`:**
  - Actions: output-approve, output-warehouse-approve, output-warehouse-reject*, production-approve, production-reject*, cancel*, delete*. Actions marked * need a reason (≥3 chars).
  - It calls the existing single-doc route handlers (captured in `ROUTE_HANDLERS` by wrapping `app.post/app.delete`) one by one, with all their permission and stock checks.
  - While `batchTx` is set, `saveData()` is a no-op and pushes are queued. On any failure, `dbForceReload=true; loadData()` discards all in-memory changes, so the result is all-or-nothing. Commit = one saveData plus one activity-log line.
  - Cancel/delete run from the last id to the first.

## Document numbers and returns (phase 4, since 1405/07/27)
- **`docNo`:** a per-type series per fiscal year, e.g. `H-1405-0007`.
  - Series: P production, H output, C consume, W waste, S shortage, E excess, R receipt (sepidar excess), I initial, B legacy return.
  - Assigned in `saveData()` → `assignDocNumbers()`. Counters live in `appSettings.docSerials` keyed `"1405|H"`.
  - Lines of one document share a number: consume/waste children get the production's number; one output `submissionId` and one initial `groupId` share a number; sepidar-sync initial docs share one number per unit and year.
  - A number is never reused or changed. The internal `id` stays the key everywhere; the UI shows `docNo` with a small `#id`, and search matches `docNo`.
- **One return path:** `POST /api/doc/output/request-return {docId}` is used by both desktop (`returnToPreviousUnit`) and mobile.
  - Only receiver-dept users or an admin can call it, and it is blocked when an active return already exists.
  - It calls the `/api/doc/output` handler for the reverse route with `returnOfDocId`, so it is a normal output with warehouse gate, shortage check and receiver approval.
  - The output handler keeps `returnOfDocId` only when it really is the reverse of an approved output with the same item.
  - The legacy `return` doc type (return_pending → return/approve|reject) remains only for old docs.

## Cancel by reversal + 4-state lifecycle (phase 5, since 1405/07/27)
- **Cancelling a doc that affected stock** (`/api/doc/:id/cancel`, `removeInitialLine` for initial groups) never deletes transactions.
  - `newReversal(doc, by, reason)` takes a number from series `V` (`appSettings.docSerials["1405|V"]`).
  - `reverseDocTransactions(doc, rv)` pushes, for each of `transactionId`/`transactionId2`, a copy with `qty = -qty`, the same type and date, plus `reversalOf`, `reversalDocId` and `reversalNo`. It applies the inverse stock effect and stores `doc.reversal = {no, at, by, reason, txIds}`.
  - A production and its consume/waste children share one V number; so do all lines of an initial group cancelled or edited in one request (`removeInitialLine.ctx`, reset per request).
  - Reports sum `t.qty` by type, so they net to zero automatically. History and item movement show these rows as «(لغو)».
  - Integrity treats `reversal.txIds` as linked (not orphans).
- **Pending cancel** (never touched stock): status cancelled + cancelledBy/At/reason, with no reversal.
- **Lifecycle shown in the UI** (`docLifecycle`):
  - open (any pending_*)
  - final (approved / return_approved)
  - rejected
  - void (cancelled)

  The status filter has these four groups, and the detail header shows the lifecycle plus the V number.
- The legacy `return/approve` path still splices the parent's transactions. It is only for old `return` docs; there are none live.

## Phase 6 (since 1405/07/27): lot tracking, in-transit, period close
- **Lots:** `buildLotLedger()` replays transactions in id order.
  - Inbound types (production/excess/receipt/initial) create a lot labelled by `lotLabelFor`: the batchNumber, «اول‌دوره {docNo}» for initial, or «انبارگردانی …».
  - Outbound types (consume/waste/shortage/output) take FIFO (oldest first). An output moves the same lots to `targetUnit`; the paired input tx is skipped.
  - Reversal txs restore exactly what the original moved.
  - At the end each unit|item is reconciled to the real inventory: a missing amount becomes lot «نامشخص», an excess trims the oldest lots.
  - `persistLotAllocations()` (in saveData) freezes `tx.lots=[{batch,qty}]` once for each new outbound tx, so later replays use the frozen split.
  - Genealogy: a consume tx carries the production's batchNumber, so production batch → consumed lots → their productions…
  - API:
    - `GET /api/lots/stock?unit&item`
    - `GET /api/lots/trace?batch` returns {origin, consumed (backward tree), usedIn (forward tree), now}.
  - UI:
    - «بچ» column in the doc detail
    - `openLotTrace(batch)` overlay
    - analysis tab «🔎 ردیابی بچ»
    - lots list in the item-movement popup
- **In-transit (light version):** the stock ledger is unchanged (stock stays with the sender until the receiver approves). The dept stock table (`renderDeptInventoryTable`) shows «در راه (ارسالی)», «موجود فیزیکی» (stock − pending outs) and «در راه (دریافتی)» when any exist (`transitQty`). Stock counts already use stock − pending outs.
- **Period close:** `appSettings.closedThrough` (YYYY/MM/DD), history in `appSettings.closeHistory`.
  - `closedProblem(date)` is enforced in `resolveDocDate` (all doc creation), stock count create/finalize, and sepidar inbox (a closed sepidar date falls back to today). The `/api/sync/sepidar` initial sync is refused while any period is closed.
  - A middleware on `/api/doc` blocks any POST/DELETE that touches an existing doc dated ≤ closedThrough (docId, docIds, /:id, initial/:id, initial-group/:gid). request-return is exempt because it creates a new doc today.
  - `GET/POST /api/period-close {action: close|reopen, through, reason}` is admin only. Close is refused while pending docs or open stock counts exist in the range. Reopen needs a reason (≥5 chars). UI: analysis tab «🔒 بستن دوره».

## Compact item names + two-step picker (since 1405/07/27, display only)
- **Parsing helpers:**
  - Desktop: `itemParts(code)` returns {groupKey, baseName, attrs:[{k:'برند'|'پک'|'رنگ'|'طول', v, c}], color}, parsed from the stage key (LASER/PACK brand and pack from def or slug, CUT length, colour suffix).
  - Mobile equivalents: `itemPartsM` and `chipsM`.
  - `baseName` = sepidarName (LASER/PACK), raw material name (CUT), or def name (SOL/INJ).
- **Item pickers:**
  - Desktop item `<select>`s (`IP_SELECTORS`: consume/waste/adjust items, output rows, material rows) are auto-enhanced by `ipScan()` (400 ms interval) into a two-step picker: base product → variant chips. The hidden select stays the source of truth, and a `change` event is dispatched on pick.
  - The production brand and colour selects are rendered as chips (`chipifySelect`).
  - Mobile forms use `twoStepList` (state `S.pickQuery`/`S.pickGroup`, reset in `go()`).
- **Reports:**
  - Kardex and the dept stock table get dynamic attribute columns (`attrKeysFor`/`attrCellsHtml`).
  - Docs, details, history and the daily report use `itemNameHtml` (short name + chips, full name in the title tooltip).
  - Prints keep the full names.

## Return form (since 1405/07/27)
- Return to the previous dept has its own form: desktop section `sec-return` (permission = `sec-output`, mapped in `canAccessSection`) and mobile screen `return` in the «ثبت» menu.
- It lists approved outputs received by the dept that are not fully returned yet. The user picks one and enters a qty (full or partial) plus a required reason.
- The existing «بازگشت به بخش قبلی» buttons open this form preselected.
- Server: `/api/doc/output/request-return {docId, qty?, note, date?}`. `returnedQtyOf(parentId)` sums active returns (pending / pending_warehouse / approved outputs with `returnOfDocId`, plus legacy return docs). qty must be ≤ remaining (default = remaining). The return is still a normal reverse output.

## Cable type (formula) on initial stock + formula-aware lots (since 1405/07/27)
- **Initial inventory:**
  - Stage keys SOL/INJ/LASER/PACK whose product has more than one Sepidar formula (e.g. imported 333000012 vs domestic 004401010 cable) require `formulaKey` per row; single-formula items get it automatically (`initialFormulaFor`, `stageFormulaKeys`).
  - Rows are keyed by item|formulaKey, so the same item can appear twice with different formulas.
  - In group edit, legacy lines without a formula may stay empty. When exactly one new row with a formula matches a legacy line, the formula is set in place (`fkAssign`, recorded in editHistory).
  - UI: column «نوعِ کابل (فرمول)» in the initial list form, labelled with the formula's cut-stage cable (`bomFormulasAll`); a warning chip in the docs list for lines still missing it.
- **Lots:**
  - The initial lot label gets « · ف{fk}».
  - `buildLotLedger` returns `batchFk` (lot → formula, taken from production/initial docs). Consume txs of a production take lots of the same formula first.
- **Suggest:** `/api/bom/suggest` for inject/laser/pack with more than one formula reads the input lots.
  - If all input stock is of one known formula, only that formula is returned (`formulaFromLots.locked`; desktop shows it disabled, mobile shows a note).
  - Otherwise the default is the first known (FIFO) lot formula, and each option shows its qty.
- **WIP report:** formula shares come from lots. Only the unknown remainder uses production-history weights.
- **Excess (اضافات) of a multi-formula stage item:** requires `formulaKey` (`/api/doc/adjust`, `excessFk`), stored on the doc (also for pending_approval) and used as the lot formula (`batchFk`). Desktop shows `#adjust-fk-box`; mobile shows a cable-type card (`S.adjFk`).
- **Mobile laser/pack production:** now shows the formula picker when the input stock is mixed, or a locked note when it is all one formula.
- **One-time migration `initialCableImportedV1`** (`migrateInitialCablesImported`, run on load):
  - Scope: manual initial lines outside the raw warehouse are treated as imported cable.
  - Simple cable (raw or CUT-) is converted to its unique imported counterpart (pairs taken from Sepidar formula pairs; imported = code 333… or item name containing «وارداتي»). It is merged into the same doc's imported line when one exists.
  - Stage items get formulaKey = their single imported formula (or the product's only formula). Frozen tx.lots labels are relabelled.
  - Ambiguous lines, or lines with movements after the initial entry, are skipped.
  - Report: `appSettings.initialCableImportedReport` and `backups/cable-imported-report-*.json`; full pre-migration backup in `backups/pre-cable-imported-*.json`.

## Dispatch orders — حواله ارسال بار (since 1405/07/28)
- **Flow:** the central office issues a dispatch order → the finished-warehouse supervisor ships it → the waybill is attached now or later.
  - Issuing: `POST /api/dispatch` (admin, or a role with `perm-dispatch-issue` in the permission matrix).
  - Shipping: `POST /api/dispatch/:sid/ship {lines:[{docId, qty}], carrier, waybillNo}` (finished-dept users, warehouse role, admin).
  - Attaching: `POST /api/dispatch/:sid/attach {name, type, data base64}` (image/pdf ≤ 8MB, stored in `attachments/`, served by `GET /api/attachments/:file`, auth required, `?token=` works).
- **Storage:**
  - Each line is a doc `type:'dispatch'` (status `pending_dispatch` → `approved` / `cancelled`) sharing a `submissionId` and a docNo from series **D**. Docs carry `customer`, `destination`, `orderedQty`, `carrier`, `waybillNo`, `attachments[]` and `waybillPending`.
  - Shipping creates tx `type:'output'` from finished with `targetUnit:'customer'` (no inbound pair). Reports count it as an output, and lots trace batches up to the customer. Cancelling a shipped line reverses it (no stock bump for 'customer'). Pending orders are deleted via the normal delete/batch.
  - The Output Messenger room `deptGroups.finished` and push notifications fire when an order is issued or shipped.
- **UI:**
  - Desktop `sec-dispatch`: issue form (picker class `.dispatch-item-select`), tabs (pending / awaiting waybill / done), ship modal, waybill upload with client-side JPEG compression, print.
  - Desktop `sec-finished-in`: report of approved outputs into finished, grouped by day or range by Sepidar code, so the office can register production docs in Sepidar.
  - Mobile screen `dispatch`: shown in «ثبت» for finished users, with camera capture for the waybill.
  - Kartabl/badges include pending and awaiting-waybill dispatch orders for the people who ship them.

## Stage-chain validation (since 1405/07/28)
- `POST /api/doc/output` rejects a stage key the destination doesn't accept (`stageKeyProblem(to, item)`). This stops skipping stages, e.g. CUT→inject or LASER→finished. Returning to the previous stage stays allowed.
- `chainProblem(unit, item, materials, formulaKey)` runs on production and production-with-materials, next to `colorProblem`. A stage input must:
  - come from the previous stage (CUT→solder, SOL→inject, INJ→laser, LASER→pack);
  - have the same Sepidar product code;
  - in pack, have the same laser brand as the PACK key's laser brand;
  - in solder, be a CUT piece that appears in the chosen formula (cable type and length).
- `/api/integrity` returns `chainIssues`: stock in a unit that doesn't accept it, approved productions whose consumed stage inputs break these rules, and outputs to a unit that doesn't accept the item. The desktop integrity panel lists them.

## Backup notes + true auto schedule (since 1405/07/28)
- Sidecar `backups-meta.json` in the backup folder: `{filename: {kind: auto|manual|pre-restore, note, by, at}}`. Legacy files without meta show as «نامشخص».
- `createBackupFile(kind, note, by)`. Auto = 'auto'; `/api/backup/create` = 'manual' (body.note); restore endpoints = 'pre-restore'.
- `latestBackupTime()` now counts ONLY auto backups (before, manual/safety backups kept postponing the auto one).
- Retention (keepCount) prunes auto, pre-restore and legacy files only — manual backups are never auto-deleted.
- `POST /api/backup/note/:filename` edits a note (admin). Settings GET returns `lastAutoAt`, `nextAutoAt`.
- All backup-type files (migration snapshots `pre-cable-imported-*`, `purged-cancelled-*`) go to `resolveBackupFolder()` (live: E:\WarehouseSystem\backups), not `__dirname/backups`. Pre-deploy code backups also go to E:\WarehouseSystem\backups\code\<name>. Only `db.json.prev` (crash recovery) stays beside db.json.

## Rework — برگشت معیوب (since 1405/07/29)
- Flow (NCR + unbuild + rework order): inject records a defective item + reason → solder receives (normal output approve) → solder «تعمیر شد» → repaired qty goes back to inject by a normal output. No new production is ever recorded.
- `POST /api/rework {unit:'inject', item, qty, reason, note}` (inject users/admin), `GET /api/rework/plan` (preview), `POST /api/rework/:id/repair {qty, scrapQty}` (solder users/admin), `POST /api/rework/:id/cancel {reason}`, `GET /api/reports/rework`, `POST /api/settings/rework-reasons` (admin; `appSettings.reworkReasons`).
- Doc `type:'rework'` (series **N**, status `approved`/`cancelled`). Fields: kind `unbuild|direct`, `unbuild[{batch,qty,prodDocId}]`, `returnLines[{item,qty,lots,docId}]`, `repairPerUnit` (formula materials with `stage:'solder'`, i.e. sockets/USB/shell), `lost` (inject-stage materials of the unbuilt qty, info only), `repairs[{qty,scrapQty,materials,wasteDocIds,outputDocId}]`. State is derived (`reworkState`): in_transit / at_repair / done / return_rejected / cancelled.
- Unbuild of an INJ item (newest lots first): per lot a **negative `production` tx** (batchNumber = that lot) and a **negative `consume` tx** of the SOL input with explicit negated `lots` (taken from the source production's consume tx). Lots without a production doc map INJ-→SOL- 1:1 keeping the lot label. tx ids: `transactionId` + `extraTxIds` (integrity and `reverseDocTransactions` include `extraTxIds`).
- Return/repair outputs are ordinary outputs created through `ROUTE_HANDLERS['post /api/doc/output']` (warehouse gate applies) with `reworkId`, `reworkLots` (output approve uses them as `txFrom.lots` so batch trace survives) and `reworkRepair` on the repair one. Repair materials + unrepairable SOL are approved `waste` docs with `parentDocId` = rework (share its N number, folded under it in lists, cannot be cancelled alone).
- Guards: production cancel refused while an active rework unbuilt part of it; rework cancel only before solder received it and with no repairs (pending return outputs → cancelled, txs reversed with a V doc).
- Repair parts `mode` (chosen by solder): `none` = same socket re-soldered, nothing consumed (default for `direct`, «جدا شدن کابل از سوکت» before injection); `formula` = new sockets of the same type, `materials` = list of codes of the ends actually replaced (subset of `repairPerUnit`, checkboxes); `convert` = socket of another type → the SOL item becomes another product: `newItem` from `GET /api/rework/:id/alternatives` (other solder products, same CUT cable first, colour kept), its solder-stage parts minus the shared ends (`materials`) are wasted, and the old SOL is converted by a negative `production` tx per lot + a positive `production` tx of `newItem` (batch `<rw.batchNumber>-T<n>`, tx.formulaKey) in `extraTxIds`; the repair output carries `newItem`. Each repair stores mode/newItem/materials; report shows qty per mode and conversions.
- Multi-line form: `POST /api/rework {unit, lines:[{item,qty,reason,note}]}` (old single-line body still accepted). The same item may appear several times with different reasons (lines with the same item+reason are merged); each line is re-planned after the previous one so availability is cumulative. One rework doc per line, all with `reworkGroup` = first id, sharing one N number; their return outputs share `submissionId 'rwg-<group>'` (one H number / one output group).
- Due date: warehouse-approve of a rework return output (`reworkId` && !`reworkRepair`) requires `dueDays` 1–60 (`/api/doc/batch` passes `dueDays` through) → `setReworkDue` sets `rw.dueDays/dueAt/dueSetBy`. If the pair is not gated, solder's receive sets the default (`appSettings.reworkDefaultDueDays`, 3). `POST /api/rework/:id/due {days}` (warehouse/admin) resets it from now. `checkReworkOverdue()` (90 s after start, then every 30 min) pushes to warehouse+admin for in_transit/at_repair reworks past `dueAt`, once per group per 24 h (`overdueAlertedAt`). Overdue reworks also show in the warehouse/admin kartable (desktop `reworkRepairDocs`, mobile `canRepairM`).
- UI: desktop `sec-rework` (access = sec-output; tabs create/repair/report + admin reasons editor; kartable counts `reworkRepairDocs`); mobile screen `rework` in «ثبت» (inject: pick → qty → reason chips → submit; solder: «تحویل گرفتم» / qty + «تعمیر شد»), at_repair reworks show in «در انتظار».

## Cancel permissions (since 1405/07/29)
- `POST /api/doc/:id/cancel` (and batch `cancel`) now checks the actor: `initial` docs only for `initialActorAllowed` (admin or a role with `sec-initial-inv`); other docs for non-`user` roles, the creator, or users of the doc's unit/fromUnit/toUnit. Desktop/mobile hide the «لغو» button on initial docs for everyone else.

## Back navigation (since 1405/07/29)
- Mobile: `go(screen, noPush)` keeps `NAV_STACK`; `back()` first closes an inner step (`subBack`: variant list `pickGroup`, selected return doc, selected dispatch, rework item picker), else pops the stack (fallback PARENT/dash). Header `#backBtn` shows whenever `canGoBack()`. The phone/browser Back key is routed to `back()` via one extra `history` entry re-pushed on each `popstate`.
- Desktop: `switchTab(tabId, noPush)` keeps `TAB_STACK`; header button `#deskBackBtn` («→ برگشت») + browser Back call `deskBack()` (closes a selected return doc first). Both stacks reset on logout.

## Reject / sender edit-delete rules (since 1405/08/02)
- Receiver reject: `POST /api/doc/output/reject {docId, reason≥3}` (receiver dept users or admin, status `pending`) → status `rejected`, `rejectedBy/At`, `rejectReason`, `rejectStage:'receiver'` (warehouse-reject sets `rejectStage:'warehouse'`). Batch action `output-reject`. Before this, the receiver's «رد/لغو» hard-deleted the doc. Rejected outputs never moved stock.
- `notifyRejected(doc, by, reason, stage)` pushes to the creator on receiver/warehouse/production/adjustment rejects.
- Sender rule (`senderModifyProblem`): only the creator (or admin) may delete (`DELETE /api/doc/:id`) or edit (`POST /api/doc/:id/edit {qty, note}`) a doc, and only before its first approval: status pending_warehouse / pending_production / pending_approval / pending_dispatch, or `pending` without `warehouseApprovedBy`. Rework-created outputs and production material children are excluded. Edit checks usable stock (excluding itself), return limits, and scales pending production materials by the same ratio; history in `doc.editHistory`. Generic cancel of a `pending` doc follows the same rule.
- UI: desktop `canModifyC` / mobile `canModifyM` show «✏️ ویرایش» + «🗑️ حذف» only then; receiver gets «❌ رد» (with reason) instead of delete; group outputs: «❌ رد (همه)», per-line edit in the detail view.

## Viewer role — مشاهده‌گر (since 1405/08/02)
- Role `viewer`: the auth middleware rejects every non-GET request (except logout / activity-login / push (un)subscribe / change-password) and the data-changing GETs `/api/sync/sepidar*` with 403 `readOnly`. Default sections `DEFAULT_ROLE_PERMISSIONS.viewer` (reports, documents, dispatch view, finished-in, stock-check); the role matrix only allows `VIEWER_SECTIONS_OK` for it (no forms, no perm-*).
- Viewer also gets sec-sepidar-inbox / sec-stock-count (migration `viewerPermsV2`), the admin-only forecast material-availability tables, and an activity-log panel in sec-stock-check (`refreshActivityLog('sc-activity-log')`). Desktop adds `body.viewer-mode`, whose CSS hides every button whose onclick starts with a mutating handler prefix (approve/reject/save/register/submit/sync/…).
- Clients: `isViewer()` / `isViewerM()` blank every document action, empty kartable; desktop rework section shows only the repair list (read-only) and report. Create/edit user role selects include «👁️ مشاهده‌گر».

## Assembly-warehouse reconcile (since 1405/08/02)
- `computeWipMaterials()` (extracted from `/api/reports/wip-materials`) explodes every dept's stock to raw materials by formula.
- `GET /api/sepidar/assembly-reconcile?stocks=16[,17,44,14]` (read-only): Sepidar stock of those warehouses (`INV.vwItemStockSummary`, resolved fiscal year) vs system raw-material content in cut/solder/inject/laser/pack/qc (free materials + WIP). Columns: per-dept split incl. `finished` (content of finished-warehouse products, included in the system total `line` and the diff since 1405/08/03), `transit` (pending raw→dept outputs), `diffWithTransit`. Desktop panel «🧮 مواد اولیه‌ی در جریان ↔ انبار مونتاژ سپیدار» in sec-stock-check (default stock 16).

## Stock-check date range (since 1405/08/02)
- `systemDailyMoves()` (initialInventory + transactions by day, integrity sign rules) / `inventoryAt(to)`; `sepidarDailyMoves(pool, refs, fy)` = receipts − deliveries per stock/item/day (`INV.vwInventoryReceipt(Item)`, `vwInventoryDelivery(Item)`; verified equal to `vwItemStockSummary`).
- `/api/sepidar/reconcile?from&to` → `reconcileByRange`: per warehouse/item opening (< from), in/out within range and closing (≤ to) for Sepidar and system; status by closing diff (`move_diff` when only the period movement differs). Without dates the old current-stock comparison runs.
- `/api/sepidar/assembly-reconcile?to=` compares balances as of `to` (system via `computeWipMaterials(inventoryAt(to))`; in-transit column only for "now").
- Excel export (`exportContainerToExcel`): `table_to_sheet(..., {raw:true})`, then every string cell that `excelNumberOf()` recognises (Persian/Latin digits, ٬/, thousands, ٫ decimal, minus) becomes a numeric cell; codes with a leading zero, dates and text stay text (since 1405/08/03).
- BOM list (`GET /api/bom`) returns `unclassified[{code,name}]` per formula (materials without a cut/solder/inject/laser/pack stage). Desktop «📋 فرمول‌های آپلودشده» highlights them (yellow row + material names), shows a count, sorts them first, has a «فقط … نامشخص» filter, and reloads after `setMaterialStage` (since 1405/08/09).
- BOM list shows only cable formulas (`isCable`: has a cut-stage material or name contains کابل) unless «نمایش فرمول‌های غیرکابلی» is ticked; search is word-based.
- Search normalisation (desktop + mobile): an inline script at the top patches `String.prototype.includes` so that when either side contains Arabic ي/ى/ك or a ZWNJ, both sides are compared with Persian ی/ک and spaces. Every client-side search inherits it (since 1405/08/09).
- Only raw metre cable is cuttable (`isCuttableMaterial`: unit «متر» in the formula and not itself a formula product). Classification POST refuses stage `cut` otherwise; rebuild-from-BOM skips such cut materials; BOM `isCable` uses the same rule (a power bank whose formula contains a finished cable is not a cable formula).

## Custom pack split — پک سفارشی (since 1405/08/10)
- Sepidar has one code for custom packs (`PACK_VARIANT_BASES = ['003000184']`); the system keeps stock per brand + cable type under keys `003000184~<brandSlug>~<cableSlug>` (e.g. `003000184~FAONE~VS_600_TC_2m`, name «پک FAONE-VS-600 TC 2m»). Brand = `packBrandList()`; cable types = `packCableTypes(base)` from formulas that use the base (`cableTypeOfFormula`: model from name VS-xx, connector from solder materials PD/IP/V8/CC/TC, length from cut qty <0.5→25cm, <1.5→1m, else 2m).
- Helpers: `parsePackVariant(key)`, `pvBase(key)`, `packVariantKey(base, brand, cable)`, `resolvePackSplits(base, splits, total)`, `pvStockForFormula(inv, code, f)`. Names persist in `appSettings.packVariants` (`registerPackVariantsInUse()` runs in `saveData`). `knownItemCode`, `resolveItemName`, `sepidarCodeOfKey` (→ base, so Sepidar reconcile sums all variants), `computeWipMaterials` and assembly-reconcile transit understand variant keys.
- Sepidar inbox approve: rows with `packSplit` require `packSplits[rowIndex] = [{brand, cable, qty}]` whose sum equals the row qty; each part becomes its own doc/tx (same submissionId). Desktop asks with `openPackSplitModal` before confirming.
- Initial inventory: `GET /api/pack-variants/options` (brands, cable types, initial lines per unit) and `POST /api/pack-variants/split-initial {unit, base, splits}` (total of that unit's initial lines stays the same; diffs lines, cancels via `removeInitialLine`, adds lines with the same groupId/source/date; checks usable stock on decreases). Desktop button «📦 تفکیکِ پک سفارشی» in sec-initial-inv → `openPackInitialSplitTool()`. The raw Sepidar stock sync skips a base that already has variant stock.
- Packaging: `/api/bom/suggest/pack` swaps the base for the variant of the pack def's `packType` + formula cable type; `packVariantProblem` (production-with-materials and production) rejects consuming another variant. Material-availability sums variants with the same cable type.
- Clients: desktop `packVariantOf` / mobile `packVariantM` → name «پک BRAND-CABLE», chips پک + نوع کابل, group = base.
- Documents list: every approved initial group containing 003000184 (or its variants), including the Sepidar-synced raw document, shows «📦 تفکیک پک» (admin, roles with sec-initial-inv, and role warehouse — the split-initial endpoint accepts the same) → `openPackSplitForUnit(unit, base)`; only that item is split, other lines stay untouched (since 1405/08/10).
