import { chromium, BASE, exe, shots } from './_env.mjs';
const ID = 'claude-zz-ask', OUT = shots('questions');
const b = await chromium.launch({ ...exe });
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const api = (path, body) => fetch(`${BASE}/api/rooms/${ID}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const state = async () => (await (await fetch(`${BASE}/api/rooms`)).json()).find((r) => r.id === ID);
const until = async (f, s = 120) => { for (let i = 0; i < s; i++) { if (await f()) return true; await new Promise((r) => setTimeout(r, 1000)); } return false; };
const idle = async () => { await until(async () => (await state()).state !== 'idle', 15); await until(async () => (await state()).state === 'idle', 120); };
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage(), errs = []; p.on('pageerror', (e) => errs.push(e.message));
p.setDefaultTimeout(15000);
await p.goto(`${BASE}/?theme=term#r=${ID}`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#composer:not([hidden])');

// 1. Preview question: card from the real question, tap answers it.
await api('send', { text: 'UI test: one AskUserQuestion, ONE question, header "Layout", "Which dashboard layout?", 3 options each with a description and a 6-line ASCII box mockup preview (┌ ─ │ └) with one line over 70 chars. Then wait.' });
ok(await until(async () => (await state()).waiting, 90), 'preview question appears');
await p.waitForSelector('#cards .opt .pv');
const pv = await p.$$eval('#cards .opt', (os) => os.map((o) => ({ t: [...o.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''), pv: !!o.querySelector('.pv') })));
ok(pv.filter((o) => o.pv).length === 3 && !pv.some((o) => /[│┌└┐┘]/.test(o.t)), 'preview card: 3 previews, clean labels');
ok(await p.$eval('#cards .qq', (q) => q.textContent) === 'Which dashboard layout?', 'preview card: real question text');
ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'preview card: no sideways page scroll');
await p.screenshot({ path: `${OUT}/preview-390.png` });
await p.tap('#cards .opt[data-n="2"]');
ok(await until(async () => !(await state()).waiting, 15), 'tapping a preview option answers it');
await idle();

// 2. Multi-select: taps tick, Done → review, Submit answers.
await api('send', { text: 'UI test: one AskUserQuestion, ONE question, header "Extras", "Which extras?", multiSelect true, options Clock/Weather/News with descriptions. Then wait.' });
ok(await until(async () => (await state()).waiting, 90), 'multi-select question appears');
await p.waitForSelector('#cards [data-next]');
await p.tap('#cards .opt[data-n="1"]'); await p.waitForTimeout(1500);
await p.tap('#cards .opt[data-n="3"]'); await p.waitForTimeout(1500);
const labels = await p.$$eval('#cards .opt', (os) => os.map((o) => o.textContent.replace(/\s+/g, ' ').slice(0, 24)));
console.log(JSON.stringify(labels));
ok(labels[0].includes('[✔]') && labels[2].includes('[✔]') && !labels.some((l) => /Submit/.test(l)), 'taps tick Clock + News, no stray Submit');
await p.screenshot({ path: `${OUT}/multi-390.png` });
await p.tap('#cards [data-next]');
ok(await until(async () => /Submit answers/.test(await p.$eval('#cards', (c) => c.textContent).catch(() => '')), 15), 'Done goes to the review screen');
ok(!/Weather/.test(await p.$eval('#cards .opts', (c) => c.textContent)), 'review screen shows its own options, not the question\'s');
await p.screenshot({ path: `${OUT}/review-390.png` });
await p.tap('#cards .opt[data-n="1"]');
ok(await until(async () => !(await state()).waiting, 15), 'Submit answers from the web');
await idle();

// 3. Diagrams in a reply.
await api('send', { text: 'UI test, no tools. Reply with exactly: (a) a fenced code block with a 90-char-wide ASCII box diagram, (b) a box diagram NOT in a code fence, (c) an unfenced file tree starting with a "project/" line then ├── and └── lines, (d) a short markdown table.' });
await idle(); await p.waitForTimeout(2500);
const pres = await p.$$eval('.feed .ai pre', (ps) => ps.slice(-4).map((x) => ({ dg: x.classList.contains('dg'), first: x.textContent.split('\n')[0].slice(0, 30), ws: getComputedStyle(x.querySelector('code') || x).whiteSpace })));
console.log(JSON.stringify(pres));
ok(pres.filter((x) => x.dg).length >= 2, 'unfenced box diagram + tree kept as drawn');
ok(pres.some((x) => x.dg && /^project\//.test(x.first)), 'tree keeps its root line');
ok(pres.every((x) => x.ws === 'pre'), 'diagram lines never wrap');
ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways page scroll');
await p.screenshot({ path: `${OUT}/reply-390.png` });
const prose = await p.$$eval('.feed pre.dg', (ps) => ps.map((x) => x.textContent.split('\n')[0]).filter((l) => !/^\s*[\u2500-\u257F]|[\u2500-\u257F].*[\u2500-\u257F]|^\S+$/.test(l)));
ok(!prose.length, 'no sentence shown as a diagram ' + JSON.stringify(prose));
ok(!errs.length, 'no page errors ' + errs.join('|'));
await b.close(); console.log(`${pass} PASS, ${fail} FAIL`);
