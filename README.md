# global-monitoring-core

Shared read-logic for the Global Monitoring plugins — one source of truth so
the hub (pull) function and the tenant (push) cron don't drift.

## Why a submodule + inline, not an npm dependency

Catalog-plugin functions ship as a **single inlined `code.ts` string** and
cannot `import` across files at runtime. So this module is consumed by:

1. Adding this repo as a **git submodule** named `shared_lib` in each plugin repo:
   ```
   git submodule add https://github.com/wonderfulcx/global-monitoring-core shared_lib
   ```
2. The plugin's `scripts/package.mjs` **inlines `shared_lib/core.ts`** at the
   top of any function/cronjob `code.ts` that contains the marker line:
   ```
   // @@inline-core
   ```
   at package time. The marker is replaced with the contents of `core.ts`.

## Hard rule

`core.ts` must contain **only plain top-level declarations** — no `export`,
`import`, or `module.exports`. It is concatenated ahead of the consuming
`code.ts`, which then references its symbols directly (`fetchTenantStatus`,
`computeWindow`, `fetchBusinessMetrics`, `secretApiKey`, …). The runner loads
one combined script with a single top-level `userFunction`.

## What's in here

Low-level: `apiCall`, `unwrapList`, `getList`, `getExactCommsCount`,
`secretApiKey`. Domain: window math (`computeWindow`, `normalizeRange`),
`fetchBusinessMetrics`, monitor/alert helpers, and `fetchTenantStatus` — the
full windowed per-tenant read used identically by both plugins.

## Updating

Edit `core.ts`, commit here, then in each consuming repo:
`git submodule update --remote shared_lib` and rebuild the plugin.
