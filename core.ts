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

// Business severity. Still a PLACEHOLDER threshold set — the business half of
// the severity decision is open — but it now speaks the single OpsSeverity
// scale instead of a second, parallel vocabulary.
// healthUnknown: when the reads that DETERMINE health (issues + alerts) failed,
// their zero counts are not trustworthy — reporting green off un-read data is
// misleading, so report unknown. A failure in a non-health read (e.g. business
// metrics) does NOT force this; the alerts/issues signal is still valid and the
// partial-data errors are surfaced anyway.
function classifyBusiness(activeAlerts: number, openIssues: number, healthUnknown = false): OpsSeverity {
  if (healthUnknown) return "unknown";
  if (activeAlerts > 0) return "sev2";
  if (openIssues > 0) return "sev3";
  return "ok";
}

// Payloads from a tenant still on an older pusher (or at T0/T1, where raw
// detail may not leave and the source pre-computes) carry the legacy
// critical/attention/healthy vocabulary. Translate rather than keep two scales.
function legacySeverityToOps(raw: unknown): OpsSeverity {
  switch (String(raw ?? "").trim().toLowerCase()) {
    case "critical":
      return "sev1";
    case "attention":
      return "sev2";
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

// Latency thresholds, from the L1 note ("normally 1 second … Sev1 if more than
// 3 seconds"). Tunable — changing these re-colours history, by design.
const AGENT_LATENCY_SEV1_MS = 3000;
const AGENT_LATENCY_SEV2_MS = 2000;
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

function classifyAgentLatency(avgMs: number | null): OpsSeverity {
  if (avgMs === null || !isFinite(avgMs)) return "unknown";
  if (avgMs > AGENT_LATENCY_SEV1_MS) return "sev1";
  if (avgMs > AGENT_LATENCY_SEV2_MS) return "sev2";
  return "ok";
}

// error_* tags are sev2, warning_* sev3 — per the L1 severity note. Rates, not
// counts, so a busy agent isn't penalised for volume.
function classifyTagRates(tags: TagCounts, interactions: number): OpsSeverity {
  if (!interactions || interactions <= 0) return "unknown";
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

async function fetchTenantStatus(name: string, baseUrl: string, apiKey: string | undefined, window: TimeWindow) {
  // No key means nothing could be read at all — that is unknown, not a health verdict.
  if (!apiKey) return { name, error: "missing_api_key", severity: "unknown" as OpsSeverity };

  const commsRange = window.start !== null && window.end !== null ? { startDate: window.start, endDate: window.end } : undefined;
  const issuesRange = window.start !== null && window.end !== null ? `&startDate=${window.start}&endDate=${window.end}` : "";
  const alertsRange = window.start !== null && window.end !== null ? `&start_date=${window.start}&end_date=${window.end}` : "";

  const [issues, incidents, commsWindow, issuesWindow, alertsWindow, monitorsRaw, agentNameById, business, perAgent] =
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
    ]);

  const openIssues = issues.items.filter(isOpenIssue).length;
  const openIncidents = incidents.items.filter(isOpenAlert);
  const activeAlerts = openIncidents.length;
  const alertDetails = openIncidents.map(toAlertDetail).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

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

  return {
    name,
    interactions: commsWindow.count,
    issues_opened: issuesWindow.total,
    alerts_triggered: alertsWindow.total,
    open_issues: openIssues,
    active_alerts: activeAlerts,
    severity: classifyBusiness(activeAlerts, openIssues, !!(issues.error || incidents.error)),
    alerts: alertDetails,
    monitors,
    monitors_by_severity: monitorAggregation.bySeverity,
    monitors_by_agent: monitorAggregation.byAgent,
    business_metrics: business.metrics,
    agents,
    ...(errors.length ? { errors } : {}),
  };
}
