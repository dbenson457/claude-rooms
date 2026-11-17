/* Mirror mode: the tmux tab keeps running and the web is a second window onto it.
 *
 * Read side: the session jsonl is tailed (new user/assistant lines → `msg` events) and the tmux pane
 * is captured every second to read what only the screen knows — Claude's own dialogs (permission,
 * questions, plan approval) with their numbered options, the spinner line, the mode and the status
 * line footer. Write side: text is pasted into the pane (bracketed paste, so newlines survive), a
 * dialog option is picked by its number, the mode is cycled with Shift+Tab — exactly what a person
 * at the terminal would press. Both places can type; whoever sends first goes first.
 */
import { execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync, statSync, mkdirSync, writeFileSync, watch } from 'node:fs';
import { listTabs, jsonlPath, run } from './tmux.js';
import { ASSISTANT_ARGS, CLAUDE_HOME, CWD } from './config.js';

const RING = 500;
const UPLOADS = `${CLAUDE_HOME}/room-uploads`;
const tmux = (args, input) => execFileSync('tmux', args, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
// A tab scrolled up in the terminal (mouse wheel) sits in tmux copy mode, which swallows keys — the
// web's text got typed but its Enter never reached Claude. Leave scroll mode before writing to a tab.
const sh = (args, input) => {
  if (args[0] === 'send-keys' || args[0] === 'paste-buffer') { const t = args[args.indexOf('-t') + 1]; try { tmux(['copy-mode', '-q', '-t', t]); } catch {} }
  return tmux(args, input);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const BORDER = /^\s*[─▔╌━]{20,}(?: [^─▔╌━]{1,40} [─▔╌━]+)?\s*$/; // the input box top can carry the tab name: "──── my-tab ─"
const MODE = /(?:⏵⏵|⏸)\s+(auto mode|manual mode|plan mode|accept edits) on/;
// Claude can draw a boxed panel beside a dialog's options (a question's previews). Its text sits on the
// same screen lines, so cut it off the option text: from the first box character to the end of the line.
const BOX = '│┃┌┐└┘╭╮╰╯├┤┬┴';
const unbox = (s) => s.replace(new RegExp(`\\s*[${BOX}].*$`), '').trim();
const TEXT_OPT = /^(Type something\.?|Tell Claude what to change|No, and tell Claude what to do differently.*)$/i;
// Another agent's message (cross-session, a helper, a teammate) is stored as a meta user line; the page
// shows it as an agent card, so it is the one meta line history keeps.
const fromAgent = (m) => { const c = m?.content, t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text || '').join('\n') : '';
  return /<(cross-session|agent|teammate)-message\b/.test(t); };
export const MODES = { auto: 'auto mode', manual: 'manual mode', plan: 'plan mode', edits: 'accept edits' };

export const mirrors = new Map();
export const mirror = (tab) => mirrors.get(tab) || mirrors.set(tab, new Mirror(tab)).get(tab);

/* ===== pane reading ===== */
// A question set's tab bar: "←  ☐ Fruit  ☒ Colours  ✔ Submit  →"; the current tab has a background colour.
const TABS = /^\s*←.*→\s*$/;
function parseTabs(line) {
  const tabs = []; let bg = false;
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) { const c = part.slice(2, -1).split(';'); if (c[0] === '48') bg = true; if (c.includes('49') || c[0] === '0' || c[0] === '') bg = false; continue; }
    for (const m of part.matchAll(/([☐☒✔])\s+([^☐☒✔→]*)/g)) tabs.push({ label: m[2].trim(), done: m[1] === '☒', submit: m[1] === '✔', cur: bg });
  }
  return tabs;
}
export async function readPane(tab) {
  // OSC sequences (terminal hyperlinks: ESC ]8;id=…;file://… ESC \) are not text — drop them.
  const raw = (await run('tmux', ['capture-pane', '-p', '-e', '-J', '-S', '-120', '-t', tab])).replace(/\n+$/, '').split('\n').map((l) => l.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ''));
  const plain = raw.map(strip);
  const tail = plain.slice(-5).join('\n');
  const modeM = tail.match(MODE);
  const out = { mode: modeM ? Object.keys(MODES).find((k) => MODES[k] === modeM[1]) : null, footer: null, spinner: null, dialog: null };

  // A footer hint ("paste again to expand", "Esc to clear again"…) can stand in for the mode line for a
  // few seconds; the input box itself (border, then the ❯ prompt) still says it's the normal screen.
  const promptAt = plain.findLastIndex((l) => /^❯(\s|$)/.test(l) && !/^❯\s*\d+\./.test(l));
  const inputBox = promptAt > 0 && promptAt >= plain.length - 12 && BORDER.test(plain[promptAt - 1]);
  if (modeM || inputBox) {
    // Normal screen: input box, then the status line(s). Footer = everything under the box's bottom border.
    let b = plain.length - 1;
    while (b > 0 && !BORDER.test(plain[b])) b--;
    out.footer = raw.slice(b + 1).map((l) => l.replace(/⇥ handoff|≡ mods/g, '').replace(/(\s|\x1b\[[0-9;]*m)+$/, ''));
    // Spinner: "✻ Cooking… (12s · ↓ 1k tokens)" above the input box — the turn-steps box can sit in
    // between and push it 10-20 lines up, so look well above (missing it = "idle" mid-turn).
    for (let i = b - 1; i >= Math.max(0, b - 40); i--) if (/esc to interrupt/.test(plain[i]) || /^\s*[^\s│╭╰❯●⎿]\s+[A-Z][\w-]*…\s*\(/.test(plain[i])) { out.spinner = plain[i].trim(); break; }
    return out;
  }

  // No input box → a dialog fills the bottom. It starts under the last conversation line.
  let start = 0;
  for (let i = plain.length - 1; i >= 0; i--) {
    if (/^(● |✻ |⎿ )/.test(plain[i]) || (/^❯ /.test(plain[i]) && !/^❯ \d+\./.test(plain[i]))) { start = i + 1; break; }
  }
  const top = start;
  while (start < plain.length && !BORDER.test(plain[start])) start++;
  const head = [], options = [];
  let tabs = null;
  const NUM = /^\s*(❯\s*)?(\d+)\.\s+(.*)$/;
  // A short pane (a phone attached to the tab) scrolls the dialog's top border away: the border found is
  // then the one under "Type something", below "1.", and every option above it was lost.
  if (!plain.slice(start).some((l) => l.match(NUM)?.[2] === '1')) start = top;
  // The real choices are the LAST run starting at "1." — numbered lines above it (a plan's own
  // steps, a question's text) are dialog text, not buttons.
  let first = -1;
  for (let i = start; i < plain.length; i++) if (plain[i].match(NUM)?.[2] === '1') first = i;
  let after = false;
  for (let i = start; i < plain.length; i++) {
    const p = plain[i], m = i >= first && first >= 0 ? p.match(NUM) : null;
    if (m) { const label = unbox(m[3]); options.push({ n: Number(m[2]), label, selected: !!m[1], text: TEXT_OPT.test(label), desc: '' }); after = true; continue; }
    if (BORDER.test(p)) { if (!after) head.push(null); continue; }
    if (after && /^\s*Submit\s*$/.test(p)) continue; // a multi-select's own Submit row (the web has a Done button)
    if (!p.trim()) continue;
    const last = options.at(-1);
    // A line that starts with a box character is the side panel itself, never the option's text.
    if (last && new RegExp(`^\\s*[${BOX}]`).test(p)) continue;
    if (last && /^\s{4,}/.test(p) && !/to cancel|to navigate|to select|ctrl\+g|shift\+tab to approve|press n to add notes|\bNotes:/.test(p)) { const t = unbox(p); if (t) last.desc += (last.desc ? '\n' : '') + t; continue; }
    if (!after && TABS.test(p)) { tabs = parseTabs(raw[i]); continue; }
    if (!after) head.push(raw[i].replace(/\s+$/, ''));
  }
  // Options with previews have no "Type something" row: the terminal offers notes on the highlighted
  // option instead ("n to add notes"), and the card needs a box for them (2026-10-28).
  const notes = plain.slice(start).some((l) => /\bn to add notes\b/.test(l));
  if (options.length) out.dialog = { head, options, tabs, notes };
  // Unnumbered pickers (/resume, /config, /permissions): mirror the screen itself and drive it with arrow keys.
  // Only when it shows key hints, so a half-drawn screen never flashes up as a card.
  else {
    const lines = raw.slice(top).map((l) => l.replace(/\s+$/, '')), text = plain.slice(top).join('\n');
    while (lines.length && !strip(lines[0]).trim()) lines.shift();
    if (lines.length && /\b[Ee]sc\b|to navigate|to select|↑|↓|Enter to/.test(text)) out.dialog = { head: lines.slice(-30), options: [], tabs, screen: true };
  }
  return out;
}

/* ===== the per-tab mirror ===== */
class Mirror {
  constructor(tab) {
    this.tab = tab;
    this.events = []; this.seq = 0; this.subs = new Set();
    this.sessionId = null; this.offset = 0; this.partial = '';
    this.pane = {}; this.paneKey = '';
    this.timer = null;
  }

  emit(type, data = {}, keep = true) {
    const ev = { id: keep ? ++this.seq : this.seq, type, ...data };
    if (keep) { this.events.push(ev); if (this.events.length > RING) this.events.shift(); }
    for (const fn of this.subs) fn(ev);
  }

  subscribe(fn) {
    this.subs.add(fn);
    // Screen 4x a second while someone watches (a capture costs ~4 ms); the transcript is read on every file change.
    if (!this.timer) { this.tick(); this.timer = setInterval(() => this.tick(), 250); }
    return () => { this.subs.delete(fn); if (!this.subs.size) { clearInterval(this.timer); this.timer = null; this.unwatch(); } };
  }

  // One tick at a time: a slow tmux call must never stack up behind itself.
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try { await this.step(); } catch {} finally { this.busy = false; }
  }

  async step() {
    const t = (await listTabs()).find((x) => x.tab === this.tab);
    if (!t?.pid) { this.emitPane({ gone: true }); return; }
    if (t.sessionId !== this.sessionId) {
      // New session (first look, /clear, /resume): start tailing from its current end; the page reloads history.
      const first = this.sessionId === null;
      this.sessionId = t.sessionId; this.partial = '';
      const p = jsonlPath(t.sessionId);
      this.offset = p ? statSync(p).size : 0;
      if (!first) this.emit('session', { sessionId: t.sessionId });
      this.unwatch();
      if (p) try { this.watcher = watch(p, () => { try { this.tail(); } catch {} }); } catch {}
    }
    this.tail();
    this.emitPane({ ...(await readPane(this.tab)), status: t.status, name: t.name });
  }

  unwatch() { this.watcher?.close(); this.watcher = null; if (!this.subs.size) this.sessionId = null; }

  tail() {
    const p = jsonlPath(this.sessionId);
    if (!p) return;
    const size = statSync(p).size;
    if (size <= this.offset) return;
    const fd = openSync(p, 'r'), buf = Buffer.alloc(size - this.offset);
    readSync(fd, buf, 0, buf.length, this.offset); closeSync(fd);
    this.offset = size;
    const lines = (this.partial + buf.toString('utf8')).split('\n');
    this.partial = lines.pop();
    for (const l of lines) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      // A message typed while Claude works is stored as a queued_command attachment where it was absorbed.
      if (j.type === 'attachment' && j.attachment?.type === 'queued_command' && !j.isSidechain && typeof j.attachment.prompt === 'string')
        this.emit('msg', { uuid: j.uuid, role: 'user', content: j.attachment.prompt, queued: true, ts: j.timestamp });
      else if ((j.type === 'user' || j.type === 'assistant') && !j.isSidechain && j.message)
        this.emit('msg', { uuid: j.uuid, role: j.type, content: j.message.content, meta: !!j.isMeta, ts: j.timestamp, compact: !!j.isCompactSummary, mid: j.message.id, usage: j.message.usage });
    }
  }

  emitPane(pane) {
    const key = JSON.stringify(pane);
    if (key === this.paneKey) return;
    this.paneKey = key; this.pane = pane;
    this.emit('pane', { pane }, false);
  }

  /* ----- write side ----- */
  async assertNoDialog() { if ((await readPane(this.tab)).dialog) throw Object.assign(new Error('Claude is showing a question — answer it first'), { status: 409 }); }

  paste(text) {
    sh(['load-buffer', '-b', 'room', '-'], text);
    sh(['paste-buffer', '-p', '-d', '-b', 'room', '-t', this.tab]);
  }

  async send(text, images = [], device = 'browser') {
    await this.assertNoDialog();
    if (images.length) {
      mkdirSync(UPLOADS, { recursive: true });
      const from = String(device).replace(/[^\w .-]/g, '').slice(0, 20) || 'browser';
      const save = (im, i) => {
        const f = im.doc
          ? `${UPLOADS}/${Date.now()}-${i}-${String(im.name || 'file').replace(/[^\w.-]+/g, '_').slice(-80)}`
          : `${UPLOADS}/${Date.now()}-${i}.${(im.type || 'image/jpeg').split('/')[1].replace('jpeg', 'jpg')}`;
        writeFileSync(f, Buffer.from(im.data, 'base64'));
        return f;
      };
      const docs = images.filter((im) => im.doc).map(save), pics = images.filter((im) => !im.doc).map(save);
      if (docs.length) text = `${text}\n\n[Document${docs.length > 1 ? 's' : ''} uploaded from ${from} — read ${docs.length > 1 ? 'them' : 'it'}]\n${docs.join('\n')}`.trim();
      // Paths go last with nothing glued to them: Claude Code turns each path it recognises into an
      // attached image, and a trailing "]" stopped it recognising the last one (that picture never arrived).
      if (pics.length) text = `${text}\n\n[Picture${pics.length > 1 ? 's' : ''} uploaded from ${from}] ${pics.join(' ')}`.trim();
    }
    this.paste(text);
    await sleep(250);
    sh(['send-keys', '-t', this.tab, 'Enter']);
    setTimeout(() => this.tick(), 400);
  }

  // Pick option n of the dialog on screen; text-entry options get the typed text then Enter.
  async pick(n, text) {
    const d = (await readPane(this.tab)).dialog;
    const opt = d?.options.find((o) => o.n === n);
    if (!opt) throw Object.assign(new Error('That question has changed — look again'), { status: 409 });
    sh(['send-keys', '-t', this.tab, String(n)]);
    // Questions with previews: the number only moves the highlight. If the same question is still up
    // with that option highlighted, confirm it with Enter (a plain list has already moved on).
    if (!opt.text) {
      await sleep(350);
      const now = (await readPane(this.tab)).dialog, same = (x) => x?.options.map((o) => o.label).join('\n');
      if (now && same(now) === same(d) && now.options.find((o) => o.n === n)?.selected) sh(['send-keys', '-t', this.tab, 'Enter']);
    }
    if (opt.text && text) {
      await sleep(400);
      sh(['send-keys', '-t', this.tab, '-l', text]);
      await sleep(200);
      sh(['send-keys', '-t', this.tab, 'Enter']);
    }
    setTimeout(() => this.tick(), 300);
  }

  // A question set, driven the way a person drives the terminal dialog (keys mapped on 2.1.296):
  // tab = ←/→ to another question · choose = the number (previews need Enter too) · toggle = the number
  // (multi-select) · type = walk the highlight to the "Type something" row, clear it (ctrl+U), type,
  // and Enter only for a single-select · chat = the "Chat about this" number · note = the number, n, the
  // note text, Enter (questions with previews).
  async ask({ act, n, text = '', to = 0, submit = false, leave = 0 }) {
    const d = (await readPane(this.tab)).dialog;
    if (!d) throw Object.assign(new Error('That question has gone — look again'), { status: 409 });
    const k = (...keys) => sh(['send-keys', '-t', this.tab, ...keys]);
    // ←/→ on the "Type something" row move the text cursor, not the question: step up off it first.
    if (act === 'tab' && leave && d.options.find((o) => o.selected)?.n === leave) { k('Up'); await sleep(120); }
    if (act === 'tab') { to = Math.max(-6, Math.min(6, Number(to) || 0)); for (let i = 0; i < Math.abs(to); i++) k(to < 0 ? 'Left' : 'Right'); }
    else if (act === 'toggle' || act === 'chat') { if (!d.options.some((o) => o.n === n)) throw Object.assign(new Error('That question has changed — look again'), { status: 409 }); k(String(n)); }
    else if (act === 'choose') { await this.pick(n); return; }
    else if (act === 'note') {
      // Preview questions: the number only moves the highlight; then n opens the notes line, the text
      // goes in, and one Enter submits the answer with its note (checked on a throwaway tab, 2.1.x).
      if (!d.notes || !d.options.some((o) => o.n === n)) throw Object.assign(new Error('That question has changed — look again'), { status: 409 });
      k(String(n)); await sleep(300);
      const now = (await readPane(this.tab)).dialog;
      if (!now?.options.find((o) => o.n === n)?.selected) throw Object.assign(new Error('That question has changed — look again'), { status: 409 });
      k('n'); await sleep(300);
      k('-l', String(text).trim().slice(0, 1000)); await sleep(200);
      k('Enter');
    }
    else if (act === 'type') {
      for (let i = 0; i < 12; i++) {
        const now = (await readPane(this.tab)).dialog, at = now?.options.find((o) => o.selected)?.n;
        if (!now) throw Object.assign(new Error('That question has gone — look again'), { status: 409 });
        if (at === n) break;
        k(at != null && at < n ? 'Down' : 'Up'); await sleep(120);
      }
      k('C-u'); await sleep(80);
      if (String(text).trim()) { k('-l', String(text).trim().slice(0, 500)); await sleep(150); }
      if (submit) k('Enter'); else k('Up'); // leave the text row so ←/→ switch questions again
    } else throw Object.assign(new Error('unknown action'), { status: 400 });
    setTimeout(() => this.tick(), 250);
  }

  key(k) {
    if (!['Escape', 'Right', 'Left', 'Up', 'Down', 'Enter', 'Tab', 'Space'].includes(k)) throw Object.assign(new Error('key not allowed'), { status: 400 });
    sh(['send-keys', '-t', this.tab, k]);
    setTimeout(() => this.tick(), 300);
  }

  // Close the tab: stop any turn/dialog, /exit, wait for claude to leave, then remove the tmux tab.
  // The transcript stays on disk, so `claude --resume` can bring the chat back.
  async close(pid) {
    if (!this.tab.startsWith('claude-')) throw Object.assign(new Error('only claude-* tabs can be closed'), { status: 400 });
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const p = await readPane(this.tab);
    if (p.dialog || p.spinner || this.pane.status === 'busy') { sh(['send-keys', '-t', this.tab, 'Escape']); await sleep(600); }
    if (p.dialog) { sh(['send-keys', '-t', this.tab, 'Escape']); await sleep(400); }
    this.paste('/exit'); await sleep(250);
    sh(['send-keys', '-t', this.tab, 'Enter']);
    for (let i = 0; i < 25 && pid && alive(); i++) await sleep(200);
    try { sh(['kill-session', '-t', this.tab]); } catch {}
    this.emitPane({ gone: true });
    clearInterval(this.timer); this.timer = null;
    mirrors.delete(this.tab);
  }

  async setMode(want) {
    if (!MODES[want]) throw Object.assign(new Error('unknown mode'), { status: 400 });
    for (let i = 0; i < 6; i++) {
      const p = await readPane(this.tab);
      if (p.dialog) throw Object.assign(new Error('Answer the question first'), { status: 409 });
      if (p.mode === want) { this.tick(); return; }
      sh(['send-keys', '-t', this.tab, 'BTab']);
      await sleep(500);
    }
    throw Object.assign(new Error(`couldn't reach ${MODES[want]}`), { status: 409 });
  }
}

/* ===== new tab ===== */
// Wake passes `--resume <id>` in args and the session's own cwd, and keeps the name the session already has.
export async function newTab(name, { args = '', cwd = CWD, rename = true } = {}) {
  const slug = (name || 'web').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'web';
  let tab = `claude-${slug}`;
  const tabs = await listTabs(true);
  for (let k = 2; tabs.some((t) => t.tab === tab) || hasSession(tab); k++) tab = `claude-${slug}-${k}`;
  sh(['new-session', '-d', '-s', tab, '-c', cwd]);
  sh(['send-keys', '-t', tab, `claude${args ? ' ' + args : ''}`, 'Enter']);
  // A folder Claude hasn't been trusted in yet asks first; accept it like the other tabs were.
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const pane = strip(sh(['capture-pane', '-p', '-t', tab]));
    if (pane.includes('Yes, I trust this folder')) { sh(['send-keys', '-t', tab, 'Down']); sh(['send-keys', '-t', tab, 'Enter']); continue; }
    if (MODE.test(pane)) break;
  }
  if (!rename) return tab;
  const m = mirror(tab);
  m.paste(`/rename ${name || slug}`); await sleep(200); sh(['send-keys', '-t', tab, 'Enter']);
  await sleep(800);
  return tab;
}

/* ===== Assistant: one pinned tab with its own flags (ROOM_ASSISTANT_ARGS: prompt, settings, hooks) ===== */
export const ASSISTANT = 'claude-assistant';
const starting = {};
// Started on first use; a tmux tab left behind without claude in it is replaced.
export function ensureAssistant(tab = ASSISTANT, name = 'Assistant', args = ASSISTANT_ARGS) {
  return starting[tab] ||= (async () => {
    if ((await listTabs(true)).some((t) => t.tab === tab && t.pid)) return tab;
    if (hasSession(tab)) sh(['kill-session', '-t', tab]);
    const made = await newTab(name, { args });
    if (made !== tab) throw new Error(`started ${made}, expected ${tab}`);
    return tab;
  })().finally(() => { delete starting[tab]; });
}
function hasSession(tab) { try { sh(['has-session', '-t', tab]); return true; } catch { return false; } }

/* ===== history: the end of the transcript only ===== */
// Reading the whole jsonl (tens of MB for a long tab) took seconds; read backwards in chunks
// until we have `limit` chat messages, so opening a room costs the same however old the tab is.
export function tailHistory(sessionId, limit) {
  const p = jsonlPath(sessionId);
  if (!p) return null;
  const size = statSync(p).size, fd = openSync(p, 'r');
  let start = size, text = '', msgs = [];
  try {
    for (let chunk = 1 << 20; ; chunk *= 2) {
      const from = Math.max(0, start - chunk), buf = Buffer.alloc(start - from);
      readSync(fd, buf, 0, buf.length, from);
      text = buf.toString('utf8') + text; start = from;
      const lines = text.split('\n');
      if (start > 0) lines.shift(); // may be cut mid-line
      msgs = [];
      for (const l of lines) {
        if (!l.includes('"message"') && !l.includes('"queued_command"')) continue;
        let j; try { j = JSON.parse(l); } catch { continue; }
        if (j.type === 'attachment' && j.attachment?.type === 'queued_command' && !j.isSidechain && typeof j.attachment.prompt === 'string') { msgs.push({ uuid: j.uuid, type: 'user', message: { content: j.attachment.prompt }, ts: j.timestamp, queued: true }); continue; }
        if ((j.type === 'user' || j.type === 'assistant') && !j.isSidechain && (!j.isMeta || fromAgent(j.message)) && j.message) msgs.push({ uuid: j.uuid, type: j.type, message: j.message, ts: j.timestamp, compact: !!j.isCompactSummary });
      }
      if (msgs.length >= limit || start === 0) break;
    }
  } finally { closeSync(fd); }
  return { sessionId, more: start > 0 || msgs.length > limit, messages: msgs.slice(-limit) };
}
