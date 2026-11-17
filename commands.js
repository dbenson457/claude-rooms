/* Slash commands for the rooms "/" button and the type-ahead list.
 * Built-ins are a curated list (names checked against Claude Code 2.1.326); skills and custom
 * commands are read from disk on each refresh, so new ones show up without a deploy.
 *   confirm: ask in-page first · args: fill the composer instead of sending · rename: use the rename card
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_HOME } from './config.js';

const BUILTIN = [
  { name: 'clear', desc: 'Start this chat fresh', group: 'Common', confirm: true },
  { name: 'model', desc: 'Switch model (opens a picker)', group: 'Common' },
  { name: 'btw', desc: 'Ask a side question without stopping the turn', group: 'Common', args: true },
  { name: 'compact', desc: 'Shrink the chat so far into a summary', group: 'More' },
  { name: 'recap', desc: 'Sum up this session so far', group: 'More' },
  { name: 'rewind', desc: 'Go back to an earlier message (and undo its file changes)', group: 'More' },
  { name: 'tasks', desc: 'Background jobs and finished helpers', group: 'More' },
  { name: 'auto-mode-setup', desc: 'Teach auto mode about this setup', group: 'More' },
  { name: 'context', desc: 'How full the context window is', group: 'More' },
  { name: 'usage', desc: 'Plan limits used', group: 'More' },
  { name: 'status', desc: 'Version, model and account', group: 'More' },
  { name: 'resume', desc: 'Reopen an earlier conversation here', group: 'More', confirm: true },
  { name: 'rename', desc: 'Rename this tab', group: 'More', rename: true },
  { name: 'export', desc: 'Save this conversation to a file', group: 'More' },
  { name: 'memory', desc: 'Edit memory files', group: 'More' },
  { name: 'config', desc: 'Settings', group: 'More' },
  { name: 'permissions', desc: 'Allow / deny tool rules', group: 'More' },
];

// Tiny frontmatter reader: top-level `key: value` lines only (that's all we need).
function front(file) {
  let txt; try { txt = readFileSync(file, 'utf8'); } catch { return null; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt);
  const out = {};
  for (const line of (m ? m[1] : '').split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}
// First sentence only, max ~80 chars: the row is one dim line under the name.
const oneLine = (s = '') => { const t = s.replace(/\s+/g, ' ').trim().split(/(?<=\.)\s/)[0]; return t.length > 80 ? t.slice(0, 79).trimEnd() + '…' : t; };
const dirs = (d) => { try { return readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => join(d, x.name)); } catch { return []; } };
const mds = (d) => { try { return readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => join(d, f)); } catch { return []; } };

function item(file, fallback, prefix) {
  const f = front(file);
  if (!f || f['user-invocable'] === 'false') return null;
  const name = (prefix ? prefix + ':' : '') + (f.name || fallback);
  return { name, desc: oneLine(f.description), group: 'Yours', args: !!f['argument-hint'], hint: f['argument-hint'] || '' };
}

function scan() {
  const out = [];
  // ~/.claude/skills/<name>/SKILL.md and the synced bundles one level deeper (shown bare, e.g. /pptx).
  const skills = join(CLAUDE_HOME, 'skills');
  for (const d of dirs(skills)) {
    if (existsSync(join(d, 'SKILL.md'))) out.push(item(join(d, 'SKILL.md'), d.split('/').pop()));
    else for (const b of dirs(d)) for (const s of dirs(b)) out.push(item(join(s, 'SKILL.md'), s.split('/').pop()));
  }
  for (const f of mds(join(CLAUDE_HOME, 'commands'))) out.push(item(f, f.split('/').pop().slice(0, -3)));
  let plugins = {};
  try { plugins = JSON.parse(readFileSync(join(CLAUDE_HOME, 'plugins/installed_plugins.json'), 'utf8')).plugins || {}; } catch {}
  for (const [key, v] of Object.entries(plugins)) {
    const p = v?.[0]?.installPath, prefix = key.split('@')[0];
    if (!p) continue;
    for (const f of mds(join(p, 'commands'))) out.push(item(f, f.split('/').pop().slice(0, -3), prefix));
    for (const s of dirs(join(p, 'skills'))) out.push(item(join(s, 'SKILL.md'), s.split('/').pop(), prefix));
  }
  const seen = new Set(BUILTIN.map((b) => b.name));
  return out.filter((x) => x && !seen.has(x.name) && seen.add(x.name)).sort((a, b) => a.name.localeCompare(b.name));
}

let cache = null, at = 0;
export function commands() {
  if (!cache || Date.now() - at > 60_000) { cache = [...BUILTIN, ...scan()]; at = Date.now(); }
  return cache;
}
