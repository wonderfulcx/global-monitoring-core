// global-monitoring-core — shared read-logic for the Global Monitoring
// plugins (hub pull function + tenant push cron).
//
// HOW THIS IS CONSUMED: the plugin packagers inline this file verbatim at
// the top of each function/cronjob `code.ts` (via a `// @@inline-core`
// marker), because catalog-plugin functions ship as a single inlined source
// string and cannot `import` across files at runtime. Therefore this file
// MUST contain only plain top-level declarations — NO `export` / `import` /
// `module.exports`. The consuming code.ts references these symbols directly.
//
// Edit the logic here once; both plugins pick it up on their next build.

const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_FILTERS = encodeURIComponent("{}");
// Communications' dedicated exact-count endpoint uses a different filter shape
// than the v1 list endpoints: {"filters":[]} not {}.
const EXACT_COUNT_EMPTY_FILTERS = encodeURIComponent(JSON.stringify({ filters: [] }));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type TenantRegistryEntry = { name: string; api_url: string; key_secret: string };
type ListResult = { items: Record<string, unknown>[]; total: number; error?: string };
type AlertSeverity = "High" | "Medium" | "Low" | "Unknown";
type AlertDetail = { name: string; severity: AlertSeverity; status: string; triggered_at: number | null };
type MonitorDetail = { name: string; description: string; severity: AlertSeverity; agent_name: string; active: boolean };
type SeverityCounts = { High: number; Medium: number; Low: number; Unknown: number };
type AgentSeverityBreakdown = { agent_name: string; total: number } & SeverityCounts;
type BusinessMetric = {
  name: string;
  passed: number;
  failed: number;
  total: number;
  rate_pct: number | null;
  single_bucket: boolean;
};
type RangeKey = "week" | "last7" | "last30" | "all";
type TimeWindow = { range: RangeKey; start: number | null; end: number | null; label: string };

// --- Technical ops ----------------------------------------------------------
// The dashboard colour scale. sev1 = dark red (attend now), sev2 = red,
// sev3 = orange (investigate), ok = green. `unknown` is NOT a severity: it
// means we could not determine health, and must never render as green.
type OpsSeverity = "sev1" | "sev2" | "sev3" | "ok" | "unknown";
type AgentServiceHealth = { agent_id: string; status: string; unhealthy_services: string[] };
type ServiceHealth = { available: boolean; agents: AgentServiceHealth[]; unhealthy_count: number; error?: string };
type NamedAvg = { key: string; avg_ms: number };
type TagCounts = { error: number; warning: number; info: number; other: number };
type SeriesPoint = { at: string; value: number };
// One verdict = the latest decision of one detector for one agent, produced by
// the TENANT's own monitoring framework. We consume these; we never recompute
// its baselines, opening hours or known-event normalisation.
type DetectorVerdict = {
  detector: string;
  agent_name: string;
  severity: OpsSeverity;
  raw_severity: string;
  status: string;
  would_notify: boolean;
};
type DetectorFeed = { available: boolean; verdicts: DetectorVerdict[]; undetermined: number; error?: string };
type AgentTechSignals = {
  agent_id: string;
  agent_name: string;
  agent_latency_ms: number | null;
  tag_counts: TagCounts;
  interactions: number;
};

// Secret shape for "API Key" type secrets, defensively unwrapped — seen as
// { value: { api_key: "..." } }; tolerate a few shapes rather than assume one.
function secretApiKey(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  const obj = raw as Record<string, unknown> | null;
  const apiKey = obj?.api_key ?? (obj?.value as Record<string, unknown> | undefined)?.api_key;
  return typeof apiKey === "string" ? apiKey : undefined;
}

function unwrapList(payload: unknown): { items: Record<string, unknown>[]; total: number } {
  const p = payload as Record<string, unknown> | undefined;
  const d = (p?.data ?? p) as Record<string, unknown> | unknown[] | undefined;
  let items: Record<string, unknown>[] = [];
  if (Array.isArray(d)) items = d as Record<string, unknown>[];
  else if (Array.isArray((d as Record<string, unknown>)?.data))
    items = (d as Record<string, unknown>).data as Record<string, unknown>[];
  else if (Array.isArray((d as Record<string, unknown>)?.items))
    items = (d as Record<string, unknown>).items as Record<string, unknown>[];
  const pag = (p?.pagination ?? (d as Record<string, unknown>)?.pagination) as
    | { total?: unknown; total_rows?: unknown }
    | undefined;
  // `total_rows` is the real field this API returns; `total` is a fallback.
  const total = pag?.total_rows ?? pag?.total ?? (d as Record<string, unknown>)?.total ?? items.length;
  return { items, total: typeof total === "number" ? total : items.length };
}

// One auth'd request helper for GET (list/count) and POST (aggregate query).
async function apiCall(baseUrl: string, path: string, apiKey: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 100)}`);
  }
  return res.json();
}

async function getList(baseUrl: string, apiKey: string, path: string): Promise<ListResult> {
  try {
    return unwrapList(await apiCall(baseUrl, path, apiKey));
  } catch (e) {
    return { items: [], total: 0, error: (e as Error).message ?? String(e) };
  }
}

// Communications has a dedicated exact-count endpoint that wonderful-ui's own
// homepage uses for interaction counts — the v1 list endpoint's pagination
// total under-reports under a date filter, so use this instead.
async function getExactCommsCount(
  baseUrl: string,
  apiKey: string,
  dateRange?: { startDate: number; endDate: number },
): Promise<{ count: number; error?: string }> {
  const range = dateRange ? `&startDate=${dateRange.startDate}&endDate=${dateRange.endDate}` : "";
  try {
    const raw = (await apiCall(
      baseUrl,
      `/api/v2/communications/count?filters=${EXACT_COUNT_EMPTY_FILTERS}${range}`,
      apiKey,
    )) as Record<string, unknown>;
    const count = (raw?.data as Record<string, unknown> | undefined)?.count ?? raw?.count;
    return { count: typeof count === "number" ? count : 0 };
  } catch (e) {
    return { count: 0, error: (e as Error).message ?? String(e) };
  }
}

// Agent-name lookup, tolerant of the platform version. V2 tenants disable
// /api/v1/agents (403 → "use /api/v3/agents"); V1 tenants serve v1. Try v3
// first, fall back to v1. Names are enrichment (monitors still work without
// them), so never throw — return an empty map if both are unavailable.
async function fetchAgentNames(baseUrl: string, apiKey: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const path of [`/api/v3/agents?filters=${EMPTY_FILTERS}&limit=1000`, `/api/v1/agents?filters=${EMPTY_FILTERS}&limit=1000`]) {
    const r = await getList(baseUrl, apiKey, path);
    if (r.error || r.items.length === 0) continue;
    for (const a of r.items) {
      const id = a.id as string | undefined;
      const nm = (a.display_name as string) ?? (a.name as string) ?? undefined;
      if (id && nm) map.set(id, nm);
    }
    if (map.size > 0) break;
  }
  return map;
}

const isOpenAlert = (i: Record<string, unknown>) => String(i.status ?? "").toLowerCase() === "open";
// Matches wonderful-ui's homepage.api.ts fetchIssuesSummary:
// open = status in {"open","pending","in-progress"}.
const OPEN_ISSUE_STATUSES = new Set(["open", "pending", "in-progress"]);
const isOpenIssue = (i: Record<string, unknown>) => OPEN_ISSUE_STATUSES.has(String(i.status ?? "").toLowerCase());

const SEVERITY_RANK: Record<AlertSeverity, number> = { High: 0, Medium: 1, Low: 2, Unknown: 3 };
const normalizeSeverity = (raw: unknown): AlertSeverity =>
  raw === "High" || raw === "Medium" || raw === "Low" ? raw : "Unknown";

function toAlertDetail(incident: Record<string, unknown>): AlertDetail {
  const alert = incident.alert as Record<string, unknown> | undefined;
  return {
    name: (alert?.name as string) ?? "(unnamed monitor)",
    severity: normalizeSeverity(alert?.severity),
    status: String(incident.status ?? ""),
    triggered_at: typeof incident.triggered_at === "number" ? incident.triggered_at : null,
  };
}

function emptySeverityCounts(): SeverityCounts {
  return { High: 0, Medium: 0, Low: 0, Unknown: 0 };
}

function toMonitorDetail(alert: Record<string, unknown>, agentNameById: Map<string, string>): MonitorDetail {
  const agentId = alert.agent_id as string | undefined;
  return {
    name: String(alert.name ?? "(unnamed monitor)"),
    description: String(alert.description ?? ""),
    severity: normalizeSeverity(alert.severity),
    agent_name: (agentId && agentNameById.get(agentId)) || "(unscoped)",
    active: Boolean(alert.active),
  };
}

function aggregateMonitors(monitors: MonitorDetail[]) {
  const bySeverity = emptySeverityCounts();
  const byAgentMap = new Map<string, AgentSeverityBreakdown>();
  for (const m of monitors) {
    bySeverity[m.severity]++;
    const entry = byAgentMap.get(m.agent_name) ?? { agent_name: m.agent_name, total: 0, ...emptySeverityCounts() };
    entry.total++;
    entry[m.severity]++;
    byAgentMap.set(m.agent_name, entry);
  }
  const byAgent = [...byAgentMap.values()].sort((a, b) => b.High - a.High || b.total - a.total);
  return { bySeverity, byAgent };
}

// --- Per-signal severity ----------------------------------------------------
// One classifier per signal, so the same threshold answers both questions a
// dashboard asks: "how is this tenant?" (the worst-of rollup, which colours a
// tile) and "which signal is bad?" (the per-signal list, which colours the tile
// that explains it). Stating a threshold twice for those two purposes would let
// a tenant's colour and its own detail tiles disagree about the very numbers
// they were both derived from.
//
// Each takes `unknown` rather than `number` on purpose. A count that never
// arrived — projected away by a T0/T1 tier, or lost to a failed read — is not
// zero. Reading a missing count as 0 and returning `ok` is exactly the lie the
// honesty rule exists to prevent, and it is a lie that renders green.

function classifyActiveAlerts(activeAlerts: unknown): OpsSeverity {
  if (typeof activeAlerts !== "number" || !isFinite(activeAlerts)) return "unknown";
  return activeAlerts > 0 ? "sev2" : "ok";
}

// The tenant's own monitor already graded each incident High/Medium/Low, and we
// collected that grade into AlertDetail — then scored every open incident sev2
// regardless, so a Low-severity incident and a High one painted the same colour.
// This uses the grade we already have.
//
// The mapping respects the tenant's judgement rather than re-deriving it: they
// called it High, so it is our Sev1. `Unknown` grades fall back to sev2, the
// old blanket answer, because an ungraded firing incident must not read as
// milder than a graded one.
const INCIDENT_SEVERITY: Record<AlertSeverity, OpsSeverity> = {
  High: "sev1",
  Medium: "sev2",
  Low: "sev3",
  Unknown: "sev2",
};

// Classified from a COUNT VECTOR, not from the incident list.
//
// Reading the grades off `alerts[]` would have made severity depend on the
// privacy tier: the same High incident scores sev1 at T3, where names and
// timestamps travel, and sev2 at T1/T2, where they do not. A tenant's health must
// not change because it discloses less. So the producer sends
// active_alerts_by_severity — four integers, no names, no timestamps, safe at T1 —
// and the mapping happens here.
function classifyIncidents(activeAlerts: unknown, bySeverity: unknown): OpsSeverity {
  const byCount = classifyActiveAlerts(activeAlerts);
  const c = bySeverity as Partial<Record<AlertSeverity, unknown>> | null | undefined;
  // Array.isArray is not paranoia — it is the bug that shipped. The hub passed the
  // T3 detail LIST where this expects the count vector; an array is `typeof
  // "object"`, so `Number(arr["High"])` gave NaN, every bucket read 0, the total
  // read 0, and one open High incident classified as `ok`. A green tile for a
  // firing incident. Anything that is not a plain object now falls back to the
  // count instead of being silently misread as "nothing is firing".
  if (!c || typeof c !== "object" || Array.isArray(c)) return byCount;

  const n = (k: AlertSeverity): number => {
    const v = Number(c[k]);
    return isFinite(v) && v > 0 ? v : 0;
  };
  const total = n("High") + n("Medium") + n("Low") + n("Unknown");
  const count = typeof activeAlerts === "number" && isFinite(activeAlerts) ? activeAlerts : null;

  // The vector must agree with the count it summarises. If it does not, one of the
  // two is wrong and we cannot tell which — so take the coarser answer rather than
  // trust a vector claiming nothing fires while the count says otherwise. Without
  // this, {count: 1, all grades 0} returned `ok`.
  if (count !== null && total !== count) return byCount;
  // A vector of zeros agreeing with a count of zero is a real answer: nothing is
  // firing. byCount already says `ok` for 0 and `unknown` when the count is absent.
  if (total === 0) return byCount;

  const graded: OpsSeverity[] = [];
  if (n("High") > 0) graded.push(INCIDENT_SEVERITY.High);
  if (n("Medium") > 0) graded.push(INCIDENT_SEVERITY.Medium);
  if (n("Low") > 0) graded.push(INCIDENT_SEVERITY.Low);
  if (n("Unknown") > 0) graded.push(INCIDENT_SEVERITY.Unknown);
  // Worst-of: one High among ten Lows is still a High.
  return worstSeverity(...graded);
}

// classifyOpenIssues is GONE, deliberately. Colour means "someone should act",
// and an open-issue backlog is not an action item — it is a work queue. Eventim
// has sat at 112-117 open issues for the whole rollout, so "over zero -> sev3"
// painted a permanent orange that told an operator nothing and trained them to
// ignore the colour. The tenant's own dashboard shows the same number as a plain
// count, which is the correct treatment.
//
// Open issues, issues opened, interactions, alerts fired and tool latency are all
// CONTEXT: shown as numbers, never coloured. Only signals a human should respond
// to now carry a status — a fired incident, a dead service, latency past the
// ceiling, an error-tag rate, and the two trust gates.
//
// If issues ever earn a status it will not be from the total. The API exposes a
// per-issue `severity` (Eventim: 23 at sev 1, 73 at 2, 19 at 3, 2 at 4) and a
// `category` (42 wrong_answer, 28 tool_failure), so a rule would be built from
// those — a different function, not this one.

// Coverage as a signal in its own right, not only as a gate on other signals.
// Any failed read means the picture is incomplete, which is precisely what grey
// claims — so only a clean read is green. Deliberately NOT a health severity: an
// unreadable metrics endpoint is our measurement problem, not the tenant
// misbehaving, and scoring it sev3 would put a tenant under investigation for
// our own gap.
function classifyDataCompleteness(failedReadCount: unknown): OpsSeverity {
  if (typeof failedReadCount !== "number" || !isFinite(failedReadCount)) return "unknown";
  return failedReadCount === 0 ? "ok" : "unknown";
}

// Freshness as a signal in its own right. gateSeverityOnFreshness applies the
// same verdict to the OTHER signals; this is the tile that says why they greyed.
function classifyFreshness(freshness: Freshness): OpsSeverity {
  return freshness.stale ? "unknown" : "ok";
}

// Business severity. Still a PLACEHOLDER threshold set — the business half of
// the severity decision is open — but it now speaks the single OpsSeverity
// scale instead of a second, parallel vocabulary.
// healthUnknown: when the reads that DETERMINE health (issues + alerts) failed,
// their zero counts are not trustworthy — reporting green off un-read data is
// misleading, so report unknown. A failure in a non-health read (e.g. business
// metrics) does NOT force this; the alerts/issues signal is still valid and the
// partial-data errors are surfaced anyway.
//
// Composed from the per-signal classifiers above rather than restating their
// thresholds, so the rollup and the signal list can never disagree. Behaviour is
// unchanged: alerts sev2 outranks issues sev3 under worstSeverity exactly as the
// old early-return order did.
function classifyBusiness(activeAlerts: number, healthUnknown = false): OpsSeverity {
  if (healthUnknown) return "unknown";
  // Open issues were part of this and no longer are, for the same reason they no
  // longer colour a tile. Leaving them here would have kept the PRODUCER's claimed
  // severity permanently orange, and the hub honoured that claim — so removing the
  // signal from the reader alone would not have changed a single tile.
  return classifyActiveAlerts(activeAlerts);
}

// The ONE adapter between a snapshot's severity string and the ops scale.
// Snapshots arrive in two vocabularies and will for as long as pushers upgrade
// independently of the hub: a tenant pinned to an older core (or at T0/T1,
// where raw detail may not leave and the source pre-computes) sends
// critical/attention/healthy, a current one sends the ops scale directly.
//
// Legacy values map to whatever the current classifier would score from the
// SAME inputs, not one level hotter: legacy `critical` meant activeAlerts > 0,
// which classifyBusiness scores sev2, and `attention` meant openIssues > 0,
// which it scores sev3. Escalating them would make every tenant look worse the
// moment the reader ships, with nothing having changed.
//
// The app carries a deliberate copy of this table — it is a React bundle and
// cannot inline core.ts. If this mapping changes, change its normalizeSeverity
// too; they are the same decision expressed twice out of necessity.
function normalizeOpsSeverity(raw: unknown): OpsSeverity {
  switch (String(raw ?? "").trim().toLowerCase()) {
    case "sev1":
      return "sev1";
    case "sev2":
    case "critical":
      return "sev2";
    case "sev3":
    case "attention":
      return "sev3";
    case "ok":
    case "healthy":
      return "ok";
    default:
      return "unknown";
  }
}

// --- Ops severity: mapping + rollup -----------------------------------------
// These run in the CONSUMER (hub reader), not in the tenant cron. Thresholds
// are a product decision, so they must be tunable in one place rather than
// redeployed to every tenant. They live here only because core.ts is the one
// file both plugins inline.

// ONE latency line, at 3 seconds. Tunable — changing it re-colours history, by
// design.
//
// There used to be two (sev1 over 3000 ms, sev2 over 2000 ms) and the 2000 ms
// tier was wrong in a way only real data showed. Eventim's Schwerbi Hotline
// averages 1891–2094 ms depending on the window, so it sat astride the line: red
// on the current week, green on last-7, flipping with the range selector while
// nothing about the agent changed. A threshold inside normal variation produces a
// colour that is permanently on, and a colour that never changes trains you to
// ignore it — the same defect as scoring a 115-issue backlog "over zero → orange".
//
// So: over 3 seconds is red and worth attention; at or under it is green. No
// intermediate tier, because we have no evidence for where one would go.
const AGENT_LATENCY_RED_MS = 3000;
// Tag rates are shares of interactions, not counts ("Tag Rate instead of Tag Count").
const ERROR_TAG_RATE_SEV2_PCT = 1;
const WARNING_TAG_RATE_SEV3_PCT = 5;

// Lower rank = worse. `unknown` outranks ok (silence is not health) but never
// outranks a real sev3.
const OPS_RANK: Record<OpsSeverity, number> = { sev1: 0, sev2: 1, sev3: 2, unknown: 3, ok: 4 };

// Worst-of, unweighted. No args (or all-ok) yields "ok".
function worstSeverity(...vals: OpsSeverity[]): OpsSeverity {
  let worst: OpsSeverity = "ok";
  for (const v of vals) if (OPS_RANK[v] < OPS_RANK[worst]) worst = v;
  return worst;
}

// Coverage rule: "unknown" only when NOTHING could be determined. If some
// signals reported and others could not, take the worst real determination and
// surface the gap separately — otherwise one missing baseline greys out an
// otherwise-known tenant.
function rollupWithCoverage(vals: OpsSeverity[]): { severity: OpsSeverity; undetermined: number } {
  const determined = vals.filter((v) => v !== "unknown");
  const undetermined = vals.length - determined.length;
  if (determined.length === 0) return { severity: vals.length ? "unknown" : "unknown", undetermined };
  return { severity: worstSeverity(...determined), undetermined };
}

// Whether a rollup's own coverage was complete. `rollupWithCoverage` returns
// `{severity: "ok", undetermined: 1}` for [ok, unknown] — correct, but the caller
// then built a signal whose severity was plainly `ok`, so the tenant-level check
// (which looks only at severity) never learned an agent had been unreadable and
// the tenant stayed green. Two agents fine and a third unreadable is not a fully
// determined tenant.
function rollupIsPartial(r: { undetermined: number }): boolean {
  return r.undetermined > 0;
}

// --- Health vs. measurement confidence ---------------------------------------
// `unknown` was doing two incompatible jobs, and the collision produced a real
// bug: rollupWithCoverage drops every unknown, so a tenant whose /stats could not
// be read rendered GREEN with a small "1 undetermined" note beside it. Verified
// on FDE 2026-07-30 — two of seven signals undetermined, tile green. That is the
// honesty rule inverted, and a test asserted it as correct.
//
// The two jobs:
//   UNREADABLE      we asked and could not tell. Uncertainty about health.
//                   Must never be reported as health.
//   NOT_APPLICABLE  there is nothing to measure here. The tenant does not use
//                   the error_/warning_ tag convention, has no evaluated
//                   metrics, and so on. Absence of a subject, not absence of an
//                   answer — it cannot make a tenant look worse.
//
// Both still render grey; the difference is whether they can hold a tenant back
// from green.
// Why a signal has no verdict. Three distinct situations that were all being
// reported as "unreadable":
//   unreadable      we asked and could not tell. Blocks green.
//   not_applicable  nothing here to measure. Cannot block green.
//   stale           the whole snapshot is too old, so this judgement is too.
//                   ONE root cause, however many signals it gates — reporting it
//                   per-signal turned a single late push into six independent
//                   "unreadable" failures on the card.
type NoVerdictReason = "unreadable" | "not_applicable" | "stale";

// A determined problem outranks uncertainty — a tenant with a firing incident is
// sev2, not "unknown because /stats was also unreadable". But `ok` plus an
// unreadable signal is not ok: it is unknown, which is precisely the claim we can
// defend.
function applyConfidence(worst: OpsSeverity, unreadableCount: number): OpsSeverity {
  return worst === "ok" && unreadableCount > 0 ? "unknown" : worst;
}

function classifyAgentLatency(avgMs: number | null): OpsSeverity {
  if (avgMs === null || !isFinite(avgMs)) return "unknown";
  return avgMs > AGENT_LATENCY_RED_MS ? "sev2" : "ok";
}

// --- Comparison against an agent's own normal --------------------------------
// The absolute rule above answers "is this bad?" with a number somebody guessed.
// This answers "is this unusual FOR THIS AGENT?" using only the agent's own
// history, which is the difference between a threshold that transfers between
// tenants and one that has to be re-guessed for each.
//
// No storage. The comparison periods are the SAME window shifted back, so a
// 28-day baseline is available on the first run instead of accumulating for a
// month. (The alternative — group_by [agent_id, recorded_at] with
// date_granularity — 500s on the interactions entity; verified 2026-07-30. The
// day_of_week/time_of_day dimensions do work, but time_of_day is per-MINUTE, so
// a 28-day window blows the 1000-row limit before it covers one agent.)

const BASELINE_PERIODS = 3; // prior windows to compare against
const BASELINE_MIN_PERIODS = 3; // fewer than this and there is no baseline
// A rise must clear BOTH gates. MAD alone is unusable at this sample size:
// Eventim's Schwerbi Hotline has priors [1752, 1712, 1709] ms, giving a MAD of
// 3 ms and a +3-MAD band of 1721 ms — so a perfectly ordinary 1967 ms reading
// would flag. The relative gate is what makes the band survive low variance.
const BASELINE_MAD_K = 3;
const BASELINE_MIN_RISE_PCT = 25;

// How often a window RECURS, which is not the same as how long it lasts. The
// business week spans 5 days (Mon 00:00 → Sat 00:00) but comes round every 7, so
// shifting it by its own span lands on Wed–Mon: a different set of weekdays, with
// a weekend in it. Comparing Mon–Fri traffic against Wed–Mon is not a comparison.
// Unbounded windows ("all") have no previous period at all.
function windowPeriodMs(w: TimeWindow): number | null {
  if (w.range === "week" || w.range === "last7") return 7 * DAY_MS;
  if (w.range === "last30") return 30 * DAY_MS;
  return null;
}

function shiftWindow(w: TimeWindow, periodsBack: number): TimeWindow | null {
  const period = windowPeriodMs(w);
  if (period === null || w.start === null || w.end === null) return null;
  const shift = period * periodsBack;
  return { range: w.range, start: w.start - shift, end: w.end - shift, label: `${w.label} −${periodsBack}` };
}

function median(nums: number[]): number | null {
  const s = nums.filter((n) => isFinite(n)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Median absolute deviation — the spread measure that survives an outlier, where
// a standard deviation would be dragged by the very spike we are looking for.
function medianAbsoluteDeviation(nums: number[], med: number): number {
  return median(nums.map((n) => Math.abs(n - med))) ?? 0;
}

// One period's reading: the mean AND how many interactions produced it. An
// average over a single call is not comparable to an average over 620, and
// without the count there is no way to tell them apart.
type BaselinePoint = { avg_ms: number; interactions: number };

// Below this, a period's mean is too thin to compare in either direction.
const BASELINE_MIN_SAMPLE = 30;

type Deviation = {
  severity: OpsSeverity;
  rise_pct: number | null;
  baseline_ms: number | null;
  periods: number;
  // Why there is no verdict, when there is none — "insufficient_history" and
  // "insufficient_sample" are very different problems to act on.
  reason: "insufficient_history" | "insufficient_sample" | "no_current_reading" | null;
};

// Only a RISE is reported. For latency a fall is good news, and reporting it as
// a deviation would put a tile on screen that nobody should act on.
function classifyLatencyTrend(current: BaselinePoint | null, priors: BaselinePoint[]): Deviation {
  const enough = (p: BaselinePoint | null | undefined): p is BaselinePoint =>
    !!p && isFinite(p.avg_ms) && p.avg_ms > 0 && isFinite(p.interactions) && p.interactions >= BASELINE_MIN_SAMPLE;

  const usable = (Array.isArray(priors) ? priors : []).filter(enough);
  const none = (reason: Deviation["reason"]): Deviation => ({
    severity: "unknown",
    rise_pct: null,
    baseline_ms: null,
    periods: usable.length,
    reason,
  });

  if (!current || !isFinite(current.avg_ms)) return none("no_current_reading");
  // The current period is held to the same bar as the history it is compared to.
  if (!enough(current)) return none("insufficient_sample");
  if (usable.length < BASELINE_MIN_PERIODS) return none("insufficient_history");
  const med = median(usable.map((p) => p.avg_ms));
  if (med === null || med <= 0) return none("insufficient_history");

  const risePct = Math.round(((current.avg_ms - med) / med) * 1000) / 10;
  const band = med + BASELINE_MAD_K * medianAbsoluteDeviation(usable.map((p) => p.avg_ms), med);
  // sev3 — "needs investigation". A deviation is not an outage; it is the leading
  // signal before one.
  //
  // Deliberately NOT called anomaly detection. At three periods the MAD term
  // contributes almost nothing (Eventim's priors give a 3 ms MAD), so the 25%
  // relative gate does nearly all the work. The honest description of the output
  // is "N% above the median of the previous 3 comparable periods" — which is what
  // the tile should say.
  const outlier = risePct >= BASELINE_MIN_RISE_PCT && current.avg_ms > band;
  return {
    severity: outlier ? "sev3" : "ok",
    rise_pct: risePct,
    baseline_ms: Math.round(med),
    periods: usable.length,
    reason: null,
  };
}

// error_* tags are sev2, warning_* sev3 — per the L1 severity note. Rates, not
// counts, so a busy agent isn't penalised for volume.
function classifyTagRates(tags: TagCounts, interactions: number): OpsSeverity {
  if (!interactions || interactions <= 0) return "unknown";
  // A tenant that does not follow the error_/warning_/info_ convention has NO
  // prefixed tags at all. Its error rate then computes as exactly 0%, and this
  // function used to answer "ok" — green, off a convention the tenant never
  // adopted. That is the honesty rule's failure mode wearing a different hat:
  // not a failed read, but an inapplicable measurement reported as health.
  //
  // Checked against real data (2026-07-30): Eventim DOES use the convention —
  // 3 error_ tags and 1 info_ among 31 — so its 0.20% error rate is a genuine
  // ok. Without this guard a tenant with 31 unprefixed tags would have been
  // indistinguishable from Eventim's clean result.
  if (tags.error + tags.warning + tags.info === 0) return "unknown";
  const errPct = (tags.error / interactions) * 100;
  const warnPct = (tags.warning / interactions) * 100;
  if (errPct >= ERROR_TAG_RATE_SEV2_PCT) return "sev2";
  if (warnPct >= WARNING_TAG_RATE_SEV3_PCT) return "sev3";
  return "ok";
}

// Any agent or sub-service not "healthy" is sev1 ("/stats all good, otherwise
// Sev1"). An unreachable/absent /stats is unknown, not ok.
function classifyServiceHealth(health: ServiceHealth): OpsSeverity {
  if (!health.available) return "unknown";
  if (health.agents.length === 0) return "unknown";
  return health.unhealthy_count > 0 ? "sev1" : "ok";
}

// --- Freshness: silence is not health ---------------------------------------
// A pushed tenant's row holds its last snapshot indefinitely, and nothing in
// that snapshot expires. So a tenant that stops pushing keeps rendering
// whatever colour it had at the moment it went quiet — the exact failure mode
// behind the 11-hour blind spot on 2026-07-27. Freshness is the signal that
// turns silence into a visible state instead of a stale green tile.
//
// The threshold is derived per tenant rather than fixed, because the cadence IS
// the tenant's own cron schedule (`*/5` by default, hourly documented as a
// supported edit) — any single hardcoded interval is wrong for somebody, and a
// wrong one is worse than none: too tight cries wolf, too loose is the blind
// spot we already had. `expectedIntervalMs` is the cadence the hub has actually
// OBSERVED for that tenant.

// How many consecutive pushes a tenant may miss before its status is no longer
// current. Below this, a gap is jitter or one skipped run, not an outage.
const FRESHNESS_MISSED_PUSHES = 3;
// Until the hub has seen enough arrivals to know a tenant's cadence, use a
// deliberately loose threshold. A tenant that legitimately pushes hourly must
// not be declared stale on its first afternoon just because we cannot yet tell
// it apart from a dead 5-minute tenant.
const FRESHNESS_UNCALIBRATED_STALE_MS = 3 * 60 * 60 * 1000;
// Clamps, so neither a pathologically fast cron nor a pathologically slow one
// produces a threshold that is useless in practice.
const FRESHNESS_MIN_STALE_MS = 15 * 60 * 1000;
const FRESHNESS_MAX_STALE_MS = 6 * 60 * 60 * 1000;
const FRESHNESS_MIN_GAPS = 3;

type Freshness = {
  age_ms: number | null;
  stale: boolean;
  stale_after_ms: number;
  expected_interval_ms: number | null;
  calibrated: boolean;
};

// The cadence is the MEDIAN observed gap, never the mean: one missed run
// doubles a single gap, and a mean would quietly raise the alarm threshold at
// exactly the moment it should be tightening.
function deriveExpectedInterval(gapsMs: unknown): number | null {
  const usable = (Array.isArray(gapsMs) ? gapsMs : [])
    .map((g) => Number(g))
    .filter((g) => isFinite(g) && g > 0);
  if (usable.length < FRESHNESS_MIN_GAPS) return null;
  const sorted = usable.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function staleAfterMs(expectedIntervalMs: number | null): number {
  if (expectedIntervalMs === null) return FRESHNESS_UNCALIBRATED_STALE_MS;
  const threshold = expectedIntervalMs * FRESHNESS_MISSED_PUSHES;
  return Math.min(FRESHNESS_MAX_STALE_MS, Math.max(FRESHNESS_MIN_STALE_MS, threshold));
}

// `receivedAt` of 0/absent means the hub holds a row it never actually received
// a push for — that is maximally stale, not brand new.
function assessFreshness(receivedAt: unknown, gapsMs: unknown, now: number): Freshness {
  const received = Number(receivedAt);
  const expected = deriveExpectedInterval(gapsMs);
  const staleAfter = staleAfterMs(expected);
  const known = isFinite(received) && received > 0;
  return {
    age_ms: known ? now - received : null,
    stale: known ? now - received > staleAfter : true,
    stale_after_ms: staleAfter,
    expected_interval_ms: expected,
    calibrated: expected !== null,
  };
}

// Freshness GATES the snapshot's severity instead of rolling up with it.
// worstSeverity would be wrong here: a stale snapshot's judgement is stale too,
// so "sev2 as of four hours ago" must not keep a tile red any more than
// "healthy as of four hours ago" may keep it green. Once a tenant goes quiet we
// do not know its state, and `unknown` is precisely that claim. This is the
// whole of "silence is not health" — everything else about freshness is
// plumbing.
function gateSeverityOnFreshness(snapshotSeverity: OpsSeverity, freshness: Freshness): OpsSeverity {
  return freshness.stale ? "unknown" : snapshotSeverity;
}

// A stale tenant's human-readable line. Says how late it is AND what was
// expected, because "43m ago" is only alarming if you know the tenant pushes
// every 5 minutes.
function staleMessage(freshness: Freshness): string {
  const mins = (ms: number) => `${Math.round(ms / 60000)}m`;
  const age = freshness.age_ms === null ? "never" : `${mins(freshness.age_ms)} ago`;
  const basis = freshness.calibrated
    ? `expected every ${mins(freshness.expected_interval_ms as number)}`
    : `cadence not yet established, allowing ${mins(freshness.stale_after_ms)}`;
  return `stale: last push ${age} (${basis})`;
}

// The tenant framework has never fired, so its non-"none" vocabulary is
// unobserved. Anything unrecognised becomes sev2 with the raw string kept — a
// firing detector must never be silently swallowed as green.
function mapDetectorSeverity(rawSeverity: unknown, status: unknown, wouldNotify: unknown): OpsSeverity {
  const s = String(rawSeverity ?? "").trim().toLowerCase();
  const st = String(status ?? "").trim().toLowerCase();
  if (st === "insufficient_data" || st === "error") return "unknown";
  const notify = wouldNotify === true || String(wouldNotify).toLowerCase() === "true";
  if (s === "" || s === "none" || s === "ok") return notify ? "sev2" : "ok";
  if (s === "sev1" || s === "critical" || s === "high" || s === "1") return "sev1";
  if (s === "sev2" || s === "warning" || s === "medium" || s === "2") return "sev2";
  if (s === "sev3" || s === "info" || s === "low" || s === "3") return "sev3";
  return "sev2";
}

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
const fmtDay = (ts: number) => {
  const d = new Date(ts);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

function normalizeRange(raw: unknown): RangeKey {
  return raw === "last7" || raw === "last30" || raw === "all" ? raw : "week";
}

// Default window is the current ISO week Mon 00:00 UTC → end of Friday
// (start of Saturday) — an explicit business week, not a rolling 7 days.
function computeWindow(range: RangeKey, now: number): TimeWindow {
  if (range === "all") return { range, start: null, end: null, label: "All time" };
  if (range === "last7" || range === "last30") {
    const days = range === "last7" ? 7 : 30;
    return { range, start: now - days * DAY_MS, end: now, label: `Last ${days} days` };
  }
  const today = startOfUtcDay(now);
  const dow = new Date(now).getUTCDay(); // 0=Sun..6=Sat
  const monday = today - ((dow + 6) % 7) * DAY_MS;
  return {
    range: "week",
    start: monday,
    end: monday + 5 * DAY_MS, // exclusive end = start of Saturday
    label: `This week (Mon ${fmtDay(monday)} – Fri ${fmtDay(monday + 4 * DAY_MS)})`,
  };
}

// Per-interaction evaluated metrics (Containment, Deflection, Repeat Intent
// Rate, …), scoped to the window. Returned generically per tenant; a
// single-bucket "counter" metric (only true or only false) suppresses its
// rate so the app shows a count instead of a misleading 0%.
async function fetchBusinessMetrics(
  baseUrl: string,
  apiKey: string,
  window: TimeWindow,
): Promise<{ metrics: BusinessMetric[]; error?: string }> {
  try {
    const body: Record<string, unknown> = {
      entity: "metric_results",
      aggregation: { type: "count" },
      group_by: ["metric_name", "status"],
      limit: 200,
    };
    if (window.start !== null && window.end !== null) body.time_range = { start: window.start, end: window.end };
    const raw = (await apiCall(baseUrl, `/api/v2/query/aggregate`, apiKey, {
      method: "POST",
      body: JSON.stringify(body),
    })) as Record<string, unknown>;
    const rows = (((raw?.data as Record<string, unknown> | undefined)?.data as unknown[]) ?? []) as Array<{
      value?: number;
      dimensions?: { metric_name?: string; status?: string };
    }>;
    const byName = new Map<string, { passed: number; failed: number }>();
    for (const r of rows) {
      const name = r.dimensions?.metric_name;
      if (!name) continue;
      const entry = byName.get(name) ?? { passed: 0, failed: 0 };
      const v = Number(r.value ?? 0);
      if (r.dimensions?.status === "true") entry.passed += v;
      else if (r.dimensions?.status === "false") entry.failed += v;
      byName.set(name, entry);
    }
    const metrics = [...byName.entries()]
      .map(([name, c]) => {
        const total = c.passed + c.failed;
        const singleBucket = total > 0 && (c.passed === 0 || c.failed === 0);
        return {
          name,
          passed: c.passed,
          failed: c.failed,
          total,
          rate_pct: total && !singleBucket ? Math.round((c.passed / total) * 1000) / 10 : null,
          single_bucket: singleBucket,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { metrics };
  } catch (e) {
    return { metrics: [], error: (e as Error).message ?? String(e) };
  }
}

// The full rich per-tenant read, windowed. Used by the hub (pull) directly,
// and by the push cron (Pattern A) to compute the payload it emits — so both
// sides produce an identical tenant object from one code path.
// Live per-agent KPI VALUES in one call, scoped to the window. POST
// /api/v2/query/metric-stats with group_by=agent_id returns each metric's
// groups[] keyed by group_value (agent id), each carrying
// {pass,fail,excluded,total,pass_rate}. Works on V2 tenants (the v1 per-agent
// metric endpoints are 403'd under agent_studio_v2). Agent display names are
// joined by the caller via the version-tolerant name lookup. Never throws —
// this is enrichment; a failure returns an empty list + error string.
type AgentKpi = { name: string; pass_rate: number; pass: number; total: number; excluded: number };
type AgentKpiBreakdown = { id: string; name: string; kpis: AgentKpi[] };

async function fetchPerAgentKpis(
  baseUrl: string,
  apiKey: string,
  window: TimeWindow,
): Promise<{ agents: AgentKpiBreakdown[]; error?: string }> {
  try {
    const body: Record<string, unknown> = { group_by: "agent_id", filter: {} };
    if (window.start !== null && window.end !== null) body.time_range = { start: window.start, end: window.end };
    const raw = (await apiCall(baseUrl, `/api/v2/query/metric-stats`, apiKey, {
      method: "POST",
      body: JSON.stringify(body),
    })) as Record<string, unknown>;
    const data = (raw?.data ?? raw) as Record<string, unknown>;
    const metrics = Array.isArray(data?.metrics) ? (data.metrics as Record<string, unknown>[]) : [];
    const byAgent = new Map<string, AgentKpi[]>();
    for (const m of metrics) {
      const metricName = (m.metric_name as string) ?? (m.name as string) ?? "";
      const groups = Array.isArray(m.groups) ? (m.groups as Record<string, unknown>[]) : [];
      for (const g of groups) {
        const agentId = (g.group_value as string) ?? "";
        if (!agentId || !metricName) continue;
        const list = byAgent.get(agentId) ?? [];
        list.push({
          name: metricName,
          pass_rate: typeof g.pass_rate === "number" ? g.pass_rate : 0,
          pass: typeof g.pass === "number" ? g.pass : 0,
          total: typeof g.total === "number" ? g.total : 0,
          excluded: typeof g.excluded === "number" ? g.excluded : 0,
        });
        byAgent.set(agentId, list);
      }
    }
    const agents: AgentKpiBreakdown[] = [...byAgent.entries()].map(([id, kpis]) => ({
      id,
      name: id, // enriched with the display name by the caller
      kpis: kpis.sort((a, b) => a.name.localeCompare(b.name)),
    }));
    return { agents };
  } catch (e) {
    return { agents: [], error: (e as Error).message ?? String(e) };
  }
}

// --- Technical-ops collectors -------------------------------------------------
// These run on the PRODUCER (the tenant's own cron) because only the tenant's
// token can read the tenant. They return facts and never decide severity — the
// classify*/rollup* functions above do that, in the consumer.
//
// Everything here goes through ONE endpoint, /api/v2/query/aggregate, which the
// canonical 7-permission monitoring role already covers (verified 2026-07-28).

type AggRow = { value?: unknown; dimensions?: Record<string, unknown>; key?: unknown };

// The aggregate response nests as { data: { data: [...] } }; tolerate the
// shallower shapes too rather than assuming one.
async function aggregateQuery(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ rows: AggRow[]; error?: string }> {
  try {
    const raw = (await apiCall(baseUrl, `/api/v2/query/aggregate`, apiKey, {
      method: "POST",
      body: JSON.stringify(body),
    })) as Record<string, unknown>;
    const outer = (raw?.data ?? raw) as Record<string, unknown> | unknown[] | undefined;
    const rows = Array.isArray(outer) ? outer : ((outer as Record<string, unknown>)?.data as unknown[]) ?? [];
    return { rows: rows as AggRow[] };
  } catch (e) {
    return { rows: [], error: (e as Error).message ?? String(e) };
  }
}

const dimStr = (r: AggRow, key: string): string => String(r.dimensions?.[key] ?? r.key ?? "");
const rowNum = (r: AggRow): number => (typeof r.value === "number" ? r.value : Number(r.value ?? 0) || 0);
const withRange = (body: Record<string, unknown>, w: TimeWindow) =>
  w.start !== null && w.end !== null ? { ...body, time_range: { start: w.start, end: w.end } } : body;

// Per-agent service health. This is the Sev1 signal: "/stats all good, otherwise
// Sev1". The response is keyed by agent id, each with a status plus a per-service
// map (llm, stt, tts, rag, sms, noise_cancellation, gender_classification).
// NOTE: `available: false` means we could not read it — that is unknown, never ok.
async function fetchServiceHealth(baseUrl: string, apiKey: string): Promise<ServiceHealth> {
  try {
    const raw = (await apiCall(baseUrl, `/api/v1/stats`, apiKey)) as Record<string, unknown>;
    const body = (raw?.data ?? raw) as Record<string, unknown>;
    const agents: AgentServiceHealth[] = [];
    for (const [agentId, value] of Object.entries(body ?? {})) {
      const entry = value as { status?: unknown; services?: Record<string, { status?: unknown }> } | null;
      if (!entry || typeof entry !== "object") continue;
      const unhealthy = Object.entries(entry.services ?? {})
        .filter(([, s]) => String(s?.status ?? "").toLowerCase() !== "healthy")
        .map(([serviceName]) => serviceName);
      agents.push({ agent_id: agentId, status: String(entry.status ?? "unknown"), unhealthy_services: unhealthy });
    }
    const unhealthyCount = agents.filter(
      (a) => a.unhealthy_services.length > 0 || a.status.toLowerCase() !== "healthy",
    ).length;
    return { available: true, agents, unhealthy_count: unhealthyCount };
  } catch (e) {
    return { available: false, agents: [], unhealthy_count: 0, error: (e as Error).message ?? String(e) };
  }
}

// error_/warning_/info_ prefixes are the tenant's own convention (the platform's
// tags_category is only General/Workflow, which carries no severity). A tenant
// that doesn't follow it simply reports zeros, which classifyTagRates reads as
// "no signal" rather than "healthy".
function classifyTagName(tag: string): keyof TagCounts {
  const t = tag.toLowerCase();
  if (t.startsWith("error_")) return "error";
  if (t.startsWith("warning_")) return "warning";
  if (t.startsWith("info_")) return "info";
  return "other";
}

// Per-agent technical signals: average agent latency, and tag counts bucketed by
// prefix. Interactions per agent come along because tag RATES need a denominator
// ("Tag Rate instead of Tag Count").
async function fetchAgentTechSignals(
  baseUrl: string,
  apiKey: string,
  window: TimeWindow,
  agentNameById: Map<string, string>,
): Promise<{ agents: AgentTechSignals[]; errors: string[] }> {
  const [latency, tags, volume] = await Promise.all([
    aggregateQuery(
      baseUrl,
      apiKey,
      withRange({ entity: "interactions", aggregation: { type: "avg", column: "agent_latency" }, group_by: ["agent_id"], limit: 200 }, window),
    ),
    aggregateQuery(
      baseUrl,
      apiKey,
      withRange({ entity: "interactions", aggregation: { type: "count" }, group_by: ["agent_id", "tags"], limit: 1000 }, window),
    ),
    aggregateQuery(
      baseUrl,
      apiKey,
      withRange({ entity: "interactions", aggregation: { type: "count" }, group_by: ["agent_id"], limit: 200 }, window),
    ),
  ]);

  const byAgent = new Map<string, AgentTechSignals>();
  const ensure = (agentId: string): AgentTechSignals => {
    let entry = byAgent.get(agentId);
    if (!entry) {
      entry = {
        agent_id: agentId,
        agent_name: agentNameById.get(agentId) ?? agentId,
        agent_latency_ms: null,
        tag_counts: { error: 0, warning: 0, info: 0, other: 0 },
        interactions: 0,
      };
      byAgent.set(agentId, entry);
    }
    return entry;
  };

  for (const r of latency.rows) {
    const v = rowNum(r);
    ensure(dimStr(r, "agent_id")).agent_latency_ms = Number.isFinite(v) ? Math.round(v) : null;
  }
  for (const r of volume.rows) ensure(dimStr(r, "agent_id")).interactions = rowNum(r);
  for (const r of tags.rows) {
    const tag = String(r.dimensions?.tags ?? "");
    if (!tag) continue;
    ensure(dimStr(r, "agent_id")).tag_counts[classifyTagName(tag)] += rowNum(r);
  }

  const errors: string[] = [];
  for (const [label, r] of [
    ["agent_latency", latency],
    ["agent_tags", tags],
    ["agent_volume", volume],
  ] as [string, { error?: string }][])
    if (r.error) errors.push(`${label}: ${r.error}`);

  return { agents: [...byAgent.values()].sort((a, b) => a.agent_name.localeCompare(b.agent_name)), errors };
}

// Average latency per tool, plus a daily trend. The trend is what makes "tool
// call latency INCREASED" answerable — a single number can only say "high".
async function fetchToolLatency(
  baseUrl: string,
  apiKey: string,
  window: TimeWindow,
): Promise<{ byTool: NamedAvg[]; trend: SeriesPoint[]; error?: string }> {
  const [perTool, daily] = await Promise.all([
    aggregateQuery(
      baseUrl,
      apiKey,
      withRange({ entity: "tools", aggregation: { type: "avg", column: "tool_latency_ms" }, group_by: ["tool_name"], limit: 100 }, window),
    ),
    aggregateQuery(
      baseUrl,
      apiKey,
      withRange(
        { entity: "tools", aggregation: { type: "avg", column: "tool_latency_ms" }, group_by: ["recorded_at"], date_granularity: "day", limit: 60 },
        window,
      ),
    ),
  ]);
  const byTool = perTool.rows
    .map((r) => ({ key: dimStr(r, "tool_name"), avg_ms: Math.round(rowNum(r)) }))
    .filter((t) => t.key)
    .sort((a, b) => b.avg_ms - a.avg_ms);
  const trend = daily.rows
    .map((r) => ({ at: dimStr(r, "recorded_at"), value: Math.round(rowNum(r)) }))
    .filter((p) => p.at)
    .sort((a, b) => a.at.localeCompare(b.at));
  const error = perTool.error ?? daily.error;
  return { byTool, trend, ...(error ? { error } : {}) };
}

// The tenant's OWN monitoring framework already computes baselines, opening
// hours and known-event normalisation. We consume its latest verdicts; we do not
// recompute any of that.
//
// It must be read through the query layer: service accounts get 403 on
// /api/v1/custom-tables/<name>/rows, but `custom_table:<name>` via aggregate is
// permitted. That returns aggregates rather than rows, so "latest verdict per
// agent per detector" is obtained by grouping over a narrow recent window — one
// detector cycle yields one row per (agent, detector).
const DETECTOR_TABLE = "custom_table:tenant_monitoring_agent_detector_runs";
const DETECTOR_LOOKBACK_MS = 30 * 60 * 1000;

async function fetchDetectorVerdicts(baseUrl: string, apiKey: string, now: number): Promise<DetectorFeed> {
  const { rows, error } = await aggregateQuery(baseUrl, apiKey, {
    entity: DETECTOR_TABLE,
    aggregation: { type: "count" },
    group_by: ["agent_name", "detector", "severity", "status", "would_notify"],
    limit: 200,
    time_range: { start: now - DETECTOR_LOOKBACK_MS, end: now },
  });
  // A tenant without the framework 404s here. That is not an error condition —
  // it means we cannot judge its technical health, i.e. unknown, not green.
  if (error) return { available: false, verdicts: [], undetermined: 0, error };

  const verdicts: DetectorVerdict[] = rows.map((r) => {
    const rawSeverity = String(r.dimensions?.severity ?? "");
    const status = String(r.dimensions?.status ?? "");
    const wouldNotify = r.dimensions?.would_notify;
    return {
      detector: String(r.dimensions?.detector ?? ""),
      agent_name: String(r.dimensions?.agent_name ?? ""),
      severity: mapDetectorSeverity(rawSeverity, status, wouldNotify),
      raw_severity: rawSeverity,
      status,
      would_notify: wouldNotify === true || String(wouldNotify).toLowerCase() === "true",
    };
  });
  return {
    available: true,
    verdicts,
    undetermined: verdicts.filter((v) => v.severity === "unknown").length,
  };
}

async function fetchTenantStatus(name: string, baseUrl: string, apiKey: string | undefined, window: TimeWindow) {
  // No key means nothing could be read at all — that is unknown, not a health verdict.
  if (!apiKey) return { name, error: "missing_api_key", severity: "unknown" as OpsSeverity };

  const commsRange = window.start !== null && window.end !== null ? { startDate: window.start, endDate: window.end } : undefined;
  const issuesRange = window.start !== null && window.end !== null ? `&startDate=${window.start}&endDate=${window.end}` : "";
  const alertsRange = window.start !== null && window.end !== null ? `&start_date=${window.start}&end_date=${window.end}` : "";

  const [issues, incidents, commsWindow, issuesWindow, alertsWindow, monitorsRaw, agentNameById, business, perAgent, serviceHealth, toolLatency] =
    await Promise.all([
      getList(baseUrl, apiKey, `/api/v1/issues?filters=${EMPTY_FILTERS}&limit=1000`),
      getList(baseUrl, apiKey, `/api/v1/alerts/incidents?filters=${EMPTY_FILTERS}&limit=1000&withPreloads=true`),
      getExactCommsCount(baseUrl, apiKey, commsRange),
      getList(baseUrl, apiKey, `/api/v1/issues?filters=${EMPTY_FILTERS}&limit=1${issuesRange}`),
      getList(baseUrl, apiKey, `/api/v1/alerts/incidents?filters=${EMPTY_FILTERS}&limit=1${alertsRange}`),
      getList(baseUrl, apiKey, `/api/v1/alerts?filters=${EMPTY_FILTERS}&limit=1000`),
      fetchAgentNames(baseUrl, apiKey),
      fetchBusinessMetrics(baseUrl, apiKey, window),
      fetchPerAgentKpis(baseUrl, apiKey, window),
      // Technical-ops facts. All five queries below were verified against live
      // Eventim data on 2026-07-30 — before this, none had ever been executed,
      // and on FDE (empty /stats, zero latency rows) a wrong entity or column
      // name would have been indistinguishable from "no data".
      //
      // fetchDetectorVerdicts is deliberately NOT called. The table exists and
      // its framework is running, but every group_by dimension comes back null
      // through /api/v2/query/aggregate — custom-table columns are not
      // groupable that way. mapDetectorSeverity then scores the empty result
      // "ok", i.e. it would render GREEN off data we cannot read. It needs the
      // rows API (403 for service accounts) or another path first.
      fetchServiceHealth(baseUrl, apiKey),
      fetchToolLatency(baseUrl, apiKey, window),
    ]);

  // Needs agentNameById, so it cannot join the batch above.
  const agentTech = await fetchAgentTechSignals(baseUrl, apiKey, window, agentNameById);

  const openIssues = issues.items.filter(isOpenIssue).length;
  const openIncidents = incidents.items.filter(isOpenAlert);
  const activeAlerts = openIncidents.length;
  const alertDetails = openIncidents.map(toAlertDetail).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  // Four integers, no names and no timestamps, so this is safe to send at T1.
  // It exists so incident severity does not depend on the disclosure tier.
  const activeAlertsBySeverity = emptySeverityCounts();
  for (const a of alertDetails) activeAlertsBySeverity[a.severity]++;

  const monitors = monitorsRaw.items
    .map((m) => toMonitorDetail(m, agentNameById))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const monitorAggregation = aggregateMonitors(monitors);

  // Per-agent KPI values, display names joined from the version-tolerant lookup.
  const agents = perAgent.agents
    .map((a) => ({ ...a, name: agentNameById.get(a.id) ?? a.id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const errors: string[] = [];
  for (const [label, r] of [
    ["issues", issues],
    ["alerts", incidents],
    ["issues_in_window", issuesWindow],
    ["alerts_in_window", alertsWindow],
    ["monitors", monitorsRaw],
  ] as [string, ListResult][])
    if (r.error) errors.push(`${label}: ${r.error}`);
  if (commsWindow.error) errors.push(`interactions: ${commsWindow.error}`);
  if (business.error) errors.push(`business_metrics: ${business.error}`);
  if (perAgent.error) errors.push(`per_agent_kpis: ${perAgent.error}`);
  // A tech-ops read that failed must surface as a gap, not vanish. `available:
  // false` on service health already means "unreadable"; the message is what
  // makes it diagnosable from the run log.
  if (serviceHealth.error) errors.push(`service_health: ${serviceHealth.error}`);
  if (toolLatency.error) errors.push(`tool_latency: ${toolLatency.error}`);
  for (const e of agentTech.errors) errors.push(e);

  return {
    name,
    interactions: commsWindow.count,
    issues_opened: issuesWindow.total,
    alerts_triggered: alertsWindow.total,
    open_issues: openIssues,
    active_alerts: activeAlerts,
    active_alerts_by_severity: activeAlertsBySeverity,
    severity: classifyBusiness(activeAlerts, !!(issues.error || incidents.error)),
    alerts: alertDetails,
    monitors,
    monitors_by_severity: monitorAggregation.bySeverity,
    monitors_by_agent: monitorAggregation.byAgent,
    business_metrics: business.metrics,
    agents,
    // Technical-ops facts, never verdicts — the consumer classifies these. Note
    // `service_health` carries its own `available` flag rather than being
    // omitted when unreadable: absent and unreadable must stay distinguishable,
    // because only one of them means "we asked and could not tell".
    service_health: serviceHealth,
    agent_tech: agentTech.agents,
    tool_latency: { by_tool: toolLatency.byTool, trend: toolLatency.trend },
    ...(errors.length ? { errors } : {}),
  };
}
