// "/" commands: sheet, type-ahead, confirm, picker + screen cards. Drives the throwaway tab claude-zz-cmdtest only.
import { chromium, BASE, exe, shots } from './_env.mjs';
const ID = 'claude-zz-cmdtest', OUT = shots('commands');
const b = await chromium.launch({ ...exe });
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const state = async () => (await (await fetch(`${BASE}/api/rooms`)).json()).find((r) => r.id === ID);
const until = async (f, s = 60) => { for (let i = 0; i < s * 2; i++) { if (await f()) return true; await new Promise((r) => setTimeout(r, 500)); } return false; };
const idle = async () => { await until(async () => (await state()).state !== 'idle', 8); return until(async () => (await state()).state === 'idle', 90); };
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const inView = (p, sel) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5; }, sel);

async function open(vp, mobile) {
  const ctx = await b.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
  const p = await ctx.newPage(), errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/status of 404/.test(m.text()) && errs.push(m.text())); p.on('response', (r) => r.status() >= 400 && !r.url().endsWith('/ask') && errs.push(r.status() + ' ' + r.url()));
  p.setDefaultTimeout(15000);
  await p.goto(`${BASE}/?theme=term#r=${ID}`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#composer:not([hidden])');
  await p.waitForTimeout(800);
  return { p, errs, ctx };
}

// ---- Phone 390 ----
{
  const { p, errs, ctx } = await open({ width: 390, height: 844 }, true);
  ok(await p.isVisible('#slashbtn'), '390: / button visible');
  await p.click('#slashbtn');
  ok(await p.isVisible('#cmdsheet'), '390: sheet opens');
  ok(await inView(p, '.cmdpanel'), '390: sheet panel inside the screen');
  const groups = await p.$$eval('#cmdrows .popl', (x) => x.map((e) => e.textContent));
  ok(groups.join() === 'Common,More,Your skills', '390: groups ' + groups.join());
  ok((await p.$$eval('#cmdrows .cmdrow b', (x) => x.slice(0, 2).map((e) => e.textContent))).join() === '/clear,/model', '390: Common = /clear, /model');
  ok(await noOverflow(p), '390: no horizontal overflow with sheet open');
  await p.screenshot({ path: `${OUT}/phone-sheet.png` });
  await p.fill('#cmdq', 'cont');
  ok((await p.textContent('#cmdrows .cmdrow b')) === '/context', '390: search "cont" → /context first');
  await p.click('#cmdrows .cmdrow');
  ok(await p.isHidden('#cmdsheet'), '390: sheet closes on pick');
  await idle();
  ok(await until(() => p.evaluate(() => /context/i.test(document.getElementById('feed').innerText)), 15), '390: /context reached the feed');
  // /model → numbered picker card
  await p.click('#slashbtn'); await p.click('#cmdrows .cmdrow:has-text("/model")');
  ok(await until(() => p.isVisible('.card.dlg .opt'), 15), '390: /model shows a picker card');
  await p.screenshot({ path: `${OUT}/phone-model.png` });
  await p.click('.card.dlg [data-esc]'); await until(() => p.isHidden('.card.dlg'), 10);
  // /resume → confirm → screen card driven by keys
  await p.click('#slashbtn'); await p.click('#cmdrows .cmdrow:has-text("/resume")');
  ok(await p.isVisible('#closecard .card h4:has-text("/resume")'), '390: /resume asks to confirm first');
  await p.click('#cleargo');
  ok(await until(() => p.isVisible('.card.dlg.screen'), 15), '390: /resume shows the screen card');
  const before = await p.textContent('.card.dlg.screen .body');
  await p.click('.card.dlg.screen [data-key=Down]');
  ok(await until(async () => (await p.textContent('.card.dlg.screen .body').catch(() => before)) !== before, 8), '390: ↓ moves the picker');
  ok(await noOverflow(p), '390: screen card has no page overflow');
  await p.screenshot({ path: `${OUT}/phone-resume.png` });
  await p.click('.card.dlg.screen [data-key=Escape]');
  ok(await until(() => p.isHidden('.card.dlg'), 10), '390: Esc closes the picker');
  // /rename → rename input
  await p.click('#slashbtn'); await p.click('#cmdrows .cmdrow:has-text("/rename")');
  ok(await p.isVisible('#rn'), '390: /rename opens the rename box'); await p.keyboard.press('Escape');
  // type-ahead
  await p.fill('#msg', '/mo');
  ok(await until(() => p.isVisible('#cmdsug'), 5) && (await p.textContent('#cmdsug .cmdrow b')) === '/model', '390: typing /mo suggests /model');
  await p.fill('#msg', '/mo x');
  ok(await until(() => p.isHidden('#cmdsug'), 3), '390: suggestions close after a space');
  await p.fill('#msg', '');
  // /clear → confirm → clears
  await p.click('#slashbtn'); await p.click('#cmdrows .cmdrow:has-text("/clear")');
  ok(await p.isVisible('#closecard .card h4:has-text("/clear")'), '390: /clear asks to confirm');
  await p.click('#cleargo'); await idle();
  ok(await p.isHidden('#closecard .card'), '390: confirm card gone after Clear');
  ok(!errs.length, '390: no console errors ' + errs.slice(0, 2).join(' | '));
  await ctx.close();
}

// ---- Desktop 1280 / 1920 ----
for (const w of [1280, 1920]) {
  const { p, errs, ctx } = await open({ width: w, height: w === 1280 ? 800 : 1080 }, false);
  await p.click('#slashbtn');
  ok(await p.isVisible('#cmdsheet') && await inView(p, '.cmdpanel'), `${w}: popover opens inside the window`);
  ok(await p.evaluate(() => document.activeElement.id === 'cmdq'), `${w}: search box focused`);
  await p.screenshot({ path: `${OUT}/desktop-${w}-sheet.png` });
  await p.keyboard.press('Escape');
  ok(await p.isHidden('#cmdsheet'), `${w}: Esc closes popover`);
  await p.click('#msg'); await p.keyboard.type('/con');
  ok(await until(() => p.isVisible('#cmdsug'), 5), `${w}: type-ahead opens`);
  const first = await p.textContent('#cmdsug .cmdrow.on b');
  await p.keyboard.press('ArrowDown');
  const second = await p.textContent('#cmdsug .cmdrow.on b');
  ok(first !== second, `${w}: ↓ moves highlight ${first} → ${second}`);
  await p.keyboard.press('Tab');
  ok((await p.inputValue('#msg')) === second, `${w}: Tab completes to ${second}`);
  await p.fill('#msg', '');
  ok(await noOverflow(p), `${w}: no horizontal overflow`);
  ok(!errs.length, `${w}: no console errors ` + errs.slice(0, 2).join(' | '));
  await ctx.close();
}

// ---- Assistant room: no button (view only, nothing typed) ----
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/?theme=term#r=claude-assistant`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#composer:not([hidden])'); await p.waitForTimeout(800);
  ok(await p.isHidden('#slashbtn'), 'Assistant: no / button');
  ok(await p.isVisible('.chip.new'), 'Assistant: New question chip still there');
  await ctx.close();
}
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
