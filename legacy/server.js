// ALAWA Ground Game — zero-dependency server (Node >= 22.13: node:http + node:sqlite)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { extname, join, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const TEAM_CODE = process.env.TEAM_CODE || 'alawa-team';   // shared with verified volunteers
const ADMIN_CODE = process.env.ADMIN_CODE || 'alawa-admin'; // leadership only
const ELECTION_DATE = process.env.ELECTION_DATE || '2027-01-16T08:30:00+01:00';
if (!process.env.TEAM_CODE || !process.env.ADMIN_CODE) {
  console.warn('⚠️  Using default TEAM_CODE/ADMIN_CODE — set them in the environment before going live.');
}

export const STATES = ['Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno','Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','FCT','Gombe','Imo','Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara','Lagos','Nasarawa','Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers','Sokoto','Taraba','Yobe','Zamfara'];
const ROLES = ['canvasser','ward_coordinator','lga_coordinator','state_coordinator','transport','media'];
const PVC = ['yes','no','collecting'];
const STATUSES = ['pledged','reminded','voted'];
const CATEGORIES = ['economy','education','infrastructure','welfare','security','agriculture','other'];

// ---------- database ----------
const db = new DatabaseSync(process.env.DB_PATH || 'alawa.db');
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS volunteers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL, lga TEXT NOT NULL, ward TEXT NOT NULL, polling_unit TEXT,
  role TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS supporters (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT,
  state TEXT NOT NULL, lga TEXT NOT NULL, ward TEXT NOT NULL, polling_unit TEXT,
  has_pvc TEXT NOT NULL, needs_transport INTEGER NOT NULL DEFAULT 0,
  consent_reminders INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pledged',
  volunteer_phone TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, body_en TEXT NOT NULL, body_ha TEXT,
  category TEXT NOT NULL, source_url TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, date TEXT NOT NULL,
  state TEXT NOT NULL, location TEXT NOT NULL, details TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

// Seed draft fact cards (unpublished: leadership must verify wording & sources before publishing)
if (db.prepare('SELECT COUNT(*) n FROM facts').get().n === 0) {
  const ins = db.prepare('INSERT INTO facts (title, body_en, category, source_url) VALUES (?,?,?,?)');
  ins.run('Student Loans for Nigerian youths',
    'The Student Loans Act created NELFUND, giving interest-free loans to students in public tertiary institutions. VERIFY figures before publishing.',
    'education', 'https://nelf.gov.ng');
  ins.run('New national minimum wage',
    'The national minimum wage was raised to ₦70,000 in 2024. VERIFY wording before publishing.',
    'welfare', 'https://statehouse.gov.ng');
  ins.run('Lagos–Calabar Coastal Highway',
    'A major coastal highway project linking southern states to boost trade and jobs. VERIFY current status before publishing.',
    'infrastructure', 'https://statehouse.gov.ng');
}

// ---------- helpers ----------
const send = (res, code, data, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
};
const fail = (res, code, error) => send(res, code, { error });

const safeEq = (a = '', b = '') => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const isAdmin = (req) => safeEq(req.headers['x-admin-code'], ADMIN_CODE);
const isTeam = (req) => isAdmin(req) || safeEq(req.headers['x-team-code'], TEAM_CODE);

// Normalise Nigerian numbers to +234XXXXXXXXXX; returns null if invalid
export function normPhone(p) {
  if (!p) return null;
  let d = String(p).replace(/\D/g, '');
  if (d.startsWith('234')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return /^[789]\d{9}$/.test(d) ? '+234' + d : null;
}
const str = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 50_000) throw new Error('too large'); }
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('bad json'); }
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s; // block spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ---------- API ----------
async function api(req, res, url) {
  const { pathname: p, searchParams: q } = url;
  const m = req.method;

  if (m === 'GET' && p === '/api/meta')
    return send(res, 200, { states: STATES, roles: ROLES, categories: CATEGORIES, electionDate: ELECTION_DATE });

  if (m === 'POST' && p === '/api/auth') {
    const b = await body(req);
    if (safeEq(b.code, ADMIN_CODE)) return send(res, 200, { level: 'admin' });
    if (safeEq(b.code, TEAM_CODE)) return send(res, 200, { level: 'team' });
    return fail(res, 401, 'Invalid code');
  }

  if (m === 'GET' && p === '/api/stats') {
    const one = (sql) => db.prepare(sql).get().n;
    const byState = db.prepare(`
      SELECT s.state,
        (SELECT COUNT(*) FROM volunteers v WHERE v.state = s.state) volunteers,
        COUNT(s.id) supporters,
        SUM(s.has_pvc = 'yes') with_pvc,
        SUM(s.status = 'voted') voted,
        COUNT(DISTINCT s.ward) wards
      FROM supporters s GROUP BY s.state
      UNION ALL
      SELECT v.state, COUNT(*), 0, 0, 0, 0 FROM volunteers v
      WHERE v.state NOT IN (SELECT state FROM supporters) GROUP BY v.state
      ORDER BY supporters DESC, volunteers DESC`).all();
    return send(res, 200, {
      volunteers: one('SELECT COUNT(*) n FROM volunteers'),
      supporters: one('SELECT COUNT(*) n FROM supporters'),
      withPvc: one("SELECT COUNT(*) n FROM supporters WHERE has_pvc = 'yes'"),
      needPvcHelp: one("SELECT COUNT(*) n FROM supporters WHERE has_pvc != 'yes'"),
      needTransport: one('SELECT COUNT(*) n FROM supporters WHERE needs_transport = 1'),
      voted: one("SELECT COUNT(*) n FROM supporters WHERE status = 'voted'"),
      wardsCovered: one("SELECT COUNT(DISTINCT state || '|' || lga || '|' || ward) n FROM volunteers"),
      byState,
    });
  }

  if (m === 'POST' && p === '/api/volunteers') {
    const b = await body(req);
    const phone = normPhone(b.phone);
    const v = { name: str(b.name), state: str(b.state), lga: str(b.lga), ward: str(b.ward), pu: str(b.polling_unit), role: str(b.role) };
    if (!b.consent) return fail(res, 400, 'Consent is required to register');
    if (!v.name || !phone || !STATES.includes(v.state) || !v.lga || !v.ward || !ROLES.includes(v.role))
      return fail(res, 400, 'Please fill all required fields with a valid Nigerian phone number');
    try {
      db.prepare('INSERT INTO volunteers (name, phone, state, lga, ward, polling_unit, role) VALUES (?,?,?,?,?,?,?)')
        .run(v.name, phone, v.state, v.lga, v.ward, v.pu, v.role);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return fail(res, 409, 'This phone number is already registered');
      throw e;
    }
    return send(res, 201, { ok: true });
  }

  if (m === 'GET' && p === '/api/volunteers') {
    if (!isAdmin(req)) return fail(res, 401, 'Admin code required');
    return send(res, 200, db.prepare('SELECT * FROM volunteers ORDER BY id DESC LIMIT 500').all());
  }

  if (m === 'POST' && p === '/api/supporters') {
    if (!isTeam(req)) return fail(res, 401, 'Team code required');
    const b = await body(req);
    const vphone = normPhone(b.volunteer_phone);
    const phone = b.phone ? normPhone(b.phone) : null;
    const s = { name: str(b.name), state: str(b.state), lga: str(b.lga), ward: str(b.ward), pu: str(b.polling_unit), pvc: str(b.has_pvc) };
    if (!vphone || !db.prepare('SELECT 1 FROM volunteers WHERE phone = ?').get(vphone))
      return fail(res, 400, 'Your volunteer phone number is not registered — sign up first');
    if (b.phone && !phone) return fail(res, 400, 'Supporter phone number is not valid');
    if (!s.name || !STATES.includes(s.state) || !s.lga || !s.ward || !PVC.includes(s.pvc))
      return fail(res, 400, 'Please fill all required fields');
    const consent = b.consent_reminders && phone ? 1 : 0;
    db.prepare(`INSERT INTO supporters (name, phone, state, lga, ward, polling_unit, has_pvc, needs_transport, consent_reminders, volunteer_phone)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(s.name, consent ? phone : null, s.state, s.lga, s.ward, s.pu, s.pvc, b.needs_transport ? 1 : 0, consent, vphone);
    return send(res, 201, { ok: true });
  }

  if (m === 'GET' && p === '/api/supporters') {
    if (!isTeam(req)) return fail(res, 401, 'Team code required');
    const state = q.get('state') || '', lga = q.get('lga') || '', ward = q.get('ward') || '';
    if (!STATES.includes(state)) return fail(res, 400, 'Choose a state');
    const rows = db.prepare(`SELECT id, name, phone, lga, ward, polling_unit, has_pvc, needs_transport, status
      FROM supporters WHERE state = ? AND (? = '' OR lga LIKE ?) AND (? = '' OR ward LIKE ?)
      ORDER BY lga, ward, polling_unit, name LIMIT 1000`)
      .all(state, lga, `%${lga}%`, ward, `%${ward}%`);
    return send(res, 200, rows);
  }

  const sm = p.match(/^\/api\/supporters\/(\d+)$/);
  if (m === 'PATCH' && sm) {
    if (!isTeam(req)) return fail(res, 401, 'Team code required');
    const b = await body(req);
    const sets = [], vals = [];
    if (b.status !== undefined) { if (!STATUSES.includes(b.status)) return fail(res, 400, 'Bad status'); sets.push('status = ?'); vals.push(b.status); }
    if (b.has_pvc !== undefined) { if (!PVC.includes(b.has_pvc)) return fail(res, 400, 'Bad PVC value'); sets.push('has_pvc = ?'); vals.push(b.has_pvc); }
    if (!sets.length) return fail(res, 400, 'Nothing to update');
    const r = db.prepare(`UPDATE supporters SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals, Number(sm[1]));
    return r.changes ? send(res, 200, { ok: true }) : fail(res, 404, 'Not found');
  }

  if (m === 'GET' && p === '/api/export/reminders.csv') {
    if (!isAdmin(req)) return fail(res, 401, 'Admin code required');
    const rows = db.prepare(`SELECT name, phone, state, lga, ward, polling_unit, has_pvc, needs_transport, status
      FROM supporters WHERE consent_reminders = 1 AND phone IS NOT NULL ORDER BY state, lga, ward`).all();
    const cols = ['name','phone','state','lga','ward','polling_unit','has_pvc','needs_transport','status'];
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n');
    res.setHeader('Content-Disposition', 'attachment; filename="alawa-reminders.csv"');
    return send(res, 200, csv, 'text/csv; charset=utf-8');
  }

  if (m === 'GET' && p === '/api/facts') {
    const all = isAdmin(req) && q.get('all') === '1';
    return send(res, 200, db.prepare(`SELECT * FROM facts ${all ? '' : 'WHERE published = 1'} ORDER BY id DESC`).all());
  }

  if (m === 'POST' && p === '/api/facts') {
    if (!isAdmin(req)) return fail(res, 401, 'Admin code required');
    const b = await body(req);
    const f = { title: str(b.title, 140), en: str(b.body_en, 1000), ha: str(b.body_ha, 1000), cat: str(b.category), src: str(b.source_url, 500) };
    if (!f.title || !f.en || !CATEGORIES.includes(f.cat) || !/^https?:\/\//.test(f.src))
      return fail(res, 400, 'Title, English text, category and a source link (http/https) are required');
    db.prepare('INSERT INTO facts (title, body_en, body_ha, category, source_url) VALUES (?,?,?,?,?)').run(f.title, f.en, f.ha, f.cat, f.src);
    return send(res, 201, { ok: true });
  }

  const fm = p.match(/^\/api\/facts\/(\d+)$/);
  if (fm && (m === 'PATCH' || m === 'DELETE')) {
    if (!isAdmin(req)) return fail(res, 401, 'Admin code required');
    const id = Number(fm[1]);
    const r = m === 'DELETE'
      ? db.prepare('DELETE FROM facts WHERE id = ?').run(id)
      : db.prepare('UPDATE facts SET published = ? WHERE id = ?').run((await body(req)).published ? 1 : 0, id);
    return r.changes ? send(res, 200, { ok: true }) : fail(res, 404, 'Not found');
  }

  if (m === 'GET' && p === '/api/events')
    return send(res, 200, db.prepare("SELECT * FROM events WHERE date >= date('now', '-1 day') ORDER BY date LIMIT 200").all());

  if (m === 'POST' && p === '/api/events') {
    if (!isTeam(req)) return fail(res, 401, 'Team code required');
    const b = await body(req);
    const e = { title: str(b.title), kind: str(b.kind), date: str(b.date, 10), state: str(b.state), loc: str(b.location, 200), det: str(b.details, 1000) };
    if (!e.title || !['interfaith','town_hall','pvc_drive','rally','training'].includes(e.kind) || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !STATES.includes(e.state) || !e.loc)
      return fail(res, 400, 'Please fill all required fields');
    db.prepare('INSERT INTO events (title, kind, date, state, location, details) VALUES (?,?,?,?,?,?)').run(e.title, e.kind, e.date, e.state, e.loc, e.det);
    return send(res, 201, { ok: true });
  }

  return fail(res, 404, 'Not found');
}

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
async function serveStatic(res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const data = await readFile(join(import.meta.dirname, 'public', rel));
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (e) {
    const clientErr = ['too large', 'bad json'].includes(e.message);
    if (!clientErr) console.error(e);
    if (!res.headersSent) fail(res, clientErr ? 400 : 500, clientErr ? 'Invalid request' : 'Server error');
  }
}).listen(PORT, () => console.log(`ALAWA Ground Game running on http://localhost:${PORT}`));
