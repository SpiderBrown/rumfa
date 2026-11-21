// Writes every mock page plus mock.css and index.html into design/mockups/
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSS, HEAD } from './common.mjs';
import room from './room.mjs';
import agent from './agent.mjs';
import con from './console.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(out, 'screenshots'), { recursive: true });
writeFileSync(join(out, 'mock.css'), CSS);
const sets = [['Rumfa Room (dashboard)', room], ['Agent app', agent], ['Rumfa Console', con]];
for (const [, s] of sets) for (const [k, html] of Object.entries(s)) writeFileSync(join(out, k + '.html'), html);
const title = (html) => html.match(/<title>(.*?)<\/title>/)[1].replace(/ · (Agent app|Rumfa Console)$/, '');
writeFileSync(join(out, 'index.html'), `${HEAD('Rumfa mockups')}<body><div class="content" style="max-width:1280px;margin:0 auto">
<div class="ph"><div><div class="eyebrow">Design mockups · sample data</div><h1>Rumfa: every page</h1><div class="lede">Click a screen to open the page. Screenshots are in the screenshots folder.</div></div></div>
${sets.map(([name, s]) => `<h2 style="margin-top:12px">${name}</h2><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(${name === 'Agent app' ? 180 : 280}px,1fr));gap:14px">
${Object.entries(s).map(([k, h]) => `<a href="${k}.html" class="card" style="overflow:hidden;color:inherit"><img src="screenshots/${k}.png" alt="" style="display:block;width:100%;aspect-ratio:${name === 'Agent app' ? '390/844' : '16/10'};object-fit:cover;object-position:top;border-bottom:1px solid var(--line)"><div style="padding:9px 12px"><b style="font-size:13px">${title(h)}</b><div class="small muted">${k}.html</div></div></a>`).join('')}</div>`).join('')}
</div></body></html>`);
console.log(sets.map(([n, s]) => `${n}: ${Object.keys(s).length}`).join('\n'));
