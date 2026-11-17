/* Offline rooms: a closed tab is remembered here so one tap can bring it back.
 *
 * Closing a room ends claude but keeps its transcript (~/.claude/projects/<dir>/<sessionId>.jsonl).
 * We keep {name, tab, sessionId, cwd, args, closedAt, lastActive} for it; Wake starts a new tab
 * running `claude --resume <sessionId>` with the flags the room was started with, in its own cwd
 * (resume only finds a session from the folder it was made in). Forget drops the entry, never the
 * transcript. One small JSON file, written whole to a temp file then renamed (never half-written).
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { jsonlPath } from './tmux.js';
import { DATA as DIR } from './config.js';

const FILE = `${DIR}/offline.json`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function load() { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return []; } }
function save(list) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(list, null, 1));
  renameSync(`${FILE}.tmp`, FILE);
}

// Live sessions are left out: a room woken (or resumed by hand in a terminal) isn't offline.
export function offlineList(liveIds = new Set()) {
  return load().filter((r) => !liveIds.has(r.sessionId) && jsonlPath(r.sessionId));
}
export const findOffline = (sessionId) => load().find((r) => r.sessionId === sessionId);

// The flags claude was started with, from its own argv, minus the resume itself. Single-quoted for
// the shell; the assistant room passes its own (ROOM_ASSISTANT_ARGS, re-read each start).
export function argsOf(pid) {
  const a = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).slice(1);
  const out = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--resume' || a[i] === '-r') { if (UUID.test(a[i + 1] || '')) i++; continue; }
    if (a[i] === '--continue' || a[i] === '-c' || a[i].startsWith('--resume=')) continue;
    out.push(`'${a[i].replace(/'/g, `'\\''`)}'`);
  }
  return out.join(' ');
}

export function remember({ name, tab, sessionId, cwd, args }) {
  if (!UUID.test(sessionId || '')) return;
  let lastActive = Date.now();
  try { lastActive = statSync(jsonlPath(sessionId)).mtimeMs; } catch {}
  save([{ name, tab, sessionId, cwd, args, closedAt: Date.now(), lastActive }, ...load().filter((r) => r.sessionId !== sessionId)]);
}
export function forget(sessionId) { save(load().filter((r) => r.sessionId !== sessionId)); }

// Rooms open right now, rewritten every 30 s by server.js. A reboot kills every tab without closing it,
// so on start claude-room resumes whatever this file says was open (see restoreAfterReboot).
const LIVE = `${DIR}/live.json`;
export function saveLive(rooms) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${LIVE}.tmp`, JSON.stringify(rooms.filter((r) => UUID.test(r.sessionId || '')), null, 1));
  renameSync(`${LIVE}.tmp`, LIVE);
}
export function lastLive() { try { return JSON.parse(readFileSync(LIVE, 'utf8')); } catch { return []; } }
