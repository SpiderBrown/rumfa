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
  sms: string;           // 1-2 letter code used in the SMS fallback
  label: string;
  severity: Severity;    // default severity
  queue: QueueKind;
  related?: string[];    // categories suggested as related at the same unit
}

// Draft taxonomy; to be approved by the campaign before go-live.
export const INCIDENT_CATEGORIES: IncidentCategory[] = [
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
