import { INCIDENT_CATEGORIES } from '../shared';

/**
 * Operating rules (tenants.settings.rules): how a client's room runs. Their admins change them in Settings;
 * anything not set keeps the defaults below, which are the numbers Rumfa used before rules existed.
 * The database reads the same paths (app.rule / app.rule_int / app.sla_minutes in 20261114004300).
 */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const QUEUE_KINDS = ['security', 'legal', 'state', 'helpdesk', 'national'] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

/** take: minutes for the person given the case to take it; resolve: minutes to resolve it;
 *  onMiss: when resolve time runs out, move it up to the client's top room (never past its seat: see
 *  20261114004600_seat_hierarchy) or keep it where it is and alert supervisors. */
export interface CaseTiming { take: number; resolve: number; onMiss: 'up' | 'stay' }
export interface Rules {
  cases: Record<Severity, CaseTiming> & { reopenMin: number };
  routing: Record<string, { queue?: QueueKind; severity?: Severity }>;
  team: { silentMin: number; turnoutMin: number; snoozeMin: number };
  callbacks: { unitMin: number; otherMin: number; retryMin: number };
  alerts: { smsAfterMin: number };
  results: { estimateMinUnits: number; estimatePct: number };
  /** useShifts: cases go to people on shift for the queue (off: to anyone whose role fits it).
   *  autoAssign: new cases go straight to someone free (off: they wait for a supervisor or someone to take them). */
  staffing: { useShifts: boolean; autoAssign: boolean };
}

export const DEFAULT_RULES: Rules = {
  cases: {
    critical: { take: 2, resolve: 10, onMiss: 'up' },
    high: { take: 5, resolve: 20, onMiss: 'up' },
    medium: { take: 15, resolve: 45, onMiss: 'up' },
    low: { take: 30, resolve: 120, onMiss: 'up' },
    reopenMin: 120,
  },
  routing: {},
  team: { silentMin: 60, turnoutMin: 120, snoozeMin: 60 },
  callbacks: { unitMin: 5, otherMin: 10, retryMin: 5 },
  alerts: { smsAfterMin: 30 },
  results: { estimateMinUnits: 20, estimatePct: 5 },
  staffing: { useShifts: true, autoAssign: true },
};

/** Allowed range for each number, by path. */
export const LIMITS: Record<string, [number, number]> = {
  'cases.take': [1, 240], 'cases.resolve': [1, 1440], 'cases.reopenMin': [0, 1440],
  'team.silentMin': [10, 600], 'team.turnoutMin': [30, 720], 'team.snoozeMin': [10, 480],
  'callbacks.unitMin': [1, 120], 'callbacks.otherMin': [1, 120], 'callbacks.retryMin': [1, 120],
  'alerts.smsAfterMin': [5, 240],
  'results.estimateMinUnits': [1, 1000], 'results.estimatePct': [0, 50],
};

/** Categories whose routing a client may change (SOS always goes to Security as critical). */
export const ROUTABLE = INCIDENT_CATEGORIES.filter((c) => c.code !== 'sos');

/** The client's rules with defaults filled in. Bad stored values fall back to the default. */
export function rulesOf(settings: any): Rules {
  const r = settings?.rules ?? {};
  const num = (v: any, d: number, path: string) => {
    const [lo, hi] = LIMITS[path];
    return Number.isInteger(v) && v >= lo && v <= hi ? v : d;
  };
  const cases = {} as Rules['cases'];
  for (const s of SEVERITIES) {
    const d = DEFAULT_RULES.cases[s], v = r.cases?.[s] ?? {};
    // ("national" was this choice's old name)
    cases[s] = { take: num(v.take, d.take, 'cases.take'), resolve: num(v.resolve, d.resolve, 'cases.resolve'), onMiss: v.onMiss === 'stay' ? 'stay' : 'up' };
  }
  cases.reopenMin = num(r.cases?.reopenMin, DEFAULT_RULES.cases.reopenMin, 'cases.reopenMin');
  const routing: Rules['routing'] = {};
  for (const c of ROUTABLE) {
    const v = r.routing?.[c.code];
    if (!v) continue;
    const o: Rules['routing'][string] = {};
    if (QUEUE_KINDS.includes(v.queue)) o.queue = v.queue;
    if (SEVERITIES.includes(v.severity)) o.severity = v.severity;
    if (o.queue || o.severity) routing[c.code] = o;
  }
  const group = <K extends 'team' | 'callbacks' | 'alerts' | 'results'>(k: K): Rules[K] =>
    Object.fromEntries(Object.entries(DEFAULT_RULES[k]).map(([f, d]) => [f, num(r[k]?.[f], d as number, `${k}.${f}`)])) as Rules[K];
  const bool = (v: any, d: boolean) => (typeof v === 'boolean' ? v : d);
  const staffing = { useShifts: bool(r.staffing?.useShifts, true), autoAssign: bool(r.staffing?.autoAssign, true) };
  return { cases, routing, team: group('team'), callbacks: group('callbacks'), alerts: group('alerts'), results: group('results'), staffing };
}

/**
 * Checks a full set of rules sent by an admin. Returns the problems in plain words (empty when fine).
 * Unlike rulesOf, nothing is quietly replaced: the admin sees what was wrong.
 */
export function rulesProblems(r: any): string[] {
  const out: string[] = [];
  const check = (v: any, path: string, label: string) => {
    const [lo, hi] = LIMITS[path];
    if (!Number.isInteger(v) || v < lo || v > hi) out.push(`${label} must be a whole number from ${lo} to ${hi}`);
  };
  if (!r || typeof r !== 'object') return ['Rules are missing'];
  for (const s of SEVERITIES) {
    const v = r.cases?.[s];
    const name = s[0].toUpperCase() + s.slice(1);
    if (!v) { out.push(`${name} case timings are missing`); continue; }
    check(v.take, 'cases.take', `${name}: take within`);
    check(v.resolve, 'cases.resolve', `${name}: resolve within`);
    if (Number.isInteger(v.take) && Number.isInteger(v.resolve) && v.resolve < v.take) out.push(`${name}: resolve time can't be shorter than take time`);
    if (!['up', 'stay', 'national'].includes(v.onMiss)) out.push(`${name}: choose what happens when time runs out`);
  }
  check(r.cases?.reopenMin, 'cases.reopenMin', 'Reopen window');
  for (const [code, v] of Object.entries<any>(r.routing ?? {})) {
    if (!ROUTABLE.some((c) => c.code === code)) { out.push(`Unknown report type ${code}`); continue; }
    if (v?.queue !== undefined && !QUEUE_KINDS.includes(v.queue)) out.push(`${code}: unknown team ${v.queue}`);
    if (v?.severity !== undefined && !SEVERITIES.includes(v.severity)) out.push(`${code}: unknown severity ${v.severity}`);
  }
  const labels: Record<string, string> = {
    'team.silentMin': 'Silent after', 'team.turnoutMin': 'No turnout update after', 'team.snoozeMin': 'Followed-up people come back after',
    'callbacks.unitMin': 'Callback about a polling unit', 'callbacks.otherMin': 'Other callbacks', 'callbacks.retryMin': 'Retry a missed callback after',
    'alerts.smsAfterMin': 'SMS after', 'results.estimateMinUnits': 'Units needed for an estimate', 'results.estimatePct': 'Share of units needed for an estimate',
  };
  for (const k of ['useShifts', 'autoAssign']) {
    if (typeof r.staffing?.[k] !== 'boolean') out.push(k === 'useShifts' ? 'Choose whether to use shifts' : 'Choose whether to assign cases automatically');
  }
  for (const [path, label] of Object.entries(labels)) {
    const [k, f] = path.split('.');
    check(r[k]?.[f], path, label);
  }
  return out;
}

/** Plain-words list of what changed, for the audit log. */
export function rulesChanges(before: Rules, after: Rules): string[] {
  const out: string[] = [];
  const walk = (a: any, b: any, path: string) => {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const k of keys) {
      const p = path ? `${path}.${k}` : k;
      const x = a?.[k], y = b?.[k];
      if ((x && typeof x === 'object') || (y && typeof y === 'object')) walk(x, y, p);
      else if (x !== y) out.push(`${p}: ${x ?? 'default'} → ${y ?? 'default'}`);
    }
  };
  walk(before, after, '');
  return out;
}
