// Rumfa agent app (phone) screens
import { phone, atb, page, ic, pill, photo } from './common.mjs';

const P = {};
const A = (title, body, opts) => page(title + ' · Agent app', phone(body, opts));
const ico = (i, bg, c) => `<span class="ico" style="background:${bg};color:${c}">${ic(i)}</span>`;

P['agent-login'] = A('Sign in', `<div class="pbody" style="justify-content:center;gap:18px;padding:30px 24px">
  <div class="mark" style="width:56px;height:56px;font-size:24px;color:#fff;border-radius:16px">A</div>
  <div><h1>ALAWA agents</h1><p class="muted" style="margin-top:6px">Enter the phone number your coordinator registered. We'll text you a code.</p></div>
  <div class="field"><label>Phone number</label><div class="inp" style="font-size:18px;padding:13px">+234 803 *** 4471</div></div>
  <button class="bigbtn p">Send code</button><p class="small muted" style="text-align:center">No data? Text <b>HELP</b> to 4040 and the helpdesk will call you.</p></div>`);

P['agent-onboarding'] = A('Before election day', `${atb('Get ready', { back: false })}<div class="pbody">
  <div class="pcard"><b>Musa Ibrahim</b><div class="small muted">Agent · PU 006 Agalawa · Kano Municipal</div><div class="small muted">Coordinator: Idris Lawan · 0806 *** 2290</div></div>
  <div class="lst">${[['photo_camera', 'Camera', 'Photos are taken inside the app so the room knows they\'re real.', true], ['location_on', 'Location', 'Checks you\'re at your polling unit when you check in.', true], ['notifications', 'Notifications', 'For calls, tasks and alerts from your coordinator.', true], ['mic', 'Microphone', 'For calls and live video from the room.', false]].map(([i, t, d, ok]) => `<div class="li">${ico(i, ok ? 'var(--okbg)' : 'var(--lowbg)', ok ? 'var(--ok)' : 'var(--ink2)')}<div class="grow"><b>${t}</b><div class="small muted">${d}</div></div>${ok ? `<span style="color:var(--ok)">${ic('check_circle', 'f')}</span>` : '<span class="btn sm p">Allow</span>'}</div>`).join('')}</div>
  <div class="pcard row"><span style="color:var(--teal)">${ic('school')}</span><div class="grow"><b>Practice run</b><div class="small muted">Send a test report and photo. Nothing goes to the room.</div></div>${ic('chevron_right')}</div>
  <div class="grow"></div><button class="bigbtn p">I'm ready</button></div>`);

P['agent-lock'] = A('Unlock', `<div class="pbody" style="align-items:center;justify-content:center;gap:20px;text-align:center">
  <div class="av" style="width:64px;height:64px;font-size:22px;background:#1F4E8C">MI</div><div><h1 style="font-size:22px">Welcome back, Musa</h1><p class="muted">Enter your 4-digit PIN</p></div>
  <div class="row" style="gap:16px">${[1, 1, 0, 0].map((f) => `<span style="width:16px;height:16px;border-radius:50%;${f ? 'background:var(--ink)' : 'border:2px solid var(--ink4)'}"></span>`).join('')}</div>
  <div style="display:grid;grid-template-columns:repeat(3,72px);gap:14px">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k) => `<div style="height:64px;border-radius:50%;${k ? 'background:#fff;border:1px solid var(--line2)' : ''};display:grid;place-items:center;font-size:24px;font-weight:600">${k}</div>`).join('')}</div>
  <a class="small" href="#">Forgot PIN? Use a text code</a></div>`);

P['agent-today'] = A('Today', `${atb('Today', { back: false, right: `<span class="pill ok">${ic('wifi', 's')}Online</span>` })}<div class="pbody">
  <div class="pcard" style="background:var(--teal);color:#fff;border:0"><div class="small" style="opacity:.8">PU 006 · Agalawa · 461 registered</div><div style="font-size:20px;font-weight:800;margin:4px 0 10px">Counting has started</div>
    <div class="row small" style="gap:6px">${['Check-in', 'Accreditation', 'Count', 'EC8A'].map((s, i) => `<span style="flex:1;height:5px;border-radius:4px;background:${i < 3 ? '#fff' : 'rgba(255,255,255,.3)'}"></span>`).join('')}</div><div class="small" style="margin-top:6px;opacity:.85">Next: take a photo of the signed EC8A</div></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
    <div class="pcard" style="display:flex;flex-direction:column;gap:8px">${ico('report', 'var(--highbg)', 'var(--high)')}<b>Report a problem</b><span class="small muted">With photo</span></div>
    <div class="pcard" style="display:flex;flex-direction:column;gap:8px">${ico('description', 'var(--infobg)', 'var(--info)')}<b>Send result</b><span class="small muted">EC8A photo + figures</span></div>
    <div class="pcard" style="display:flex;flex-direction:column;gap:8px">${ico('how_to_reg', 'var(--okbg)', 'var(--ok)')}<b>Turnout</b><span class="small muted">Last sent 35 min ago</span></div>
    <div class="pcard" style="display:flex;flex-direction:column;gap:8px;border:1.5px solid var(--info)">${ico('phone_callback', 'var(--info)', '#fff')}<b>Ask to be called</b><span class="small muted">Idris (coordinator) calls you</span></div></div>
  <div class="pcard row" style="gap:12px;border-color:#F3C8C2;background:#FFF8F7"><span style="color:var(--crit)">${ic('assignment_ind', 'f')}</span><div class="grow"><b>Task from the room</b><div class="small muted">Go to PU 008 and check on the BVAS · sent 2 min ago</div></div><span class="btn sm p">Open</span></div>
  <div class="lst">${[['14:21', 'Ballot box snatching', 'Taken by the room · Ibrahim S.', 'box'], ['13:05', 'Turnout · 312 accredited', 'Received', null]].map(([t, a, b, ph]) => `<div class="li">${ph ? photo(ph, { w: 44, h: 44, badge: null }) : ico('check', 'var(--okbg)', 'var(--ok)')}<div class="grow"><b style="font-size:14px">${a}</b><div class="small muted">${t} · ${b}</div></div>${ic('chevron_right')}</div>`).join('')}</div>
  <button class="bigbtn d" style="margin-top:4px">${ic('sos', 'f')}SOS · I'm in danger</button></div>`, { tabs: { on: 'today' } });

P['agent-report'] = A('Report a problem', `${atb('Report a problem')}<div class="pbody">
  <div class="small b muted">WHAT IS HAPPENING?</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${[['Ballot box snatching', 'inventory_2', 1], ['Violence or attack', 'warning'], ['Thugs or intimidation', 'group'], ['Agent denied entry', 'block'], ['Vote buying', 'payments'], ['BVAS not working', 'fingerprint'], ['Voters turned away', 'person_cancel'], ['Other', 'more_horiz']].map(([t, i, on]) => `<div class="pcard" style="padding:11px;display:flex;gap:8px;align-items:center;${on ? 'border:2px solid var(--teal);background:var(--tealbg)' : ''}"><span style="color:${on ? 'var(--teal)' : 'var(--ink2)'}">${ic(i)}</span><span style="font-size:13px;font-weight:600;line-height:1.2">${t}</span></div>`).join('')}</div>
  <div class="small b muted">PHOTOS <span style="font-weight:500">· taken in the app</span></div>
  <div class="row" style="gap:8px">${photo('box', { w: 104, h: 104, badge: null, stamp: '14:21' })}${photo('crowd', { w: 104, h: 104, badge: null, stamp: '14:21' })}<div style="width:104px;height:104px;border-radius:10px;border:2px dashed var(--teal);display:grid;place-items:center;text-align:center;color:var(--teal);font-size:12px;font-weight:700">${ic('photo_camera', 'l')}<br>Take photo</div></div>
  <div class="row small muted" style="gap:6px">${ic('videocam', 's')}Hold the button to record up to 20 s of video</div>
  <div class="field"><label>What did you see? (optional)</label><div class="inp" style="min-height:70px;align-items:flex-start">Four men came with a bus and took the box before counting. Police not here.</div></div>
  <button class="bigbtn p">${ic('send')}Send to the room</button><p class="small muted" style="text-align:center">No network? It's saved and sent as soon as you're back online.</p></div>`);

P['agent-camera'] = A('Camera', `<div style="flex:1;position:relative;background:#000">
  <div style="position:absolute;inset:0">${photo('crowd', { h: 800, badge: null, style: 'border-radius:0' })}</div>
  <div style="position:absolute;top:0;left:0;right:0;padding:10px 16px;display:flex;align-items:center;gap:10px;color:#fff;background:linear-gradient(rgba(0,0,0,.6),transparent)">${ic('close')}<span class="grow"></span><span class="pill" style="background:rgba(21,127,59,.9);color:#fff">${ic('my_location', 's')}At PU 006 · ±8 m</span>${ic('flash_off')}</div>
  <div style="position:absolute;left:22px;right:22px;top:120px;bottom:250px;border:2px solid rgba(255,255,255,.7);border-radius:14px"></div>
  <div style="position:absolute;left:0;right:0;bottom:200px;text-align:center;color:#fff;font-size:12.5px;font-weight:600;text-shadow:0 1px 3px #000">Rumfa · 14:21 · PU 006 Agalawa · will be printed on the photo</div>
  <div style="position:absolute;left:0;right:0;bottom:0;padding:18px 26px 34px;background:rgba(0,0,0,.75);color:#fff;display:flex;flex-direction:column;gap:16px">
    <div class="row small" style="justify-content:center;gap:18px;font-weight:700"><span style="opacity:.6">VIDEO</span><span style="color:#FDE68A">PHOTO</span><span style="opacity:.6">SHEET</span></div>
    <div class="row" style="justify-content:space-between">${photo('crowd', { w: 46, h: 46, badge: null })}<span style="width:74px;height:74px;border-radius:50%;border:4px solid #fff;display:grid;place-items:center"><span style="width:58px;height:58px;border-radius:50%;background:#fff"></span></span><span style="width:46px;height:46px;border-radius:50%;background:rgba(255,255,255,.15);display:grid;place-items:center">${ic('cameraswitch')}</span></div>
    <div class="small" style="text-align:center;opacity:.75">${ic('verified', 's')} Only the in-app camera can be used for proof</div></div></div>`, { dark: true });

P['agent-camera-review'] = A('Use this photo?', `<div style="flex:1;position:relative;background:#000;display:flex;flex-direction:column">
  <div style="flex:1;padding:8px 0">${photo('box', { h: 560, badge: null, stamp: 'Rumfa · 14:21:07 · PU 006 Agalawa · 12 m', style: 'border-radius:0' })}</div>
  <div style="padding:16px 18px 32px;color:#fff;display:flex;flex-direction:column;gap:12px">
    <div class="row small" style="gap:8px;color:#B7E4C7">${ic('verified', 's f')}Time, place and fingerprint saved with the photo</div>
    <div class="row" style="gap:10px"><button class="bigbtn o" style="background:transparent;color:#fff;border-color:#555">${ic('refresh')}Retake</button><button class="bigbtn p">${ic('check')}Use photo</button></div></div></div>`, { dark: true });

P['agent-sos'] = A('SOS sent', `<div class="pbody" style="background:var(--crit);color:#fff;margin:0;padding:24px 20px;gap:16px">
  <div style="text-align:center;padding:14px 0"><span style="width:96px;height:96px;border-radius:50%;background:rgba(255,255,255,.18);display:inline-grid;place-items:center">${ic('sos', 'l f')}</span>
  <h1 style="font-size:26px;margin-top:12px">Help is on the way</h1><p style="opacity:.9;margin-top:6px">The security room and Idris (your coordinator) have been alerted with your location.</p></div>
  <div style="background:rgba(0,0,0,.18);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:8px">${[['check_circle', 'Sent 14:31 · location ±8 m'], ['check_circle', 'Security room saw it · 14:31'], ['pending', 'Ibrahim S. is calling you…']].map(([i, t]) => `<div class="row" style="gap:8px">${ic(i, 'f')}${t}</div>`).join('')}</div>
  <div class="small b" style="opacity:.85">IF IT IS SAFE, ADD DETAILS</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div style="background:#fff;color:var(--crit);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:6px;font-weight:700">${ic('photo_camera', 'l')}Take a photo</div><div style="background:#fff;color:var(--crit);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:6px;font-weight:700">${ic('videocam', 'l')}Record 20 s</div></div>
  <div style="background:#fff;color:var(--ink);border-radius:14px;padding:12px 14px">What's happening? <span class="muted">(optional)</span></div>
  <div class="grow"></div><button class="bigbtn" style="background:rgba(0,0,0,.25);color:#fff">I'm safe now</button></div>`, { bg: 'var(--crit)' });

P['agent-count'] = A('Turnout', `${atb('Turnout update')}<div class="pbody">
  <div class="pcard"><div class="small muted">PU 006 · 461 registered</div><div class="b">Accredited so far (from BVAS)</div>
  <div class="row" style="justify-content:space-between;margin-top:10px"><span class="bigbtn o" style="width:60px">−</span><span style="font-size:44px;font-weight:800">312</span><span class="bigbtn o" style="width:60px">+</span></div><div class="small muted" style="text-align:center">Last sent 268 at 12:58</div></div>
  <div class="pcard row">${ic('photo_camera')}<div class="grow"><b>Photo of the BVAS screen</b><div class="small muted">Optional, helps the room trust the number</div></div>${photo('crowd', { w: 52, h: 52, badge: null })}</div>
  <div class="grow"></div><button class="bigbtn p">Send</button></div>`);

P['agent-result'] = A('Send result', `${atb('Send result · EC8A')}<div class="pbody">
  <div class="row" style="gap:6px">${['Photo', 'Figures', 'Check'].map((s, i) => `<span style="flex:1;text-align:center;font-size:12px;font-weight:700;padding:6px;border-radius:8px;${i === 0 ? 'background:var(--teal);color:#fff' : 'background:#fff;color:var(--ink3)'}">${i + 1}. ${s}</span>`).join('')}</div>
  <div style="position:relative;border-radius:14px;overflow:hidden">${photo('sheet', { h: 420, badge: null, style: 'border-radius:0' })}
    <div style="position:absolute;inset:26px 30px;border:3px solid #2DD4BF;border-radius:6px;box-shadow:0 0 0 999px rgba(0,0,0,.35)"></div>
    <div class="pill" style="position:absolute;top:10px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.7);color:#fff">${ic('crop_free', 's')}Sheet found · hold still</div></div>
  <div class="note ok">${ic('verified', 'f')}<div>Use the in-app camera. We'll read the figures for you to check, and the photo is stamped with time and place.</div></div>
  <button class="bigbtn p">${ic('photo_camera')}Take photo of signed sheet</button></div>`);

P['agent-callback'] = A('Ask to be called', `${atb('Ask to be called')}<div class="pbody">
  <div class="pcard row" style="gap:12px"><div class="av" style="width:44px;height:44px;background:var(--teal)">IL</div><div class="grow"><b>Idris Lawan</b><div class="small muted">Your coordinator · usually calls back in 4 min</div></div></div>
  <div class="small b muted">WHAT IS IT ABOUT?</div>
  <div class="lst">${[['help', 'Question about a form'], ['location_on', 'Problem at my polling unit', 1], ['phonelink_erase', 'App or phone problem'], ['more_horiz', 'Other']].map(([i, t, on]) => `<div class="li" style="${on ? 'background:var(--tealbg)' : ''}">${ic(i)}<span class="grow b" style="font-size:14px">${t}</span>${on ? `<span style="color:var(--teal)">${ic('radio_button_checked')}</span>` : ic('radio_button_unchecked')}</div>`).join('')}</div>
  <div class="field"><label>Anything to add? (optional)</label><div class="inp" style="min-height:60px;align-items:flex-start">They are not allowing our agent to sign.</div></div>
  <div class="grow"></div><button class="bigbtn p">${ic('phone_callback')}Ask Idris to call me</button><p class="small muted" style="text-align:center">No data? It goes by SMS automatically.</p></div>`);

P['agent-chats'] = A('Chats', `${atb('Chats', { back: false, right: ic('edit_square') })}<div class="pbody">
  <div class="lst">${[['campaign', 'Announcements', 'Coordinators: EC8A photos before 18:00 please', '14:02', 'var(--crit)', 1], ['groups', 'Agalawa ward', 'Idris: Everyone check in by 8:30', '08:12', 'var(--teal)', 0], ['person', 'Idris Lawan', 'Photo', '14:25', '#1F4E8C', 2], ['support_agent', 'Situation room', 'Ibrahim: Is the bus still there?', '14:26', '#3D4652', 1]].map(([i, t, m, w, c, n]) => `<div class="li">${ico(i, c, '#fff')}<div class="grow" style="min-width:0"><div class="row" style="justify-content:space-between"><b style="font-size:14.5px">${t}</b><span class="small muted">${w}</span></div><div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${m === 'Photo' ? `${ic('photo_camera', 's')} Photo` : m}</div></div>${n ? `<span class="pill" style="background:var(--teal);color:#fff">${n}</span>` : ''}</div>`).join('')}</div></div>`, { tabs: { on: 'chats' } });

const bub = (me, body, t) => `<div style="align-self:${me ? 'flex-end' : 'flex-start'};max-width:78%;background:${me ? '#D8F1EC' : '#fff'};border-radius:14px;padding:8px 10px;border:1px solid var(--line2)">${body}<div class="small muted" style="text-align:right;font-size:11px">${t}</div></div>`;
P['agent-chat'] = A('Situation room', `${atb('Situation room', { right: ic('call') })}<div class="pbody" style="gap:8px">
  <div class="small muted" style="text-align:center">Case: Ballot box snatching · PU 006</div>
  ${bub(false, 'Musa, can you send a photo of where the bus was?', '14:24')}
  ${bub(true, `${photo('crowd', { w: 230, h: 160, badge: 'app', stamp: '14:25 · PU 006' })}<div style="margin-top:6px">This is where it parked</div>`, '14:25 ✓✓')}
  ${bub(false, 'Is the bus still there?', '14:26')}
  ${bub(true, 'No it left towards Kofar Mata', '14:26 ✓✓')}
  <div class="grow"></div>
  <div class="row" style="gap:8px"><span class="ico" style="background:#fff;border:1px solid var(--line)">${ic('photo_camera')}</span><div class="inp grow" style="border-radius:20px;color:var(--ink4)">Message</div><span class="ico" style="background:var(--teal);color:#fff;border-radius:50%">${ic('send')}</span></div></div>`);

P['agent-photo'] = A('Photo', `<div style="flex:1;background:#000;color:#fff;display:flex;flex-direction:column">
  <div class="row" style="padding:8px 14px">${ic('arrow_back')}<div class="grow"><b>You</b><div class="small" style="opacity:.7">14:25 · Situation room</div></div>${ic('share')}</div>
  <div style="flex:1;display:grid;place-items:center">${photo('crowd', { h: 420, badge: 'app', stamp: 'Rumfa · 14:25 · PU 006 Agalawa · 15 m', style: 'border-radius:0' })}</div>
  <div style="padding:14px 18px 34px" class="small"><div class="row" style="gap:6px;color:#B7E4C7">${ic('verified', 's f')}Taken in the app · fingerprint saved</div><div style="opacity:.7;margin-top:4px">Pinch to zoom · swipe for the next photo</div></div></div>`, { dark: true });

P['agent-me'] = A('Me', `${atb('Me', { back: false })}<div class="pbody">
  <div class="pcard row" style="gap:12px"><div class="av" style="width:52px;height:52px;font-size:18px;background:#1F4E8C">MI</div><div class="grow"><b style="font-size:17px">Musa Ibrahim</b><div class="small muted">Agent · PU 006 Agalawa</div></div></div>
  <div class="lst">${[['language', 'Language', 'Hausa'], ['lock', 'Change PIN', ''], ['cloud_upload', 'Waiting to send', '0 items'], ['school', 'Practice mode', 'Off'], ['help', 'Help and how-tos', ''], ['support_agent', 'Call the helpdesk', '']].map(([i, t, v]) => `<div class="li">${ic(i)}<span class="grow">${t}</span><span class="small muted">${v}</span>${ic('chevron_right')}</div>`).join('')}</div>
  <div class="small muted" style="text-align:center">App 2.4.1 · Signed in since 06:12</div><button class="bigbtn o">Sign out</button></div>`, { tabs: { on: 'me' } });

P['agent-area'] = A('My area', `${atb('Gama ward', { back: false, right: '<span class="pill high">3 to do</span>' })}<div class="pbody">
  <div class="pcard" style="padding:0;overflow:hidden"><svg viewBox="0 0 360 230" style="display:block;width:100%;background:#EEF1E8">${[[60, 60, 1], [120, 90, 1], [200, 50, 0], [260, 120, 1], [90, 160, 2], [180, 170, 1], [300, 190, 1], [230, 80, 1]].map(([x, y, s]) => `<circle cx="${x}" cy="${y}" r="10" fill="${['#C5CCD6', '#0F766E', '#B42318'][s]}" stroke="#fff" stroke-width="3"/>`).join('')}<path d="M20 200 Q150 120 340 210" stroke="#D0C8B0" stroke-width="8" fill="none"/></svg></div>
  <div class="row small" style="gap:12px"><span><span class="dot" style="background:#0F766E"></span> In place 12</span><span><span class="dot" style="background:#C5CCD6"></span> Not in 1</span><span><span class="dot" style="background:#B42318"></span> Problem 1</span></div>
  <div class="lst">${[['Abubakar Garba', 'PU 012 · not checked in', 'crit'], ['Rakiya Sani', 'PU 027 · silent 1 h', 'high'], ['Yusuf D.', 'PU 019 · reported vote buying', 'high']].map(([n, s, c]) => `<div class="li"><div class="av" style="background:#1F4E8C">${n[0]}</div><div class="grow"><b style="font-size:14px">${n}</b><div class="small" style="color:var(--${c})">${s}</div></div><span class="ico" style="background:var(--tealbg);color:var(--teal)">${ic('call')}</span></div>`).join('')}</div></div>`, { tabs: { on: 'area', coord: true } });

P['agent-requests'] = A('Requests', `${atb('Call requests', { back: false })}<div class="pbody">
  ${[['Hauwa Kabir', 'PU 014 · Problem at my unit', '"They are not allowing our agent to sign."', '12 min', true], ['Bello Nuhu', 'PU 044 · App or phone problem', '', '3 min', false]].map(([n, w, q, t, u]) => `<div class="pcard" style="display:flex;flex-direction:column;gap:10px;${u ? 'border-color:#F3C8C2' : ''}"><div class="row"><div class="av" style="background:#1F4E8C">${n[0]}</div><div class="grow"><b>${n}</b><div class="small muted">${w}</div></div><span class="small b" style="color:${u ? 'var(--crit)' : 'var(--ink2)'}">${t}</span></div>${q ? `<div class="small">${q}</div>` : ''}<div class="row" style="gap:8px"><button class="bigbtn p" style="padding:10px;font-size:14px">${ic('call')}Call</button><button class="bigbtn o" style="padding:10px;font-size:14px">Done</button></div></div>`).join('')}</div>`, { tabs: { on: 'requests', coord: true } });

P['agent-team'] = A('My team', `${atb('My team · Gama')}<div class="pbody">
  <div class="row" style="gap:6px;overflow:hidden"><span class="chip on">Needs a call 3</span><span class="chip">All 14</span><span class="chip">Done 2</span></div>
  <div class="lst">${[['Abubakar Garba', 'PU 012', 'Not checked in'], ['Rakiya Sani', 'PU 027', 'Silent 1 h 12 min'], ['Maryam Bala', 'PU 015', 'No turnout 2 h']].map(([n, u, s]) => `<div class="li"><div class="av" style="background:#1F4E8C">${n[0]}</div><div class="grow"><b style="font-size:14px">${n}</b><div class="small muted">${u} · <span style="color:var(--high);font-weight:600">${s}</span></div></div><span class="ico" style="background:var(--tealbg);color:var(--teal)">${ic('call')}</span><span class="ico" style="background:var(--okbg);color:var(--ok)">${ic('done')}</span></div>`).join('')}</div>
  <div class="pcard" style="display:flex;flex-direction:column;gap:8px"><b>Message everyone in Gama</b><div class="inp" style="min-height:60px;align-items:flex-start;color:var(--ink4)">Write an announcement…</div><div class="small muted">Push to all · SMS to anyone offline for 30 min</div><button class="bigbtn p" style="padding:11px;font-size:14px">Send</button></div></div>`);

P['agent-live'] = A('Live video', `<div style="flex:1;position:relative;background:#000;color:#fff">
  ${photo('night', { h: 800, badge: null, style: 'border-radius:0;position:absolute;inset:0' })}
  <div style="position:absolute;top:10px;left:14px;right:14px" class="row"><span class="pill" style="background:var(--crit);color:#fff">${ic('fiber_manual_record', 's f')}LIVE 0:42</span><span class="grow"></span><span class="pill" style="background:rgba(0,0,0,.6);color:#fff">${ic('visibility', 's')}Situation room</span></div>
  <div style="position:absolute;bottom:0;left:0;right:0;padding:18px 24px 36px;background:linear-gradient(transparent,rgba(0,0,0,.85));display:flex;flex-direction:column;gap:14px;align-items:center">
    <div class="small" style="text-align:center">Ibrahim S. is watching. Point the phone at what's happening.</div>
    <div class="row" style="gap:24px"><span class="ico" style="width:54px;height:54px;border-radius:50%;background:rgba(255,255,255,.2)">${ic('mic')}</span><span class="ico" style="width:64px;height:64px;border-radius:50%;background:var(--crit)">${ic('call_end')}</span><span class="ico" style="width:54px;height:54px;border-radius:50%;background:rgba(255,255,255,.2)">${ic('cameraswitch')}</span></div></div></div>`, { dark: true });

P['agent-task'] = A('Task', `${atb('Task from the room')}<div class="pbody">
  <div class="pcard" style="display:flex;flex-direction:column;gap:8px;border-color:#F3C8C2"><div class="row">${pill('high')}<span class="small muted">Sent 14:29 by Ibrahim S.</span></div><b style="font-size:17px">Go to PU 008 and check on the BVAS</b><div class="small">Agent there reports BVAS not working for 40 min. Confirm and take a photo of the queue.</div>
    <div class="row small muted">${ic('directions_walk', 's')} PU 008 Tudun Wada · 1.2 km · about 15 min walk</div></div>
  <div class="pcard"><div class="small b muted" style="margin-bottom:8px">PROGRESS · THE ROOM SEES THIS</div>${[['Sent', '14:29', 1], ['Seen', '14:30', 1], ['On my way', '', 0], ['Arrived', '', 0], ['Reported back', '', 0]].map(([s, t, d], i) => `<div class="row" style="gap:10px;padding:5px 0"><span style="color:${d ? 'var(--ok)' : 'var(--ink4)'}">${ic(d ? 'check_circle' : 'radio_button_unchecked', d ? 'f' : '')}</span><span class="grow ${d ? 'b' : 'muted'}">${s}</span><span class="small muted">${t}</span></div>`).join('')}</div>
  <div class="grow"></div><div class="row" style="gap:8px"><button class="bigbtn o">Can't go</button><button class="bigbtn p">${ic('directions_walk')}I'm on my way</button></div></div>`);

export default P;
