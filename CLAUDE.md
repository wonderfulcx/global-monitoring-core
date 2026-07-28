# CLAUDE.md — global-monitoring-core

Shared read-logic for the Global Monitoring plugins. This file is about **how to write code here**. Nothing else in this repo documents the contract, so read `core.ts`'s header comment before your first edit.

## The hard constraint (breaking it breaks both plugins)

`core.ts` is **inlined verbatim** into each plugin's function/cronjob at build time via the `// @@inline-core` marker.

- **No `import`, `export`, `require`, or `module.exports`.** Plain top-level declarations only.
- **Prefer pure functions over classes.** There is no long-lived runtime state to encapsulate, and the inliner makes cross-file structure impossible. A class here buys nothing and costs readability.
- One file. If it feels like it wants to be several, that's a signal to *delete*, not to split.

## No duplication — this is the rule I break most

- **Before adding a function, grep for one that already does it.** `apiCall`, `getList`, `unwrapList`, `aggregateQuery`, `secretApiKey` already exist. Do not write a second variant with a different name.
- **One concept, one vocabulary.** Two parallel scales for the same idea is a defect, not a migration step. Real example: `Severity` (critical/attention/healthy) and `OpsSeverity` (sev1/2/3/ok/unknown) coexisted for one commit — that was wrong, and the fix was to collapse to one plus a single `legacySeverityToOps` adapter at the boundary.
- **Adapters live at the edge, exactly once.** Tolerating a weird platform response shape is a boundary concern: do it in one helper, never inline at each call site.
- Shared logic belongs *here*, not copy-pasted into the plugins. If both plugins need it, it goes in `core.ts` and the submodule pin moves.

## Modularity

- **One responsibility per function.** A function must not both perform a network read *and* decide policy. `fetch*` returns facts; `classify*` / `rollup*` turn facts into judgements. Keep that seam clean — it is what lets severity be computed in the consumer.
- **Pure where it can be pure.** Every `classify*` / `worst*` / `map*` function takes plain values and returns plain values: no `fetch`, no clock, no globals. These are the only parts that are trivially testable, so keep them that way.
- **I/O at the edges, policy in the middle, no mixing.**

## Where computation belongs (decided, do not drift)

- **Producer** (tenant cron): collect raw per-agent facts · enforce the tier · pass the tenant's detector verdicts through untouched.
- **Consumer** (hub reader): map severity · roll up agent → tenant → fleet · append history · detect outliers.

Thresholds are a product decision. They must be tunable in **one** place, never redeployed to every tenant.

## Honesty rules (these are correctness, not style)

- **A failed read must never render as green.** If the data that determines health could not be read, the answer is `unknown`. Silence is not health.
- `unknown` is not a severity. It outranks green and never outranks a real `sev3`.
- Rates, not counts, wherever volume differs between agents.

## Elegance

- **Prefer deleting to adding.** If a change makes a file longer without making behaviour clearer, reconsider it.
- Name things for what they are, not how they're built.
- Match the surrounding comment density: explain *why*, never *what*.
- No dead placeholders. A tile or field that says "not implemented" is worse than its absence — it reads as a signal.
