/* Claude rooms — the chat page (mirror mode).
 *
 * Each room is a live Claude tab. The feed is the session transcript (history, then new lines over
 * SSE); the screen state from the tab (Claude's own dialogs, spinner, mode, status line) arrives as
 * `pane` events. Typing here pastes into the tab, so the terminal and the web can both be used.
 * Tool calls fold into a per-turn "N steps · View steps" line; the turn-steps plan drives a plan box.
 */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = (p, body) => fetch('api/' + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || r.status), { busy: !!j.busy }); return j; });
const PLAN = 'mcp__turn-steps__plan';
const MODES = [['auto', '⏵⏵ Auto'], ['manual', '⏸ Manual'], ['plan', '⏸ Plan'], ['edits', '⏵⏵ Accept edits']];
const app = $('app'), feed = $('feed');

function deviceName() {
  const u = navigator.userAgent;
  if (/iPad/.test(u) || (/Macintosh/.test(u) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(u)) return 'iPhone';
  if (/Android/.test(u)) return 'Android';
  if (/Macintosh/.test(u)) return 'Mac';
  if (/Windows/.test(u)) return 'Windows PC';
  return 'browser';
}

// Show a scroll bar only while something is being scrolled, then fade it out.
document.addEventListener('scroll', (e) => {
  const el = e.target === document ? document.documentElement : e.target;
  if (!el.classList) return;
  el.classList.add('scrolling'); clearTimeout(el._sb); el._sb = setTimeout(() => el.classList.remove('scrolling'), 900);
}, true);

/* ===== theme (same rule as the home dashboard: night 19:00–07:00 in auto) ===== */
// ?embed=1 = framed inside the home dashboard (ROOM_HOME_ORIGIN): no brand/theme button, theme comes from the home site.
const CFG = window.ROOMS || {}, HOME = CFG.homeOrigin || '';
const Q = new URLSearchParams(location.search), EMBED = Q.has('embed');
if (EMBED) document.documentElement.classList.add('embed');
// Framed on the phone the home app hides its own bar, so ‹ and ⌂ Home here close the chat sheet.
window.toHome = (what) => HOME && parent.postMessage({ cr: what }, HOME);
// The >_ button opens a web terminal, if one is configured (ROOM_TERM_URL).
if (CFG.termUrl) Object.assign(document.querySelector('.termbtn'), { href: CFG.termUrl, hidden: false });
// Inside the home app the >_ button opens the terminal sheet over this room (Back returns here), not a new tab.
if (EMBED) document.querySelector('.termbtn')?.addEventListener('click', (e) => { e.preventDefault(); toHome('term'); });
// Embedded in the home app: the theme it asks for (always Terminal blue).
let theme = EMBED && ['day', 'night', 'term'].includes(Q.get('theme')) ? Q.get('theme')
  : (() => { try { return localStorage.getItem('cr-theme') || 'term'; } catch { return 'term'; } })();
// iOS home-screen apps often ignore a changed theme-color; swapping in a new meta tag makes them repaint the status bar.
const setTC = (c) => { const o = $('tc'); if (o.content === c) return; const m = o.cloneNode(); m.content = c; o.replaceWith(m); };
function applyTheme() {
  const h = new Date().getHours(), night = theme === 'night' || (theme === 'auto' && (h < 7 || h >= 19));
  document.documentElement.dataset.theme = theme === 'term' ? 'term' : night ? 'night' : 'day';
  setTC(theme === 'term' ? '#092451' : night ? '#05080b' : '#f3efe8');
  $('themebtn').textContent = { auto: (night ? '☾' : '☀') + ' Auto', day: '☀ Day', night: '☾ Night', term: '❯ Terminal' }[theme];
  tellHome();
}
// Embedded: tell the home app which colours we show (its status bar, sheet bar and keyboard area follow),
// and let its theme button cycle ours.
function tellHome() {
  if (!EMBED || !HOME) return;
  const cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(k).trim();
  parent.postMessage({ cr: 'theme', label: $('themebtn').textContent, bg: v('--bg'), card: v('--card'), ink: v('--ink'), line: v('--line'), accent: v('--accent') }, HOME);
}
addEventListener('message', (e) => { if (EMBED && HOME && e.origin === HOME && e.data?.cr === 'cycle') $('themebtn').click(); });
$('themebtn').onclick = () => { theme = { term: 'auto', auto: 'day', day: 'night', night: 'term' }[theme]; try { localStorage.setItem('cr-theme', theme); } catch {} applyTheme(); };
applyTheme(); setInterval(applyTheme, 60_000);

/* ===== markdown (small: fences, headings, lists, tables, inline) ===== */
function inline(s) {
  return esc(s)
    .replace(/`(?:! (?=\S))?([^`]+)`/g, '<code>$1</code>') // "! cmd" shows as plain cmd
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}
// Lists nest by indent, like the terminal: "   - x" under "1. y" is a sub-list of item 1.
const LI = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
function list(lines, i, ind) {
  const ol = /\d/.test(lines[i].match(LI)[2]), tag = ol ? 'ol' : 'ul', lis = [];
  while (i < lines.length) {
    const m = lines[i].match(LI);
    if (!m) {
      // A code block indented under the item belongs to it too, drawn as a real block with Copy.
      if (lis.length && /^\s*```/.test(lines[i]) && lines[i].search(/\S/) > ind) {
        const s0 = i++; while (i < lines.length && !/^\s*```/.test(lines[i])) i++;
        lis[lis.length - 1] += md(lines.slice(s0, ++i).join('\n')); continue;
      }
      // A wrapped line indented under the item belongs to it.
      if (lis.length && lines[i].trim() && lines[i].search(/\S/) > ind) { lis[lis.length - 1] += '<br>' + inline(lines[i++].trim()); continue; }
      break;
    }
    const d = m[1].length;
    if (d < ind) break;
    if (d > ind && lis.length) { const [sub, j] = list(lines, i, d); lis[lis.length - 1] += sub; i = j; continue; }
    if (/\d/.test(m[2]) !== ol) break;
    lis.push((ol ? `<li value="${parseInt(m[2], 10)}">` : '<li>') + inline(m[3])); i++;
  }
  return [`<${tag}>${lis.map((x) => x + '</li>').join('')}</${tag}>`, i];
}
// Box-drawing characters (─ │ ┌ ├ ╔ …) mean a hand-drawn diagram.
const DIAG = /[\u2500-\u257F]/;
// …or a tree's root line ("project/") right above its ├── lines.
// A diagram starts on a line that begins with a box character, or has two of them with another box line under it;
// one "│" in a sentence, or a lone line quoting "──── my-tab ─", is prose.
const diagAt = (ls, i) => /^\s*[\u2500-\u257F]/.test(ls[i]) || (/[\u2500-\u257F].*[\u2500-\u257F]/.test(ls[i]) && DIAG.test(ls[i + 1] || '')) || (/^\S+$/.test(ls[i].trim()) && /^\s*[├└│]/.test(ls[i + 1] || ''));
// Every web address in Claude's text opens in a new tab: with or without https://, inside `code` or
// **bold**, and bare names like example.com/home or 10.0.0.5:8080/review (they weren't clickable before).
const URL_RE = /\b(?:https?:\/\/[^\s<>"'`]+|(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}(?:\/[^\s<>"'`]*)?|(?:[a-z0-9-]+\.)+(?:uk|com|org|net|io|dev|ai|app|me|co)(?::\d+)?(?:\/[^\s<>"'`]*)?)/gi;
function linkify(root) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement.closest('a,pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const nodes = []; while (walk.nextNode()) nodes.push(walk.currentNode);
  for (const n of nodes) {
    const t = n.nodeValue; URL_RE.lastIndex = 0; if (!URL_RE.test(t)) continue;
    const frag = document.createDocumentFragment(); let at = 0; URL_RE.lastIndex = 0;
    for (const m of t.matchAll(URL_RE)) {
      let u = m[0].replace(/[.,;:!?)\]]+$/, ''); // trailing sentence punctuation is not part of the address
      if (/\.(js|mjs|css|json|md|sh|py|html|png|jpg|db|txt|log|yml|yaml)$/i.test(u) && !/^https?:|\//.test(u)) continue; // file names, not sites
      frag.append(t.slice(at, m.index));
      const a = document.createElement('a'); a.textContent = u; a.target = '_blank'; a.rel = 'noopener';
      a.href = /^https?:/i.test(u) ? u : (/^\d/.test(u) ? 'http://' : 'https://') + u;
      frag.append(a); at = m.index + u.length;
    }
    frag.append(t.slice(at)); n.replaceWith(frag);
  }
}
function md(src) {
  const out = [], lines = String(src || '').split('\n');
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    // A fence can be indented (a code block inside a numbered list): drop that indent from its lines.
    if (/^\s*```/.test(l)) {
      const ind = l.match(/^\s*/)[0].length, buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { const x = lines[i++]; buf.push(x.slice(Math.min(ind, x.match(/^\s*/)[0].length))); }
      i++; out.push(`<div class="cb"><pre><code>${esc(buf.join('\n').replace(/^! (?=\S)/gm, ''))}</code></pre><button class="cpy" type="button">Copy</button></div>`); continue;
    }
    // A diagram written without a code fence (boxes, ├── trees): keep it as drawn, never reflow it.
    if (diagAt(lines, i)) {
      const buf = [lines[i++]]; while (i < lines.length && lines[i].trim() && (DIAG.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) buf.push(lines[i++]);
      out.push(`<pre class="dg"><code>${esc(buf.join('\n'))}</code></pre>`); continue;
    }
    if (/^#{1,4}\s/.test(l)) { const n = l.match(/^#+/)[0].length; out.push(`<h${n}>${inline(l.slice(n + 1))}</h${n}>`); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows = []; while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      out.push(`<table>${body.map((r, k) => `<tr>${cells(r).map((c) => k ? `<td>${inline(c)}</td>` : `<th>${inline(c)}</th>`).join('')}</tr>`).join('')}</table>`); continue;
    }
    if (LI.test(l)) { const [html, j] = list(lines, i, l.match(LI)[1].length); out.push(html); i = j; continue; }
    if (!l.trim()) { i++; continue; }
    const para = []; while (i < lines.length && lines[i].trim() && !diagAt(lines, i) && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) { out.push(`<p>${inline(lines[i++])}</p>`); continue; }
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

/* ===== ANSI (the tab's own colours) → HTML ===== */
// 256-colour greys read as dim; the teal/blue mode colours as cyan. Truecolour is skipped.
const C256 = (n) => (n >= 240 && n <= 250) || n === 8 ? 'a-d' : [73, 74, 38, 39, 45, 117, 153].includes(n) ? 'a-c' : [114, 77, 78, 71, 2, 10].includes(n) ? 'a-g' : [174, 167, 203, 196, 1, 9].includes(n) ? 'a-r' : [220, 214, 178, 179, 3, 11].includes(n) ? 'a-y' : null;
function ansi(s) {
  let open = 0, html = '';
  for (const part of String(s).split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) { html += esc(part); continue; }
    const codes = (m[1] || '0').split(';').map(Number);
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k];
      let cls = null;
      if (c === 0 || c === 39 || c === 22) { html += '</span>'.repeat(open); open = 0; continue; }
      if (c === 38 && codes[k + 1] === 5) { cls = C256(codes[k + 2]); k += 2; }
      else if (c === 38 && codes[k + 1] === 2) { k += 4; }
      else cls = { 1: 'a-b', 2: 'a-d', 31: 'a-r', 32: 'a-g', 33: 'a-y', 36: 'a-c', 34: 'a-c', 91: 'a-r', 92: 'a-g', 93: 'a-y', 96: 'a-c' }[c];
      if (cls) { html += `<span class="${cls}">`; open++; }
    }
  }
  return html + '</span>'.repeat(open);
}

/* ===== room list ===== */
let rooms = [], offline = [], cur = null;
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
// New reply: the server says when Claude last wrote in each room (replyAt), and a room is New when that's
// later than when this device last looked at it (seen). Nothing has to be watched live, so it still works
// after the phone app slept. A room first met with replies counts as read; one first met empty counts from 0.
const ls = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } };
let seen = ls('roomsSeen', {}), unread = {}, baseTitle = 'Claude Rooms';
const looking = (id) => cur?.id === id && !document.hidden;
function markUnread() {
  const was = JSON.stringify(seen);
  unread = {};
  for (const r of rooms) {
    if (r.replyAt === undefined) continue; // a server without replyAt: never guess
    if (seen[r.id] == null || looking(r.id)) seen[r.id] = Math.max(seen[r.id] || 0, r.replyAt || 0);
    else if (r.replyAt > seen[r.id] && r.state !== 'busy' && !r.waiting) unread[r.id] = r.replyAt;
  }
  // Each write wakes the other open page (an embedded copy in the home dashboard shares this storage).
  const now = JSON.stringify(seen);
  if (now !== was) try { localStorage.setItem('roomsSeen', now); } catch {}
  unreadBadges();
}
function unreadBadges() {
  const n = Object.keys(unread).filter((id) => id !== cur?.id).length;
  document.title = (n ? `(${n}) ` : '') + baseTitle;
  $('back').classList.toggle('has', !!n); $('back').dataset.n = n;
}
const setTitle = (t) => { baseTitle = t; unreadBadges(); };
addEventListener('storage', (e) => { if (e.key === 'roomsSeen') { seen = ls('roomsSeen', {}); loadRooms(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadRooms(); });
async function loadRooms() {
  try { [rooms, offline] = await Promise.all([api('rooms'), api('offline').catch(() => offline)]); } catch { return; }
  markUnread();
  $('rooms').innerHTML = rooms.map((r) => { const nu = !!unread[r.id] && cur?.id !== r.id; return `<button class="room ${cur?.id === r.id ? 'on' : ''}${nu ? ' unread' : ''}" onclick="go('${esc(r.id)}')">
    <span class="dot ${r.waiting ? 'waiting' : r.state}"></span><span class="nm">${esc(r.name)}</span>
    ${r.handoff && !hoffDone().some((k) => k.endsWith('|' + r.handoff.task)) ? `<span class="hft" title="Working on a handoff: ${esc(r.handoff.task)}">↘ ${esc(r.handoff.from)}</span>` : ''}
    ${r.waiting ? '<span class="tag">waiting</span>' : r.state === 'busy' ? '<span class="tag">working</span>' : nu ? '<span class="newpill">New</span>' : r.state === 'shell' ? '<span class="tag">background</span>' : ''}</button>`; }).join('')
    + (offline.length ? `<div class="offh">Offline <small>tap to bring back</small></div>` + offline.map((r) => `<div class="room off" data-sid="${esc(r.sessionId)}" role="button" tabindex="0" onclick="wake(this)">
    <span class="dot off"></span><span class="nm">${esc(r.name)}</span><span class="tag">${ago(r.lastActive || r.closedAt)}</span>
    <button class="fgt" onclick="forgetRoom(event,this)" aria-label="Forget ${esc(r.name)}">✕</button></div>`).join('') : '');
}
// Wake: resume the closed room's chat in a new tab, then open it.
window.wake = async (el) => {
  if (el.classList.contains('waking')) return;
  el.classList.add('waking'); el.querySelector('.tag').textContent = 'Waking…';
  try { const r = await api(`offline/${el.dataset.sid}/wake`, {}); await loadRooms(); go(r.id); }
  catch (e) { el.classList.remove('waking'); el.querySelector('.tag').textContent = 'Try again'; fail(e); }
};
// Forget: two taps on ✕ (the first asks "Forget?"); only the list entry goes, the chat stays saved on disk.
window.forgetRoom = async (e, b) => {
  e.stopPropagation();
  if (!b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = 'Forget?'; setTimeout(() => { b.classList.remove('sure'); b.textContent = '✕'; }, 4000); return; }
  try { await api(`offline/${b.parentElement.dataset.sid}/forget`, {}); loadRooms(); } catch (err) { fail(err); }
};
setInterval(loadRooms, 5000);
// New tab: the button turns into a name box; it turns back once the room starts, on Esc, or when left empty.
function newBtn() {
  if ($('newform')) $('newform').outerHTML = '<button class="newbtn" id="newbtn">＋ New tab</button>';
  $('newbtn').onclick = newForm;
}
function newForm() {
  $('newbtn').outerHTML = `<form class="newform" id="newform"><input id="newname" placeholder="Name for the new tab" autocomplete="off"><button class="btn pri">Start</button></form>`;
  const i = $('newname'); i.focus();
  i.onkeydown = (e) => { if (e.key === 'Escape') newBtn(); };
  i.onblur = () => setTimeout(() => { if ($('newname') === i && !i.value.trim() && document.activeElement?.closest('#newform') == null) newBtn(); }, 150);
  $('newform').onsubmit = async (e) => {
    e.preventDefault();
    if (!i.value.trim()) return i.focus();
    const btn = $('newform').querySelector('button'); btn.disabled = true; btn.textContent = 'Starting…';
    try { const r = await api('rooms/new', { name: i.value.trim() }); newBtn(); await loadRooms(); go(r.id); }
    catch (err) { btn.textContent = err.message; setTimeout(() => { btn.disabled = false; btn.textContent = 'Start'; }, 3000); }
  };
}
newBtn();
$('back').onclick = () => { if (EMBED) toHome('close'); else location.hash = ''; };
window.go = (id) => { location.hash = 'r=' + encodeURIComponent(id); };
window.addEventListener('hashchange', route);
function route() {
  const id = decodeURIComponent((location.hash.match(/r=([^&]+)/) || [])[1] || '');
  // #r=<room>&draft=<text> (Ask the assistant): pre-fill that room's draft once, never send it.
  const dm = location.hash.match(/[#&]draft=([^&]*)/);
  if (id && dm) { drafts[id] = decodeURIComponent(dm[1]); storeDrafts(); history.replaceState(null, '', '#r=' + encodeURIComponent(id)); if (cur?.id === id) loadDraft(); 
    // Cursor at the end so you just carry on typing (a draft can end with "I want to say: ").
    setTimeout(() => { if (cur?.id === id) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); } }, 700); }
  if (id) openRoom(id); else closeRoom();
}

/* ===== header + screen state ===== */
// A dialog counts as mid-turn: the tab reports idle while it waits on you.
const busy = () => !!(cur?.pane?.spinner || cur?.pane?.status === 'busy' || cur?.pane?.dialog);
function header() {
  const p = cur.pane || {}, waiting = !!p.dialog;
  const st = waiting ? 'waiting' : busy() ? 'busy' : p.status === 'shell' ? 'shell' : 'idle';
  $('cname').textContent = p.name || cur.name;
  $('cstate').className = st;
  $('cstate').innerHTML = `<span class="dot ${st}"></span>${waiting ? 'Waiting for you' : busy() ? 'Working…' : st === 'shell' ? 'Background task running' : 'Idle'}`;
  setTitle((waiting ? '● ' : '') + (p.name || cur.name) + ' · Claude');
  const m = MODES.find(([k]) => k === p.mode);
  // The header redraws on every screen update (each second mid-turn): keep an open menu open.
  const open = [...document.querySelectorAll('#cbtns .pop')].find((x) => !x.hidden)?.id;
  $('cbtns').innerHTML = `${(busy() || st === 'shell') && !waiting ? '<button class="btn bad" onclick="stop()">■ Stop</button>' : ''}
    <span class="menu"><button class="btn mode-${p.mode || 'x'}" onclick="toggleMenu(event,'modepop')">${m ? m[1] : 'Mode'}</button><div class="pop" id="modepop" hidden>
      ${MODES.map(([k, label]) => `<button onclick="setMode('${k}')">${k === p.mode ? '✓' : '<span style="width:1ch"></span>'} ${label}</button>`).join('')}
    </div></span>
    <span class="menu"><button class="btn" onclick="toggleMenu(event,'pop')" aria-label="More">⋯</button><div class="pop" id="pop" hidden>
      ${EMBED ? `<button onclick="toHome('home')">⌂ Home</button><a href="${CFG.selfUrl || location.origin}/#r=${encodeURIComponent(cur.id)}" target="_blank" rel="noopener">↗ Open on its own</a><hr>` : ''}
      <button onclick="startRename()">✎ Rename</button>
      <button onclick="cmd('compact')">⇲ Compact</button>
      <button onclick="handoff()">⇥ Handoff</button>
      <div class="popl">Model</div>
      ${['opus', 'fable', 'sonnet', 'haiku', 'default'].map((x) => `<button onclick="cmd('model',{model:'${x}'})">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}
      <hr><button class="bad" onclick="askClose()">✕ Close tab</button>
    </div></span>`;
  if (open && $(open)) $(open).hidden = false;
  $('msg').disabled = waiting;
  $('msg').placeholder = waiting ? (matchMedia('(max-width:760px)').matches ? 'Answer the question above' : 'Answer Claude’s question above') : busy() ? (matchMedia('(max-width:760px)').matches ? 'Queue a message…' : 'Message Claude (it queues behind this turn)…') : 'Message Claude…';
}
window.toggleMenu = (e, id) => { e.stopPropagation(); const el = $(id), was = el.hidden; document.querySelectorAll('.pop').forEach((x) => (x.hidden = true)); el.hidden = !was; };
document.addEventListener('click', () => document.querySelectorAll('.pop').forEach((x) => (x.hidden = true)));
const enc = () => encodeURIComponent(cur.id);
const fail = (e) => note(e.message, 'bad');
// Stop = end the turn (Escape) and any background commands still running in this room.
window.stop = () => Promise.all([busy() ? api(`rooms/${enc()}/key`, { key: 'Escape' }) : null, api(`rooms/${enc()}/stopbg`, {})]).catch(fail);
window.setMode = (m) => api(`rooms/${enc()}/mode`, { mode: m }).catch(fail);
window.cmd = (c, body = {}) => api(`rooms/${enc()}/${c}`, body).catch(fail);
window.handoff = () => cmd('handoff');
// Assistant room: quick questions fill the message box (never sent), "New question" clears its context.
const QUICK = [['What changed today?', 'Sum up what changed on this machine today.'],
  ['Why is … down?', 'Why is  down?', 7], ['Free disk space', 'Disk is getting low. Find what is using it and free space safely.'],
  ['Check services', 'Check every service is up and tell me anything that is not.'], ['Check backups', 'Check all backups are recent and tell me anything out of date.']];
function chips(on) {
  $('chips').hidden = !on; if (!on) return;
  $('chips').innerHTML = QUICK.map(([l], k) => `<button type="button" class="chip" onclick="quick(${k})">${esc(l)}</button>`).join('')
    + '<button type="button" class="chip new" onclick="askClear()">↺ New question</button>';
}
window.quick = (k) => {
  const [, text, at] = QUICK[k];
  box.value = text; box.dispatchEvent(new Event('input')); box.focus();
  box.setSelectionRange(at ?? text.length, at ?? text.length);
};
// In-page confirm card (never a browser dialog — it exits fullscreen). The assistant's New question and the "/" commands share it.
function askConfirm(title, body, go, onGo) {
  $('closecard').innerHTML = `<div class="card"><h4>${esc(title)}</h4><div class="body">${esc(body)}</div>
    <div class="acts"><button class="btn pri" id="cleargo">${esc(go)}</button><button class="btn" onclick="$('closecard').innerHTML=''">Cancel</button></div></div>`;
  stick();
  $('cleargo').onclick = async () => {
    $('cleargo').disabled = true;
    try { await onGo(); $('closecard').innerHTML = ''; } catch (e) { $('cleargo').disabled = false; fail(e); }
  };
}
window.askClear = () => askConfirm('New question', 'Clear the assistant’s memory of this chat so the next question starts fresh? The old chat stays saved.', 'Start fresh',
  () => api(`rooms/${enc()}/send`, { text: '/clear', device: deviceName() }));
// Close tab: in-page confirm (never a browser dialog), then /exit + remove the tmux tab.
window.askClose = (wasBusy) => {
  const name = esc(cur.pane?.name || cur.name), mid = busy() || wasBusy === true;
  $('closecard').innerHTML = `<div class="card closing"><h4>Close tab</h4>
    <div class="body">Close <b>${name}</b>? Claude stops and frees its memory. The room stays in the list as <b>Offline</b> — tap it to bring the whole chat back.
    ${mid ? '<p class="warnl">It’s in the middle of something — closing stops it first.</p>' : ''}</div>
    <div class="acts"><button class="btn danger" id="closego">${mid ? 'Stop and close' : 'Close tab'}</button><button class="btn" onclick="$('closecard').innerHTML=''">Cancel</button></div></div>`;
  stick();
  $('closego').onclick = async () => {
    const id = cur.id, nm = cur.pane?.name || cur.name, b = $('closego');
    b.disabled = true; b.textContent = 'Closing…';
    try {
      // Without the busy warning shown, the server refuses a room that started working meanwhile: ask again.
      try { await api(`rooms/${encodeURIComponent(id)}/close`, { confirm: mid }); }
      catch (e) { if (e.busy && cur?.id === id) return askClose(true); throw e; }
      delete drafts[id]; delete draftPics[id]; storeDrafts();
      $('closecard').innerHTML = '';
      sideNote(`Closed ${nm}`);
      location.hash = '';
    } catch (e) { b.disabled = false; b.textContent = 'Try again'; fail(e); }
  };
};
function sideNote(t) {
  const n = $('sidenote'); n.textContent = t; n.hidden = false;
  clearTimeout(n.t); n.t = setTimeout(() => (n.hidden = true), 6000);
}
window.startRename = () => {
  const b = $('cname');
  b.innerHTML = `<input id="rn" value="${esc(cur.pane?.name || cur.name)}" style="font:inherit;color:inherit;background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:2px 6px;width:100%">`;
  const i = $('rn'); i.focus(); i.select();
  i.onkeydown = async (e) => {
    if (e.key === 'Escape') return header();
    if (e.key !== 'Enter') return;
    await cmd('rename', { name: i.value });
    header();
  };
  i.onblur = () => header();
};

function onPane(p) {
  const was = busy();
  cur.pane = p || {};
  // The mode line is hidden while a dialog is up: keep showing the last one seen.
  if (cur.pane.mode) cur.mode = cur.pane.mode; else cur.pane.mode = cur.mode;
  if (p?.gone) { feed.innerHTML = '<div class="empty">Claude isn’t running in this tab any more.</div>'; return; }
  if (p?.status === 'idle' && cur.bg?.size) cur.bg.clear();
  header(); awaiting(); bgBox();
  dialog(p.dialog);
  if (p.footer?.length) footer(p.footer);
  // Turn over: tidy the plan box. Only on a real reading (a pane with no status is "unknown"), and only
  // once it has stayed not-busy for 1.5 s, so a reconnect or a blip never ends a turn early.
  clearTimeout(cur.endT);
  if (was && !busy() && p?.status) {
    const me = cur;
    me.endT = setTimeout(() => {
      if (cur !== me || busy()) return;
      const t = me.turns.at(-1); if (t) summary(t); stepsBox(t, true);
    }, 1500);
  }
  loadRoomsSoon();
}
let lrs; function loadRoomsSoon() { clearTimeout(lrs); lrs = setTimeout(loadRooms, 300); }

function footer(lines) {
  // l1 = ctx + limit bars, l2 = 5h by tab, l3 = mode; the phone shows only l1.
  $('foot').innerHTML = lines.map((l, k) => `<div class="l l${k + 1}">${ansi(l.replace(/^((?:\x1b\[[0-9;]*m)*)\s+/, '$1'))}</div>`).join('');
  $('foot').hidden = false;
}

/* ===== Claude's dialog, as a card ===== */
// A plan dialog, even when the terminal has scrolled the plan's first lines out of view.
const PLAN_HEAD = /Ready to code\?|Here is Claude's plan|written up a plan|\.claude\/plans\//;
const PLAN_OPT = /^Yes, (and use auto mode|manually approve edits|and auto-accept|clear context)/;
// Questions: the terminal draws previews in a box beside the options, which garbles the screen text.
// Build the card from the AskUserQuestion call itself; the screen only says which question is up,
// which option is highlighted, and any extra options Claude adds ("Type something.").
const plainText = (l) => (l || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
function askData(d, pend) {
  const qs = pend?.name === 'AskUserQuestion' ? pend.input?.questions : cur.askQs;
  if (!qs?.length) return null;
  const screen = d.head.map(plainText).join(' ').replace(/\s+/g, ' ');
  const q = qs.find((x) => screen.includes(x.question.replace(/\s+/g, ' ').slice(0, 40))) || qs.find((x) => x.header && screen.includes(x.header)) || (qs.length === 1 ? qs[0] : null);
  if (!q) return null;
  const bare = (l) => l.replace(/^\[[^\]]\]\s*/, '').toLowerCase();
  if (!d.options.every((o) => !q.options[o.n - 1] || bare(o.label).startsWith(bare(q.options[o.n - 1].label).slice(0, 12)))) return null;
  const options = d.options.map((o) => {
    const mine = q.options[o.n - 1], tick = o.label.match(/^\[([^\]])\]\s*/);
    return mine ? { ...o, label: (tick ? `[${tick[1]}] ` : '') + mine.label + (/\s✔$/.test(o.label) ? ' ✔' : ''), desc: mine.description || '', preview: mine.preview || '' } : o;
  });
  return { q, options };
}
function dialog(d) {
  // A plan's key is only its options: scrolling the plan in the terminal changes the screen lines
  // but must not re-render (user report: it flipped back to the screen version).
  // A question asked in plan mode shows "Planning: …/.claude/plans/…" above it — tabs, "Chat about this"
  // or a pending AskUserQuestion mean it is a question, never the plan approval.
  const askish = !!d && (d.tabs?.length || d.options.some((o) => /^chat about this$/i.test(o.label)) || pending()?.name === 'AskUserQuestion');
  const planDlg = !!d && !askish && (d.head.some((l) => l && PLAN_HEAD.test(l)) || d.options.some((o) => PLAN_OPT.test(o.label)));
  // No numbered rows read (the pane is too short to show them): the screen card with arrow keys, never
  // a question card with no choices and a Submit that can't be pressed.
  const ask = d && !planDlg && d.options.length ? askData(d, pending()) : null;
  // Not in the transcript yet: fetch the saved question once per dialog, then draw again.
  if (d && !planDlg && !ask && d.options.length && cur.askFor !== JSON.stringify(d.options)) {
    const me = cur; me.askFor = JSON.stringify(d.options);
    fetch(`api/rooms/${enc()}/ask`).then((r) => r.ok ? r.json() : null).then((j) => {
      if (!j?.questions?.length || cur !== me) return;
      me.askQs = j.questions; me.dialogKey = null; dialog(me.pane?.dialog);
    }).catch(() => {});
  }
  const key = JSON.stringify(planDlg ? { plan: 1, options: d.options } : ask ? { ask: ask.q.question, tabs: d.tabs, options: ask.options.map((o) => [o.n, o.selected, o.label]) } : d || null);
  if (key === cur.dialogKey) return;
  cur.dialogKey = key;
  const box = $('cards');
  if (!d) { box.innerHTML = ''; $('dock').classList.remove('sheet'); if (cur.focusMsg) { cur.focusMsg = false; setTimeout(() => $('msg').focus(), 60); } return; }
  if (ask) { askCard(d, ask, box); return; }
  if (d.screen) { screenCard(d, box); return; }
  // Plan approval: show the plan itself (from the pending ExitPlanMode call) above Claude's options.
  const pend = pending();
  const plan = pend?.name === 'ExitPlanMode' && pend.input?.plan;
  const isPlan = !!plan || planDlg;
  const cached = isPlan && cur.planText;
  const head = plan ? `<div class="ai">${md(plan)}</div>` : cached ? `<div class="ai">${md(cached)}</div>`
    : ask ? `${ask.q.header ? `<div class="qh">${esc(ask.q.header)}</div>` : ''}<div class="qq">${esc(ask.q.question)}</div>${ask.q.multiSelect ? '<div class="qm">Pick any that apply</div>' : ''}` : d.head.map((l) => l === null ? '<hr>' : `<div class="hl">${ansi(l) || '&nbsp;'}</div>`).join('');
  box.innerHTML = `<div class="card dlg${isPlan ? ' plan' : ''}">${isPlan ? '<h4>Claude\'s plan · ready to start?</h4>' : ''}<div class="body">${head}</div><div class="opts">${(ask ? ask.options : d.options).map((o) =>
    `<button class="opt ${o.selected ? 'sel' : ''}" data-n="${o.n}" data-text="${o.text ? 1 : ''}"><b>${o.n}.</b> ${esc(o.label)}${o.desc ? `<small>${esc(o.desc)}</small>` : ''}${o.preview ? `<pre class="pv">${esc(o.preview)}</pre>` : ''}</button>`).join('')}</div>
    <div class="typed" hidden><input type="text" placeholder="Type your answer"><button class="btn pri">Send</button></div>
    <div class="acts">${d.tabs?.length ? '<button class="btn" data-back>‹ Back</button>' : ''}<button class="btn" data-esc>Esc · cancel</button></div></div>`;
  const card = box.firstChild, typed = card.querySelector('.typed'), input = typed.querySelector('input');
  $('dock').classList.toggle('sheet', isPlan);
  if (isPlan) gutter();
  // The screen shows only part of a long plan — swap in the whole plan file when it loads.
  // Always re-check the file (it may have been edited); the cached copy shows meanwhile, so it never flips.
  if (isPlan && !plan) {
    const id = cur.id;
    fetch(`api/rooms/${enc()}/plan`).then((r) => r.ok ? r.json() : null).then((j) => {
      if (!j?.text || cur?.id !== id) return;
      const changed = j.text !== cur.planText;
      cur.planText = j.text;
      const body = $('cards').querySelector('.card.dlg.plan .body');
      if (body && (changed || !body.querySelector('.ai'))) body.innerHTML = `<div class="ai">${md(j.text)}</div>`;
    }).catch(() => {});
  }
  const back = card.querySelector('[data-back]');
  if (back) back.onclick = () => { lock(card); api(`rooms/${enc()}/key`, { key: 'Left' }).catch(fail); };
  card.querySelectorAll('.opt').forEach((b) => b.onclick = () => {
    const n = Number(b.dataset.n);
    if (b.dataset.text) { typed.hidden = false; typed.dataset.n = n; input.focus(); return; }
    lock(card); api(`rooms/${enc()}/pick`, { n }).catch(fail);
  });
  const sendTyped = () => { if (!input.value.trim()) return; lock(card); api(`rooms/${enc()}/pick`, { n: Number(typed.dataset.n), text: input.value.trim() }).catch(fail); };
  typed.querySelector('button').onclick = sendTyped;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); sendTyped(); } };
  card.querySelector('[data-esc]').onclick = () => { lock(card); api(`rooms/${enc()}/key`, { key: 'Escape' }).catch(fail); };
  stick();
}
// A question (AskUserQuestion), worked like the terminal: tabs across the top go back and forth between
// questions; a single-select answer is picked first, then Next sends it; multi-select ticks go straight to
// the terminal; "Type something" opens a box (in multi-select it is a tick of its own); Chat about this
// ends the question so the reply can be typed in the message box.
function askCard(d, ask, box) {
  const q = ask.q, len = q.options.length, multi = !!q.multiSelect;
  const sel = (cur.askSel ||= {}), drafts = (cur.askDraft ||= {});
  const tabs = d.tabs || [], at = tabs.findIndex((t) => t.cur);
  const bare = (l) => l.replace(/^\[[^\]]\]\s*/, '').replace(/\s+✔$/, '');
  const on = (o) => /^\[✔\]/.test(o.label), done = (o) => /\s✔$/.test(o.label);
  const real = ask.options.filter((o) => o.n <= len);
  const typeRow = ask.options.find((o) => o.n === len + 1 && !/chat about this/i.test(o.label));
  const chat = ask.options.find((o) => /chat about this/i.test(o.label));
  const typedNow = typeRow && !/^type something\.?$/i.test(bare(typeRow.label)) ? bare(typeRow.label) : '';
  if (!multi && sel[q.question] == null) { const was = ask.options.find((o) => o.n <= len + 1 && done(o)); if (was) sel[q.question] = was.n; }
  const choice = () => sel[q.question];
  const draft = drafts[q.question] ?? typedNow;
  // Options with previews: the terminal has no "Type something" row, it takes a note on the chosen
  // option instead (the user's "Change it" notes never reached Claude, 2026-10-28).
  const notesOn = !!d.notes && !multi, notesDraft = (cur.askNote ||= {}), note = notesDraft[q.question] || '';
  // an unsent draft ticks the row too (a re-render after another tick must not drop it)
  const typedOn = drafts[q.question] != null ? !!drafts[q.question].trim() : !!(typeRow && on(typeRow));
  const mark = (o) => multi ? (on(o) ? '☑' : '☐') : `${o.n}.`;
  box.innerHTML = `<div class="card dlg ask">
    ${tabs.length ? `<div class="qtabs">${tabs.map((t, i) => `<button class="qtab${t.cur ? ' cur' : ''}${t.done ? ' done' : ''}" data-tab="${i}">${t.submit ? '✔' : t.done ? '☒' : '☐'} ${esc(t.label)}</button>`).join('')}</div>` : ''}
    <div class="body">${tabs.length > 1 && at >= 0 && !tabs[at].submit ? `<div class="qn">Question ${at + 1} of ${tabs.filter((t) => !t.submit).length}</div>` : ''}${q.header && !tabs.length ? `<div class="qh">${esc(q.header)}</div>` : ''}<div class="qq">${esc(q.question)}</div>${multi ? '<div class="qm">Pick any that apply</div>' : ''}</div>
    <div class="opts">${real.map((o) => `<button class="opt${multi && on(o) ? ' on' : ''}${!multi && choice() === o.n ? ' sel' : ''}" data-n="${o.n}"><b>${mark(o)}</b> ${esc(bare(o.label))}${o.desc ? `<small>${esc(o.desc)}</small>` : ''}${o.preview ? `<pre class="pv">${esc(o.preview)}</pre>` : ''}</button>`).join('')}
    ${typeRow ? `<button class="opt typ${multi && typedOn ? ' on' : ''}${!multi && choice() === typeRow.n ? ' sel' : ''}" data-type><b>${multi ? (typedOn ? '☑' : '☐') : mark(typeRow)}</b> ${typedNow ? esc(typedNow) : '<i>Type something…</i>'}</button>` : ''}</div>
    <div class="typed" ${(!multi && typeRow && choice() === typeRow.n) || drafts[q.question] != null ? '' : 'hidden'}><input type="text" placeholder="Type your answer" value="${esc(draft)}"></div>
    ${notesOn ? `<div class="notes"><input type="text" placeholder="Add a note to your choice (optional)" value="${esc(note)}"></div>` : ''}
    <div class="acts">${at > 0 ? '<button class="btn" data-back>‹ Back</button>' : ''}<button class="btn pri" data-go>${tabs.length ? 'Next ›' : 'Submit'}</button>${chat ? '<button class="btn" data-chat>💬 Chat about this</button>' : ''}<button class="btn" data-esc>Esc · cancel</button></div></div>`;
  const card = box.firstChild, typed = card.querySelector('.typed'), input = typed.querySelector('input'), go = card.querySelector('[data-go]');
  const act = (body) => api(`rooms/${enc()}/ask`, body);
  const run = (fn) => { lock(card); fn().catch((e) => { fail(e); unlock(card); }); };
  const ready = () => { go.disabled = !multi && (choice() == null || (choice() === typeRow?.n && !input.value.trim())); };
  ready(); go.addEventListener('ready', ready);
  $('dock').classList.remove('sheet');
  card.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { const to = Number(b.dataset.tab) - at; if (to && at >= 0) run(async () => { await keep(); return act({ act: 'tab', to, leave: typeRow?.n }); }); });
  card.querySelectorAll('.opt[data-n]').forEach((b) => b.onclick = () => {
    const n = Number(b.dataset.n);
    if (multi) return run(() => act({ act: 'toggle', n }));
    sel[q.question] = n; typed.hidden = true;
    card.querySelectorAll('.opt').forEach((x) => x.classList.toggle('sel', x === b)); ready();
  });
  const typeBtn = card.querySelector('[data-type]');
  if (typeBtn) typeBtn.onclick = () => {
    if (!multi) { sel[q.question] = typeRow.n; card.querySelectorAll('.opt').forEach((x) => x.classList.toggle('sel', x === typeBtn)); }
    typed.hidden = false; drafts[q.question] = input.value; input.focus(); ready();
  };
  // Like the terminal: the box ticks as soon as there is text (and unticks when it is cleared).
  input.oninput = () => {
    drafts[q.question] = input.value; ready();
    if (multi && typeBtn) { const has = !!input.value.trim(); typeBtn.classList.toggle('on', has); typeBtn.querySelector('b').textContent = has ? '☑' : '☐'; }
  };
  // Multi-select: Save puts the typed text in the terminal's row (empty Save clears and unticks it).
  const save = () => act({ act: 'type', n: typeRow.n, text: input.value }).then(() => { delete drafts[q.question]; });
  // Multi-select: typed text goes to the terminal when you move on (Next, Back or a tab).
  const keep = async () => { if (multi && typeRow && drafts[q.question] != null && input.value.trim() !== typedNow) await save(); };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } };
  const noteIn = card.querySelector('.notes input');
  if (noteIn) {
    noteIn.oninput = () => { notesDraft[q.question] = noteIn.value; };
    noteIn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } };
  }
  go.onclick = () => run(async () => {
    if (multi) {
      await keep(); delete drafts[q.question];
      return act({ act: 'tab', to: 1, leave: typeRow?.n });
    }
    const n = choice();
    if (n === typeRow?.n) await act({ act: 'type', n, text: input.value, submit: true });
    else if (noteIn && noteIn.value.trim()) await act({ act: 'note', n, text: noteIn.value });
    else await act({ act: 'choose', n });
    delete sel[q.question]; delete drafts[q.question]; delete notesDraft[q.question];
  });
  const back = card.querySelector('[data-back]');
  if (back) back.onclick = () => run(async () => { await keep(); return act({ act: 'tab', to: -1, leave: typeRow?.n }); });
  const chatBtn = card.querySelector('[data-chat]');
  if (chatBtn) chatBtn.onclick = () => run(async () => { cur.focusMsg = true; await act({ act: 'chat', n: chat.n }); });
  card.querySelector('[data-esc]').onclick = () => run(() => api(`rooms/${enc()}/key`, { key: 'Escape' }));
  stick();
}
function gutter() {
  const body = document.querySelector('.card.dlg.plan .body');
  if (body) body.parentElement.style.setProperty('--g', (body.offsetWidth - body.clientWidth) / 2 + 'px');
}
addEventListener('resize', gutter);
function lock(card) { card.querySelectorAll('button,input').forEach((x) => (x.disabled = true)); card.style.opacity = '.6'; setTimeout(() => unlock(card), 2500); }
// A key that changed nothing on screen (← on the first question) leaves no re-render to unlock the card.
function unlock(card) { if (!card.isConnected) return; card.querySelectorAll('button,input').forEach((x) => (x.disabled = false)); card.style.opacity = ''; card.querySelector('[data-go]')?.dispatchEvent(new Event('ready')); }
// The newest tool call that has no result yet (what a dialog is about).
function pending() { const t = cur.turns.at(-1); return t && [...t.steps].reverse().find((s) => s.result == null); }

/* ===== feed: the same shape as the terminal ===== */
// ❯ your message · ● Claude's text · ✻ Worked for Ns · N steps · View steps at the end of a turn.
// Tool calls are NOT shown in the chat (user ask, like the turn-steps mod): they fold into the turn's
// steps, opened from View steps. Rows that arrive live slide in. The plan tool drives the plan box.
function newTurn(ts) {
  const el = document.createElement('div');
  el.className = 'turn';
  const sum = document.createElement('div');
  sum.className = 'sum'; sum.hidden = true;
  el.appendChild(sum);
  feed.appendChild(el);
  grower.observe(el);
  const t = { el, sum, steps: [], byId: new Map(), plan: null, start: ts, end: ts, work: 0 };
  cur.turns.push(t);
  return t;
}
const turn = () => cur.turns.at(-1) || newTurn();
function add(el, t = turn()) { t.el.insertBefore(el, t.sum); }
function row(cls, html, t) {
  const d = document.createElement('div');
  d.className = cls + (cur.live ? ' new' : '');
  d.innerHTML = html;
  add(d, t);
  return d;
}
// When each message was sent: 14:05 today, Sat 14:05 this week, 17 Oct 14:05 before that.
// A "Saturday 17 October" line goes above the first message of each day.
function stamp(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date(), hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = d.toDateString() === now.toDateString() ? hm
    : now - d < 6 * 864e5 ? d.toLocaleDateString([], { weekday: 'short' }) + ' ' + hm
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + hm;
  return `<time class="ts" title="${d.toLocaleString()}">${day}</time>`;
}
function dayLine(ts, t) {
  if (!ts) return;
  const d = new Date(ts), key = d.toDateString();
  if (cur.lastDay === key) return;
  cur.lastDay = key;
  row('day', `<span>${d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })}</span>`, t);
}
function note(text, cls = '') { if (!cur) return; row('note ' + cls, esc(text)); stick(); }

function msg(m) {
  if (m.uuid) { if (cur.seen.has(m.uuid)) return; cur.seen.add(m.uuid); }
  if (m.compact) { row('note', 'Conversation compacted'); return; }
  if (m.role === 'user') { if (m.queued) queuedMsg(m.content, m.ts); else if (!m.meta || /<(cross-session|agent|teammate)-message\b/.test(JSON.stringify(m.content))) userMsg(m.content, m.ts); }
  else { assistantMsg(m.content, m.ts); const t = cur.turns.at(-1); if (t && m.mid && m.usage) (t.use ||= new Map()).set(m.mid, m.usage); }
  // Worked-for counts only working time: a resumed session adds entries to a days-old turn, and no
  // step runs 30 minutes without writing something, so a longer gap is time away, not work.
  const t = cur.turns.at(-1); if (t && m.ts) { const gap = new Date(m.ts) - new Date(t.end); if (gap > 0 && gap < 30 * 60e3) t.work += gap; t.end = m.ts; summary(t); }
}
function userMsg(content, ts) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content || [];
  const results = blocks.filter((b) => b.type === 'tool_result');
  if (results.length) return toolResults(results);
  let text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const imgs = blocks.filter((b) => b.type === 'image').length;
  // Slash command output and ! shell output hang under the command, like the terminal's ⎿ line.
  const out = text.match(/<(local-command-stdout|bash-stdout)>([\s\S]*?)<\/\1>/);
  if (out) { const s = out[2].replace(/\x1b\[[0-9;]*m/g, '').trim(); if (s) row('res', `<span class="g">└</span><span>${esc(s)}</span>`); return; }
  if (/^\s*<task-notification/.test(text)) { bgNote(text); return; }
  if (/^\s*<(local-command-caveat|task-notification|bash-stderr)/.test(text)) return;
  if (agentIn(text, ts, true)) return;
  const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
  const bash = text.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
  text = cleanUser(text);
  if (!text && !imgs && !cmd) return;
  if (/^\[Request interrupted/.test(text)) { row('res bad', '<span class="g">└</span><span>Interrupted · What should Claude do instead?</span>'); return; }
  const t = newTurn(ts);
  // A new prompt: the last turn's finished box goes; this turn's box appears with its first step.
  if (cur.live) { cur.boxMin = false; stepsBox(null); }
  const shown = cmd ? cmd[1] + ' ' + ((text.match(/<command-args>([^<]*)</) || [])[1] || '') : bash ? '! ' + bash[1] : text;
  t.prompt = shown.split('\n')[0];
  dayLine(ts, t);
  const u = row('u' + (cmd || bash ? ' cmd' : ''), `<span class="g">❯</span><div>${imgs ? `<span class="img">🖼 ${imgs}</span>` : ''}${esc(shown)}</div>${stamp(ts)}`, t);
  // The sent message already flew in as a placeholder: swap it for the real row without animating twice.
  cur.said?.push([shown.trim(), Date.parse(ts) || 0]);
  if (cur.pending) { cur.pending.remove(); cur.pending = null; u.classList.remove('new'); }
}
/* ===== agent ↔ agent ===== */
// Another agent's message arrives as a user turn wrapped in <cross-session-message from-name="…"> (a room
// or session), <agent-message> (this room's own helper) or <teammate-message>. It is never the user's, so it
// gets its own card. The shared handoff shape (CLAUDE.md) is "Handoff:" / "Handoff done:" + Field: lines.
const AGENT_WRAP = /<(cross-session-message|agent-message|teammate-message)\b([^>]*)>\n?([\s\S]*?)\n?<\/\1>/g;
function agentIn(text, ts, own) {
  const clean = cleanUser(text);
  if (/^\[Cross-session (idle|delivery) notice\]/.test(clean)) { row('res', `<span class="g">└</span><span>${esc(short(clean, 200))}</span>`); return true; }
  const all = [...clean.matchAll(AGENT_WRAP)];
  if (!all.length) return false;
  const t = own ? newTurn(ts) : turn();
  for (const [, kind, attrs, body] of all) {
    const who = (attrs.match(/\bfrom-name="([^"]+)"/) || attrs.match(/\bfrom="([^"]+)"/) || [, kind === 'agent-message' ? 'a helper agent' : 'another agent'])[1];
    const addr = attrs.match(/\bfrom="([^"]+)"/)?.[1]; if (addr) (cur.addrs ||= {})[addr] = who; // a reply is sent to this address
    agentCard('in', who, body, ts, t);
  }
  if (own) t.prompt = '↘ ' + short(all[0][3].split('\n')[0], 80);
  return true;
}
function handoffOf(body) {
  const lines = String(body).trim().split('\n'), m = lines[0].match(/^\s*Handoff( done)?:\s*(.+)$/i);
  if (!m) return null;
  const f = {};
  for (const l of lines.slice(1)) { const x = l.match(/^\s*(From|Done|Next|Send back|Result|Files):\s*(.*)$/i); if (x) f[x[1].toLowerCase()] = x[2]; else { const k = Object.keys(f).at(-1); if (k) f[k] += '\n' + l; } }
  return { done: !!m[1], task: m[2].trim(), f };
}
// A room by the name an agent goes by (its tab name), for the Open buttons.
const roomByName = (n) => { n = String(n || '').toLowerCase(); return rooms.find((r) => r.name.toLowerCase() === n || r.id === 'claude-' + n.replace(/\s+/g, '-')); };
function agentCard(dir, who, body, ts, t) {
  const h = handoffOf(body), r = roomByName(who), inc = dir === 'in';
  const title = h ? (h.done ? (inc ? `Result from ${who}` : `Result sent to ${who}`) : (inc ? `Handed over from ${who}` : `Handed to ${who}`)) : (inc ? `From ${who}` : `Sent to ${who}`);
  const fields = h ? [['from', 'From'], ['done', 'Done so far'], ['next', 'Next'], ['send back', 'Send back'], ['result', 'Result'], ['files', 'Files']]
    .filter(([k]) => h.f[k]).map(([k, l]) => `<dt>${l}</dt><dd>${md(h.f[k])}</dd>`).join('') : '';
  dayLine(ts, t);
  const el = row(`agent ${inc ? 'in' : 'out'}${h ? ' hoff' + (h.done ? ' done' : '') : ''}`, `<div class="ah"><span class="ar">${inc ? '↘' : '↗'}</span><b>${esc(title)}</b>${stamp(ts)}${r && r.id !== cur.id ? `<button type="button" class="btn sm" onclick="go('${esc(r.id)}')">Open ${esc(r.name)}</button>` : ''}</div>`
    + (h ? `<div class="task">${esc(h.task)}</div>${fields ? `<dl>${fields}</dl>` : ''}` : `<div class="ai">${md(body)}</div>`), t);
  linkify(el);
  if (h) handoffSeen(dir, who, h, ts);
}
// The open handoff this room is working on: pinned above the message box until it is sent back or marked done.
function handoffSeen(dir, who, h, ts) {
  cur.hoffs ||= [];
  if (dir === 'in' && !h.done) cur.hoffs.push({ who, task: h.task, back: h.f['send back'] || '', key: (ts || '') + '|' + h.task });
  if (dir === 'out' && h.done) { const o = cur.hoffs.find((x) => x.task === h.task) || cur.hoffs.filter((x) => x.who === who).at(-1); if (o) o.closed = true; }
  hoffBox();
}
const hoffDone = () => { try { return JSON.parse(localStorage.getItem('handoffDone')) || []; } catch { return []; } };
function hoffBox() {
  const done = hoffDone(), o = (cur?.hoffs || []).filter((x) => !x.closed && !done.includes(x.key)).at(-1), box = $('hoff');
  box.hidden = !o; if (!o) return;
  const r = roomByName(o.who);
  box.innerHTML = `<div class="hl"><span class="ar">↘</span><div><small>Working on · from ${esc(o.who)}</small><b>${esc(o.task)}</b></div></div>
    <div class="hb">${r && r.id !== cur.id ? `<button type="button" class="btn sm" onclick="go('${esc(r.id)}')">Open ${esc(r.name)}</button>` : ''}
    <button type="button" class="btn sm pri" onclick="hoffBack()">Send result back</button><button type="button" class="btn sm" onclick="hoffClose()">Mark done</button></div>`;
  box.dataset.key = o.key;
}
const hoffOpen = () => (cur?.hoffs || []).find((x) => x.key === $('hoff').dataset.key);
window.hoffBack = () => { const o = hoffOpen(); if (!o) return;
  api(`rooms/${enc()}/send`, { text: `Send the result of the handoff "${o.task}" back to ${o.who} now, as a "Handoff done:" message.`, device: deviceName() }).catch(fail); };
window.hoffClose = () => { const o = hoffOpen(); if (!o) return;
  try { localStorage.setItem('handoffDone', JSON.stringify([...hoffDone(), o.key].slice(-200))); } catch {} hoffBox(); };
// Harness wrappers are not what the user typed: drop reminders, unwrap a paste back to its own text.
function cleanUser(text) {
  return String(text || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<\/?pasted_content\b[^>]*>/g, '').trim();
}
// Sent while Claude was working: it sits inside the running turn where Claude picked it up, like the terminal.
function queuedMsg(text, ts) {
  if (/^\s*<task-notification/.test(text)) { bgNote(text); return; }
  if (/^\s*<(local-command-caveat|task-notification|bash-stderr)/.test(text)) return;
  if (agentIn(text, ts, false)) return;
  text = cleanUser(text);
  if (!text) return;
  const u = row('u', `<span class="g">❯</span><div>${esc(text)}</div>`, turn());
  cur.said?.push([text, Date.parse(ts) || 0]);
  if (cur.pending) { cur.pending.remove(); cur.pending = null; u.classList.remove('new'); }
}
function assistantMsg(content, ts) {
  const t = turn();
  for (const b of content || []) {
    // The terminal prints a thinking block that has text as an ordinary ● line, so show it the same way
    // (user ask: "I want to see what the terminal sees"). Empty/redacted thinking stays hidden.
    const said = b.type === 'text' ? b.text : b.type === 'thinking' ? b.thinking : '';
    if (said?.trim()) {
      dayLine(ts, t);
      linkify(row('a', `<span class="g">●</span><div class="ai">${md(said)}</div>${stamp(ts)}`, t).querySelector('.ai'));
    } else if (b.type === 'tool_use') {
      if (b.name === PLAN) { planUpdate(t, b.input); continue; }
      if (b.name === 'SendMessage' && b.input?.message) { const to = String(b.input.to || '').replace(/\s*\[[^\]]*\]$/, ''); agentCard('out', cur.addrs?.[to] || (/^\w+:\//.test(to) ? 'the sender' : to), b.input.message, ts, t); }
      const s = { id: b.id, name: b.name, input: b.input, result: null, error: false };
      t.steps.push(s); t.byId.set(b.id, s);
      if (cur.live) { s.at = Date.now(); if (t === cur.turns.at(-1)) stepsBox(t); }
    }
  }
}
function toolResults(results) {
  const t = turn();
  for (const r of results) {
    const s = t.byId.get(r.tool_use_id); if (!s) continue;
    s.result = typeof r.content === 'string' ? r.content : (r.content || []).map((c) => c.text || (c.type === 'image' ? '[image]' : '')).join('\n');
    s.error = !!r.is_error;
    const bg = s.name === 'Bash' && s.result.match(/(?:moved to the background|running in background)[^\n]*?ID: ([\w-]+)/i);
    if (bg) { (cur.bg ||= new Map()).set(bg[1], { label: stepLine(s), at: cur.live ? Date.now() : null }); bgBox(); }
    if (cur.live && t === cur.turns.at(-1) && !cur.boxEnded) stepsBox(t);
    if (s.name === 'AskUserQuestion' || s.name === 'ExitPlanMode') row('res' + (s.error ? ' bad' : ''), `<span class="g">└</span><span>${resultLine(s)}</span>`);
  }
}
const short = (x, n = 120) => { x = String(x ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n) + '…' : x; };
function resultLine(s) {
  const r = String(s.result || '');
  if (s.name === 'ExitPlanMode') return s.error ? 'Plan not approved' : 'You approved the plan';
  if (s.error) return esc(short(r.split('\n')[0] || 'Skipped', 160));
  // The result wraps the answers in instructions to Claude; keep only "question"="answer" pairs.
  const pairs = [...r.matchAll(/"([^"]+)"\s*=\s*"([^"]*)"/g)].map((m) => `${m[1]} → ${m[2]}`);
  return 'You answered: ' + esc(pairs.join(' · ') || short(r, 120));
}
const dur = (ms) => { const s = Math.max(1, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`; };
function summary(t) {
  const live = t === cur.turns.at(-1) && busy();
  const failed = t.steps.filter((s) => s.error).length;
  const ms = t.work;
  if (live || (!t.steps.length && !t.plan && !ms) || t.el.children.length < 3) { t.sum.hidden = true; return; }
  t.sum.hidden = false;
  const cost = costLine(t);
  t.sum.innerHTML = `<span class="g">✻</span><span>Worked for ${dur(ms)}</span>${t.steps.length ? `<span>· ${t.steps.length} step${t.steps.length === 1 ? '' : 's'}</span>` : ''}${failed ? `<span class="bad">· ${failed} failed</span>` : ''}${cost ? `<span>· ${cost}</span>` : ''}${t.steps.length ? `<span>·</span><button>View steps</button>` : ''}`;
  const btn = t.sum.querySelector('button'); if (btn) btn.onclick = () => showSteps(t);
}
// "25k tokens (+3.9M cached) · 5h +3%" — the turn-steps mod's cost line. Tokens = the turn's API calls
// (fresh input + cache writes + output; cache reads shown apart). 5h = the limit before vs after the
// turn, from claude-room's samples (whole percents; missing for turns before sampling began).
const kTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
function costLine(t) {
  const parts = [];
  if (t.use?.size) {
    let fresh = 0, cached = 0, out = 0;
    for (const u of t.use.values()) { fresh += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0); cached += u.cache_read_input_tokens || 0; out += u.output_tokens || 0; }
    parts.push(`${kTok(fresh + out)} tokens${cached ? ` (+${kTok(cached)} cached)` : ''}`);
  }
  const at = (ts) => { const x = +new Date(ts); let v = null; for (const s of cur.five || []) { if (s.t <= x) v = s; else break; } return v; };
  const a = t.start && at(t.start), b = t.end && at(t.end);
  if (a && b) parts.push(`5h +${a.resets === b.resets ? Math.max(0, b.pct - a.pct) : b.pct}%`);
  return parts.join(' · ');
}
function planUpdate(t, input) {
  if (Array.isArray(input.steps)) t.plan = { steps: input.steps, current: input.current ?? 0 };
  else if (t.plan && input.current != null) t.plan.current = input.current;
  if (t === cur.turns.at(-1) && cur.live) stepsBox(t);
}
// Same look as the turn-steps mod in the terminal: prompt + timer, "N of M steps" bar + %, a chip per
// step, and the step running now. A turn without a plan gets the box too (step count + running step).
// Once the turn ends the box stays, with − to shrink it to a pill and back, until the next prompt.
let boxTick = null;
// Background commands (run_in_background, or moved there after 2 minutes): Claude marks the room
// "shell" while one runs. Listed under the steps box until its task notice arrives or the room goes idle.
function bgNote(text) {
  const id = (text.match(/<task-id>([^<]+)<\/task-id>/) || [])[1];
  const st = (text.match(/<status>([^<]+)<\/status>/) || [])[1];
  if (id && st !== 'running' && cur.bg?.delete(id)) bgBox();
}
function bgBox() {
  const box = $('bgtasks'), list = [...(cur?.bg?.values() || [])];
  if (!list.length) { box.hidden = true; return; }
  const at = (b) => b.at ? `<span class="pr"> · since ${new Date(b.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>` : '';
  box.innerHTML = `<div class="bgh">⧗ ${list.length} running in the background</div>`
    + list.slice(-4).map((b) => `<div class="bgl">${esc(b.label)}${at(b)}</div>`).join('');
  box.hidden = false;
}
function stepsBox(t, ended = false) {
  const box = $('planbox');
  // One timer for the one box, whichever room drew it (a per-room timer kept ticking after a room switch).
  clearInterval(boxTick); boxTick = null;
  cur.boxEnded = ended;
  if (!t || (!t.plan && !t.steps.length)) { box.hidden = true; return; }
  const since = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };
  const secs = () => since(Date.now() - +new Date(t.start || Date.now()));
  box.hidden = false;
  if (ended && cur.boxMin) {
    box.className = 'planbox mini';
    box.innerHTML = `<button class="pshow">▸ Steps · ${t.steps.length}${t.plan ? ` · ${t.plan.steps.length}-step plan` : ''}</button>`;
    box.querySelector('.pshow').onclick = () => { cur.boxMin = false; stepsBox(t, true); };
    return;
  }
  const p = t.plan && (ended ? { ...t.plan, current: t.plan.steps.length } : t.plan);
  const run = !ended && [...t.steps].reverse().find((s) => s.result == null);
  const took = ended ? 'took ' + dur(t.work || (new Date(t.end) - new Date(t.start))) : secs();
  let html = `<div class="ph"><span class="pt">${ended ? '✓' : '✻'} ${esc(t.prompt || 'Working')}</span><span class="pe">${took}</span>`
    + (ended ? '<button class="pmin" title="Minimise" aria-label="Minimise">−</button>' : '') + '</div>';
  if (p) {
    const n = p.steps.length, done = Math.min(p.current, n), all = done >= n, pct = Math.round(done / n * 100);
    html += `<div class="pp"><span>${all ? '✓ All done' : `${done} of ${n} steps`}</span><span class="pbar"><i style="width:${pct}%"></i></span><b>${pct}%</b></div>`
      + `<ol>${p.steps.map((s, i) => { const k = i < p.current ? 'done' : i === p.current ? 'now' : 'todo';
        return `<li class="${k}"><i>${k === 'done' ? '✓' : k === 'now' ? '●' : '○'}</i><span class="pn">${esc(s)}</span><span class="chip"></span><span class="pl">${k === 'done' ? 'Done' : k === 'now' ? 'Working' : i === p.current + 1 ? 'Next' : 'Up next'}</span></li>`; }).join('')}</ol>`;
  } else {
    const n = t.steps.filter((s) => s.result != null).length;
    const sp = (k) => `${k} step${k === 1 ? '' : 's'}`;
    html += `<div class="pp"><span>${ended ? sp(t.steps.length) : `${sp(n)} done`}</span></div>`;
  }
  if (run) html += `<div class="prun"><i>●</i><b>${esc(run.name.replace(/^mcp__/, '').replace(/__/g, ' '))}</b><span class="pw">${esc(stepLine(run))}</span><span class="pr"></span></div>`;
  if (ended && t.steps.length) html += '<div class="pv"><button class="pview">View steps</button></div>';
  box.className = 'planbox' + (ended ? ' all' : '');
  box.innerHTML = html;
  if (ended) {
    box.querySelector('.pmin').onclick = () => { cur.boxMin = true; stepsBox(t, true); };
    const v = box.querySelector('.pview'); if (v) v.onclick = () => showSteps(t);
    return;
  }
  const tick = () => {
    const e = box.querySelector('.pe'); if (e) e.textContent = secs();
    const r = box.querySelector('.pr'); if (r && run?.at) r.textContent = since(Date.now() - run.at);
  };
  tick(); boxTick = setInterval(tick, 1000);
}

/* ===== View steps drawer ===== */
function stepBody(s) {
  const i = s.input || {}, pre = (x) => `<pre>${esc(x)}</pre>`;
  if (s.name === 'Bash') return (i.description ? `<div>${esc(i.description)}</div>` : '') + pre(i.command);
  if (s.name === 'Edit') return `<div class="mono">${esc(i.file_path)}</div>` + diff(i.old_string, i.new_string);
  if (s.name === 'MultiEdit') return `<div class="mono">${esc(i.file_path)}</div>` + (i.edits || []).map((e) => diff(e.old_string, e.new_string)).join('');
  if (s.name === 'Write') return `<div class="mono">${esc(i.file_path)}</div><details><summary>${(i.content || '').split('\n').length} lines</summary>${pre(i.content)}</details>`;
  if (s.name === 'Read') return `<div class="mono">${esc(i.file_path)}${i.offset ? ` · from ${i.offset}` : ''}</div>`;
  if (s.name === 'Grep' || s.name === 'Glob') return `<div class="mono">${esc(i.pattern)}${i.path ? ' in ' + esc(i.path) : ''}</div>`;
  return pre(JSON.stringify(i, null, 2));
}
function diff(a = '', b = '') {
  const l = (x, c, p) => x.split('\n').map((y) => `<span class="${c}">${p} ${esc(y)}</span>`).join('');
  return `<pre class="diff">${l(a, 'del', '-')}${l(b, 'add', '+')}</pre>`;
}
// One line per step (number · tool · what · status); tap a line to open its command/diff/output.
function stepLine(s) {
  const i = s.input || {}, f = (p) => String(p || '').replace(/^\/(?:root|home\/[^/]+|Users\/[^/]+)\//, '~/');
  const what = s.name === 'Bash' ? (i.description || i.command) : i.file_path ? f(i.file_path) : i.pattern || i.url || i.query || i.description || i.skill || '';
  return short(what, 140);
}
function showSteps(t) {
  $('dbody').innerHTML = `<div class="dsum">${esc(t.steps.length)} steps${t.steps.some((s) => s.error) ? ` · <span class="bad">${t.steps.filter((s) => s.error).length} failed</span>` : ''}</div>` + (t.steps.map((s, k) => `<details class="step ${s.error ? 'err' : ''}"${s.error ? ' open' : ''}>
    <summary><span class="t">${k + 1}</span><b>${esc(s.name.replace(/^mcp__/, '').replace(/__/g, ' '))}</b><span class="w">${esc(stepLine(s))}</span>
    <span class="x ${s.error ? 'bad' : s.result == null ? '' : 'ok'}">${s.error ? 'failed' : s.result == null ? '…' : '✓'}</span></summary>
    <div class="sd">${stepBody(s)}${s.result != null ? `<pre>${esc(s.result.slice(0, 8000))}</pre>` : ''}</div></details>`).join('') || '<div class="note">No steps.</div>');
  $('drawer').hidden = false;
}
$('dclose').onclick = () => { $('drawer').hidden = true; };
$('drawer').onclick = (e) => { if (e.target === $('drawer')) $('drawer').hidden = true; };

/* ===== open / close ===== */
let atBottom = true;
// Copy what Claude gives you to run: the Copy button on a code block, or a tap on `inline code`.
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  const a = Object.assign(document.createElement('textarea'), { value: t }); a.setAttribute('readonly', ''); a.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(a); a.select(); let ok = false; try { ok = document.execCommand('copy'); } catch {} a.remove(); return ok;
}
feed.addEventListener('click', async (e) => {
  if (e.target.closest('a')) return; // a link opens; it never copies
  const btn = e.target.closest('.cpy'), ic = !btn && e.target.closest('.ai code');
  const el = btn || (ic && !ic.closest('pre') ? ic : null);
  if (!el || window.getSelection()?.toString()) return;
  // "! cmd" is how Claude says "run this yourself"; the user pastes into a real terminal, so copy drops the "! ".
  const ok = await copyText((btn ? btn.parentElement.querySelector('code') : el).textContent.replace(/\n$/, '').replace(/^! (?=\S)/gm, ''));
  el.classList.add(ok ? 'copied' : 'nocopy');
  if (btn) btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
  setTimeout(() => { el.classList.remove('copied', 'nocopy'); if (btn) btn.textContent = 'Copy'; }, 1500);
});
feed.addEventListener('scroll', () => { atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80; });
// Phone: while a finger is on the feed (and while it coasts after), never pull it back to the bottom.
let touching = false, coastTill = 0;
feed.addEventListener('touchstart', () => { touching = true; }, { passive: true });
feed.addEventListener('touchend', () => { touching = false; coastTill = Date.now() + 700; }, { passive: true });
feed.addEventListener('touchcancel', () => { touching = false; }, { passive: true });
// Your message just went in and Claude hasn't replied yet: keep the room a reply will take under it
// straight away, so it doesn't sit on the bottom edge and jump when the answer lands.
function awaiting() {
  const t = cur?.turns.at(-1);
  // Also for a few seconds after sending: the row is recorded before the tab reports busy.
  const fresh = Date.now() - (cur?.sentAt || 0) < 8000;
  const wait = !!cur && (!!cur.pending || (!!t && (busy() || fresh) && !!t.el.querySelector('.u') && !t.el.querySelector('.a')));
  feed.classList.toggle('awaiting', wait);
  // The spinner line sits in the dock; until Claude's own spinner shows, hold its place so the
  // just-sent message doesn't float above an empty gap and then drop when "Brewing…" lands.
  const sp = cur?.pane?.spinner || (wait && !cur?.pane?.dialog ? '✢ Working…' : '');
  $('spin').textContent = sp; $('spin').hidden = !sp;
}
function stick() { awaiting(); if (atBottom && !touching && Date.now() > coastTill) feed.scrollTop = feed.scrollHeight; }
// Late growth (web fonts landing, a tool row opening) must not leave the newest line hidden.
const grower = new ResizeObserver(() => stick());
// The dock growing (spinner line, a longer draft, a wrapped footer) shrinks the feed: stay on the newest line.
grower.observe(feed);
document.fonts?.ready.then(() => stick());

function closeRoom() {
  cur?.es?.close(); cur = null;
  app.classList.remove('inroom');
  $('cname').textContent = 'Pick a room'; $('cstate').textContent = ''; $('cbtns').innerHTML = '';
  feed.innerHTML = '<div class="empty">Pick a room on the left, or start a new tab.</div>';
  $('hoff').hidden = $('composer').hidden = $('foot').hidden = $('planbox').hidden = $('spin').hidden = $('chips').hidden = true; $('cards').innerHTML = $('closecard').innerHTML = '';
  setTitle('Claude Rooms');
  loadRooms();
}

async function openRoom(id) {
  saveDraft();
  cur?.es?.close();
  if (!rooms.find((r) => r.id === id)) await loadRooms();
  const info = rooms.find((r) => r.id === id);
  if (!info) { feed.innerHTML = '<div class="empty">That room is gone.</div>'; return; }
  const me = cur = { id, name: info.name, turns: [], seen: new Set(), pane: { status: info.state }, live: true, limit: 150, buffer: [], ready: false };
  app.classList.add('inroom');
  $('cards').innerHTML = $('closecard').innerHTML = ''; $('planbox').hidden = true; $('hoff').hidden = true; clearInterval(boxTick); $('bgtasks').hidden = true; $('foot').hidden = true; $('spin').hidden = true; $('composer').hidden = false;
  header(); loadRooms(); loadDraft(); chips(info.assistant); assistantRoom = !!info.assistant; $('slashbtn').hidden = assistantRoom; closeCmds(); if (!assistantRoom) loadCmds();
  // Listen first, then load history, then apply whatever arrived meanwhile (deduped by uuid).
  listen(me);
  await loadHistory();
}
// Live stream. A server restart answers the reconnect with a 502 from the reverse proxy, and EventSource then gives up for good,
// so reopen it ourselves and reload the history (messages from the gap are in the transcript).
function listen(me) {
  me.es = new EventSource(`api/rooms/${encodeURIComponent(me.id)}/events`);
  me.es.onerror = () => {
    if (me.es.readyState !== EventSource.CLOSED || cur !== me) return;
    setTimeout(() => { if (cur !== me) return; listen(me); loadHistory(); }, 2000);
  };
  me.es.addEventListener('msg', (e) => { if (cur !== me) return; const m = JSON.parse(e.data); me.ready ? (msg(m), stick()) : me.buffer.push(m); });
  me.es.addEventListener('pane', (e) => cur === me && onPane(JSON.parse(e.data).pane));
  me.es.addEventListener('session', () => cur === me && loadHistory());
  me.es.addEventListener('five', (e) => { if (cur !== me) return; (me.five ||= []).push(JSON.parse(e.data).sample); const t = me.turns.at(-1); if (t) summary(t); });
}

async function loadHistory() {
  const me = cur;
  me.ready = false;
  let h;
  try { h = await api(`rooms/${enc()}/history?limit=${me.limit}`); } catch { feed.innerHTML = '<div class="empty">No conversation yet. Say hello.</div>'; me.ready = true; return; }
  if (cur !== me) return;
  feed.innerHTML = ''; me.turns = []; me.seen = new Set(); me.dialogKey = undefined; me.lastDay = undefined;
  // A reload (reconnect after the phone slept, new session) wipes the feed: keep the "sending" message
  // through it unless the history already has it, or it vanishes until a manual refresh.
  const pend = me.pending; me.pending = null; me.said = [];
  if (h.more) {
    const b = document.createElement('button'); b.className = 'btn more'; b.textContent = 'Load earlier';
    b.onclick = () => { me.limit += 150; atBottom = false; loadHistory(); };
    feed.appendChild(b);
  }
  me.live = false;
  me.five = h.five || [];
  for (const m of h.messages) msg({ uuid: m.uuid, role: m.type, content: m.message.content, ts: m.ts, compact: m.compact, mid: m.message.id, usage: m.message.usage, queued: m.queued });
  me.live = true;
  // Uploads add their paths after the text, so match the start; a pictures-only send matches by time instead.
  const pt = pend?.dataset.text;
  const got = pend && me.said.some(([x, at]) => (pt ? x.startsWith(pt) : at >= (me.sentAt || 0) - 60e3));
  me.said = null;
  if (pend && !got && Date.now() - (me.sentAt || 0) < 10 * 60e3) { feed.appendChild(pend); me.pending = pend; }
  for (const m of me.buffer.splice(0)) msg(m);
  me.ready = true;
  if (!feed.children.length) feed.innerHTML = '<div class="empty">No conversation yet. Say hello.</div>';
  const last = me.turns.at(-1);
  if (last) stepsBox(last, !busy());
  if (me.pane) onPane(me.pane);
  atBottom = true; stick();
}

/* ===== composer ===== */
let pics = [];
const box = $('msg');
// Each room keeps its own unsent text (and pictures) — switching rooms never carries a draft over.
const drafts = (() => { try { return JSON.parse(localStorage.getItem('cr-drafts') || '{}'); } catch { return {}; } })();
const draftPics = {};
function storeDrafts() { try { localStorage.setItem('cr-drafts', JSON.stringify(drafts)); } catch {} }
function saveDraft() {
  if (!cur) return;
  if (box.value) drafts[cur.id] = box.value; else delete drafts[cur.id];
  if (pics.length) draftPics[cur.id] = pics; else delete draftPics[cur.id];
  storeDrafts();
}
function loadDraft() { box.value = drafts[cur.id] || ''; pics = draftPics[cur.id] || []; thumbs(); grow(); }
box.addEventListener('input', () => { if (cur) { if (box.value) drafts[cur.id] = box.value; else delete drafts[cur.id]; storeDrafts(); } });
// Measure a hidden twin, never the box itself: collapsing the real box to measure it made the feed
// clamp its scroll and, on iPhone, the page jump to chase the caret on every key.
const twin = document.createElement('textarea');
twin.setAttribute('aria-hidden', 'true'); twin.tabIndex = -1; twin.rows = 1;
function grow() {
  if (!twin.isConnected) box.after(twin);
  twin.className = box.className + ' twin'; twin.style.width = box.offsetWidth + 'px'; twin.value = box.value;
  const h = Math.min(twin.scrollHeight, 180) + 'px';
  if (box.style.height !== h) box.style.height = h;
}
box.addEventListener('input', grow);
box.addEventListener('keydown', (e) => {
  if (sugKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && matchMedia('(hover:hover)').matches) { e.preventDefault(); $('composer').requestSubmit(); }
});
box.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])].filter((x) => x.type.startsWith('image/')); if (f.length) { e.preventDefault(); addPics(f); } });
$('file').onchange = (e) => { addPics([...e.target.files]); e.target.value = ''; };
// Drag files anywhere onto the window, like claude.ai: a drop zone shows while dragging, letting go attaches them.
let dragN = 0;
const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (!isFiles(e)) return; e.preventDefault(); if (cur && dragN++ === 0) document.body.classList.add('dropping'); });
addEventListener('dragover', (e) => { if (!isFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = cur ? 'copy' : 'none'; });
addEventListener('dragleave', (e) => { if (isFiles(e) && --dragN <= 0) { dragN = 0; document.body.classList.remove('dropping'); } });
addEventListener('drop', (e) => {
  if (!isFiles(e)) return;
  e.preventDefault(); dragN = 0; document.body.classList.remove('dropping');
  const f = [...e.dataTransfer.files];
  if (cur && f.length) { addPics(f); box.focus(); }
});
// Phone photos are huge: scale to 1600px JPEG before upload (saved on the host, path given to Claude).
// Anything else (pdf, md, docx…) goes up as-is; Claude gets its path and reads it.
// iPhone HEIC: only Safari decodes it, so other browsers convert it to JPEG first (decoder loaded on first use).
const isHeic = (f) => /image\/hei[cf]/.test(f.type) || /\.hei[cf]$/i.test(f.name);
let heicLib;
const heicToJpeg = async (f) => {
  heicLib ||= new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/heic-to@1.6.5/dist/iife/heic-to.js'; s.onload = () => ok(window.HeicTo); s.onerror = () => { heicLib = null; no(new Error('HEIC decoder failed to load')); }; document.head.append(s); });
  return (await heicLib)({ blob: f, type: 'image/jpeg', quality: 0.9 });
};
let attachErr = '';
async function addPics(files) {
  attachErr = '';
  for (const f of files) try { await addPic(f); } catch (e) { console.error(e); attachErr = `Couldn't attach ${f.name}: ${e.message || e}`; }
  thumbs();
}
async function addPic(f) {
  if ((!f.type.startsWith('image/') || f.type === 'image/svg+xml') && !isHeic(f)) {
    const url = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); });
    pics.push({ doc: true, name: f.name, type: f.type || 'application/octet-stream', data: url.split(',')[1] });
    return;
  }
  let img;
  try { img = await createImageBitmap(f); } catch (e) { if (!isHeic(f)) throw e; img = await createImageBitmap(await heicToJpeg(f)); }
  const k = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.85);
  pics.push({ url, type: 'image/jpeg', data: url.split(',')[1] });
}
function thumbs() {
  $('thumbs').innerHTML = pics.map((p, i) => `<span>${p.doc ? `<b class="doc">📄 ${esc(p.name)}</b>` : `<img src="${p.url}" alt="">`}<button type="button" onclick="dropPic(${i})">×</button></span>`).join('') + (attachErr ? `<em class="attach-err">${esc(attachErr)}</em>` : '');
}
window.dropPic = (i) => { pics.splice(i, 1); thumbs(); };
$('composer').onsubmit = async (e) => {
  e.preventDefault();
  if (!cur) return;
  const text = box.value.trim();
  if (!text && !pics.length) return;
  const images = pics.map(({ type, data, doc, name }) => ({ type, data, doc, name }));
  box.value = ''; pics = []; thumbs(); grow(); atBottom = true;
  delete drafts[cur.id]; delete draftPics[cur.id]; storeDrafts();
  // Fly the message up from the box straight away; the real row replaces it when the tab records it.
  cur.pending?.remove();
  cur.sentAt = Date.now();
  const pend = cur.pending = document.createElement('div');
  pend.className = 'u sending';
  pend.dataset.text = text;
  pend.innerHTML = `<span class="g">❯</span><div>${images.length ? `<span class="img">${images.some((x) => x.doc) ? '📎' : '🖼'} ${images.length}</span>` : ''}${esc(text)}</div>`;
  feed.appendChild(pend); stick();
  try { await api(`rooms/${enc()}/send`, { text, images, device: deviceName() }); } catch (err) { pend.remove(); if (cur.pending === pend) cur.pending = null; fail(err); box.value = text; }
};

// A picker Claude draws without numbers (/resume, /config, /permissions): show the screen, drive it with keys.
function screenCard(d, box) {
  const K = [['Up', '↑'], ['Down', '↓'], ...(d.tabs?.length ? [['Left', '←'], ['Right', '→']] : []), ['Space', 'Space'], ['Enter', '⏎ Select']];
  box.innerHTML = `<div class="card dlg screen"><div class="body">${d.head.map((l) => `<div class="hl">${ansi(l) || '&nbsp;'}</div>`).join('')}</div>
    <div class="acts keys">${K.map(([k, l]) => `<button class="btn${k === 'Enter' ? ' pri' : ''}" data-key="${k}">${l}</button>`).join('')}<button class="btn" data-key="Escape">Esc</button></div></div>`;
  $('dock').classList.remove('sheet');
  box.querySelectorAll('[data-key]').forEach((b) => b.onclick = () => api(`rooms/${enc()}/key`, { key: b.dataset.key }).catch(fail));
  stick();
}

/* ===== "/" commands: button sheet + type-ahead (not in the assistant's room) ===== */
let cmds = [], cmdsAt = 0, assistantRoom = false, sugAt = -1, sugList = [];
const CMD_GROUPS = [['Common', 'Common'], ['More', 'More'], ['Yours', 'Your skills']];
async function loadCmds() {
  if (Date.now() - cmdsAt < 60_000) return cmds;
  try { cmds = await api('commands'); cmdsAt = Date.now(); } catch {}
  return cmds;
}
function matchCmds(q) {
  q = q.toLowerCase();
  if (!q) return cmds;
  const pre = cmds.filter((c) => c.name.startsWith(q)), sub = cmds.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || c.desc.toLowerCase().includes(q)));
  return [...pre, ...sub];
}
const cmdRow = (c, k, on) => `<button type="button" class="cmdrow${on ? ' on' : ''}" data-k="${k}"><b>/${esc(c.name)}${c.hint ? ` <i>${esc(c.hint)}</i>` : ''}</b><span>${esc(c.desc)}</span></button>`;
function drawSheet() {
  const q = $('cmdq').value.trim().replace(/^\//, ''), list = matchCmds(q);
  $('cmdrows').innerHTML = (q
    ? list.map((c) => cmdRow(c, cmds.indexOf(c))).join('')
    : CMD_GROUPS.map(([g, label]) => { const r = list.filter((c) => c.group === g); return r.length ? `<div class="popl">${label}</div>` + r.map((c) => cmdRow(c, cmds.indexOf(c))).join('') : ''; }).join(''))
    || '<div class="cmdnone">No command matches.</div>';
}
function closeCmds() { $('cmdsheet').hidden = true; $('cmdsug').hidden = true; sugAt = -1; }
$('slashbtn').onclick = async (e) => {
  e.stopPropagation();
  if (!$('cmdsheet').hidden) return closeCmds();
  closeCmds(); $('cmdq').value = ''; drawSheet(); $('cmdsheet').hidden = false; // show at once; redraw if the list was stale
  if (Date.now() - cmdsAt >= 60_000) { await loadCmds(); if (!$('cmdsheet').hidden) drawSheet(); }
  if (matchMedia('(hover:hover)').matches) $('cmdq').focus(); // phones: no keyboard until you tap the search box
};
$('cmdq').oninput = drawSheet;
$('cmdq').onkeydown = (e) => { if (e.key === 'Escape') closeCmds(); if (e.key === 'Enter') { e.preventDefault(); $('cmdrows').querySelector('.cmdrow')?.click(); } };
$('cmdsheet').onclick = (e) => { if (e.target === $('cmdsheet')) closeCmds(); }; // tap the backdrop (phone)
for (const id of ['cmdrows', 'cmdsug']) $(id).onclick = (e) => { const r = e.target.closest('.cmdrow'); if (r) runCmd(cmds[+r.dataset.k]); };
$('cmdsug').onmousedown = (e) => e.preventDefault(); // keep the box focused so blur doesn't close the list first
document.addEventListener('click', (e) => { if (!e.target.closest('#cmdsheet,#cmdsug,#slashbtn,#msg')) closeCmds(); });

// Tap: confirm-first ones ask in-page; ones that take text fill the box; the rest send now (same path as typing it).
function runCmd(c) {
  if (!c) return;
  closeCmds();
  const text = '/' + c.name;
  if (c.rename) { box.value = ''; grow(); return startRename(); }
  if (c.args) { box.value = text + ' '; box.dispatchEvent(new Event('input')); box.focus(); box.setSelectionRange(box.value.length, box.value.length); return; }
  if (c.confirm) {
    const body = c.name === 'clear' ? 'Start this chat fresh? Claude forgets the conversation so far; the old chat stays saved.' : `Run ${text} in this tab?`;
    box.value = ''; grow();
    return askConfirm(text, body, c.name === 'clear' ? 'Clear' : 'Run', () => api(`rooms/${enc()}/send`, { text, device: deviceName() }));
  }
  box.value = text; $('composer').requestSubmit();
}

// Type-ahead: while the box is just "/word", list matches above it (like Claude Code itself).
async function suggest() {
  const m = /^\/(\S*)$/.exec(box.value);
  if (!m || assistantRoom || !cur) { $('cmdsug').hidden = true; sugAt = -1; return; }
  await loadCmds();
  if (!/^\/\S*$/.test(box.value)) return; // typed on while loading
  sugList = matchCmds(m[1]).slice(0, 6);
  if (!sugList.length) { $('cmdsug').hidden = true; sugAt = -1; return; }
  sugAt = Math.min(Math.max(sugAt, 0), sugList.length - 1);
  $('cmdsheet').hidden = true;
  $('cmdsug').innerHTML = sugList.map((c, i) => cmdRow(c, cmds.indexOf(c), i === sugAt)).join('');
  $('cmdsug').hidden = false;
}
box.addEventListener('input', suggest);
box.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== box) { $('cmdsug').hidden = true; sugAt = -1; } }, 150));
// Keys while the list is open: ↑/↓ move, Tab/Enter pick, Esc closes. Returns true when it handled the key.
function sugKey(e) {
  if ($('cmdsug').hidden || !sugList.length) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sugAt = (sugAt + (e.key === 'ArrowDown' ? 1 : -1) + sugList.length) % sugList.length; suggest(); return true; }
  if (e.key === 'Escape') { e.preventDefault(); closeCmds(); return true; }
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && matchMedia('(hover:hover)').matches)) {
    const c = sugList[sugAt];
    // Tab completes the name (like Claude Code) without running it.
    if (e.key === 'Tab') { e.preventDefault(); box.value = '/' + c.name + (c.args ? ' ' : ''); grow(); closeCmds(); if (!c.args) suggest(); return true; }
    // Enter on an exact name just sends it as typed; otherwise pick the highlighted one.
    if (e.key === 'Enter' && box.value === '/' + c.name && !c.confirm && !c.args && !c.rename) { closeCmds(); return false; }
    e.preventDefault(); runCmd(c); return true;
  }
  return false;
}

loadRooms().then(route);

// iPhone keyboard: 100dvh ignores it, so iOS slides the whole page up to show the bar and the feed
// scrolls underneath. Fit the app to the space above the keyboard and keep the page itself still.
if (window.visualViewport && matchMedia('(pointer:coarse)').matches) {
  const vv = window.visualViewport;
  const fit = () => { document.documentElement.style.setProperty('--vvh', vv.height + 'px'); if (window.scrollY) window.scrollTo(0, 0); };
  vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
}
