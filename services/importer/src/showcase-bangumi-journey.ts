/** Run the selected archive journey on an approved stack host, retaining only public evidence. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { CrossMediaSeedReport } from './cross-media-seed.ts';

const root = resolve(import.meta.dir, '../../..');
const evidence = resolve(root, '.temp/anime-journey');
const privateLogs = resolve(root, '.temp/anime-stack');
const env = {
  ...process.env,
  KERNEL_DATABASE_CONTAINER: 'rezics-anime-journey',
  KERNEL_DATABASE_VOLUME: 'rezics-anime-journey',
  KERNEL_DATABASE_PORT: '15439',
  KERNEL_SEARCH_CONTAINER: 'rezics-anime-journey-search',
  KERNEL_SEARCH_VOLUME: 'rezics-anime-journey-search',
  KERNEL_SEARCH_PORT: '15939',
  REZICS_LOCAL_STACK_WEB_ORIGIN: 'http://127.0.0.1:13039',
  REZICS_LOCAL_STACK_ISSUER_ORIGIN: 'http://127.0.0.1:14239',
  REZICS_LOCAL_STACK_NATIVE_ORIGIN: 'http://127.0.0.1:13139',
  REZICS_LOCAL_STACK_KERNEL_ORIGIN: 'http://127.0.0.1:14139',
};
const web = env.REZICS_LOCAL_STACK_WEB_ORIGIN;
const api = env.REZICS_LOCAL_STACK_KERNEL_ORIGIN;
let phase = 'infrastructure';

async function command(name: string, args: string[]) {
  console.info(`Anime journey: ${name}`);
  const log = Bun.file(resolve(privateLogs, `${name}.log`));
  const child = Bun.spawn(args, { cwd: root, env, stdout: log, stderr: log });
  const code = await child.exited;
  if (code !== 0) {
    const lines = (await log.text()).split('\n');
    const error = lines.find((line) => /^(?:error:|Error:|remote-check:.*failed|task: Failed)/.test(line));
    throw new Error(`${name} exited ${code}${error ? `: ${error}` : ''}`);
  }
}

async function ready(origin: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    }
    await Bun.sleep(500);
  }
  throw new Error(`Stack origin did not become ready: ${origin}`);
}

async function current(id: string) {
  const response = await fetch(`${api}/v1/subjects/${id}`);
  assert.equal(response.status, 200, `anonymous Subject ${id}`);
  return await response.json();
}

export async function runBangumiJourney() {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await mkdir(privateLogs, { recursive: true, mode: 0o700 });
  await command('infrastructure', ['go-task', 'dev:infra']);
  const stackLog = Bun.file(resolve(privateLogs, 'stack.log'));
  const stack = Bun.spawn(['bun', 'services/auth/scripts/dev-stack.ts', 'start'], {
    cwd: root,
    env,
    stdout: stackLog,
    stderr: stackLog,
  });
  try {
    phase = 'readiness';
    await Promise.race([
      Promise.all([ready(web), ready(env.REZICS_LOCAL_STACK_ISSUER_ORIGIN), ready(api)]),
      stack.exited.then((code) => { throw new Error(`Development stack exited ${code}`); }),
    ]);
    phase = 'persona';
    await command('persona', ['go-task', 'dev:persona']);
    phase = 'seed';
    await command('seed', ['go-task', 'seed:dev']);
    const report = JSON.parse(await readFile(resolve(root, '.temp/cross-media-seed/result.json'), 'utf8')) as CrossMediaSeedReport;
    const works = report.showcase!.published.filter((row) => row.provider === 'bangumi' && ['10380', '51'].includes(row.sourceKey));
    assert.equal(works.length, 2, 'both selected anime have native publication identities');
    phase = 'anonymous-api';
    const reads = [];
    for (const work of works) {
      const read = await current(work.subjectId);
      for (const property of ['schema:datePublished', 'schema:numberOfEpisodes']) {
        assert.ok(read.subject.statements[property]?.length, `${work.sourceKey} current ${property}`);
      }
      assert.ok(work.assertions.some((row) => row.citations?.includes(`https://bgm.tv/subject/${work.sourceKey}`)));
      reads.push({ sourceKey: work.sourceKey, id: work.subjectId, route: work.readerRoute, assertions: work.assertions, read });
    }
    await writeFile(resolve(evidence, 'native.json'), JSON.stringify(reads, null, 2), { mode: 0o600 });
    phase = 'anonymous-browser';
    const require = createRequire(resolve(root, 'apps/web/package.json'));
    const { chromium } = require('playwright') as typeof import('../../../apps/web/node_modules/playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
      const page = await context.newPage();
      const visits: { sourceKey: string; url: string; text: string; links: { href: string; text: string }[] }[] = [];
      for (const work of works) {
        const url = `${web}/en${work.readerRoute}`;
        const response = await page.goto(url);
        assert.equal(response?.status(), 200, `mounted work ${work.sourceKey}`);
        await page.locator('main').waitFor();
        const text = await page.locator('main').innerText();
        const links = await page.locator('main a[href]').evaluateAll((nodes) => nodes.map((node) => ({ href: node.getAttribute('href')!, text: node.textContent ?? '' })));
        visits.push({ sourceKey: work.sourceKey, url: page.url(), text, links });
        await page.screenshot({ path: resolve(evidence, `anonymous-${work.sourceKey}.png`), fullPage: true });
        assert.ok(text.includes('STEINS;GATE') || text.includes('CLANNAD'), 'selected anime title rendered');
        assert.ok(links.some((link) => link.href.includes('bgm.tv')), 'source citation rendered');
      }
      await writeFile(resolve(evidence, 'browser.json'), JSON.stringify(visits, null, 2), { mode: 0o600 });
    } finally {
      await browser.close();
    }
    phase = 'complete';
  } finally {
    stack.kill('SIGTERM');
    await stack.exited;
    await writeFile(resolve(evidence, 'phase.json'), JSON.stringify({ phase }), { mode: 0o600 });
  }
}

if (import.meta.main) await runBangumiJourney();
