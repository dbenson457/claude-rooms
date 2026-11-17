import { chromium, BASE, exe, shots } from './_env.mjs';
const OUT = shots('spacing'), tag = process.argv[2] || 'before';
const b = await chromium.launch({ ...exe });
const p = await (await b.newContext({ viewport: { width: 1280, height: Number(process.argv[3] || 800) } })).newPage();
await p.goto(`${BASE}/?theme=term#r=claude-zz-space`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#composer:not([hidden])'); await p.waitForTimeout(1500);
const gaps = () => p.evaluate(() => {
  const us = [...document.querySelectorAll('.feed .u')], last = us.at(-1), fb = document.getElementById('feed').getBoundingClientRect().bottom;
  const next = (u) => { let e = u.nextElementSibling; while (e && (e.hidden || !e.offsetHeight)) e = e.nextElementSibling; return e; };
  const prev = us.at(-2), pn = prev && next(prev);
  return { prevGap: pn ? Math.round(pn.getBoundingClientRect().top - prev.getBoundingClientRect().bottom) : null, lastToFeedBottom: Math.round(fb - last.getBoundingClientRect().bottom), lastHasNext: !!next(last) };
});
await p.screenshot({ path: `${OUT}/${tag}-0-idle.png` });
await p.fill('#msg', 'Run the bash command `sleep 6` then reply "done".'); await p.click('#sendbtn');
await p.waitForTimeout(300); console.log('just sent', JSON.stringify(await gaps())); await p.screenshot({ path: `${OUT}/${tag}-1-sent.png` });
await p.waitForTimeout(3000); console.log('working  ', JSON.stringify(await gaps())); await p.screenshot({ path: `${OUT}/${tag}-2-working.png` });
await p.waitForTimeout(12000); console.log('replied  ', JSON.stringify(await gaps())); await p.screenshot({ path: `${OUT}/${tag}-3-done.png` });
await b.close();
