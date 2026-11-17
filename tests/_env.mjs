// Shared by the e2e scripts: which copy to drive and where screenshots go.
// Run them against a test copy (npm run test-copy), never the copy you are using.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

export { chromium };
export const BASE = process.env.ROOM_URL || 'http://localhost:4631';
// Optional: a Chromium build of your own instead of Playwright's download.
export const exe = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
export const shots = (name) => { const d = `${process.env.SHOTS || 'screenshots'}/${name}`; mkdirSync(d, { recursive: true }); return d; };
