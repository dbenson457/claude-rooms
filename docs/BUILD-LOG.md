# Build log

A short history, written from the notes Claude kept while building. All of it was built by Claude Code sessions, with the owner choosing direction and reviewing each step on a phone and a desktop.

**2026-10-12 · The idea.** The goal was to use Claude Code from a phone without a browser terminal: chat rooms like Claude on the web, one per terminal tab. A plan was written and approved first.

**2026-10-13 · Spike, then a first backend.** A spike proved that a tmux tab can be matched to its Claude session through the CLI's own session files. The first backend used the Agent SDK to "take over" a session and "hand it back" to the terminal. A chat page followed the same day: rooms sidebar, composer with image upload, question/plan/permission cards and a "View steps" drawer.

**2026-10-13 · Rebuilt as mirror mode.** The owner wanted the terminal and the page open together, typing on either. The SDK engine was removed. Instead the tab keeps running, the server tails the session transcript for messages, and it reads the tmux screen every second for what only the screen shows: dialogs and their numbered options, the spinner and the mode. Input is pasted into the pane, exactly as a person at the keyboard would type it. The feed was restyled to look like the terminal, and tool calls were folded into each turn's steps instead of filling the chat.

**2026-10-13 · Pinned assistant room.** One room was pinned with its own system prompt, settings and quick questions. It started on demand, and the home dashboard could call it.

**2026-10-14 · "/" commands.** A commands button and type-ahead were added: curated built-ins plus the user's own skills and plugin commands, read from disk. Pickers with no numbers became cards with arrow-key buttons.

**2026-10-15 to 19 · Turn steps, Stop, timestamps.** Every turn got a steps box. Stop now also ends background commands (each one runs in its own process session, so a group kill missed some). Messages got timestamps and day dividers.

**2026-10-19 · An outage and two fixes.** Restarting the rooms service killed every Claude tab, because the tmux server lived in the service's cgroup. Fixed with `KillMode=process`, and a standing rule was added never to restart it without asking. Detached tabs were also only 80 columns wide, which cut off status lines, so they are now kept at 260×50.

**2026-10-29 · Offline and Wake.** Closing a room now parks it as **Offline** instead of losing it. Tapping it **wakes** it: `claude --resume <session>` in a new tab, in its own folder, with the flags it started with. Tapping ✕ twice forgets it (the transcript is never deleted). Closing a busy room needs an in-page confirm. Files can be dropped onto the window to attach them.

**2026-10-30 · Reboot restore.** "Rooms never come back by themselves." The server now saves the open rooms every 30 s (`live.json`, written atomically). On start it resumes each one that isn't running, one at a time, with the same chat, flags and folder. This was proven first on the :4631 test copy with its own data folder.

**2026-10-30 to 31 · Phone polish.** A sent message no longer vanishes on reconnect. The chat no longer jumps while you type a long draft. The layout follows the on-screen keyboard. Fonts load their full weight ranges.

**2026-11-17 · Unread badges.** The first version guessed "new" from busy→idle changes in each browser. It blinked, and missed rooms that finished while the page was closed. It was rebuilt on the server: `replyAt` is the time of the newest assistant message in the transcript, and the page compares it with when you last looked at that room. The result is a steady **New** pill, a count in the tab title and a badge on the phone's back button. Checked end to end on the test copy (shows, stays steady, survives a reload, clears on open).

**2026-11-17 · Handoffs.** Sessions can pass work to each other in a fixed shape that the page draws as cards. Offline rooms can be woken by name for a handoff (`room-wake`). See [HANDOFFS.md](HANDOFFS.md).

**2026-11-17 · Catching up with the CLI.** A new model was added to the menu, along with new built-in commands. A new "resume this conversation?" dialog shows as a normal card.
