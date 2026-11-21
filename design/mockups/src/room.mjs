// Rumfa Room (dashboard) pages
import { roomShell, page, ic, pill, tog, photo, KIND } from './common.mjs';

const P = {};
const head = (eyebrow, title, lede, actions = '') => `<div class="ph"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${lede ? `<div class="lede">${lede}</div>` : ''}</div><div class="row">${actions}</div></div>`;

// ---------------------------------------------------------------- Login
P['room-login'] = page('Sign in · Rumfa Room', `<div style="min-height:100vh;display:grid;grid-template-columns:1fr 1fr">
  <div style="background:#121A24;color:#fff;padding:56px;display:flex;flex-direction:column;justify-content:space-between">
    <div class="row"><div class="mark" style="width:40px;height:40px;font-size:18px">R</div><b style="font-size:18px">Rumfa Room</b></div>
    <div style="max-width:440px"><div style="font-size:34px;font-weight:800;line-height:1.15;letter-spacing:-.02em">Every polling unit, every problem, one room.</div>
    <p style="color:#9AA6B6;margin-top:14px;font-size:15px">Cases from the field arrive with photos taken in the agent app, stamped with time and place, so your team acts on what is real.</p></div>
    <div class="small" style="color:#8693A4">Protected sign-in · Sessions are shared safely across tabs</div></div>
  <div style="display:grid;place-items:center;padding:40px"><div style="width:380px;display:flex;flex-direction:column;gap:16px">
    <h1>Sign in</h1><p class="muted">Use the phone number or email your organisation added you with.</p>
    <div class="field"><label>Phone or email</label><div class="inp">aisha.bello@alawa.org</div></div>
    <div class="field"><label>Password</label><div class="inp">••••••••••</div></div>
    <span class="btn p" style="justify-content:center;padding:11px">Sign in</span>
    <a class="small" href="#">Forgot password?</a></div></div></div>`);

// ---------------------------------------------------------------- Situation room
const cases = [
  ['security', 'critical', 'Ballot box snatching', 'PU 006 · Agalawa · Kano Municipal', '4 min left', 'Musa I. (agent)', 2, 'box', 'Assigned · Ibrahim S.'],
  ['security', 'critical', 'Emergency (SOS)', 'PU 014 · Dala ward · Dala', '1 min left', 'Hauwa K. (agent)', 1, 'night', 'Not taken'],
  ['security', 'high', 'Thugs or intimidation', 'PU 002 · Gwammaja · Dala', '12 min left', 'Sani A. (ward coord.)', 0, null, 'Not taken'],
  ['legal', 'high', 'Our agent denied entry', 'PU 031 · Kurna · Ungogo', '9 min left', 'Zainab M. (agent)', 1, 'crowd', 'Assigned · Barr. Halima'],
  ['legal', 'medium', 'Vote buying observed', 'PU 019 · Gama · Nassarawa', '31 min left', 'Yusuf D. (agent)', 3, 'crowd', 'Not taken'],
  ['state', 'high', 'BVAS not working', 'PU 008 · Tudun Wada · Nassarawa', '6 min left', 'Amina L. (agent)', 1, 'crowd', 'Assigned · Kabiru'],
  ['helpdesk', 'low', 'App or phone problem', 'PU 044 · Fagge D2 · Fagge', '1 h 10 min left', 'Bello N. (agent)', 0, null, 'Not taken'],
];
const qcards = [['security', 'Security', 3, 2, 'Kano room · 3 on shift'], ['legal', 'Legal', 2, 0, '2 lawyers on shift'], ['state', 'Kano state', 1, 0, '4 on shift'], ['helpdesk', 'Helpdesk', 1, 0, '2 on shift'], ['national', 'National', 0, 0, 'Escalations land here']];
function caseRow(c, sel = false, compact = false) {
  const [k, sev, t, where, due, by, n, ph, who] = c;
  return `<div style="display:flex;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line2);${sel ? 'background:#F0F7F6;box-shadow:inset 3px 0 0 var(--teal)' : ''}">
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px"><div class="row" style="gap:8px">${pill(sev)}<b>${t}</b></div>
    <div class="small muted">${compact ? where.split(' · ').slice(0, 2).join(' · ') : where + ' · from ' + by}</div>
    <div class="row small" style="gap:12px"><span style="color:${due.startsWith('1 min') || due.startsWith('4') ? 'var(--crit)' : 'var(--ink2)'};font-weight:600">${ic('timer', 's')} ${due}</span>${compact ? '' : `<span class="muted">${who}</span>`}${n ? `<span class="muted">${ic('photo_camera', 's')} ${n}</span>` : ''}</div></div>
    ${ph && !compact ? photo(ph, { w: 88, h: 66, badge: null, style: 'flex:none' }) : ''}</div>`;
}
function queueList(selIdx = -1, compact = false) {
  let out = '', i = 0;
  for (const [k, name] of [['security', 'Security'], ['legal', 'Legal'], ['state', 'Kano state'], ['helpdesk', 'Helpdesk']]) {
    const rows = cases.map((c, idx) => [c, idx]).filter(([c]) => c[0] === k);
    out += `<div style="display:flex;align-items:center;gap:8px;padding:9px 14px;background:#FAFBFC;border-bottom:1px solid var(--line2);border-top:1px solid var(--line2)"><span class="dot" style="background:${KIND[k]}"></span><b style="font-size:13px">${name}</b><span class="muted small">${rows.length} open</span></div>`;
    out += rows.map(([c, idx]) => caseRow(c, idx === selIdx, compact)).join('');
  }
  return out;
}
const qCardsHtml = `<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px">${qcards.map(([k, n, open, urgent, sub]) => `<div class="card" style="padding:12px 14px;display:flex;gap:10px"><span class="kbar" style="background:${KIND[k]}"></span><div class="grow"><div class="row" style="justify-content:space-between"><b>${n}</b>${urgent ? pill('critical', urgent + ' urgent') : ''}</div><div style="font-size:24px;font-weight:800">${open}<span class="small muted" style="font-weight:600"> open</span></div><div class="small muted">${sub}</div></div></div>`).join('')}</div>`;
P['room-room'] = page('Situation room', roomShell('room', `<div class="content">
  ${head('Kano state room · 12 on shift', 'Situation room', 'Cases from the field, grouped by the team that acts on them. Photos open in place.', `<span class="seg"><span class="on">List</span><span>Map</span></span><span class="btn">${ic('filter_list')}Kano · All kinds</span><span class="btn p">${ic('add')}New case</span>`)}
  ${qCardsHtml}
  <div style="display:grid;grid-template-columns:1fr 420px;gap:16px;align-items:start">
    <div class="card" style="overflow:hidden"><div class="ch"><div class="row"><span class="chip on">Open 7</span><span class="chip">Urgent 3</span><span class="chip">Mine 1</span><span class="chip">Not taken 4</span><span class="chip">Resolved today 23</span></div><span class="small muted">Sorted by time left</span></div>${queueList(0)}</div>
    <div class="card" style="position:sticky;top:16px;overflow:hidden">
      <div class="cb" style="display:flex;flex-direction:column;gap:12px">
        <div class="row">${pill('critical')}<span class="pill ghost"><span class="dot" style="background:${KIND.security}"></span>Security</span><span class="grow"></span><span class="small b" style="color:var(--crit)">${ic('timer', 's')} 4 min to resolve</span></div>
        <h2 style="font-size:18px">Ballot box snatching at PU 006</h2>
        <div class="small muted">Agalawa · Kano Municipal · reported 14:21 by Musa Ibrahim (agent)</div>
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:8px">${photo('box', { h: 170, stamp: '14:21 · PU 006 · 12 m from unit' })}<div style="display:grid;gap:8px">${photo('crowd', { h: 81, badge: null })}<div class="ph-img" style="height:81px;display:grid;place-items:center;background:#E9EDF2;color:var(--ink2);font-weight:700">+1 video</div></div></div>
        <p style="font-size:13.5px">"Four men came with a bus and took the box before counting. Police not here. Voters still around."</p>
        <div class="row"><span class="btn p">${ic('open_in_full')}Open case</span><span class="btn">${ic('call')}Call Musa</span><span class="btn">${ic('person_add')}Assign</span></div>
      </div></div>
  </div></div>`));

// ---------------------------------------------------------------- Case open beside queue
const tl = [
  ['14:21', 'Musa Ibrahim', 'agent', 'Reported ballot box snatching', 'Four men came with a bus and took the box before counting. Police not here.', ['box', 'crowd']],
  ['14:22', 'Rumfa', 'sys', 'Case opened in Security · critical · resolve by 14:31', null, null],
  ['14:23', 'Ibrahim Sule', 'room', 'Took the case', null, null],
  ['14:24', 'Musa Ibrahim', 'agent', 'Sent a video', '0:18 · voters shouting near the bus', ['night']],
  ['14:26', 'Ibrahim Sule', 'room', 'Called Musa · 2 min', 'Bus left towards Kofar Mata. Number plate partly seen: KAN 4..', null],
];
P['room-case'] = page('Case · Ballot box snatching', roomShell('room', `<div class="content" style="padding-top:18px">
  <div class="row small"><a href="room-room.html">${ic('arrow_back', 's')} Situation room</a><span class="muted">/ Security / Case 2027-0612</span></div>
  <div style="display:grid;grid-template-columns:300px 1fr;gap:16px;align-items:start">
    <div class="card" style="overflow:hidden">${queueList(0, true)}</div>
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="card cb" style="display:flex;flex-direction:column;gap:14px">
        <div class="row">${pill('critical')}<span class="pill ghost"><span class="dot" style="background:${KIND.security}"></span>Security</span><span class="pill info">In progress</span><span class="grow"></span>
          <span class="b" style="color:var(--crit)">${ic('timer')} 4:12 to resolve</span><span class="small muted">· escalates to National room at 14:31</span></div>
        <div><h1 style="font-size:22px">Ballot box snatching at PU 006</h1>
          <div class="muted" style="margin-top:4px">Agalawa · Kano Municipal · Kano Central · PU 006 (461 registered)</div></div>
          <div class="row"><span class="btn">${ic('call')}Call Musa</span><span class="btn">${ic('videocam')}Ask for live video</span><span class="btn">${ic('trending_up')}Escalate</span><span class="btn p">${ic('check_circle')}Resolve</span></div>
        <div class="row" style="padding:10px 12px;background:#FAFBFC;border:1px solid var(--line2);border-radius:10px;gap:14px">
          <div class="av" style="background:var(--teal)">IS</div><div class="grow"><div class="b">Ibrahim Sule · room operator</div><div class="small muted">Took it at 14:23</div></div>
          <span class="small muted">Send someone:</span><span class="btn sm">${ic('person_pin_circle', 's')}Sani A. · ward coord. · 1.2 km</span><span class="btn sm">${ic('local_police', 's')}DPO Kofar Mata</span><span class="btn sm p">${ic('assignment_ind', 's')}Assign</span></div>
      </div>
      <div class="card"><div class="ch"><h2>Evidence <span class="muted" style="font-weight:600">· 3 photos · 1 video</span></h2><div class="row"><span class="small" style="color:var(--ok);font-weight:600">${ic('verified', 's f')} All taken in the app, at the unit</span><span class="btn sm">${ic('download', 's')}Download all</span></div></div>
        <div class="cb" style="display:grid;grid-template-columns:2fr 1fr 1fr;grid-template-rows:120px 120px;gap:10px">
          <a href="room-case-photo.html" style="grid-row:span 2">${photo('box', { h: 250, stamp: '14:21 · Musa I. · 12 m from PU 006' })}</a>
          ${photo('crowd', { h: 120, stamp: '14:21 · 15 m' })}${photo('night', { h: 120, stamp: '14:24 · 0:18', play: true })}
          ${photo('crowd', { h: 120, stamp: '14:25 · 40 m', badge: 'app' })}<div class="ph-img" style="height:120px;background:#F5F6F8;border:1.5px dashed var(--line);display:grid;place-items:center;color:var(--ink3);text-align:center;font-size:12.5px;font-weight:600">${ic('add_a_photo')}<br>Ask Musa for<br>more photos</div>
        </div></div>
      <div class="card"><div class="tabs" style="padding:0 18px"><span class="on">Timeline</span><span>Messages 4</span><span>People to call 3</span><span>Live video</span></div>
        <div class="cb" style="display:flex;flex-direction:column;gap:0">${tl.map(([t, who, k, title, body, imgs]) => `<div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--line2)">
          <div class="small muted" style="width:44px;flex:none;padding-top:2px">${t}</div><div class="av" style="width:26px;height:26px;font-size:10px;background:${k === 'agent' ? '#1F4E8C' : k === 'sys' ? '#C5CCD6' : 'var(--teal)'}">${who.split(' ').map((w) => w[0]).join('')}</div>
          <div class="grow" style="display:flex;flex-direction:column;gap:6px"><div><b>${who}</b> <span class="muted">· ${title}</span></div>${body ? `<div style="font-size:13.5px">${body}</div>` : ''}
          ${imgs ? `<div class="row">${imgs.map((i) => photo(i, { w: 150, h: 104, badge: null, play: i === 'night', stamp: i === 'night' ? '0:18' : null })).join('')}</div>` : ''}</div></div>`).join('')}
        <div class="row" style="padding-top:12px"><div class="inp grow" style="color:var(--ink4)">Add a note or message Musa…</div><span class="btn">${ic('attach_file')}</span><span class="btn p">Send</span></div></div></div>
    </div></div></div>`));

// ---------------------------------------------------------------- Photo preview (lightbox)
P['room-case-photo'] = page('Photo · Case 2027-0612', `<div style="min-height:100vh;background:#0B0F16;color:#fff;display:flex;flex-direction:column">
  <div class="row" style="padding:14px 22px;border-bottom:1px solid #1E2836"><span class="b">Photo 1 of 4</span><span style="color:#8693A4">· Ballot box snatching at PU 006</span><span class="grow"></span>
    <span class="btn g" style="color:#fff">${ic('zoom_in')}</span><span class="btn g" style="color:#fff">${ic('rotate_right')}</span><span class="btn g" style="color:#fff">${ic('download')}</span><span class="btn g" style="color:#fff">${ic('close')}</span></div>
  <div style="flex:1;display:grid;grid-template-columns:1fr 340px;min-height:0">
    <div style="position:relative;display:grid;place-items:center;padding:26px 70px">
      <span style="position:absolute;left:18px;top:50%;width:44px;height:44px;border-radius:50%;background:#1E2836;display:grid;place-items:center">${ic('chevron_left')}</span>
      <span style="position:absolute;right:18px;top:50%;width:44px;height:44px;border-radius:50%;background:#1E2836;display:grid;place-items:center">${ic('chevron_right')}</span>
      ${photo('box', { w: 860, h: 600, badge: null, stamp: 'Rumfa · 14:21:07 · 12.0021, 8.5167 · PU 006 Agalawa', style: 'border-radius:6px' })}</div>
    <aside style="background:#121A24;border-left:1px solid #1E2836;padding:20px;display:flex;flex-direction:column;gap:16px">
      <div class="note ok" style="background:#10321F;color:#B7E4C7">${ic('verified', 'f')}<div><b>Taken in the Rumfa app</b><br>Captured by the camera inside the app, not picked from the gallery. Time and place come from the phone at the moment of capture.</div></div>
      ${[['Taken by', 'Musa Ibrahim · agent, PU 006'], ['Taken at', '14:21:07 · 15 Feb 2027'], ['Received', '14:21:31 (24 s later)'], ['Location', '12.0021, 8.5167 · ±8 m'], ['Distance from unit', '12 m from PU 006'], ['Device', 'Tecno Spark 10 · app 2.4.1'], ['Fingerprint', 'sha256 9f1c…a72e'], ['Part of', 'Report at 14:21, 2 photos']].map(([k, v]) => `<div><div class="small" style="color:#8693A4">${k}</div><div style="font-weight:600">${v}</div></div>`).join('')}
      <div style="display:flex;gap:8px;margin-top:auto"><span class="btn" style="flex:1;justify-content:center">${ic('flag')}Mark unclear</span><span class="btn p" style="flex:1;justify-content:center">${ic('push_pin')}Key evidence</span></div>
    </aside></div>
  <div class="row" style="padding:12px 22px;border-top:1px solid #1E2836;gap:10px">${['box', 'crowd', 'night', 'crowd'].map((k, i) => `<div style="border-radius:8px;outline:${i === 0 ? '2px solid #2DD4BF' : '0'};outline-offset:2px">${photo(k, { w: 96, h: 64, badge: null, play: k === 'night' })}</div>`).join('')}</div></div>`);

// ---------------------------------------------------------------- My field team
const needs = [['notin', 'Not checked in', 6, 'person_off', 'var(--crit)'], ['silent', 'Silent over 60 min', 4, 'notifications_paused', 'var(--high)'], ['turnout', 'No turnout update 2 h', 9, 'schedule', 'var(--med)'], ['callback', 'Asked for a call', 2, 'phone_callback', 'var(--info)'], ['trouble', 'Phone or app trouble', 1, 'phonelink_erase', 'var(--ink2)']];
const people = [['Abubakar Garba', 'Agent · PU 012 Gama', ['notin'], '—', 'G'], ['Fatima Usman', 'Agent · PU 004 Kawo', ['silent', 'turnout'], '1 h 22 min', 'F'], ['Idris Lawan', 'Ward coord. · Gama', ['callback'], '6 min', 'I'], ['Rakiya Sani', 'Agent · PU 027 Hotoro N', ['notin'], '—', 'R'], ['Kabir Ahmad', 'Agent · PU 009 Tudun Wada', ['trouble'], '18 min', 'K'], ['Maryam Bala', 'Agent · PU 015 Kawo', ['turnout'], '35 min', 'M']];
const NL = Object.fromEntries(needs.map(([k, l, , , c]) => [k, [l, c]]));
P['room-team'] = page('My field team', roomShell('team', `<div class="content">
  ${head('Nassarawa LGA coordinator · 11 wards', 'My field team', 'Who needs a call right now. Mark them done and they leave the list for an hour.', `<span class="btn">${ic('campaign')}Announcement</span><span class="btn">${ic('groups')}Group call</span>`)}
  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px">${needs.map(([k, l, n, i, c], x) => `<div class="kpi" style="${x === 0 ? 'border-color:var(--ink);box-shadow:0 0 0 1px var(--ink)' : ''}"><div class="row" style="justify-content:space-between"><span class="l">${l}</span><span style="color:${c}">${ic(i)}</span></div><div class="n">${n}</div></div>`).join('')}</div>
  <div class="card"><div class="ch"><h2>Wards</h2><span class="small muted">Click a ward to filter · Open to go in</span></div><div class="cb" style="display:flex;gap:10px;overflow:hidden">
    ${[['Gama', 'Idris L.', 14, 12, 3], ['Kawo', 'Hadiza Y.', 11, 9, 4], ['Tudun Wada', 'Kabiru A.', 13, 13, 1], ['Hotoro N', 'Sule M.', 15, 11, 5], ['Giginyu', 'Aminu T.', 10, 10, 0], ['Gawuna', 'No coordinator', 8, 6, 2]].map(([w, c, a, inp, todo]) => `<div style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-width:170px;display:flex;flex-direction:column;gap:4px"><div class="row" style="justify-content:space-between"><b>${w}</b>${todo ? `<span class="pill high">${todo} to do</span>` : '<span class="pill ok">All good</span>'}</div><div class="small ${c.startsWith('No') ? '' : 'muted'}" style="${c.startsWith('No') ? 'color:var(--crit);font-weight:600' : ''}">${c}</div><div class="small muted">${inp}/${a} in place</div><div class="bar"><i style="width:${(inp / a) * 100}%"></i></div></div>`).join('')}</div></div>
  <div class="card" style="overflow:hidden"><div class="ch"><h2>People to follow up <span class="muted">· 22</span></h2><div class="row"><span class="chip">${ic('visibility', 's')}Show followed up (5)</span></div></div>
  <table class="tbl"><tr><th>Person</th><th>Needs</th><th>Last heard</th><th style="text-align:right">Actions</th></tr>
  ${people.map(([n, r, nd, last, a]) => `<tr><td><div class="row" style="gap:10px"><div class="av" style="background:#1F4E8C">${a}</div><div><b>${n}</b><div class="small muted">${r}</div></div></div></td><td><div class="row" style="gap:6px">${nd.map((k) => `<span class="pill" style="background:#fff;border:1px solid var(--line);color:${NL[k][1]}">${NL[k][0]}</span>`).join('')}</div></td><td class="muted">${last}</td><td><div class="row" style="justify-content:flex-end;gap:6px"><span class="btn sm">${ic('call', 's')}Call</span><span class="btn sm">${ic('chat', 's')}Message</span><span class="btn sm p">${ic('done', 's')}Done</span></div></td></tr>`).join('')}</table></div></div>`));

// ---------------------------------------------------------------- Callback requests
P['room-callbacks'] = page('Callback requests', roomShell('callbacks', `<div class="content">
  ${head('Kano · helpdesk and coordinators', 'Callback requests', 'People in the field who asked to be called. Oldest first; each call is logged with what happened.', `<span class="seg"><span class="on">Waiting 3</span><span>Calling 1</span><span>Done today 41</span></span>`)}
  <div style="display:grid;grid-template-columns:1fr 440px;gap:16px;align-items:start">
    <div class="card" style="overflow:hidden">${[['Hauwa Kabir', 'Agent · PU 014 Dala', 'Problem at my polling unit', '12 min', 2, true], ['Idris Lawan', 'Ward coord. · Gama', 'Question about a form', '6 min', 0, false], ['Bello Nuhu', 'Agent · PU 044 Fagge', 'App or phone problem', '3 min', 1, false], ['Sadiq Umar', 'Agent · PU 003 Kurna', 'Other', 'Calling · Halima', 0, false]].map(([n, r, why, w, tries, sel]) =>
      `<div class="row" style="padding:13px 16px;border-bottom:1px solid var(--line2);gap:12px;${sel ? 'background:#F0F7F6;box-shadow:inset 3px 0 0 var(--teal)' : ''}"><div class="av" style="background:#1F4E8C">${n[0]}</div><div class="grow"><b>${n}</b><div class="small muted">${r} · ${why}</div></div><div style="text-align:right"><div class="b small" style="${w.startsWith('12') ? 'color:var(--crit)' : ''}">${w}</div><div class="small muted">${tries ? tries + ' tries' : 'Not tried'}</div></div></div>`).join('')}</div>
    <div class="card cb" style="display:flex;flex-direction:column;gap:14px">
      <div class="row"><div class="av" style="width:42px;height:42px;background:#1F4E8C">H</div><div class="grow"><h2>Hauwa Kabir</h2><div class="small muted">Agent · PU 014 Dala ward · 0803 *** 4471</div></div><span class="pill critical">Waiting 12 min</span></div>
      <div class="note">${ic('info')}<div><b>Problem at my polling unit</b><br>"They are not allowing our agent to sign. Please call." · sent 14:20 by SMS</div></div>
      <div class="row"><span class="btn p" style="flex:1;justify-content:center">${ic('call')}Call in the app</span><span class="btn" style="flex:1;justify-content:center">${ic('phone')}Phone call</span></div>
      <div><div class="small b" style="margin-bottom:6px">How did it go?</div><div class="row" style="gap:6px"><span class="chip">Sorted on the call</span><span class="chip">Opened a case</span><span class="chip">No answer</span><span class="chip">Busy, try later</span><span class="chip">Wrong number</span></div></div>
      <div><div class="small b" style="margin-bottom:6px">If no answer</div><div class="small muted">Try again after 5 min, then 10, then send an SMS and tell her coordinator (Settings → Callbacks).</div></div>
      <div><div class="small b" style="margin-bottom:6px">History</div>${[['14:24', 'Ibrahim S. · no answer'], ['14:29', 'Ibrahim S. · busy'], ['14:20', 'Asked by SMS']].map(([t, x]) => `<div class="row small" style="padding:5px 0;border-bottom:1px solid var(--line2)"><span class="muted" style="width:44px">${t}</span>${x}</div>`).join('')}</div>
    </div></div></div>`));

// ---------------------------------------------------------------- Authority contacts
P['room-contacts'] = page('Authority contacts', roomShell('contacts', `<div class="content">
  ${head('Kept by Rumfa · read only', 'Authority contacts', 'Police, INEC, security and emergency numbers for your areas. Call from here; the call is logged on the case you have open.', `<span class="btn">${ic('filter_list')}Kano · All</span>`)}
  <div class="row"><span class="chip on">All 64</span><span class="chip">Police 22</span><span class="chip">INEC 18</span><span class="chip">DSS 6</span><span class="chip">Civil defence 9</span><span class="chip">Ambulance and fire 9</span></div>
  <div class="card" style="overflow:hidden"><table class="tbl"><tr><th>Name</th><th>Office</th><th>Area</th><th>Phone</th><th>Last checked</th><th></th></tr>
  ${[['CSP Abdullahi Musa', 'DPO · Kofar Mata division', 'Kano Municipal', '0803 *** 1120', '2 days ago'], ['Hajiya Rabi Sani', 'Electoral officer · INEC', 'Nassarawa', '0806 *** 7731', '1 week ago'], ['Police control room', 'Kano state command', 'Kano', '0706 *** 0000', 'Today'], ['Mal. Garba Idris', 'Supervisory presiding officer', 'Dala', '0813 *** 2290', '3 days ago'], ['NSCDC duty desk', 'Civil defence · Kano', 'Kano', '0909 *** 4410', 'Today'], ['Fire service', 'Kano state fire service', 'Kano', '0802 *** 9032', '1 week ago']].map(([n, o, a, p, l]) => `<tr><td class="b">${n}</td><td>${o}</td><td class="muted">${a}</td><td>${p}</td><td class="muted">${l}</td><td style="text-align:right"><span class="btn sm">${ic('call', 's')}Call</span></td></tr>`).join('')}</table></div></div>`));

// ---------------------------------------------------------------- Election day
const stages = [['Check-in', 92], ['Accreditation', 71], ['Count', 38], ['EC8A', 21], ['IReV', 14]];
P['room-election-day'] = page('Election day', roomShell('election-day', `<div class="content">
  ${head('Kano state · Governorship 2027 · 8,074 polling units', 'Election day', 'One page for the day, from check-in to IReV. Pick a stage; the map and table follow it.', `<span class="seg"><span>Zones</span><span class="on">LGAs</span><span>Senatorial</span></span>`)}
  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px">${stages.map(([s, p], i) => `<div class="kpi" style="${i === 2 ? 'border-color:var(--teal);box-shadow:0 0 0 1px var(--teal)' : ''}"><div class="l">${i + 1}. ${s}</div><div class="n">${p}%</div><div class="bar" style="margin-top:6px"><i style="width:${p}%"></i></div></div>`).join('')}</div>
  <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:16px;align-items:start">
    <div class="card"><div class="ch"><h2>Kano · count started</h2><span class="seg"><span class="on">Progress</span><span>Votes</span><span>Issues</span></span></div>
      <div class="cb"><svg viewBox="0 0 520 380" style="width:100%">${Array.from({ length: 44 }, (_, i) => { const x = (i % 8) * 62 + 14 + (Math.floor(i / 8) % 2) * 20, y = Math.floor(i / 8) * 64 + 14, v = (i * 37) % 100; return `<path d="M${x} ${y + 8} l28 -8 l28 10 l2 30 l-24 22 l-30 -6 l-6 -26z" fill="${v > 66 ? '#0F766E' : v > 33 ? '#5EB5A9' : '#CDE7E3'}" stroke="#fff" stroke-width="2"/>`; }).join('')}<g><circle cx="250" cy="170" r="9" fill="#B42318" stroke="#fff" stroke-width="2"/><circle cx="300" cy="200" r="7" fill="#B54708" stroke="#fff" stroke-width="2"/></g></svg>
      <div class="row small muted"><span class="dot" style="background:#CDE7E3"></span>Under a third<span class="dot" style="background:#5EB5A9"></span>Up to two thirds<span class="dot" style="background:#0F766E"></span>Most units<span class="dot" style="background:#B42318"></span>Open case</div></div></div>
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="card"><div class="ch"><h2>Votes so far</h2><span class="small muted">612 of 8,074 units · estimate shown</span></div><div class="cb" style="display:flex;flex-direction:column;gap:10px">
        ${[['APC', '#1F6FB2', 46, 49], ['NNPP', '#C0392B', 41, 39], ['PDP', '#2E8B57', 9, 9], ['LP', '#7FBF3F', 3, 2]].map(([p, c, conf, est]) => `<div><div class="row small" style="justify-content:space-between"><b>${p}</b><span class="muted">${conf}% confirmed · ~${est}% estimate</span></div><div class="bar" style="height:12px"><i style="width:${conf}%;background:${c}"></i></div></div>`).join('')}</div></div>
      <div class="card"><div class="ch"><h2>Flags and cases</h2><span class="seg"><span class="on">This area</span><span>Everywhere</span></span></div>
        ${cases.slice(0, 4).map((c) => `<div class="row" style="padding:10px 18px;border-bottom:1px solid var(--line2)">${pill(c[1])}<div class="grow"><b style="font-size:13px">${c[2]}</b><div class="small muted">${c[3]}</div></div>${c[6] ? photo(c[7], { w: 54, h: 40, badge: null }) : ''}</div>`).join('')}</div></div></div>
  <div class="card" style="overflow:hidden"><table class="tbl"><tr><th>LGA</th><th>Checked in</th><th>Count started</th><th>EC8A in</th><th>Open cases</th><th>Coordinator</th></tr>
  ${[['Dala', '88%', '22%', '9%', 2, 'Sani A.'], ['Ungogo', '90%', '31%', '12%', 1, 'Lami B.'], ['Nassarawa', '94%', '36%', '19%', 2, 'Hadiza Y.'], ['Kano Municipal', '96%', '44%', '25%', 1, 'Garba T.'], ['Fagge', '97%', '51%', '30%', 1, 'Musa K.']].map((r) => `<tr><td class="b">${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td><td>${r[4] ? pill('high', r[4] + ' open') : ''}</td><td class="muted">${r[5]}</td></tr>`).join('')}</table></div></div>`));

// ---------------------------------------------------------------- Results
P['room-results'] = page('Results', roomShell('results', `<div class="content">
  ${head('Governorship 2027 · Kano', 'Results', 'Our agents\' sheets against IReV, unit by unit. Differences go to Sheet review.', `<span class="btn">${ic('download')}Export</span>`)}
  <div class="kpis">${[['Units with our sheet', '1,904', '24% of 8,074'], ['On IReV', '1,412', '17%'], ['Both, matching', '1,288', '91% of both'], ['Differences', '37', 'Over 10 votes'], ['Missing sheet', '214', 'Count done, no EC8A']].map(([l, n, s]) => `<div class="kpi"><div class="l">${l}</div><div class="n">${n}</div><div class="s">${s}</div></div>`).join('')}</div>
  <div class="card" style="overflow:hidden"><div class="ch"><h2>By LGA</h2><span class="seg"><span class="on">Our sheets</span><span>IReV</span><span>Difference</span></span></div>
  <table class="tbl"><tr><th>LGA</th><th>Units in</th><th>APC</th><th>NNPP</th><th>PDP</th><th>Others</th><th>Differences</th></tr>
  ${[['Fagge', '61%', '41,220', '38,901', '6,112', '1,940', 2], ['Kano Municipal', '48%', '52,014', '47,388', '7,421', '2,203', 7], ['Nassarawa', '39%', '48,770', '50,231', '5,902', '1,880', 4], ['Dala', '22%', '21,456', '24,118', '2,914', '901', 9], ['Ungogo', '31%', '30,112', '28,840', '3,410', '1,106', 3]].map((r) => `<tr><td class="b">${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td><td>${r[5]}</td><td>${r[6] > 5 ? pill('high', r[6] + ' to review') : pill('low', r[6] + ' to review')}</td></tr>`).join('')}</table></div></div>`));

// ---------------------------------------------------------------- IReV data
P['room-irev'] = page('IReV data', roomShell('irev', `<div class="content">
  ${head('Pulled from INEC\'s result viewing portal', 'IReV data', 'Rumfa downloads published sheets every 10 minutes and reads the figures. Low-confidence reads go to Sheet review.', `<span class="btn">${ic('refresh')}Pull now</span>`)}
  <div class="kpis">${[['Sheets published', '1,412', 'Last pull 14:30'], ['Read automatically', '1,301', '92%'], ['Need a person', '111', 'Blurred or partial'], ['Not yet on IReV', '6,662', '']].map(([l, n, s]) => `<div class="kpi"><div class="l">${l}</div><div class="n">${n}</div><div class="s">${s}</div></div>`).join('')}</div>
  <div class="card" style="overflow:hidden"><div class="ch"><h2>Latest sheets</h2><span class="small muted">Click a sheet to preview it</span></div>
  <div class="cb" style="display:grid;grid-template-columns:repeat(6,1fr);gap:12px">${['006 Agalawa', '014 Dala', '031 Kurna', '019 Gama', '008 Tudun Wada', '044 Fagge D2', '002 Gwammaja', '027 Hotoro N', '012 Gama', '004 Kawo', '015 Kawo', '009 Tudun W.'].map((u, i) => `<div style="display:flex;flex-direction:column;gap:6px">${photo('sheet', { h: 150, badge: null })}<div class="row small" style="justify-content:space-between"><b>PU ${u}</b>${i % 5 === 3 ? pill('high', 'Check') : pill('ok', 'Read')}</div></div>`).join('')}</div></div></div>`));

// ---------------------------------------------------------------- Sheet review
P['room-sheet-review'] = page('Sheet review', roomShell('sheet-review', `<div class="content">
  ${head('37 differences · 111 unclear reads', 'Sheet review', 'Our agent\'s photo and the IReV copy side by side. Zoom in, correct the figures, and decide which stands.', `<span class="small muted">PU 019 · Gama · Nassarawa</span><span class="btn">${ic('skip_next')}Skip</span>`)}
  <div style="display:grid;grid-template-columns:1fr 1fr 360px;gap:16px;align-items:start">
    <div class="card" style="overflow:hidden"><div class="ch"><h3>Our agent's photo</h3><span class="small" style="color:var(--ok);font-weight:600">${ic('verified', 's f')} In-app · 17:42 · 9 m</span></div><div style="padding:12px">${photo('sheet', { h: 470, badge: null, stamp: 'Yusuf D. · 17:42 · PU 019' }).replace('Polling unit 006 · Agalawa ward · Kano Municipal', 'Polling unit 019 · Gama ward · Nassarawa')}</div><div class="row" style="padding:0 12px 12px"><span class="btn sm">${ic('zoom_in', 's')}</span><span class="btn sm">${ic('zoom_out', 's')}</span><span class="btn sm">${ic('rotate_right', 's')}</span><span class="grow"></span><span class="btn sm">${ic('open_in_full', 's')}Full screen</span></div></div>
    <div class="card" style="overflow:hidden"><div class="ch"><h3>IReV copy</h3><span class="small muted">Published 18:10</span></div><div style="padding:12px">${photo('sheet', { h: 470, badge: null, style: 'filter:grayscale(.8) contrast(.9)' }).replace('Polling unit 006 · Agalawa ward · Kano Municipal', 'Polling unit 019 · Gama ward · Nassarawa').replace('>187<', '>137<').replace('>449<', '>399<')}</div><div class="row" style="padding:0 12px 12px"><span class="btn sm">${ic('zoom_in', 's')}</span><span class="btn sm">${ic('zoom_out', 's')}</span><span class="grow"></span><span class="small muted">Linked zoom ${ic('link', 's')}</span></div></div>
    <div class="card"><div class="ch"><h3>Figures</h3></div><table class="tbl"><tr><th></th><th>Ours</th><th>IReV</th></tr>
      ${[['APC', 212, 212], ['NNPP', 187, 137], ['PDP', 34, 34], ['LP', 9, 9], ['Rejected', 6, 6], ['Total valid', 449, 399], ['Accredited', 461, 461]].map(([p, a, b]) => `<tr style="${a !== b ? 'background:#FEF0E1' : ''}"><td class="b">${p}</td><td>${a}</td><td>${b}${a !== b ? ` <span class="pill high">−${a - b}</span>` : ''}</td></tr>`).join('')}</table>
      <div class="cb" style="display:flex;flex-direction:column;gap:8px"><div class="note warn">${ic('warning')}<div>NNPP is 50 lower on IReV and totals don't add up there. Likely an altered sheet.</div></div>
      <span class="btn p" style="justify-content:center">${ic('gavel')}Open a legal case</span><span class="btn" style="justify-content:center">Ours is wrong, use IReV</span></div></div></div></div>`));

// ---------------------------------------------------------------- People
P['room-people'] = page('People', roomShell('people', `<div class="content">
  ${head('ALAWA · Kano', 'People', 'Room staff, coordinators and agents. Add one, or import a list.', `<span class="btn">${ic('upload')}Import list</span><span class="btn p">${ic('person_add')}Add person</span>`)}
  <div class="row"><span class="chip on">Everyone 9,312</span><span class="chip">Room 34</span><span class="chip">Coordinators 497</span><span class="chip">Agents 8,781</span><span class="chip">Not onboarded 412</span></div>
  <div class="card" style="overflow:hidden"><table class="tbl"><tr><th>Name</th><th>Role</th><th>Area</th><th>App</th><th>Last seen</th><th></th></tr>
  ${[['Aisha Bello', 'Admin', 'Kano', 'Dashboard', 'Now'], ['Ibrahim Sule', 'Operator · Security', 'Kano', 'Dashboard', 'Now'], ['Hadiza Yusuf', 'LGA coordinator', 'Nassarawa', 'App 2.4.1', '2 min'], ['Idris Lawan', 'Ward coordinator', 'Gama', 'App 2.4.1', '6 min'], ['Musa Ibrahim', 'Agent', 'PU 006 Agalawa', 'App 2.4.1', '1 min'], ['Abubakar Garba', 'Agent', 'PU 012 Gama', 'Not installed', '—']].map(([n, r, a, ap, s]) => `<tr><td><div class="row" style="gap:10px"><div class="av" style="background:#1F4E8C">${n[0]}</div><b>${n}</b></div></td><td>${r}</td><td class="muted">${a}</td><td>${ap.startsWith('Not') ? pill('high', ap) : ap}</td><td class="muted">${s}</td><td style="text-align:right"><span class="btn sm g">${ic('more_horiz', 's')}</span></td></tr>`).join('')}</table></div></div>`));

// ---------------------------------------------------------------- Shifts
P['room-shifts'] = page('Shifts and queues', roomShell('shifts', `<div class="content">
  ${head('Who is on which queue, and when', 'Shifts and queues', 'Cases are offered to people on shift for that queue. Nobody on shift? They go to the next level up.', `<span class="btn p">${ic('add')}Add shift</span>`)}
  <div class="card" style="overflow:hidden"><div class="ch"><h2>Saturday 15 Feb</h2><span class="seg"><span>Fri</span><span class="on">Sat</span><span>Sun</span></span></div>
  <div class="cb">${[['security', 'Security · Kano', [[6, 14, 'Ibrahim S.'], [6, 14, 'Bashir A.'], [14, 22, 'Rabiu M.']]], ['legal', 'Legal · Kano', [[7, 19, 'Barr. Halima'], [12, 24, 'Barr. Tijjani']]], ['state', 'Kano state', [[6, 14, 'Kabiru'], [6, 18, 'Asma\'u'], [14, 24, 'Lawal']]], ['helpdesk', 'Helpdesk', [[5, 13, 'Zahra'], [13, 21, 'Usman']]], ['national', 'National', [[6, 24, 'Abuja room']]]].map(([k, n, sh]) => `<div class="row" style="padding:10px 0;border-bottom:1px solid var(--line2);gap:14px"><div style="width:150px" class="row"><span class="dot" style="background:${KIND[k]}"></span><b>${n}</b></div><div style="flex:1;position:relative;height:${sh.length * 26}px">${sh.map(([a, b, who], i) => `<div style="position:absolute;left:${(a / 24) * 100}%;width:${((b - a) / 24) * 100}%;top:${i * 26}px;height:22px;border-radius:6px;background:${KIND[k]}22;border-left:3px solid ${KIND[k]};font-size:12px;font-weight:600;padding:2px 8px">${who} · ${a}:00–${b}:00</div>`).join('')}</div></div>`).join('')}
  <div class="row small muted" style="justify-content:space-between;padding-left:164px;padding-top:6px">${[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => `<span>${h}:00</span>`).join('')}</div></div></div></div>`));

// ---------------------------------------------------------------- Airtime
P['room-airtime'] = page('Airtime and data', roomShell('airtime', `<div class="content">
  ${head('Add-on · switched on by Rumfa', 'Airtime and data', 'Top up agents so they can report on election day. Every top-up is logged against the person.', `<span class="btn p">${ic('send')}Send top-ups</span>`)}
  <div class="kpis">${[['Wallet', '₦1,240,000', 'Held by Rumfa'], ['Sent today', '₦386,500', '773 people'], ['Failed', '14', 'Wrong network or number'], ['Scheduled', 'Fri 18:00', '₦500 data to all agents']].map(([l, n, s]) => `<div class="kpi"><div class="l">${l}</div><div class="n">${n}</div><div class="s">${s}</div></div>`).join('')}</div>
  <div class="card" style="overflow:hidden"><table class="tbl"><tr><th>When</th><th>Who</th><th>What</th><th>Network</th><th>Status</th></tr>${[['14:02', 'All agents in Dala (612)', '₦500 airtime', 'Mixed', pill('ok', 'Sent 604 · 8 failed')], ['11:40', 'Hauwa Kabir', '1 GB data', 'MTN', pill('ok', 'Sent')], ['09:15', 'Coordinators (497)', '2 GB data', 'Mixed', pill('ok', 'Sent 491 · 6 failed')]].map((r) => `<tr>${r.map((x, i) => `<td class="${i === 1 ? 'b' : ''}">${x}</td>`).join('')}</tr>`).join('')}</table></div></div>`));

// ---------------------------------------------------------------- Voice outreach
P['room-voice'] = page('Voice outreach', roomShell('voice', `<div class="content">
  ${head('Add-on · switched on by Rumfa', 'Voice outreach', 'Recorded voice calls to supporters in their language. Sent through the add-on, reported by listen time.', `<span class="btn p">${ic('add')}New campaign</span>`)}
  <div class="grid3">${[['Get out and vote · Hausa', 'Sent Fri 18:00', '212,400 reached', 71], ['Polling unit reminder', 'Sat 06:30', '180,120 reached', 64], ['Thank you message', 'Draft', 'Not sent', 0]].map(([t, w, r, p]) => `<div class="card cb" style="display:flex;flex-direction:column;gap:10px"><div class="row" style="justify-content:space-between"><b>${t}</b>${p ? pill('ok', 'Sent') : pill('low', 'Draft')}</div><div class="small muted">${w} · ${r}</div><div class="row" style="gap:10px"><span class="btn sm">${ic('play_arrow', 's')}0:42</span><div class="bar grow"><i style="width:${p}%"></i></div><span class="small b">${p}% listened</span></div></div>`).join('')}</div></div>`));

// ---------------------------------------------------------------- Settings
const sevRow = (sev, ack, res, esc) => `<tr><td>${pill(sev)}</td><td><div class="inp num">${ack}<span class="muted small">min</span></div></td><td><div class="inp num">${res}<span class="muted small">min</span></div></td><td><div class="inp" style="min-width:190px">${esc} ${ic('expand_more', 's')}</div></td></tr>`;
const setRow = (label, hint, ctrl) => `<div class="row" style="padding:14px 0;border-bottom:1px solid var(--line2);gap:24px;align-items:center"><div class="grow"><div class="b">${label}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>${ctrl}</div>`;
const num = (v, u) => `<div class="inp num">${v}<span class="muted small">${u}</span></div>`;
P['room-settings'] = page('Settings', roomShell('settings', `<div class="content">
  ${head('Admins only · changes apply straight away and are logged', 'Settings', 'How your room runs: how fast cases must move, when people count as silent, what proof photos need.', `<span class="small muted">Last change: Aisha B. · 2 h ago</span><span class="btn">${ic('history')}Change log</span><span class="btn p">Save changes</span>`)}
  <div style="display:grid;grid-template-columns:220px 1fr;gap:20px;align-items:start">
    <div class="card" style="padding:8px;position:sticky;top:16px">${[['gavel', 'Case timings', 1], ['call_split', 'Routing and escalation'], ['diversity_3', 'Field team'], ['photo_camera', 'Photos and proof'], ['sos', 'SOS'], ['phone_callback', 'Callbacks'], ['notifications', 'Alerts and SMS'], ['bar_chart', 'Results'], ['flag', 'Our party'], ['call', 'Calls in the app']].map(([i, t, on]) => `<div class="nl" style="color:${on ? 'var(--teal)' : 'var(--ink2)'};${on ? 'background:var(--tealbg);font-weight:700' : ''}">${ic(i)}<span>${t}</span></div>`).join('')}</div>
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="card"><div class="ch"><div><h2>Case timings</h2><div class="hint">How long a case can wait before someone must take it, and before it must be resolved. When time runs out it moves up.</div></div><span class="btn sm">Reset to Rumfa defaults</span></div>
        <table class="tbl"><tr><th>Severity</th><th>Take it within</th><th>Resolve within</th><th>If not resolved, move to</th></tr>
        ${sevRow('critical', 2, 10, 'National room')}${sevRow('high', 5, 20, 'State room supervisor')}${sevRow('medium', 15, 45, 'State room supervisor')}${sevRow('low', 30, 120, 'Leave in queue')}</table>
        <div class="cb" style="padding-top:4px">${setRow('Move up automatically when time runs out', 'Off: the case turns red and supervisors are alerted, but it stays put.', tog(true))}
        ${setRow('How many times a case can move up', 'Ward → LGA → state room → national room', num(3, 'levels'))}
        ${setRow('Take back from someone idle', 'A case someone took but hasn\'t touched goes back to the queue.', num(8, 'min'))}
        ${setRow('Warn before time runs out', 'The countdown turns amber, and the person who took it gets a push.', num(2, 'min'))}</div></div>

      <div class="card"><div class="ch"><div><h2>Routing and escalation</h2><div class="hint">Which team gets each kind of report, and its starting severity.</div></div></div>
        <table class="tbl"><tr><th>Report</th><th>Goes to</th><th>Starts as</th><th>Photo needed</th></tr>
        ${[['Ballot box snatching', 'Security', 'critical', true], ['Violence or attack', 'Security', 'critical', false], ['Our agent denied entry', 'Legal', 'high', false], ['Vote buying observed', 'Legal', 'medium', true], ['BVAS not working', 'State room', 'high', false], ['Dispute over result sheet', 'Legal', 'high', true]].map(([r, q, s, ph]) => `<tr><td class="b">${r}</td><td><div class="inp" style="width:150px">${q} ${ic('expand_more', 's')}</div></td><td><div class="inp" style="width:130px">${pill(s)} ${ic('expand_more', 's')}</div></td><td>${tog(ph)}</td></tr>`).join('')}</table></div>

      <div class="card"><div class="ch"><div><h2>Field team</h2><div class="hint">When someone shows up on My field team as needing a call.</div></div></div><div class="cb" style="padding-top:0">
        ${setRow('Check-in opens at', 'Agents can check in from this time on election day.', `<div class="inp num">07:00</div>`)}
        ${setRow('Late check-in after', 'After this, not-checked-in agents are flagged to their coordinator.', `<div class="inp num">08:30</div>`)}
        ${setRow('Check-in must be within', 'Further away and the check-in is flagged, not refused.', num(150, 'm'))}
        ${setRow('Silent after', 'No message, report or app activity for this long.', num(60, 'min'))}
        ${setRow('No turnout update after', 'Between accreditation and the count.', num(120, 'min'))}
        ${setRow('Followed up people come back after', 'Done on My field team hides them for this long.', num(60, 'min'))}</div></div>

      <div class="card"><div class="ch"><div><h2>Photos and proof</h2><div class="hint">Photos taken inside the app carry time, place and a fingerprint, so they hold up as evidence.</div></div></div><div class="cb" style="padding-top:0">
        ${setRow('Photos must be taken with the in-app camera', 'Off lets agents pick from the gallery; those photos are marked "From gallery" in the room.', tog(true))}
        ${setRow('Stamp time and polling unit on photos', 'Printed on the photo itself, so screenshots and forwards still show it.', tog(true))}
        ${setRow('Flag photos taken far from the unit', 'Shown with an amber marker in the case.', num(300, 'm'))}
        ${setRow('EC8A needs a photo before figures can be sent', '', tog(true))}
        ${setRow('Photos per report', '', num(4, 'max'))}
        ${setRow('Video clips', 'Short clips upload on weak networks.', num(20, 's max'))}</div></div>

      <div class="card"><div class="ch"><div><h2>SOS</h2><div class="hint">What happens the moment an agent presses SOS.</div></div></div><div class="cb" style="padding-top:0">
        ${setRow('Alert the agent\'s coordinators', 'Ward and LGA coordinator get a call-style alert.', tog(true))}
        ${setRow('Ring the security queue on shift', 'Loud alert on every Security screen until taken.', tog(true))}
        ${setRow('Ask the agent for a live video', 'Starts a request on their phone right after SOS.', tog(false))}
        ${setRow('Unanswered SOS goes to National after', '', num(2, 'min'))}</div></div>

      <div class="card"><div class="ch"><div><h2>Callbacks, alerts and results</h2></div></div><div class="cb" style="padding-top:0">
        ${setRow('Retry a missed callback after', 'Then double each time.', num(5, 'min'))}
        ${setRow('Give up and tell their coordinator after', '', num(3, 'tries'))}
        ${setRow('Send SMS when the phone hasn\'t been seen for', 'Announcements and alerts fall back to SMS.', num(30, 'min'))}
        ${setRow('Show vote estimate once this many units are in', 'And at least 5% of units in the area.', num(20, 'units'))}
        ${setRow('Flag a sheet when ours and IReV differ by', '', num(10, 'votes'))}</div></div>
    </div></div></div>`));

export default P;
