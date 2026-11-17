/* tmux tabs ↔ Claude sessions.
 *
 * Each tab is a tmux session `claude-<name>` whose pane runs a shell with `claude` as its child.
 * Claude writes ~/.claude/sessions/<pid>.json ({sessionId, name, status busy|idle}) once the tab
 * has been opened; before that we fall back to the `--resume <uuid>` in its args and the jsonl mtime.
 * Driving the tabs (paste, keys, new tabs) lives in mirror.js.
 *
 * Speed: one `tmux list-panes` + one `ps` for every tab, async, shared for 1.5 s — the page polls
 * and every open room ticks each second, so per-tab process spawns blocked the whole server.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { CLAUDE_HOME, CWD, SKIP } from './config.js';

const SESS = `${CLAUDE_HOME}/sessions`;
const PROJ = `${CLAUDE_HOME}/projects`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const TTL = 1500;

export const run = async (cmd, args) => (await promisify(execFile)(cmd, args, { encoding: 'utf8', maxBuffer: 8 << 20 })).stdout;

const paths = new Map();
export function jsonlPath(sessionId) {
  if (!sessionId) return null;
  const hit = paths.get(sessionId);
  if (hit) return hit;
  for (const d of readdirSync(PROJ)) {
    const p = `${PROJ}/${d}/${sessionId}.jsonl`;
    try { statSync(p); paths.set(sessionId, p); return p; } catch {}
  }
  return null;
}

function fromArgs(pid) {
  const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  const id = args.find(a => UUID.test(a))?.match(UUID)[0];
  if (!id) return null;
  const p = jsonlPath(id);
  // No status file: call it idle when the transcript hasn't moved for a minute.
  const quiet = p && Date.now() - statSync(p).mtimeMs > 60_000;
  return { sessionId: id, status: quiet ? 'idle' : 'busy', guessed: true };
}

async function load() {
  let panes, ps;
  try { [panes, ps] = await Promise.all([run('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}']), run('ps', ['-eo', 'pid=,ppid=,comm='])]); }
  catch { return []; }
  const claudeOf = new Map();
  for (const l of ps.split('\n')) {
    const [pid, ppid, comm] = l.trim().split(/\s+/);
    if (comm === 'claude') claudeOf.set(ppid, Number(pid));
  }
  const seen = new Set();
  return panes.trim().split('\n').map(r => r.split('\t')).filter(([s]) => s?.startsWith('claude-') && !SKIP.has(s) && !seen.has(s) && seen.add(s)).map(([tab, panePid]) => {
    const pid = claudeOf.get(panePid) || null;
    const base = { tab, name: tab.slice(7), pid, cwd: CWD, sessionId: null, status: pid ? 'busy' : 'stopped' };
    if (!pid) return base;
    try {
      const j = JSON.parse(readFileSync(`${SESS}/${pid}.json`, 'utf8'));
      return { ...base, sessionId: j.sessionId, name: j.name || base.name, status: j.status || 'busy', cwd: j.cwd || base.cwd };
    } catch {
      try { return { ...base, ...fromArgs(pid) }; } catch { return base; }
    }
  });
}

let cache = { at: 0, p: null };
export function listTabs(fresh = false) {
  if (fresh || !cache.p || Date.now() - cache.at > TTL) cache = { at: Date.now(), p: load() };
  return cache.p;
}
