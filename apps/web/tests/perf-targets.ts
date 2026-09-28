import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

// The page types the performance and accessibility checks visit, with the data
// they need. On the isolated QA stack the Work page seed provides a public
// Work with chapters and a Realm; the first spec to ask seeds it and the
// others reuse it. Against another stack, REZICS_PAGE_TARGETS names existing
// data as JSON: {"work":"<uuid>","chapter":"<uuid>","realm":"<segment>","profile":"<handle>"}.

export interface PageTargets {
  work: string;
  chapter: string;
  /** A Realm's route segment or ID. */
  realm: string;
  /** A handle without the @. */
  profile: string;
}

const uuid = (iri: string) => iri.slice(-36);

function sessionAgent(): string | null {
  const path = process.env.REZICS_WEB_AUTH_PUBLIC_PATH;
  return path && existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as { actingSubject: string }).actingSubject : null;
}

/** The signed-in member of the QA web-auth fixture, or of REZICS_WEB_AUTH_PRIVATE_PATH elsewhere. */
export function member(): { email: string; password: string } | null {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  return path && existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as { member: { email: string; password: string } }).member : null;
}

/** Sign in at Accounts. A loaded host can take longer than the helper's five seconds to finish the callback,
 * so a slow return to `next` is waited out rather than failed. */
export async function signIn(page: Page, next: string, account: { email: string; password: string }) {
  await signInAtAccounts(page, next, account).catch(async () => {
    await page.waitForURL(url => url.pathname === next, { timeout: 60_000 });
  });
}

async function settled(work: string) {
  // Main keeps processing the seed's events for a while (409 on reads); start once its position holds still.
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${uuid(work)}`;
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main).catch(() => null);
    const position = response?.ok
      ? JSON.stringify((await response.json() as { sourcePosition: unknown }).sourcePosition) : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise(done => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for a minute after the seed');
}

export async function pageTargets(): Promise<PageTargets> {
  if (process.env.REZICS_PAGE_TARGETS) return JSON.parse(process.env.REZICS_PAGE_TARGETS) as PageTargets;
  const runId = process.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Set REZICS_PAGE_TARGETS outside an isolated QA run');
  const cache = join(tmpdir(), `rezics-page-targets-${runId}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8')) as PageTargets;
  const result = spawnSync('bun', ['apps/web/tests/work-page-seed.ts'], { cwd: process.cwd(), env: process.env,
    encoding: 'utf8', timeout: 90_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`Work page seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  const seed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { work: string; realm: string; chapters: string[] };
  await settled(seed.work);
  const agent = sessionAgent();
  if (!agent) throw new Error('The QA web-auth fixture names no session Agent');
  const targets = { work: uuid(seed.work), chapter: uuid(seed.chapters[0]!), realm: uuid(seed.realm),
    profile: `agent-${uuid(agent)}` };
  writeFileSync(cache, JSON.stringify(targets));
  return targets;
}
