# Agent-to-agent handoffs

Every room is its own Claude Code session. Sessions on the same machine can message each other: `ListAgents` lists the live ones and `SendMessage` delivers text to one by name. Claude Rooms adds a fixed **shape** to those messages, so a handoff can be recognised, shown as a card and tracked until it comes back.

## The format

The rule sits in the project instruction file (`CLAUDE.md`), so every session follows it.

**Passing work on** is one `SendMessage` whose text is exactly:

```
Handoff: <the task, one line>
From: <your room name> · <owner> asked: <their request, a few words>
Done: <what's finished, with files/paths>
Next: <what's left for them>
Send back: <what you need returned, or "nothing">
```

**Finishing a handoff you received** is a reply to the sender (`to` = the message's `from`):

```
Handoff done: <the same task line>
Result: <what you did / found>
Files: <paths, or "none">
```

Other rules that go with it:

- **The receiving room isn't running?** Run `room-wake <room name>`. It calls `POST /api/rooms/wake` (localhost only), which resumes the newest offline room with that name and returns once it is ready. Then send.
- **After any message from another agent**, the reply to the owner opens with who it was from (`**From reviewer:** …`), so it's always clear what started a turn.
- **Only real handoffs use the shape.** Never present the owner's own words as a handoff. Any other chat between agents is a normal message.
- **Never ask another room to do something your own session was refused.**

## How the page shows it

Incoming messages reach the session's transcript as a meta user line:

```
<cross-session-message from="uds:…" from-name="alpha" from-mode=…>
Handoff: …
</cross-session-message>
```

- **Transcript reading** (`mirror.js` `tailHistory`): meta lines are normally hidden, but ones that came from another agent are kept.
- **Chat cards** (`web/room.js`): a message from another agent is never drawn as the user's bubble. It gets a purple card, ↘ for in and ↗ for out, including the room's own outgoing `SendMessage` calls. A handoff lays out its fields (From / Done / Next / Send back). Replies are addressed to a socket address, which the page maps back to a room name.
- **Open handoff banner**: while a room holds a handoff it hasn't answered, a bar over the composer shows the task with *Open*, *Send result back* and *Mark done*.
- **Room list tag** (`server.js` `replyAt`): the server scans the end of each transcript (cached by file mtime) for a `Handoff:` received with no `Handoff done:` sent after it, and returns it with the room. The sidebar tags that room.

## Tested end to end

On the test copy: room *alpha* found that *beta* was offline, woke it with `room-wake`, handed off a task, and got the result back in about 24 seconds. Both sides showed the right cards. The test rooms were removed afterwards.
