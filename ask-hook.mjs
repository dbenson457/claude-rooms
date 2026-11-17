#!/usr/bin/env node
// PreToolUse hook (matcher AskUserQuestion, in ~/.claude/settings.json): saves the question Claude is
// about to ask, because the transcript only gets it after it's answered. The rooms page builds the
// question card from this instead of the screen, where previews are drawn in a box beside the options.
import fs from 'node:fs';
import os from 'node:os';
try {
  const h = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (h.tool_name === 'AskUserQuestion' && h.session_id) {
    const dir = `${process.env.ROOM_DATA || `${process.env.CLAUDE_HOME || `${os.homedir()}/.claude`}/room-data`}/ask`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/${h.session_id}.json`, JSON.stringify({ at: Date.now(), questions: h.tool_input?.questions || [] }));
  }
} catch {}
