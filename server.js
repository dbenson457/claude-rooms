/* claude-room — Claude Code chat rooms for the browser.
 *
 * Runs as the user who runs Claude (needs ~/.claude and tmux). Listens on ROOM_HOSTS but only answers
 * the IPs in ROOM_ALLOW (localhost, or a reverse proxy that does its own auth).
 * Rooms = every claude-* tmux tab with Claude running (except ROOM_SKIP), in mirror mode: the tab stays
 * open and the web reads it and types into it (see mirror.js). Both places can be used at once.
 */
import express from 'express';
import { fileURLToPath } from 'node:url';
import { openSync, readSync, fstatSync, closeSync, readFileSync } from 'node:fs';
import { listTabs, jsonlPath, run } from './tmux.js';
import { five, startFive } from './five.js';
import { commands } from './commands.js';
import { ASSISTANT, ensureAssistant, mirror, mirrors, newTab, readPane, tailHistory } from './mirror.js';
import { argsOf, findOffline, forget, lastLive, offlineList, remember, saveLive } from './offline.js';

import { ALLOW, ASSISTANT_ARGS, CLAUDE_HOME, CWD, DATA, HOME_ORIGIN, HOSTS, PORT, SELF_URL, TERM_URL } from './config.js';

const WEB = fileURLToPath(new URL('./web/', import.meta.url));
const MODELS = { opus: 'opus', fable: 'fable', sonnet: 'sonnet', haiku: 'haiku', default: 'default' };

const app = express();
app.use((req, res, next) => {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ALLOW.has(ip) ? next() : res.status(403).end();
});
// Only the home dashboard (if any) may frame the rooms page.
app.use((req, res, next) => { res.set('Content-Security-Policy', `frame-ancestors ${HOME_ORIGIN || "'self'"}`); next(); });
app.use(express.json({ limit: '60mb' }));
// The page's settings, before room.js loads.
app.get('/config.js', (req, res) => res.type('js').set('Cache-Control', 'no-cache').send(`window.ROOMS=${JSON.stringify({ homeOrigin: HOME_ORIGIN, termUrl: TERM_URL, selfUrl: SELF_URL })};`));
// js/css/html always revalidate; ?v= in index.html busts them on deploy.
app.use(express.static(WEB, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// CORS for the home dashboard only (ROOM_HOME_ORIGIN); nothing else gets it.
const homeCors = (req, res) => { if (HOME_ORIGIN && req.get('Origin') === HOME_ORIGIN) res.set({ 'Access-Control-Allow-Origin': HOME_ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST' }); };
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(e.status || 500).json({ error: e.message }));
// Only ever drive a tab that is in the room list.
const room = async (req) => {
  const t = (await listTabs()).find((x) => x.tab === req.params.id && x.pid);
  if (!t) throw Object.assign(new Error('no such room'), { status: 404 });
  return mirror(t.tab);
};

// From the transcript's last 512 KB, re-read only when the file has changed: when Claude last wrote (the
// page compares it with when you last looked, for the New badge) and any handoff another room passed
// in that this room hasn't sent back yet ("Handoff:" in, "Handoff done:" out — see docs/HANDOFFS.md).
const replies = new Map();
function replyAt(sessionId) {
  const p = sessionId && jsonlPath(sessionId);
  if (!p) return {};
  let fd;
  try {
    fd = openSync(p, 'r');
    const { size, mtimeMs } = fstatSync(fd), hit = replies.get(p);
    if (hit?.mtimeMs === mtimeMs) return hit;
    const len = Math.min(size, 512 << 10), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let at = hit?.at ?? null, hoff = null;
    const lines = buf.toString('utf8').split('\n');
    for (const l of lines.slice().reverse()) {
      if (!l.includes('"type":"assistant"')) continue;
      try { const t = Date.parse(JSON.parse(l).timestamp); if (t) { at = t; break; } } catch {}
    }
    for (const l of lines) {
      if (!l.includes('Handoff')) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      const c = j.message?.content, blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : c || [];
      for (const b of blocks) {
        const m = b.type === 'text' && /<cross-session-message\b([^>]*)>\n?Handoff:\s*(.+)/.exec(b.text);
        // Prefer the sender's room name; the socket address comes first in the tag.
        if (m) hoff = { from: (m[1].match(/\bfrom-name="([^"]+)"/) || m[1].match(/\bfrom="([^"]+)"/))[1], task: m[2].trim() };
        if (b.type === 'tool_use' && b.name === 'SendMessage' && /^\s*Handoff done:/i.test(b.input?.message || '')) hoff = null;
      }
    }
    const out = { mtimeMs, at, hoff };
    replies.set(p, out);
    return out;
  } catch { return {}; } finally { if (fd !== undefined) closeSync(fd); }
}
app.get('/api/rooms', wrap(async (req, res) => {
  // The home dashboard (ROOM_HOME_ORIGIN) can list rooms too.
  homeCors(req, res);
  // Tabs with no claude running (e.g. an empty tmux window) aren't rooms.
  const tabs = (await listTabs()).filter((t) => t.pid);
  const waiting = await Promise.all(tabs.map((t) => readPane(t.tab).then((p) => !!p.dialog, () => false)));
  res.json(tabs.map((t, i) => ({ id: t.tab, tab: t.tab, name: t.name, sessionId: t.sessionId, state: t.status, waiting: waiting[i], ...(({ at, hoff }) => ({ replyAt: at ?? null, handoff: hoff || undefined }))(replyAt(t.sessionId)), assistant: t.tab === ASSISTANT || undefined })));
}));

// The plan being approved: the newest ~/.claude/plans/*.md this session mentions (Write/Edit or
// the plan-mode notice). The screen only shows part of a long plan; the file has all of it.
const PLAN_RE = new RegExp(CLAUDE_HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/plans/[\\w.-]+\\.md', 'g');
app.get('/api/rooms/:id/plan', wrap(async (req, res) => {
  const sid = (await listTabs()).find((t) => t.tab === req.params.id)?.sessionId;
  const p = sid && jsonlPath(sid);
  if (!p) return res.status(404).json({ error: 'no session' });
  const fd = openSync(p, 'r');
  let tail = '';
  try { const size = fstatSync(fd).size, n = Math.min(size, 8 << 20), buf = Buffer.alloc(n); readSync(fd, buf, 0, n, size - n); tail = buf.toString('utf8'); } finally { closeSync(fd); }
  const file = (tail.match(PLAN_RE) || []).at(-1);
  if (!file) return res.status(404).json({ error: 'no plan' });
  try { res.json({ file, text: readFileSync(file, 'utf8') }); } catch { res.status(404).json({ error: 'no plan' }); }
}));

// The question a tab is asking right now, saved by ask-hook.mjs (the transcript only has it once answered).
app.get('/api/rooms/:id/ask', wrap(async (req, res) => {
  const sid = (await listTabs()).find((t) => t.tab === req.params.id)?.sessionId;
  try { res.json(JSON.parse(readFileSync(`${DATA}/ask/${sid}.json`, 'utf8'))); } catch { res.status(404).json({ error: 'no question' }); }
}));
app.get('/api/rooms/:id/history', wrap(async (req, res) => {
  const sid = (await listTabs()).find((t) => t.tab === req.params.id)?.sessionId;
  const h = sid && tailHistory(sid, Math.min(Number(req.query.limit) || 150, 1000));
  if (!h) return res.status(404).json({ error: 'no session' });
  res.json({ ...h, five: five() });
}));

// The home dashboard can start a new tab too.
app.options('/api/rooms/new', (req, res) => { homeCors(req, res); res.status(204).end(); });
app.post('/api/rooms/new', wrap(async (req, res) => { homeCors(req, res); res.json({ id: await newTab(String(req.body?.name || '').trim()) }); }));
// The pinned assistant room: start it if it isn't running, then open it.
app.options('/api/assistant', (req, res) => { homeCors(req, res); res.status(204).end(); });
app.post('/api/assistant', wrap(async (req, res) => { homeCors(req, res); res.json({ id: await ensureAssistant() }); }));
app.post('/api/rooms/:id/send', wrap(async (req, res) => {
  const { text = '', images = [], device } = req.body || {};
  if (!text.trim() && !images.length) return res.status(400).json({ error: 'empty' });
  await (await room(req)).send(text, images, device);
  res.json({ ok: true });
}));
app.post('/api/rooms/:id/pick', wrap(async (req, res) => { await (await room(req)).pick(Number(req.body?.n), String(req.body?.text || '')); res.json({ ok: true }); }));
app.post('/api/rooms/:id/ask', wrap(async (req, res) => { const b = req.body || {}; await (await room(req)).ask({ act: String(b.act), n: Number(b.n), text: String(b.text || ''), to: Number(b.to), submit: !!b.submit, leave: Number(b.leave) || 0 }); res.json({ ok: true }); }));
app.post('/api/rooms/:id/key', wrap(async (req, res) => { (await room(req)).key(req.body?.key); res.json({ ok: true }); }));
// Stop's second half: Escape ends the turn but not background commands. Each Bash command Claude runs
// is a child `bash -c source …/shell-snapshots/…` leading its own session; end every process in it.
app.post('/api/rooms/:id/stopbg', wrap(async (req, res) => {
  const t = (await listTabs(true)).find((x) => x.tab === req.params.id && x.pid);
  if (!t) return res.status(404).json({ error: 'no such room' });
  const ps = await run('ps', ['--ppid', String(t.pid), '-o', 'pid=,args=']).catch(() => '');
  let n = 0;
  for (const l of ps.split('\n')) {
    const m = l.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || !m[2].includes('/.claude/shell-snapshots/')) continue;
    // Claude starts each one in its own session (sid = that bash); pipeline parts get their own groups.
    await run('pkill', ['-TERM', '-s', m[1]]).then(() => n++, () => {});
  }
  res.json({ stopped: n });
}));
app.post('/api/rooms/:id/mode', wrap(async (req, res) => { await (await room(req)).setMode(req.body?.mode); res.json({ ok: true }); }));
app.post('/api/rooms/:id/model', wrap(async (req, res) => {
  const m = MODELS[req.body?.model];
  if (!m) return res.status(400).json({ error: 'unknown model' });
  await (await room(req)).send(`/model ${m}`); res.json({ ok: true });
}));
app.post('/api/rooms/:id/rename', wrap(async (req, res) => {
  const name = String(req.body?.name || '').replace(/[\r\n]/g, ' ').trim();
  if (!name) return res.status(400).json({ error: 'empty' });
  await (await room(req)).send(`/rename ${name}`); res.json({ ok: true });
}));
// Close = go offline: remember the room (see offline.js), then end claude. A room mid-turn (or asking
// something) is only closed when the page's in-page confirm said so ({ confirm: true }).
app.post('/api/rooms/:id/close', wrap(async (req, res) => {
  const t = (await listTabs(true)).find((x) => x.tab === req.params.id && x.pid);
  if (!t) throw Object.assign(new Error('no such room'), { status: 404 });
  const p = await readPane(t.tab).catch(() => ({}));
  if (!req.body?.confirm && (t.status === 'busy' || p.spinner || p.dialog)) return res.status(409).json({ error: 'It’s in the middle of something', busy: true });
  const args = argsFor(t);
  remember({ name: t.name, tab: t.tab, sessionId: t.sessionId, cwd: t.cwd, args });
  await mirror(t.tab).close(t.pid); await listTabs(true); res.json({ ok: true });
}));
// Offline rooms: the list, Wake (resume it in a new tab; answers the new room id) and Forget.
app.options('/api/offline/*rest', (req, res) => { homeCors(req, res); res.status(204).end(); });
app.get('/api/offline', wrap(async (req, res) => {
  homeCors(req, res);
  const live = new Set((await listTabs()).filter((t) => t.pid).map((t) => t.sessionId));
  res.json(offlineList(live).map(({ name, tab, sessionId, closedAt, lastActive }) => ({ name, tab, sessionId, closedAt, lastActive, assistant: tab === ASSISTANT || undefined })));
}));
const waking = {};
app.post('/api/offline/:sid/wake', wrap(async (req, res) => {
  homeCors(req, res);
  const sid = req.params.sid, r = findOffline(sid);
  if (!r) throw Object.assign(new Error('not an offline room'), { status: 404 });
  res.json({ id: await wake(sid, r) });
}));
function wake(sid, r) {
  return (waking[sid] ||= (async () => {
    const live = (await listTabs(true)).find((t) => t.pid && t.sessionId === sid);
    if (live) return live.tab;
    const tab = await newTab(r.name, { args: `--resume ${sid}${r.args ? ' ' + r.args : ''}`, cwd: r.cwd || CWD, rename: false });
    forget(sid); await listTabs(true);
    return tab;
  })().finally(() => { delete waking[sid]; }));
}
// Wake by name, for an agent that needs an offline room for a handoff (`room-wake <name>`). Local only.
// A room that is already running answers at once; the newest offline room with that name is resumed.
app.post('/api/rooms/wake', wrap(async (req, res) => {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw Object.assign(new Error('local only'), { status: 403 });
  const name = String(req.body?.name || '').trim().toLowerCase();
  if (!name) throw Object.assign(new Error('name needed'), { status: 400 });
  const live = (await listTabs(true)).find((t) => t.pid && (t.name.toLowerCase() === name || t.tab === 'claude-' + name));
  if (live) return res.json({ id: live.tab, name: live.name, already: true });
  const r = offlineList().filter((x) => x.name.toLowerCase() === name).sort((a, b) => (b.lastActive || b.closedAt || 0) - (a.lastActive || a.closedAt || 0))[0];
  if (!r) throw Object.assign(new Error(`no room called "${req.body.name}" is open or offline`), { status: 404 });
  res.json({ id: await wake(r.sessionId, r), name: r.name, woke: true });
}));
app.post('/api/offline/:sid/forget', wrap(async (req, res) => { homeCors(req, res); forget(req.params.sid); res.json({ ok: true }); }));
// Slash commands for the "/" button + type-ahead (built-ins + skills, re-read every 60 s).
app.get('/api/commands', (req, res) => res.json(commands()));
app.post('/api/rooms/:id/compact', wrap(async (req, res) => { await (await room(req)).send('/compact'); res.json({ ok: true }); }));
app.post('/api/rooms/:id/handoff', wrap(async (req, res) => { await (await room(req)).send('handoff'); res.json({ ok: true }); }));

// SSE: replay `msg` events after Last-Event-ID (or ?after=), then the current screen state, then live.
app.get('/api/rooms/:id/events', async (req, res) => {
  let m; try { m = await room(req); } catch (e) { return res.status(e.status).json({ error: e.message }); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  const send = (ev) => res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  const after = req.get('Last-Event-ID') ?? req.query.after;
  if (after != null) for (const ev of m.events) if (ev.id > Number(after)) send(ev);
  // A fresh mirror (just after a restart) has no screen yet: read it first. An empty pane made the
  // page think the turn had ended (steps box "All done" + "Worked for" mid-turn).
  if (!m.paneKey) try { await m.step(); } catch {}
  const off = m.subscribe(send);
  send({ id: m.seq, type: 'pane', pane: m.pane });
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); off(); });
});

// After a reboot: resume every room that was open (same chat, same flags, same folder), one at a time,
// then keep live.json current. Rooms that are still running (claude-room restarted, tabs survived) are left alone.
const argsFor = (t) => (t.tab === ASSISTANT ? ASSISTANT_ARGS : argsOf(t.pid));
async function restoreAfterReboot() {
  const was = lastLive(), live = new Set((await listTabs(true)).filter((t) => t.pid).map((t) => t.sessionId));
  for (const r of was.filter((r) => !live.has(r.sessionId) && !/^zz-/.test(r.name) && jsonlPath(r.sessionId))) { // zz-* = throwaway test rooms
    try {
      const tab = await newTab(r.name, { args: `--resume ${r.sessionId}${r.args ? ' ' + r.args : ''}`, cwd: r.cwd || CWD, rename: false });
      forget(r.sessionId); console.log(`restored ${r.name} → ${tab}`);
    } catch (e) { console.log(`restore ${r.name} failed: ${e.message}`); }
  }
}
async function snapshotLive() {
  try {
    const tabs = (await listTabs(true)).filter((t) => t.pid && t.sessionId);
    saveLive(tabs.map((t) => { try { return { name: t.name, tab: t.tab, sessionId: t.sessionId, cwd: t.cwd, args: argsFor(t) }; } catch { return null; } }).filter(Boolean));
  } catch (e) { console.log(`live snapshot failed: ${e.message}`); }
}
restoreAfterReboot().catch((e) => console.log(`restore failed: ${e.message}`)).finally(() => { snapshotLive(); setInterval(snapshotLive, 30_000); });

if (!process.env.ROOM_TEST) startFive((sample) => { for (const m of mirrors.values()) m.emit('five', { sample }, false); });
for (const h of HOSTS) app.listen(PORT, h, () => console.log(`claude-room on ${h}:${PORT}`));
