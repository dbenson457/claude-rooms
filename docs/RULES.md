# The rules Claude worked to

Claude Rooms was built by Claude Code, working in a terminal on a home server that also runs live services people use every day. Its instructions lived in two places:

- **A project instruction file** (`CLAUDE.md`), loaded at the start of every session: what runs where, which actions are dangerous, how to hand work between sessions.
- **A memory folder**: one small file per lesson, each with a **Why** (the incident that caused it) and a **How to apply**. An index of one-line pointers is loaded every session. When a correction came up, Claude wrote it down there so the next session would follow it too.

Below are the rules that shaped this project, with server details and personal content taken out. Most of them were written after something went wrong.

## Safety first

1. **Think through side effects before acting.** Before a restart, delete, update or overwrite, ask "what does this break or interrupt?" Several early incidents (a restart during an import, a folder nearly deleted mid-session) came from acting first.
2. **Confirm destructive actions.** Before any delete, `rm -rf`, stack removal or overwrite, say exactly what will be destroyed and wait for a yes.
3. **Never restart a live service mid-task.** Check whether it is importing, downloading or processing first. If it is, wait, or warn and get a go-ahead.
4. **Never restart the rooms server on your own.** The tmux server that holds every Claude tab once lived inside the rooms service's cgroup, so a restart killed every room mid-turn, including the one doing the restart. That was fixed (`KillMode=process`), but the rule stayed: server-side changes wait for a moment the owner says is free. Front-end changes need no restart, so prefer them.
5. **Back up a database before editing it directly**, and use SQLite's `.backup`, not `cp`. A WAL-mode database copied with `cp` silently loses recent commits.
6. **Diagnose, don't panic.** A number that looks wrong (0 MB/s, 100% load) may be normal. Find the cause before changing config. After a network change, wait 60–90 s before calling it broken.
7. **Research before claiming.** Never state that a feature, flag or menu exists from memory. Check the docs or the source first.
8. **Nothing goes out without a final "send".** Emails and messages are shown as a draft. Phrases like "format it" or "reply with this" still mean draft. Only the word "send" sends.

## Testing

9. **Test on a separate copy, never the one in use.** The rooms server has a test mode (`ROOM_TEST=1 ROOM_PORT=4631`, its own `ROOM_DATA`) and the e2e scripts only drive throwaway tabs named `zz-*`. A test must never type into a room someone is reading.
10. **Tests own their data.** Never point a dev server or browser script at another suite's fixtures or at live data. A poisoned fixture looks like a code regression.
11. **One test sweep at the end, not one per edit.** Make the whole change, then run the one or two scripts that cover it. The owner judges a change by how long it takes to reach them.
12. **A passing script is not proof.** UI work counts as done only after it has been looked at in a real browser at desktop (1280, 1920) and phone (390) widths, and the owner has done the visual review.
13. **No heavy jobs on a shared box without asking.** Anything using several cores for more than ~30 s gets an OK first. Look for the one-second version of the test.

## Code and UI

14. **Change only what was asked.** Check the narrow-screen media query and any other page that shares the class before calling a style change done.
15. **No browser dialogs.** `confirm()`/`alert()`/`prompt()` drop a full-screen or home-screen app out of full screen. Use the in-page confirm card (`askConfirm` in `web/room.js`).
16. **Cut code on function boundaries.** Never edit by slicing between two text markers. That once deleted five methods at once. Find the function's own start and end, or restore from git.
17. **Persistent things live in proper places.** Services and scripts never live in `/tmp`.
18. **Kill processes precisely.** `pkill -f pattern` can match the agent's own shell. Anchor the pattern (`pgrep -f '^node server.js'`) and `kill` the pid.
19. **Match the surrounding code.** Same comment density, naming and idiom. Comments say *why*, often with the date and the report that caused them.

## Git

20. **Short commit messages, no AI signature lines.**
21. **Branch from a freshly fetched default branch**, and check a PR's file count before calling it done.

## Working style

22. **Be concise.** Short answers, no running commentary.
23. **Long sessions hand over cleanly.** When a session gets long, write the live state into the project memory file and start fresh, rather than relying on automatic summaries.
24. **Use a visible plan for anything with three or more steps**, and keep it updated, so progress can be followed at a glance.
