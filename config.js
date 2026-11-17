/* Settings, all from the environment (see .env.example). Defaults run a single local copy:
 * listen on localhost only, read Claude Code's files from ~/.claude.
 */
import { homedir } from 'node:os';

// A .env next to server.js, if there is one (Node 20.12+). Real environment variables win.
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}

const list = (v, d) => (v || d).split(',').map((s) => s.trim()).filter(Boolean);

export const HOME = process.env.HOME || homedir();
export const CLAUDE_HOME = process.env.CLAUDE_HOME || `${HOME}/.claude`;
export const DATA = process.env.ROOM_DATA || `${CLAUDE_HOME}/room-data`;
export const PORT = Number(process.env.ROOM_PORT) || 4630; // a test copy runs on another port (4631)
// Addresses to listen on, and the only client IPs answered (e.g. a reverse proxy in front).
export const HOSTS = list(process.env.ROOM_HOSTS, '127.0.0.1');
export const ALLOW = new Set(list(process.env.ROOM_ALLOW, '127.0.0.1'));
// Folder new tabs start in.
export const CWD = process.env.ROOM_CWD || HOME;
// tmux tabs that are never shown as rooms (e.g. a bot running Claude in the background).
export const SKIP = new Set(list(process.env.ROOM_SKIP, ''));
// Optional: a dashboard that frames the rooms page (?embed=1) and may call the API cross-origin.
export const HOME_ORIGIN = process.env.ROOM_HOME_ORIGIN || '';
// Optional: links shown in the page — a web terminal, and this page's own public address.
export const TERM_URL = process.env.ROOM_TERM_URL || '';
export const SELF_URL = process.env.ROOM_SELF_URL || '';
// The pinned assistant room: extra claude flags, e.g. its own system prompt and settings file.
export const ASSISTANT_ARGS = process.env.ROOM_ASSISTANT_ARGS || '--permission-mode auto';
