# How changes were tested, reviewed and shipped

## The loop

1. **Plan.** Anything bigger than a fix starts as a written plan, approved before code. UI choices are shown as real mock pages, not described.
2. **Build** in the working copy. Comments explain *why*, often with the date and the report behind them.
3. **Test on a separate copy.** One sweep at the end, not after every edit.
4. **Look at it in a real browser** at 1280, 1920 and 390 wide.
5. **Owner review** on a phone and a desktop. Corrections come back item by item.
6. **Ship.** Front-end files go live with a cache-busting `?v=` bump and no restart. Server changes wait for the owner's go.
7. **Commit** with a short message once approved.

## The test copy (:4631)

The live rooms server keeps tabs that people are using, so tests never touch it. A second copy runs beside it:

```sh
ROOM_TEST=1 ROOM_PORT=4631 ROOM_DATA=/tmp/rooms-test node server.js   # or: npm run test-copy
```

- `ROOM_TEST=1` turns off the usage sampler, so the test copy writes nothing shared.
- `ROOM_DATA` gives it its own offline list and `live.json`, so reboot-restore and Wake are tested on data the live copy never reads.
- Tests only drive **throwaway tabs named `zz-*`**, made with `POST /api/rooms/new {"name":"zz-…"}` and closed afterwards. Reboot restore skips `zz-*` on purpose.

## The tests/ scripts

These are Playwright scripts that drive the real page against real Claude tabs. They print `PASS`/`FAIL` lines and save screenshots to `screenshots/`.

| Script | What it checks |
|---|---|
| `commands.mjs` | "/" sheet and type-ahead at phone and desktop sizes, Tab completion, in-page confirm, picker cards, no sideways overflow, no console errors; the assistant room has no "/" button (39 checks) |
| `flow.mjs` | Question cards built from the real question: previews under options, multi-select ticks → review → submit; box diagrams and file trees in replies keep their shape and never wrap |
| `ask-flow.mjs` | A multi-tab question walked forward and back; checks the terminal's own screen agrees after each tap |
| `ask-chat.mjs` / `ask-tick.mjs` | The same at 390 px with touch: type-your-own answers, ticks, review screen |
| `space.mjs` | Spacing between messages before, during and after a turn (before/after shots for a layout fix) |

Run one against the test copy:

```sh
npm i -D playwright && npx playwright install chromium
ROOM_URL=http://localhost:4631 node tests/commands.mjs
```

Some scripts need a waiting question in a `zz-q` tab first. Their header comments say what they expect.

**A pass is not proof.** The scripts catch regressions. The owner still reviews every screen by eye.

## Changing a live service safely

- **Back up before changing.** Each edit to a live file left a dated backup (`*.bak-<feature>`) until it was approved and committed. Backups are left out of this repo.
- **Client-only changes need no restart.** `web/` is served with `Cache-Control: no-cache` and versioned `?v=` URLs.
- **Server changes**: ask first, pick a quiet moment, and check that every room survived the restart.
- **Verify before moving on**: service up, page loads, rooms listed, then report.

## Code style

- Plain Node (ES modules) and plain browser JS, no build step, one dependency (Express).
- Small files by job: `tmux.js` (tabs ↔ sessions), `mirror.js` (read screen + transcript, type into the tab), `offline.js` (park/wake/restore), `five.js` (usage samples), `commands.js` ("/" list), `server.js` (HTTP + SSE).
- Shared work is cached briefly: one `tmux list-panes` and one `ps` cover every tab for 1.5 s, and transcript scans are cached by mtime, so many open phones don't each spawn processes.
- Files are written atomically (temp file + rename), so a crash never leaves half a JSON file.
