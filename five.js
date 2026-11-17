/* The 5-hour limit over time, so each turn can say "5h +3%" like the turn-steps mod.
 *
 * The terminal mod reads the limit inside the CLI; out here the only source is the status line's
 * ~/.claude/statusline-usage/.limits.json (whole percents, refreshed by any open tab). Every
 * 15 s we keep a sample when it changes, in memory and in a small file so a restart keeps history.
 */
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { CLAUDE_HOME, DATA as DIR } from './config.js';

// Written by a status line script (not part of this repo); without it the "5h +x%" part is just left out.
const SRC = process.env.ROOM_LIMITS_FILE || `${CLAUDE_HOME}/statusline-usage/.limits.json`;
const LOG = `${DIR}/five.jsonl`;
const KEEP_MS = 3 * 86400_000;
let samples = [];

export const five = () => samples;

function read() {
  try { const f = JSON.parse(readFileSync(SRC, 'utf8')).five_hour; return f ? { t: Date.now(), pct: f.last, resets: f.resets } : null; } catch { return null; }
}

export function startFive(onSample) {
  mkdirSync(DIR, { recursive: true });
  try { samples = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const cut = Date.now() - KEEP_MS;
  if (samples.some((x) => x.t < cut)) { samples = samples.filter((x) => x.t >= cut); writeFileSync(LOG, samples.map((x) => JSON.stringify(x) + '\n').join('')); }
  const tick = () => {
    const s = read(), last = samples.at(-1);
    if (!s || (last && last.pct === s.pct && last.resets === s.resets)) return;
    samples.push(s); appendFileSync(LOG, JSON.stringify(s) + '\n');
    onSample(s);
  };
  tick(); setInterval(tick, 15_000);
}
