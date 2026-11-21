// Full-page screenshots of every mock page with headless Chrome (no extra packages).
// Usage: node shoot.mjs [name-prefix]
import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2] ?? '';
const files = readdirSync(dir).filter((f) => f.endsWith('.html') && f.startsWith(only)).sort();
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, '--hide-scrollbars', '--no-first-run', '--user-data-dir=' + join(process.env.TMPDIR ?? '/tmp', 'rumfa-shoot'), 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const wait = new Map(); const events = [];
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result ?? m); wait.delete(m.id); } else events.push(m.method); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
for (const f of files) {
  const phone = f.startsWith('agent-');
  const width = phone ? 390 : f === 'index.html' ? 1280 : 1440;
  const scale = phone ? 2 : 1;
  await send('Emulation.setDeviceMetricsOverride', { width, height: phone ? 844 : 900, deviceScaleFactor: scale, mobile: false });
  events.length = 0;
  await send('Page.navigate', { url: pathToFileURL(join(dir, f)).href });
  for (let i = 0; i < 100 && !events.includes('Page.loadEventFired'); i++) await sleep(50);
  await send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });
  await sleep(250);
  const h = (await send('Runtime.evaluate', { expression: 'Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)', returnByValue: true })).result.value;
  const height = Math.max(phone ? 844 : 900, h);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await sleep(150);
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } });
  writeFileSync(join(dir, 'screenshots', f.replace('.html', '.png')), Buffer.from(shot.data, 'base64'));
  console.log(f, width + 'x' + height + (h > height ? ` (page is ${h} tall)` : ''));
}
ws.close(); chrome.kill();
