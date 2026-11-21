// Rumfa Console (platform staff) pages
import { consoleShell, page, ic, pill, tog } from './common.mjs';

const P = {};
const head = (eyebrow, title, lede, actions = '') => `<div class="ph"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${lede ? `<div class="lede">${lede}</div>` : ''}</div><div class="row">${actions}</div></div>`;
const C = (active, title, body) => page(title + ' · Rumfa Console', consoleShell(active, `<div class="content">${body}</div>`));

P['console-login'] = page('Sign in · Rumfa Console', `<div style="min-height:100vh;display:grid;place-items:center;background:#0E1420"><div class="card" style="width:400px;padding:28px;display:flex;flex-direction:column;gap:16px">
  <div class="row"><div class="mark" style="background:#3D4652;color:#fff">R</div><b>Rumfa Console</b></div><h1 style="font-size:22px">Platform staff sign in</h1>
  <div class="field"><label>Email</label><div class="inp">umar@rumfa.ng</div></div><div class="field"><label>Password</label><div class="inp">••••••••••</div></div>
  <span class="btn p" style="justify-content:center;padding:11px">Sign in</span><p class="small muted">Staff are added by invitation only.</p></div></div>`);

const clients = [['ALAWA', 'Party campaign · Kano', 'Governorship 2027', '9,312', ['Voice', 'Airtime'], 'Live'], ['Yiaga watch', 'Observer group · national', 'Governorship 2027', '24,105', ['Airtime'], 'Live'], ['NNPP Kaduna', 'Party · Kaduna', 'Off-cycle 2026', '3,880', [], 'Set up'], ['Civic Lens', 'Observer · Lagos', '—', '0', [], 'Invited']];
P['console-clients'] = C('clients', 'Clients', `${head('4 clients · 37,297 people', 'Clients', 'Each client has its own room, people and settings. Rumfa staff switch add-ons and limits on here.', `<span class="btn p">${ic('add')}New client</span>`)}
  <div class="card" style="overflow:hidden"><table class="tbl"><tr><th>Client</th><th>Election</th><th>People</th><th>Add-ons</th><th>Status</th><th></th></tr>
  ${clients.map(([n, d, e, p, a, s]) => `<tr><td><div class="row" style="gap:10px"><div class="mark" style="width:30px;height:30px;color:#fff;font-size:13px">${n[0]}</div><div><b>${n}</b><div class="small muted">${d}</div></div></div></td><td>${e}</td><td>${p}</td><td><div class="row" style="gap:4px">${a.length ? a.map((x) => pill('teal', x)).join('') : '<span class="muted small">None</span>'}</div></td><td>${s === 'Live' ? pill('ok', s) : s === 'Set up' ? pill('medium', s) : pill('low', s)}</td><td style="text-align:right">${ic('chevron_right')}</td></tr>`).join('')}</table></div>`);

const sRow = (label, hint, ctrl) => `<div class="row" style="padding:13px 0;border-bottom:1px solid var(--line2);gap:24px"><div class="grow"><div class="b">${label}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>${ctrl}</div>`;
const num = (v, u) => `<div class="inp num">${v}<span class="muted small">${u}</span></div>`;
P['console-client'] = C('clients', 'ALAWA', `<div class="row small"><a href="console-clients.html">${ic('arrow_back', 's')} Clients</a></div>
  ${head('Party campaign · Kano · since Sep 2026', 'ALAWA', '', `<span class="btn">${ic('login')}Open their room</span><span class="btn">${ic('pause')}Pause</span>`)}
  <div class="tabs"><span class="on">Overview</span><span>Add-ons</span><span>Limits</span><span>Admins</span><span>Activity</span></div>
  <div class="grid2" style="align-items:start">
    <div class="card"><div class="ch"><h2>Add-ons</h2><span class="small muted">Billed separately</span></div><div class="cb" style="padding-top:0">
      ${sRow(`${ic('campaign')} Voice outreach`, 'Recorded calls to supporters. 212,400 calls this month.', tog(true))}
      ${sRow(`${ic('sim_card')} Airtime and data`, 'Top-ups for agents. Wallet ₦1,240,000.', tog(true))}
      ${sRow(`${ic('videocam')} Live video from the field`, 'Room can ask an agent to stream.', tog(true))}
      ${sRow(`${ic('document_scanner')} Sheet reading`, 'Reads EC8A figures from photos and IReV.', tog(false))}</div></div>
    <div class="card"><div class="ch"><h2>Limits</h2><span class="small muted">What their admins can set in Settings</span></div><div class="cb" style="padding-top:0">
      ${sRow('People', 'Room, coordinators and agents', num('10,000', 'max'))}
      ${sRow('Shortest case timing allowed', 'Admins can\'t set "take within" lower than this.', num(1, 'min'))}
      ${sRow('Allow gallery photos', 'If off, their admins can\'t switch off the in-app camera rule.', tog(false))}
      ${sRow('SMS per day', 'Fallback SMS for alerts and announcements', num('50,000', 'max'))}
      ${sRow('Keep photos and videos for', 'Then deleted, unless pinned as key evidence', num(24, 'months'))}</div></div></div>
  <div class="kpis">${[['People', '9,312', '8,781 agents'], ['Cases today', '146', '7 open'], ['Photos today', '1,904', '98% in-app'], ['SMS today', '12,880', 'of 50,000']].map(([l, n, s]) => `<div class="kpi"><div class="l">${l}</div><div class="n">${n}</div><div class="s">${s}</div></div>`).join('')}</div>`);

P['console-onboard'] = C('clients', 'New client', `${head('Step 2 of 4', 'New client', 'Set them up in four steps. Their first admin gets an invitation at the end.')}
  <div class="row" style="gap:8px">${['Organisation', 'Election and area', 'Add-ons', 'First admin'].map((s, i) => `<div style="flex:1;padding:10px 12px;border-radius:10px;${i === 1 ? 'background:var(--teal);color:#fff' : i < 1 ? 'background:var(--tealbg);color:var(--teal)' : 'background:#fff;border:1px solid var(--line);color:var(--ink3)'};font-weight:700;font-size:13px">${i < 1 ? ic('check', 's') : i + 1 + '.'} ${s}</div>`).join('')}</div>
  <div class="card cb" style="max-width:720px;display:flex;flex-direction:column;gap:14px">
    <div class="field"><label>Election</label><div class="inp">Governorship 2027 · 15 Feb 2027 ${ic('expand_more', 's')}</div></div>
    <div class="field"><label>Where they work</label><div class="row">${['Kano', 'Jigawa'].map((s) => `<span class="chip on">${s} ${ic('close', 's')}</span>`).join('')}<span class="chip">${ic('add', 's')}Add state</span></div><div class="hint">8,074 + 3,527 polling units · places loaded for both states</div></div>
    <div class="field"><label>Their party</label><div class="inp">ALAWA ${ic('expand_more', 's')}</div></div>
    <div class="row" style="justify-content:flex-end"><span class="btn">Back</span><span class="btn p">Next: add-ons</span></div></div>`);

P['console-parties'] = C('parties', 'Parties', `${head('Shared by every client', 'Parties', 'Names and colours used on results and maps.', `<span class="btn p">${ic('add')}Add party</span>`)}
  <div class="card" style="overflow:hidden"><table class="tbl"><tr><th>Party</th><th>Short name</th><th>Colour</th><th>On ballot in</th></tr>${[['All Progressives Congress', 'APC', '#1F6FB2'], ['New Nigeria Peoples Party', 'NNPP', '#C0392B'], ['Peoples Democratic Party', 'PDP', '#2E8B57'], ['Labour Party', 'LP', '#7FBF3F'], ['African Democratic Congress', 'ADC', '#F2C94C'], ['Social Democratic Party', 'SDP', '#FFFFFF']].map(([n, s, c]) => `<tr><td class="b">${n}</td><td>${s}</td><td><span class="row" style="gap:8px"><span style="width:18px;height:18px;border-radius:5px;background:${c};box-shadow:inset 0 0 0 1px rgba(0,0,0,.15)"></span>${c}</span></td><td class="muted">All 36 states + FCT</td></tr>`).join('')}</table></div>`);

P['console-contacts'] = C('contacts', 'Authority contacts', `${head('Shown read-only in every client\'s room', 'Authority contacts', 'Police, INEC and emergency numbers, kept and checked by Rumfa staff.', `<span class="btn">${ic('upload')}Import</span><span class="btn p">${ic('add')}Add contact</span>`)}
  <div class="row"><span class="chip on">All 1,284</span><span class="chip">Not checked in 30 days 112</span><span class="chip">Kano 64</span></div>
  <div class="card" style="overflow:hidden"><table class="tbl"><tr><th>Name</th><th>Office</th><th>Area</th><th>Phone</th><th>Checked</th><th></th></tr>${[['CSP Abdullahi Musa', 'DPO · Kofar Mata', 'Kano Municipal', '0803 *** 1120', '2 days ago'], ['Hajiya Rabi Sani', 'Electoral officer · INEC', 'Nassarawa', '0806 *** 7731', '1 week ago'], ['Police control room', 'Kano state command', 'Kano', '0706 *** 0000', 'Today'], ['NSCDC duty desk', 'Civil defence', 'Kano', '0909 *** 4410', '41 days ago']].map(([n, o, a, p, c]) => `<tr><td class="b">${n}</td><td>${o}</td><td class="muted">${a}</td><td>${p}</td><td>${c.startsWith('41') ? pill('high', c) : `<span class="muted">${c}</span>`}</td><td style="text-align:right"><span class="btn sm">Mark checked</span></td></tr>`).join('')}</table></div>`);

P['console-places'] = C('places', 'Places', `${head('States, LGAs, wards, polling units', 'Places', 'Load a state from INEC\'s lists. Recent loads are under Import history, not on this page.', `<span class="btn">${ic('history')}Import history</span><span class="btn p">${ic('download')}Load a state</span>`)}
  <div class="kpis">${[['States complete', '34 of 37', 'Akwa Ibom, Ogun, Oyo partial'], ['LGAs', '774', ''], ['Wards', '8,809', ''], ['Polling units', '176,846', ''], ['Voters loaded', '93.4 m', 'From INEC register']].map(([l, n, s]) => `<div class="kpi"><div class="l">${l}</div><div class="n">${n}</div><div class="s">${s}</div></div>`).join('')}</div>
  <div class="card" style="overflow:hidden"><table class="tbl"><tr><th>State</th><th>LGAs</th><th>Wards</th><th>Polling units</th><th>Outlines</th><th>Status</th></tr>${[['Kano', '44 / 44', 484, '11,222', 'Yes', 'ok'], ['Kaduna', '23 / 23', 255, '8,012', 'Yes', 'ok'], ['Akwa Ibom', '31 / 31', 329, '3,920 of 4,353', 'Yes', 'partial'], ['Ogun', '20 / 20', 236, '4,821 of 5,042', 'Yes', 'partial'], ['Lagos', '20 / 20', 245, '13,325', 'Yes', 'ok']].map(([s, l, w, p, o, st]) => `<tr><td class="b">${s}</td><td>${l}</td><td>${w}</td><td>${p}</td><td>${o}</td><td>${st === 'ok' ? pill('ok', 'Complete') : pill('high', 'Partial')}</td></tr>`).join('')}</table></div>`);

P['console-elections'] = C('elections', 'Elections', `${head('Elections clients can pick', 'Elections', '', `<span class="btn p">${ic('add')}Add election</span>`)}
  <div class="grid3">${[['Governorship 2027', '15 Feb 2027', '28 states', 'Live'], ['Presidential and NASS 2027', '20 Jan 2027', 'Nationwide', 'Upcoming'], ['Off-cycle Kogi 2026', '11 Nov 2026', '1 state', 'Done']].map(([n, d, a, s]) => `<div class="card cb" style="display:flex;flex-direction:column;gap:8px"><div class="row" style="justify-content:space-between"><b>${n}</b>${s === 'Live' ? pill('ok', s) : s === 'Done' ? pill('low', s) : pill('info', s)}</div><div class="small muted">${d} · ${a}</div><div class="small">Offices: Governor, State assembly</div></div>`).join('')}</div>`);

P['console-staff'] = C('staff', 'Staff', `${head('Rumfa staff with Console access', 'Staff', '', `<span class="btn p">${ic('person_add')}Invite</span>`)}
  <div class="card" style="overflow:hidden"><table class="tbl"><tr><th>Name</th><th>Role</th><th>Last active</th><th></th></tr>${[['Umar B.', 'Owner', 'Now'], ['Zainab A.', 'Support', '12 min'], ['Kelechi O.', 'Data (places, contacts)', 'Yesterday'], ['Tunde F.', 'Invited', '—']].map(([n, r, l]) => `<tr><td class="b">${n}</td><td>${r === 'Invited' ? pill('medium', r) : r}</td><td class="muted">${l}</td><td style="text-align:right"><span class="btn sm g">${ic('more_horiz', 's')}</span></td></tr>`).join('')}</table></div>`);

P['console-activity'] = C('activity', 'Activity', `${head('Everything staff and client admins changed', 'Activity', '', `<span class="btn">${ic('filter_list')}All</span>`)}
  <div class="card" style="overflow:hidden">${[['14:02', 'Aisha B. (ALAWA admin)', 'Changed case timing: critical resolve 15 → 10 min'], ['13:40', 'Umar B.', 'Switched on Live video for ALAWA'], ['11:15', 'Aisha B. (ALAWA admin)', 'Turned on "Photos must be taken with the in-app camera"'], ['09:02', 'Kelechi O.', 'Loaded Ogun polling units · 4,821 added'], ['Yesterday', 'Zainab A.', 'Reset password for Hadiza Y. (ALAWA)']].map(([t, w, x]) => `<div class="row" style="padding:12px 18px;border-bottom:1px solid var(--line2);gap:14px"><span class="small muted" style="width:70px">${t}</span><b style="width:220px">${w}</b><span>${x}</span></div>`).join('')}</div>`);

export default P;
