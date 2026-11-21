// Shared pieces for the Rumfa mock pages: tokens, the three app shells, sample photos and small helpers.
// Run `node design/mockups/src/build.mjs` to regenerate every page, then `node design/mockups/src/shoot.mjs` for screenshots.

export const CSS = `
:root{
  --ink:#14171F;--ink2:#3D4652;--ink3:#5B6675;--ink4:#8693A4;--line:#DCE1E8;--line2:#E9EDF2;--bg:#F5F6F8;--card:#FFFFFF;
  --teal:#0F766E;--teal2:#0B5A54;--tealbg:#E6F4F2;--nav:#121A24;--nav2:#1E2836;
  --crit:#B42318;--critbg:#FDECEA;--high:#B54708;--highbg:#FEF0E1;--med:#8A6100;--medbg:#FEF7DC;--low:#3D4652;--lowbg:#EEF1F5;
  --ok:#157F3B;--okbg:#E5F4EA;--info:#1F4E8C;--infobg:#E8EFF9;
  --k-security:#A1251B;--k-legal:#5B3FA8;--k-state:#1F4E8C;--k-helpdesk:#0F766E;--k-national:#3D4652;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);font-family:Inter,system-ui,sans-serif;color:var(--ink);font-size:14px;line-height:1.45}
a{color:#0F5E8C;text-decoration:none}
button{font:inherit;cursor:pointer}
h1{margin:0;font-size:26px;font-weight:800;letter-spacing:-.01em}
h2{margin:0;font-size:16px;font-weight:700}
h3{margin:0;font-size:14px;font-weight:700}
p{margin:0}
.ms{font-family:'Material Symbols Outlined';font-weight:normal;font-style:normal;font-size:20px;line-height:1;display:inline-block;vertical-align:middle;-webkit-font-smoothing:antialiased;font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24}
.ms.f{font-variation-settings:'FILL' 1,'wght' 400,'GRAD' 0,'opsz' 24}
.ms.s{font-size:16px}.ms.l{font-size:28px}

/* Room / Console shell */
.app{display:flex;min-height:100vh}
.side{width:248px;flex:none;background:var(--nav);color:#fff;padding:18px 12px;display:flex;flex-direction:column;gap:16px}
.brand{display:flex;align-items:center;gap:10px;padding:0 8px 4px}
.mark{width:32px;height:32px;border-radius:9px;background:var(--teal);display:grid;place-items:center;font-weight:800}
.brand b{display:block;font-size:15px}.brand small{color:#9AA6B6;font-size:12px}
.grp{display:flex;flex-direction:column;gap:1px}
.gt{font-size:11px;font-weight:700;letter-spacing:.08em;color:#8693A4;padding:0 12px 6px;text-transform:uppercase}
.nl{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;color:#C9D1DC;font-size:14px}
.nl .ms{font-size:19px;color:#8693A4}
.nl.on{background:var(--teal);color:#fff;font-weight:600}.nl.on .ms{color:#fff}
.nl .cnt{margin-left:auto;background:#B42318;color:#fff;font-size:11px;font-weight:700;border-radius:10px;padding:1px 7px}
.sidefoot{margin-top:auto;border-top:1px solid #253041;padding:12px 8px 0;font-size:12px;color:#9AA6B6;display:flex;gap:10px;align-items:center}
.av{width:30px;height:30px;border-radius:50%;background:#2B3A4E;color:#fff;display:grid;place-items:center;font-size:12px;font-weight:700;flex:none}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.top{height:56px;background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px;padding:0 24px}
.top .search{flex:0 1 380px;display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:10px;padding:7px 12px;color:var(--ink4);background:var(--bg)}
.top .sp{flex:1}
.live{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--ok);background:var(--okbg);padding:4px 10px;border-radius:20px}
.live i{width:7px;height:7px;border-radius:50%;background:var(--ok)}
.content{padding:24px 28px 40px;display:flex;flex-direction:column;gap:18px}
.ph{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}
.ph .eyebrow{font-size:13px;color:var(--ink3);font-weight:600;margin-bottom:4px}
.ph .lede{font-size:14px;color:var(--ink2);margin-top:6px;max-width:720px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.grow{flex:1}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px}
.card.pad{padding:18px}
.ch{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line2)}
.cb{padding:16px 18px}
.btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:#fff;color:var(--ink);font-size:13px;font-weight:600;padding:7px 12px;border-radius:9px;white-space:nowrap}
.btn.p{background:var(--teal);border-color:var(--teal);color:#fff}
.btn.d{background:var(--crit);border-color:var(--crit);color:#fff}
.btn.g{border-color:transparent;background:transparent}
.btn.sm{padding:4px 9px;font-size:12px}
.btn .ms{font-size:18px}
.pill{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:700;padding:2px 8px;border-radius:20px;white-space:nowrap}
.pill.critical{background:var(--critbg);color:var(--crit)}.pill.high{background:var(--highbg);color:var(--high)}
.pill.medium{background:var(--medbg);color:var(--med)}.pill.low{background:var(--lowbg);color:var(--low)}
.pill.ok{background:var(--okbg);color:var(--ok)}.pill.info{background:var(--infobg);color:var(--info)}.pill.teal{background:var(--tealbg);color:var(--teal)}
.pill.ghost{background:#fff;border:1px solid var(--line);color:var(--ink2);font-weight:600}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:#fff}
.seg span{padding:6px 12px;font-size:13px;font-weight:600;color:var(--ink2);border-right:1px solid var(--line)}
.seg span:last-child{border-right:0}.seg span.on{background:var(--ink);color:#fff}
.muted{color:var(--ink3)}.small{font-size:12px}.b{font-weight:700}
.tbl{width:100%;border-collapse:collapse;font-size:13.5px}
.tbl th{text-align:left;font-size:12px;font-weight:600;color:var(--ink3);padding:10px 14px;border-bottom:1px solid var(--line);background:#FAFBFC}
.tbl td{padding:11px 14px;border-bottom:1px solid var(--line2);vertical-align:middle}
.tbl tr:last-child td{border-bottom:0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.kpi{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.kpi .n{font-size:26px;font-weight:800;letter-spacing:-.02em}
.kpi .l{font-size:12.5px;color:var(--ink3);font-weight:600}
.kpi .s{font-size:12px;color:var(--ink3);margin-top:2px}
.bar{height:8px;border-radius:6px;background:var(--line2);overflow:hidden}.bar i{display:block;height:100%;background:var(--teal);border-radius:6px}
.field{display:flex;flex-direction:column;gap:5px}
.field label{font-size:12.5px;font-weight:600;color:var(--ink2)}
.inp{border:1px solid var(--line);border-radius:9px;padding:8px 11px;background:#fff;font-size:14px;color:var(--ink);min-height:38px;display:flex;align-items:center;gap:6px}
.inp.num{width:90px;justify-content:space-between}
.hint{font-size:12px;color:var(--ink3)}
.tog{display:inline-block;width:36px;height:20px;border-radius:12px;background:#C5CCD6;position:relative;flex:none}
.tog::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.tog.on{background:var(--teal)}.tog.on::after{left:18px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.kbar{width:4px;align-self:stretch;border-radius:4px;flex:none}
.note{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:10px;background:var(--infobg);color:#173D6E;font-size:13px}
.note.warn{background:var(--highbg);color:#7A3306}
.note.ok{background:var(--okbg);color:#0F5A2A}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line)}
.tabs span{padding:10px 14px;font-size:13.5px;font-weight:600;color:var(--ink3);border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs span.on{color:var(--ink);border-color:var(--teal)}
.chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);border-radius:20px;padding:4px 10px;font-size:12.5px;font-weight:600;background:#fff;color:var(--ink2)}
.chip.on{background:var(--ink);border-color:var(--ink);color:#fff}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}

/* Photos */
.ph-img{position:relative;border-radius:10px;overflow:hidden;background:#222;display:block}
.ph-img svg{display:block;width:100%;height:100%}
.stamp{position:absolute;left:0;right:0;bottom:0;padding:16px 8px 6px;font-size:10.5px;font-weight:600;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.7));display:flex;gap:6px;align-items:center;letter-spacing:.01em}
.verified{position:absolute;top:6px;left:6px;display:inline-flex;align-items:center;gap:3px;background:rgba(21,127,59,.92);color:#fff;font-size:10.5px;font-weight:700;padding:2px 7px 2px 5px;border-radius:12px}
.verified.warn{background:rgba(181,71,8,.95)}
.playbadge{position:absolute;inset:0;display:grid;place-items:center}
.playbadge span{width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,.55);display:grid;place-items:center;color:#fff}

/* Phone */
.stage{min-height:100vh;display:flex;align-items:flex-start;justify-content:center;background:var(--bg)}
.phone{width:390px;min-height:844px;background:#F4F5F7;position:relative;display:flex;flex-direction:column;overflow:hidden}
.sb{height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 22px;font-size:14px;font-weight:700;flex:none}
.sb .ic{display:flex;gap:5px;align-items:center}.sb .ms{font-size:17px}
.atb{display:flex;align-items:center;gap:8px;padding:6px 12px 10px;flex:none}
.atb h1{font-size:20px}.atb .back{width:36px;height:36px;border-radius:50%;display:grid;place-items:center}
.pbody{flex:1;padding:4px 16px 20px;display:flex;flex-direction:column;gap:12px}
.tabbar{flex:none;display:flex;justify-content:space-around;background:#fff;border-top:1px solid var(--line);padding:8px 4px 22px}
.tabbar span{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:11px;font-weight:600;color:var(--ink4);min-width:60px}
.tabbar span.on{color:var(--teal)}.tabbar .ms{font-size:24px}
.pcard{background:#fff;border-radius:16px;padding:14px;border:1px solid var(--line2)}
.bigbtn{display:flex;align-items:center;justify-content:center;gap:8px;border-radius:14px;padding:15px;font-size:16px;font-weight:700;border:0;width:100%}
.bigbtn.p{background:var(--teal);color:#fff}.bigbtn.d{background:var(--crit);color:#fff}.bigbtn.o{background:#fff;border:1.5px solid var(--line);color:var(--ink)}
.lst{background:#fff;border-radius:16px;border:1px solid var(--line2);overflow:hidden}
.li{display:flex;align-items:center;gap:12px;padding:13px 14px;border-bottom:1px solid var(--line2)}
.li:last-child{border-bottom:0}
.ico{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;flex:none}
.sheet{position:absolute;left:0;right:0;bottom:0;background:#fff;border-radius:22px 22px 0 0;padding:10px 18px 30px;box-shadow:0 -10px 30px rgba(0,0,0,.18)}
.grab{width:40px;height:5px;border-radius:4px;background:#D0D5DD;margin:0 auto 12px}
`;

export const HEAD = (title, extra = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400..600,0..1,0&display=block" rel="stylesheet">
<link rel="stylesheet" href="mock.css">${extra}
</head>`;

export const ic = (name, cls = '') => `<span class="ms ${cls}">${name}</span>`;
export const pill = (sev, text) => `<span class="pill ${sev}">${text ?? sev[0].toUpperCase() + sev.slice(1)}</span>`;
export const tog = (on) => `<span class="tog ${on ? 'on' : ''}"></span>`;
export const KIND = { security: '#A1251B', legal: '#5B3FA8', state: '#1F4E8C', helpdesk: '#0F766E', national: '#3D4652' };

// ---------- Room ----------
const ROOM_NAV = [
  ['Operate', [['room', 'support_agent', 'Situation room', 7], ['team', 'diversity_3', 'My field team'], ['callbacks', 'phone_callback', 'Callback requests', 3], ['contacts', 'contact_phone', 'Authority contacts']]],
  ['Election day', [['election-day', 'how_to_vote', 'Election day'], ['results', 'bar_chart', 'Results']]],
  ['Results data', [['irev', 'cloud_download', 'IReV data'], ['sheet-review', 'fact_check', 'Sheet review']]],
  ['Organisation', [['people', 'groups', 'People'], ['shifts', 'schedule', 'Shifts and queues'], ['airtime', 'sim_card', 'Airtime and data'], ['voice', 'campaign', 'Voice outreach'], ['settings', 'settings', 'Settings']]],
];
export function roomShell(active, body, { search = 'Search cases, people, polling units', who = ['AB', 'Aisha Bello', 'Admin · Kano'] } = {}) {
  const nav = ROOM_NAV.map(([t, items]) => `<div class="grp"><div class="gt">${t}</div>${items.map(([p, i, txt, n]) =>
    `<a class="nl ${p === active ? 'on' : ''}" href="room-${p}.html">${ic(i)}<span>${txt}</span>${n ? `<span class="cnt">${n}</span>` : ''}</a>`).join('')}</div>`).join('');
  return `<div class="app"><aside class="side"><div class="brand"><div class="mark">A</div><div><b>ALAWA Room</b><small>Rumfa Room</small></div></div>${nav}
  <div class="sidefoot"><div class="av">${who[0]}</div><div><div style="color:#fff;font-weight:600">${who[1]}</div>${who[2]}</div></div></aside>
  <div class="main"><div class="top"><div class="search">${ic('search', 's')} ${search}</div><div class="sp"></div>
  <span class="live"><i></i>Live · Governorship 2027</span><span class="btn g">${ic('notifications')}</span><span class="btn g">${ic('help')}</span></div>
  ${body}</div></div>`;
}

// ---------- Console ----------
const CON_NAV = [
  ['Clients', [['clients', 'apartment', 'Clients']]],
  ['Reference data', [['places', 'map', 'Places'], ['parties', 'flag', 'Parties'], ['elections', 'event', 'Elections'], ['contacts', 'contact_phone', 'Authority contacts']]],
  ['Platform', [['staff', 'badge', 'Staff'], ['activity', 'history', 'Activity']]],
];
export function consoleShell(active, body) {
  const nav = CON_NAV.map(([t, items]) => `<div class="grp"><div class="gt">${t}</div>${items.map(([p, i, txt]) =>
    `<a class="nl ${p === active ? 'on' : ''}" href="console-${p}.html">${ic(i)}<span>${txt}</span></a>`).join('')}</div>`).join('');
  return `<div class="app"><aside class="side" style="background:#0E1420"><div class="brand"><div class="mark" style="background:#3D4652">R</div><div><b>Rumfa Console</b><small>Platform staff</small></div></div>${nav}
  <div class="sidefoot"><div class="av">UB</div><div><div style="color:#fff;font-weight:600">Umar B.</div>Owner</div></div></aside>
  <div class="main"><div class="top"><div class="search">${ic('search', 's')} Search clients, places, staff</div><div class="sp"></div><span class="pill ghost">Production</span></div>
  ${body}</div></div>`;
}

// ---------- Agent ----------
export function phone(body, { tabs = null, dark = false, bg = null } = {}) {
  const tb = tabs ? `<nav class="tabbar">${[['today', 'today', 'Today'], ['chats', 'forum', 'Chats'], ...(tabs.coord ? [['area', 'map', 'My area'], ['requests', 'phone_callback', 'Requests']] : []), ['me', 'person', 'Me']]
    .map(([k, i, t]) => `<span class="${k === tabs.on ? 'on' : ''}">${ic(i, k === tabs.on ? 'f' : '')}${t}</span>`).join('')}</nav>` : '';
  return `<div class="stage"><div class="phone" style="${dark ? 'background:#000;color:#fff;' : ''}${bg ? `background:${bg};` : ''}">
  <div class="sb"><span>14:32</span><span class="ic">${ic('signal_cellular_alt')}${ic('wifi')}${ic('battery_5_bar')}</span></div>
  ${body}${tb}</div></div>`;
}
export const atb = (title, { back = true, right = '' } = {}) => `<div class="atb">${back ? `<span class="back">${ic('arrow_back')}</span>` : ''}<h1 class="grow">${title}</h1>${right}</div>`;

// ---------- Sample photos (drawn, so nothing real is shipped) ----------
export const PHOTO = {
  crowd: `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9CC3E0"/><stop offset="1" stop-color="#E9D7B5"/></linearGradient></defs>
    <rect width="400" height="300" fill="url(#sky)"/><rect y="170" width="400" height="130" fill="#B98F5F"/><rect x="250" y="90" width="130" height="90" fill="#D9C6A2"/><rect x="262" y="110" width="30" height="70" fill="#6B4E2E"/><rect x="305" y="105" width="60" height="30" fill="#8FA9BF"/>
    ${Array.from({ length: 14 }, (_, i) => { const x = 18 + i * 27 + (i % 3) * 4, y = 150 + (i % 4) * 12, c = ['#3A2A20', '#2C3E50', '#7B2D26', '#1E5631', '#5A3E8C'][i % 5]; return `<circle cx="${x}" cy="${y}" r="10" fill="#4A3426"/><rect x="${x - 13}" y="${y + 10}" width="26" height="60" rx="11" fill="${c}"/>`; }).join('')}
    <rect x="40" y="70" width="160" height="34" rx="3" fill="#F2F2F2"/><text x="120" y="93" font-size="15" font-family="Inter" font-weight="700" text-anchor="middle" fill="#1F4E8C">PU 006 · AGALAWA</text></svg>`,
  box: `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice"><rect width="400" height="300" fill="#C9B79A"/><rect y="200" width="400" height="100" fill="#8C6E4C"/>
    <rect x="110" y="95" width="180" height="140" rx="6" fill="#EDF2F5" stroke="#A9B6C2" stroke-width="3"/><rect x="170" y="95" width="60" height="8" fill="#56616E"/><text x="200" y="175" font-size="22" font-family="Inter" font-weight="800" text-anchor="middle" fill="#0F5E8C">INEC</text>
    <path d="M290 130 L340 110 L350 140 L300 160Z" fill="#3A2A20"/><circle cx="355" cy="95" r="16" fill="#4A3426"/><rect x="335" y="110" width="40" height="110" rx="14" fill="#7B2D26"/><path d="M60 120 l30 0 l-4 80 l-22 0z" fill="#2C3E50"/><circle cx="75" cy="105" r="14" fill="#4A3426"/></svg>`,
  sheet: `<svg viewBox="0 0 300 400" preserveAspectRatio="xMidYMid slice"><rect width="300" height="400" fill="#6E5A44"/><g transform="rotate(-2 150 200)"><rect x="22" y="18" width="256" height="364" fill="#FAF7EE"/>
    <text x="150" y="44" font-size="11" font-family="Inter" font-weight="800" text-anchor="middle" fill="#222">FORM EC8A · STATEMENT OF RESULT</text><text x="150" y="58" font-size="8" font-family="Inter" text-anchor="middle" fill="#444">Polling unit 006 · Agalawa ward · Kano Municipal</text>
    ${Array.from({ length: 10 }, (_, i) => `<line x1="34" x2="266" y1="${80 + i * 22}" y2="${80 + i * 22}" stroke="#BBB"/><text x="40" y="${95 + i * 22}" font-size="9" font-family="Inter" fill="#333">${['APC', 'NNPP', 'PDP', 'LP', 'ADC', 'SDP', 'YPP', 'Rejected', 'Total valid', 'Accredited'][i]}</text><text x="230" y="${96 + i * 22}" font-size="12" font-family="Comic Sans MS, cursive" fill="#1B3A8C">${[212, 187, 34, 9, 4, 2, 1, 6, 449, 461][i]}</text>`).join('')}
    <line x1="200" x2="200" y1="70" y2="300" stroke="#BBB"/><text x="40" y="335" font-size="8" font-family="Inter" fill="#444">Presiding officer signature</text><path d="M45 360 q20 -20 40 0 t40 -5 t30 4" stroke="#1B3A8C" fill="none" stroke-width="1.6"/>
    <circle cx="232" cy="352" r="20" fill="none" stroke="#7B2D26" stroke-width="2" opacity=".6"/><text x="232" y="355" font-size="6" font-family="Inter" text-anchor="middle" fill="#7B2D26" opacity=".7">INEC STAMP</text></g></svg>`,
  night: `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice"><rect width="400" height="300" fill="#2A2F3A"/><rect y="190" width="400" height="110" fill="#3B3328"/><circle cx="320" cy="60" r="40" fill="#F4C27A" opacity=".35"/>
    <rect x="40" y="140" width="110" height="60" rx="8" fill="#5C6470"/><rect x="50" y="120" width="70" height="30" rx="6" fill="#4B525C"/><circle cx="65" cy="200" r="12" fill="#111"/><circle cx="130" cy="200" r="12" fill="#111"/>
    ${[200, 235, 270, 300].map((x, i) => `<circle cx="${x}" cy="${145 + i % 2 * 6}" r="10" fill="#2C2018"/><rect x="${x - 12}" y="${155 + i % 2 * 6}" width="24" height="50" rx="10" fill="${['#111', '#3A1F1F', '#1F2A3A', '#222'][i]}"/>`).join('')}
    <path d="M300 160 l40 -30" stroke="#8B6B4A" stroke-width="6" stroke-linecap="round"/></svg>`,
  selfie: `<svg viewBox="0 0 300 300" preserveAspectRatio="xMidYMid slice"><rect width="300" height="300" fill="#D8CBB6"/><circle cx="150" cy="125" r="55" fill="#6B4A32"/><path d="M95 115 q55 -70 110 0 q-10 -50 -55 -50 q-45 0 -55 50" fill="#1E1E1E"/><rect x="70" y="190" width="160" height="120" rx="60" fill="#1E5631"/></svg>`,
};
export function photo(kind, { w = '100%', h = 160, stamp = null, badge = 'app', play = false, style = '' } = {}) {
  const b = badge === 'app' ? `<span class="verified">${ic('verified', 's f')}In-app camera</span>` : badge === 'gallery' ? `<span class="verified warn">${ic('photo_library', 's')}From gallery</span>` : '';
  return `<div class="ph-img" style="width:${typeof w === 'number' ? w + 'px' : w};height:${h}px;${style}">${PHOTO[kind]}${b}${play ? `<div class="playbadge"><span>${ic('play_arrow', 'f')}</span></div>` : ''}${stamp ? `<div class="stamp">${ic('location_on', 's')}${stamp}</div>` : ''}</div>`;
}

export function page(title, body, extraCss = '') {
  return `${HEAD(title, extraCss ? `<style>${extraCss}</style>` : '')}<body>${body}</body></html>`;
}
