// GENERATED from shared/src/index.ts by scripts/sync-shared.sh. Do not edit.
// Shared constants and pure functions used by the agent app, the dashboard,
// the Edge Functions (Deno) and the Node worker.
// Keep this file dependency-free and self-contained (no imports), so every
// runtime can load it as-is.

// ---------------------------------------------------------------------------
// Roles and levels
// ---------------------------------------------------------------------------

export const ROLES = [
  'agent',        // polling-unit agent
  'volunteer',    // ward/unit volunteer without agent accreditation
  'coordinator',  // ward, LGA or state coordinator (level says which)
  'operator',     // situation room operator
  'supervisor',   // situation room supervisor / team lead
  'analyst',      // results analyst
  'legal',        // legal desk
  'security',     // security liaison
  'voice_ops',    // voice outreach operator
  'admin',
] as const;
export type Role = (typeof ROLES)[number];

export const LEVELS = ['pu', 'ward', 'lga', 'state', 'national'] as const;
export type Level = (typeof LEVELS)[number];

// ---------------------------------------------------------------------------
// Polling unit codes: SS-LL-WW-PPP (INEC state, LGA, ward, unit)
// ---------------------------------------------------------------------------

const PU_RE = /^(\d{2})-(\d{2})-(\d{2})-(\d{3})$/;

export interface PuParts { state: string; lga: string; ward: string; pu: string }

export function parsePuCode(code: string): PuParts | null {
  const m = PU_RE.exec(code.trim());
  if (!m) return null;
  return { state: m[1], lga: m[2], ward: m[3], pu: m[4] };
}

export function normalisePuCode(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length !== 9) return null;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

export function wardCodeOf(puCode: string): string { return puCode.slice(0, 8); }
export function lgaCodeOf(code: string): string { return code.slice(0, 5); }
export function stateCodeOf(code: string): string { return code.slice(0, 2); }

/** Area code of a unit at a given level, e.g. ('19-28-02-003','lga') -> '19-28'. */
export function areaAt(puCode: string, level: Level): string {
  switch (level) {
    case 'pu': return puCode;
    case 'ward': return wardCodeOf(puCode);
    case 'lga': return lgaCodeOf(puCode);
    case 'state': return stateCodeOf(puCode);
    case 'national': return 'NG';
  }
}

// ---------------------------------------------------------------------------
// Incidents, severities and deadlines
// ---------------------------------------------------------------------------

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export function severityRank(s: Severity): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[s];
}
export function maxSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/** Minutes to acknowledge and to resolve, per severity. */
export const SLA: Record<Severity, { ackMin: number; resolveMin: number }> = {
  critical: { ackMin: 2, resolveMin: 10 },
  high: { ackMin: 5, resolveMin: 20 },
  medium: { ackMin: 15, resolveMin: 45 },
  low: { ackMin: 30, resolveMin: 120 },
};

export type QueueKind = 'state' | 'security' | 'legal' | 'helpdesk' | 'national';

export interface IncidentCategory {
  code: string;          // stable code stored in the database and SMS
  sms: string;           // 1-3 letter code used in the SMS fallback
  label: string;
  severity: Severity;    // default severity
  queue: QueueKind;
  related?: string[];    // categories suggested as related at the same unit
}

// Draft taxonomy; to be approved by the campaign before go-live.
export const INCIDENT_CATEGORIES: IncidentCategory[] = [
  // Sent by holding SOS in the agent app, before saying what is happening (the agent may add that after)
  { code: 'sos', sms: 'SOS', label: 'Emergency (SOS)', severity: 'critical', queue: 'security' },
  { code: 'violence', sms: 'V', label: 'Violence or attack', severity: 'critical', queue: 'security' },
  { code: 'ballot_snatching', sms: 'BS', label: 'Ballot box snatching', severity: 'critical', queue: 'security' },
  { code: 'thugs', sms: 'TH', label: 'Thugs or intimidation', severity: 'high', queue: 'security' },
  { code: 'agent_denied', sms: 'AD', label: 'Our agent denied entry', severity: 'high', queue: 'legal' },
  { code: 'vote_buying', sms: 'VB', label: 'Vote buying observed', severity: 'medium', queue: 'legal' },
  { code: 'materials_late', sms: 'ML', label: 'Materials or officials not arrived', severity: 'medium', queue: 'state', related: ['bvas_failure', 'voters_turned_away'] },
  { code: 'bvas_failure', sms: 'BF', label: 'BVAS not working', severity: 'high', queue: 'state', related: ['voters_turned_away', 'materials_late'] },
  { code: 'voters_turned_away', sms: 'VT', label: 'Voters turned away', severity: 'high', queue: 'state', related: ['bvas_failure'] },
  { code: 'result_not_posted', sms: 'RP', label: 'Result (EC60E) not posted', severity: 'medium', queue: 'legal' },
  { code: 'result_dispute', sms: 'RD', label: 'Dispute over result sheet', severity: 'high', queue: 'legal' },
  { code: 'upload_failed', sms: 'UF', label: 'Result not uploaded to IReV', severity: 'medium', queue: 'legal' },
  { code: 'app_problem', sms: 'AP', label: 'App or phone problem', severity: 'low', queue: 'helpdesk' },
  { code: 'other', sms: 'O', label: 'Other', severity: 'medium', queue: 'state' },
];

export function categoryByCode(code: string): IncidentCategory | undefined {
  return INCIDENT_CATEGORIES.find((c) => c.code === code);
}
export function categoryBySms(sms: string): IncidentCategory | undefined {
  return INCIDENT_CATEGORIES.find((c) => c.sms === sms.toUpperCase());
}

export const CALLBACK_REASONS = [
  { code: 'form', sms: 'F', label: 'Question about a form' },
  { code: 'unit', sms: 'U', label: 'Problem at my polling unit' },
  { code: 'app', sms: 'A', label: 'App or phone problem' },
  { code: 'other', sms: 'O', label: 'Other' },
] as const;

/** Minutes before a callback request escalates, by reason. */
export function callbackDueMinutes(reason: string): number {
  return reason === 'unit' ? 5 : 10;
}

// Merge windows (settings; tuned at the dry run)
export const MERGE_WINDOW_MIN = 60;
export const REOPEN_WINDOW_MIN = 120;
export const RELATED_WINDOW_MIN = 30;

// ---------------------------------------------------------------------------
// Results arithmetic
// ---------------------------------------------------------------------------

export interface ResultFigures {
  registered: number;
  accredited: number;
  rejected: number;
  totalValid: number;
  votes: Record<string, number>; // party acronym -> votes
}

export interface CheckIssue { code: string; message: string }

export function checkResult(r: ResultFigures): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const sum = Object.values(r.votes).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries({ registered: r.registered, accredited: r.accredited, rejected: r.rejected, totalValid: r.totalValid })) {
    if (!Number.isInteger(v) || v < 0) issues.push({ code: 'bad_number', message: `${k} must be a whole number` });
  }
  if (sum !== r.totalValid) issues.push({ code: 'sum_mismatch', message: `Party votes add up to ${sum}, but total valid votes is ${r.totalValid}` });
  if (r.totalValid + r.rejected > r.accredited) issues.push({ code: 'over_accredited', message: `Valid + rejected (${r.totalValid + r.rejected}) is more than accredited voters (${r.accredited})` });
  if (r.accredited > r.registered) issues.push({ code: 'over_registered', message: `Accredited (${r.accredited}) is more than registered voters (${r.registered})` });
  return issues;
}

/** Field-by-field comparison of two result sheets. Returns the differing fields. */
export function diffResults(a: ResultFigures, b: ResultFigures): string[] {
  const out: string[] = [];
  for (const k of ['registered', 'accredited', 'rejected', 'totalValid'] as const) if (a[k] !== b[k]) out.push(k);
  const parties = new Set([...Object.keys(a.votes), ...Object.keys(b.votes)]);
  for (const p of parties) if ((a.votes[p] ?? 0) !== (b.votes[p] ?? 0)) out.push(`votes.${p}`);
  return out;
}

// ---------------------------------------------------------------------------
// SMS fallback codec
// ---------------------------------------------------------------------------
// The app builds these messages from the saved form; agents never type them.
//
// Result:   R1 19-28-02-003 V2 RG607 AC265 RJ0 TV265 APC83 NNPP149 PDP32 ADP1 K7F3 C42
//   R1 = result message, format 1; V = submission version; RG registered;
//   AC accredited; RJ rejected; TV total valid; then PARTY<votes>;
//   K agent code; C checksum (2 digits).
// Incident: I1 19-28-02-003 TBF SH K7F3 C17         (T category, S severity letter)
// Callback: B1 RU K7F3 C55                           (R reason letter)

const SEV_LETTER: Record<Severity, string> = { critical: 'C', high: 'H', medium: 'M', low: 'L' };
const LETTER_SEV: Record<string, Severity> = { C: 'critical', H: 'high', M: 'medium', L: 'low' };

/** Two-digit checksum over the message body (weighted char sum mod 97). */
export function smsChecksum(body: string): string {
  let s = 0;
  const t = body.replace(/\s+/g, ' ').trim().toUpperCase();
  for (let i = 0; i < t.length; i++) s = (s + t.charCodeAt(i) * ((i % 7) + 1)) % 97;
  return String(s).padStart(2, '0');
}

function seal(body: string): string {
  return `${body} C${smsChecksum(body)}`;
}

export interface ResultSms extends ResultFigures { kind: 'result'; puCode: string; version: number; agentCode: string }
export interface IncidentSms { kind: 'incident'; puCode: string; category: string; severity: Severity; agentCode: string }
export interface CallbackSms { kind: 'callback'; reason: string; agentCode: string }
export type DecodedSms = ResultSms | IncidentSms | CallbackSms;

const RESERVED = new Set(['RG', 'AC', 'RJ', 'TV']);

export function encodeResultSms(r: Omit<ResultSms, 'kind'>): string {
  const parts = [`R1 ${r.puCode} V${r.version}`, `RG${r.registered}`, `AC${r.accredited}`, `RJ${r.rejected}`, `TV${r.totalValid}`];
  for (const [party, v] of Object.entries(r.votes)) {
    const p = party.toUpperCase().replace(/[^A-Z]/g, '');
    if (!p || RESERVED.has(p) || p === 'K' || p === 'C' || p === 'V') throw new Error(`Party code not allowed in SMS: ${party}`);
    parts.push(`${p}${v}`);
  }
  parts.push(`K${r.agentCode}`);
  return seal(parts.join(' '));
}

export function encodeIncidentSms(i: Omit<IncidentSms, 'kind'>): string {
  const cat = categoryByCode(i.category);
  if (!cat) throw new Error(`Unknown category ${i.category}`);
  return seal(`I1 ${i.puCode} T${cat.sms} S${SEV_LETTER[i.severity]} K${i.agentCode}`);
}

export function encodeCallbackSms(c: Omit<CallbackSms, 'kind'>): string {
  const r = CALLBACK_REASONS.find((x) => x.code === c.reason);
  if (!r) throw new Error(`Unknown reason ${c.reason}`);
  return seal(`B1 R${r.sms} K${c.agentCode}`);
}

export class SmsDecodeError extends Error {}

export function decodeSms(text: string): DecodedSms {
  const t = text.replace(/\s+/g, ' ').trim().toUpperCase();
  const m = /^(.*) C(\d{2})$/.exec(t);
  if (!m) throw new SmsDecodeError('Missing checksum');
  const [, body, sum] = m;
  if (smsChecksum(body) !== sum) throw new SmsDecodeError('Checksum does not match');
  const tok = body.split(' ');
  const agentTok = tok.pop() ?? '';
  if (!/^K[A-Z0-9]{3,8}$/.test(agentTok)) throw new SmsDecodeError('Missing agent code');
  const agentCode = agentTok.slice(1);
  const head = tok.shift();

  if (head === 'R1') {
    const puCode = tok.shift() ?? '';
    if (!parsePuCode(puCode)) throw new SmsDecodeError('Bad polling unit code');
    const ver = tok.shift() ?? '';
    if (!/^V\d+$/.test(ver)) throw new SmsDecodeError('Missing version');
    const out: ResultSms = { kind: 'result', puCode, version: Number(ver.slice(1)), agentCode, registered: NaN, accredited: NaN, rejected: NaN, totalValid: NaN, votes: {} };
    for (const x of tok) {
      const mm = /^([A-Z]+)(\d+)$/.exec(x);
      if (!mm) throw new SmsDecodeError(`Bad field ${x}`);
      const [, k, v] = mm;
      const n = Number(v);
      if (k === 'RG') out.registered = n;
      else if (k === 'AC') out.accredited = n;
      else if (k === 'RJ') out.rejected = n;
      else if (k === 'TV') out.totalValid = n;
      else out.votes[k] = n;
    }
    if ([out.registered, out.accredited, out.rejected, out.totalValid].some((n) => Number.isNaN(n))) throw new SmsDecodeError('Missing header figure');
    return out;
  }
  if (head === 'I1') {
    const puCode = tok.shift() ?? '';
    if (!parsePuCode(puCode)) throw new SmsDecodeError('Bad polling unit code');
    const catTok = tok.shift() ?? '';
    const sevTok = tok.shift() ?? '';
    const cat = catTok.startsWith('T') ? categoryBySms(catTok.slice(1)) : undefined;
    const sev = sevTok.startsWith('S') ? LETTER_SEV[sevTok.slice(1)] : undefined;
    if (!cat || !sev) throw new SmsDecodeError('Bad category or severity');
    return { kind: 'incident', puCode, category: cat.code, severity: sev, agentCode };
  }
  if (head === 'B1') {
    const rTok = tok.shift() ?? '';
    const r = CALLBACK_REASONS.find((x) => `R${x.sms}` === rTok);
    if (!r) throw new SmsDecodeError('Bad reason');
    return { kind: 'callback', reason: r.code, agentCode };
  }
  throw new SmsDecodeError('Unknown message type');
}

// ---------------------------------------------------------------------------
// Nigerian phone numbers
// ---------------------------------------------------------------------------

/** Normalise to E.164 (+234...). Returns null if not a valid Nigerian mobile. */
export function normaliseNgPhone(raw: string): string | null {
  let d = raw.replace(/[^0-9+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('234')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  if (!/^[789][01]\d{8}$/.test(d)) return null;
  return `+234${d}`;
}

// ---------------------------------------------------------------------------
// Situation-room map colours (dashboard and agent app use the same rules)
// ---------------------------------------------------------------------------

export interface AreaIssues { open: number; critical: number; high: number; medium: number; low: number }
export type MapLayer = 'issues' | 'votes' | 'reporting';

/** Weighted open-issue score: a critical case outweighs several minor ones. */
export function issueScore(i: AreaIssues): number {
  return i.critical * 8 + i.high * 4 + i.medium * 2 + i.low;
}

/** Issue heat bands, calm to severe. Any open critical case shows as the darkest band. */
export const ISSUE_BANDS = [
  { label: 'No open issues', colour: '#dfeee2' },
  { label: 'Minor', colour: '#fde68a' },
  { label: 'Several', colour: '#fb923c' },
  { label: 'Serious', colour: '#e5484d' },
  { label: 'Critical open', colour: '#8f1d1d' },
] as const;

export function issueBand(i: AreaIssues): number {
  if (i.critical > 0) return 4;
  const s = issueScore(i);
  return s === 0 ? 0 : s <= 3 ? 1 : s <= 9 ? 2 : 3;
}

/** Distinct, party-neutral colours given out in ballot order; a client can set its own per party. */
const PARTY_PALETTE = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777', '#4b5563', '#65a30d'];
export function partyColour(party: string, ballotOrder: string[], overrides: Record<string, string> = {}): string {
  if (overrides[party]) return overrides[party];
  const i = ballotOrder.indexOf(party);
  if (i >= 0) return PARTY_PALETTE[i % PARTY_PALETTE.length];
  let h = 0;
  for (const c of party) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PARTY_PALETTE[h % PARTY_PALETTE.length];
}

/** Votes layer: stronger fill for a wider lead (margin is the lead over second place as a share of votes). */
export function leadOpacity(margin: number): number {
  return Math.round((0.3 + 0.6 * Math.min(1, Math.max(0, margin) * 2.5)) * 100) / 100;
}

/** Reporting layer: share of polling units with a result, in five blue steps. */
export const REPORTING_BANDS = ['#eef2f7', '#c6dbef', '#9ecae1', '#4292c6', '#08519c'] as const;
export function reportingBand(reported: number, units: number): number {
  if (!units || !reported) return 0;
  const r = reported / units;
  return r < 0.25 ? 1 : r < 0.5 ? 2 : r < 0.9 ? 3 : 4;
}

// ---------------------------------------------------------------------------
// Check-in location: is the agent within their own area?
// ---------------------------------------------------------------------------

export type Geo = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] };

/** Metres between two points (haversine). */
export function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(h)));
}

function inRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Is the point inside a GeoJSON polygon or multipolygon (holes respected)? */
export function pointInGeometry(lat: number, lng: number, g: Geo): boolean {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.some(([outer, ...holes]) => inRing(lng, lat, outer) && !holes.some((h) => inRing(lng, lat, h)));
}

/**
 * What a check-in is compared against, best first: the ward outline; else the polling unit's own position
 * (within UNIT_RADIUS_M); else the LGA outline; else the state outline. Whichever the data has.
 */
export interface CheckinFence {
  level: 'ward' | 'unit' | 'lga' | 'state';
  code: string;
  name: string;
  geometry?: Geo | null;
  center?: { lat: number; lng: number } | null;
}
export const UNIT_RADIUS_M = 1500;

export interface CheckinJudgement { inside: boolean | null; distance: number | null; against: CheckinFence['level'] | null }

/** inside: true/false, or null when there is no location or nothing to compare with. */
export function judgeCheckin(fence: CheckinFence | null | undefined, pos: { lat?: number | null; lng?: number | null }): CheckinJudgement {
  if (!fence) return { inside: null, distance: null, against: null };
  if (pos.lat == null || pos.lng == null) return { inside: null, distance: null, against: fence.level };
  const p = { lat: pos.lat, lng: pos.lng };
  const distance = fence.center ? metres(p, fence.center) : null;
  if (fence.level === 'unit') return { inside: distance != null && distance <= UNIT_RADIUS_M, distance, against: 'unit' };
  if (!fence.geometry) return { inside: null, distance, against: fence.level };
  return { inside: pointInGeometry(p.lat, p.lng, fence.geometry), distance, against: fence.level };
}

// ---------------------------------------------------------------------------
// Place names for display
// ---------------------------------------------------------------------------

const ROMAN = /^(i{1,3}|iv|v|vi{1,3}|ix|x{1,3})$/i;
// Common short forms in INEC unit and ward names, kept in capitals
const ABBREV = new Set(['FCT', 'LGA', 'LGEA', 'UBE', 'JSS', 'SSS', 'GSS', 'GDSS', 'GJSS', 'GGSS', 'GSSS', 'LEA', 'PS', 'PRY', 'NYSC', 'ECWA', 'RCM', 'CAC', 'UMCA', 'NEPA', 'NITEL', 'NNPC', 'PHC', 'MCH', 'GRA', 'II', 'III']);

/**
 * Tidies a place name for people to read: INEC lists are often in capitals ("TUDUN WADA" -> "Tudun Wada"),
 * keeping roman numerals ("Laru II") and the usual short forms ("LGEA Pri. Sch.") as they are written.
 */
export function placeName(raw: string | null | undefined): string {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const shouting = s === s.toUpperCase() && /[A-Z]{3}/.test(s);
  return s.replace(/[A-Za-z][A-Za-z']*/g, (w) => {
    if (ROMAN.test(w)) return w.toUpperCase();
    if (!shouting) return w;
    if (ABBREV.has(w.toUpperCase())) return w.toUpperCase();
    return w[0].toUpperCase() + w.slice(1).toLowerCase();
  });
}

// ---------------------------------------------------------------------------
// Polling-day figures (EC8A summary, sent stage by stage)
// ---------------------------------------------------------------------------

/** EC8A summary figures by item number. `used` (item 8) is spoiled + rejected + total valid. */
export interface UnitFigures {
  registered?: number;        // 1 voters on the register
  accredited?: number;        // 2 accredited voters
  ballots_received?: number;  // 3 ballot papers issued to the polling unit
  unused?: number;            // 4 unused ballot papers
  spoiled?: number;           // 5 spoiled ballot papers
  rejected?: number;          // 6 rejected ballots
  total_valid?: number;       // 7 total valid votes
  used?: number;              // 8 total used ballot papers, as announced (when it differs from 5 + 6 + 7)
}
export const UNIT_FIGURE_ITEMS: { key: keyof UnitFigures; item: number; label: string }[] = [
  { key: 'registered', item: 1, label: 'Voters on the register' },
  { key: 'accredited', item: 2, label: 'Accredited voters' },
  { key: 'ballots_received', item: 3, label: 'Ballot papers issued to the polling unit' },
  { key: 'unused', item: 4, label: 'Unused ballot papers' },
  { key: 'spoiled', item: 5, label: 'Spoiled ballot papers' },
  { key: 'rejected', item: 6, label: 'Rejected ballots' },
  { key: 'total_valid', item: 7, label: 'Total valid votes' },
  { key: 'used', item: 8, label: 'Total used ballot papers' },
];
export const UNIT_FIGURE_KEYS = UNIT_FIGURE_ITEMS.map((i) => i.key);

const has = (n: number | undefined | null): n is number => typeof n === 'number' && Number.isFinite(n);

/** Item 8 as it should be: spoiled + rejected + total valid (null until all three are known). */
export function usedBallots(f: UnitFigures): number | null {
  return has(f.spoiled) && has(f.rejected) && has(f.total_valid) ? f.spoiled + f.rejected + f.total_valid : null;
}

export type FigureFlag =
  | 'over_registered' | 'over_accredited' | 'ballots_unbalanced' | 'used_mismatch'
  | 'very_high_turnout' | 'low_turnout' | 'stronghold_low_turnout' | 'accreditation_dropped';

export interface FigureFlagResult { flag: FigureFlag; message: string; details: Record<string, unknown> }

/** Thresholds for turnout flags (share of the register). */
export const TURNOUT = { veryHigh: 0.9, veryLow: 0.1, strongholdFraction: 0.5, strongholdShare: 0.5, minRegister: 50 };

/**
 * Problems shown by a unit's figures. Used on the phone (as warnings while typing) and on the server (as flags
 * raised to the situation room). `final` means accreditation has closed (close-of-poll or result figures).
 * `baseline` is the same unit in the previous election, when known; `previousAccredited` the last figure sent.
 */
export function figureFlags(f: UnitFigures, opts: {
  final?: boolean; previousAccredited?: number | null;
  baseline?: { turnout: number | null; ownShare: number | null } | null;
} = {}): FigureFlagResult[] {
  const out: FigureFlagResult[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (has(f.accredited) && has(f.registered) && f.accredited > f.registered) {
    out.push({ flag: 'over_registered', message: `Accredited (${f.accredited}) is more than voters on the register (${f.registered})`,
      details: { accredited: f.accredited, registered: f.registered } });
  }
  if (has(f.accredited) && has(f.rejected) && has(f.total_valid) && f.rejected + f.total_valid > f.accredited) {
    out.push({ flag: 'over_accredited', message: `Rejected + valid (${f.rejected + f.total_valid}) is more than accredited voters (${f.accredited})`,
      details: { accredited: f.accredited, counted: f.rejected + f.total_valid } });
  }
  const used = usedBallots(f);
  if (used !== null && has(f.unused) && has(f.ballots_received) && used + f.unused !== f.ballots_received) {
    out.push({ flag: 'ballots_unbalanced',
      message: `Used (${used}) + unused (${f.unused}) = ${used + f.unused}, but ${f.ballots_received} ballot papers were issued`,
      details: { received: f.ballots_received, used, unused: f.unused, difference: used + f.unused - f.ballots_received } });
  }
  if (used !== null && has(f.used) && f.used !== used) {
    out.push({ flag: 'used_mismatch', message: `Announced used ballot papers (${f.used}) differ from spoiled + rejected + valid (${used})`,
      details: { announced: f.used, computed: used } });
  }
  if (has(opts.previousAccredited) && has(f.accredited) && f.accredited < opts.previousAccredited) {
    out.push({ flag: 'accreditation_dropped', message: `Accredited went down from ${opts.previousAccredited} to ${f.accredited}`,
      details: { before: opts.previousAccredited, now: f.accredited } });
  }
  if (opts.final && has(f.accredited) && has(f.registered) && f.registered >= TURNOUT.minRegister && f.accredited <= f.registered) {
    const turnout = f.accredited / f.registered;
    if (turnout > TURNOUT.veryHigh) {
      out.push({ flag: 'very_high_turnout', message: `Turnout ${pct(turnout)} of the register`, details: { turnout } });
    }
    if (turnout < TURNOUT.veryLow) {
      out.push({ flag: 'low_turnout', message: `Turnout only ${pct(turnout)} of the register`, details: { turnout } });
    }
    const b = opts.baseline;
    if (b && has(b.turnout) && has(b.ownShare) && b.ownShare >= TURNOUT.strongholdShare && turnout < b.turnout * TURNOUT.strongholdFraction) {
      out.push({ flag: 'stronghold_low_turnout',
        message: `Turnout ${pct(turnout)}, less than half of last time (${pct(b.turnout)}) in a unit where we had ${pct(b.ownShare)} of the votes`,
        details: { turnout, baselineTurnout: b.turnout, ownShare: b.ownShare } });
    }
  }
  return out;
}
