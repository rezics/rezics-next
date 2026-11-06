/** Opt-in real Auth/API/media-worker/Web journey. Run through scripts/worker-check.ts. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createAccountTokenProvider, IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { createImportTransport } from '../../../importer/src/import-client.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import { crossMediaAliases, type CrossMediaTables } from '../../../importer/src/cross-media-seed.ts';
import { importShowcaseBooks, showcaseBooksToCrossMediaPlan } from '../../../importer/src/showcase-books.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import source from './showcase-books-source.json';

const root = resolve(import.meta.dir, '../../../..');
// Playwright is installed with the web app; only the calls this journey makes are typed here.
type Page = any;
const { chromium } = createRequire(resolve(root, 'apps/web/package.json'))('playwright') as {
  chromium: { launch(options: { headless: boolean }): Promise<any> };
};
const directory = resolve(root, '.temp/book-journey');
await mkdir(directory, { recursive: true, mode: 0o700 });
const handle = `rezics-books-${randomUUID().slice(0, 8)}`;
async function freePort() {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = server.port!;
  await server.stop(true);
  return port;
}
const [databasePort, searchPort, webPort, issuerPort, nativePort, kernelPort] = await Promise.all(
  Array.from({ length: 6 }, freePort),
);
const origins = {
  web: `http://127.0.0.1:${webPort}`,
  issuer: `http://127.0.0.1:${issuerPort}`,
  native: `http://127.0.0.1:${nativePort}`,
  kernel: `http://127.0.0.1:${kernelPort}`,
};
const env = {
  ...process.env,
  KERNEL_DATABASE_CONTAINER: `${handle}-db`,
  KERNEL_DATABASE_VOLUME: `${handle}-db`,
  KERNEL_DATABASE_PORT: String(databasePort),
  KERNEL_SEARCH_CONTAINER: `${handle}-search`,
  KERNEL_SEARCH_VOLUME: `${handle}-search`,
  KERNEL_SEARCH_PORT: String(searchPort),
  REZICS_LOCAL_STACK_WEB_ORIGIN: origins.web,
  REZICS_LOCAL_STACK_ISSUER_ORIGIN: origins.issuer,
  REZICS_LOCAL_STACK_NATIVE_ORIGIN: origins.native,
  REZICS_LOCAL_STACK_KERNEL_ORIGIN: origins.kernel,
};
async function command(args: string[], log: string) {
  const child = Bun.spawn(args, { cwd: root, env, stdout: Bun.file(resolve(directory, log)), stderr: 'pipe' });
  const error = await new Response(child.stderr).text();
  const code = await child.exited;
  assert.equal(code, 0, `${args.join(' ')} exited ${code}: ${error}`);
}
async function ready(url: string, child: Bun.Subprocess) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'Local stack exited before readiness');
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    if (response?.ok) return;
    await Bun.sleep(1000);
  }
  throw new Error(`Local stack did not become ready: ${url}`);
}
const tables: CrossMediaTables = {
  async *rows(provider, table) {
    assert.equal(provider, 'bangumi');
    yield* source.rows[table as keyof typeof source.rows];
  },
};
const evidence: Record<string, unknown> = {
  handle,
  origins,
  snapshot: {
    archive: 'dump-2026-10-20.210332Z.zip',
    sha256: '9fe8de272398ff4bd12994b73e25aac37cca631372383f6aadc503528623aa93',
    tableDigests: source.digests,
  },
  visits: [],
};
const visits = evidence.visits as Record<string, unknown>[];
let stack: Bun.Subprocess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let journal: ShowcaseJournal | undefined;
try {
  console.log('books journey: starting isolated infrastructure', handle);
  await command(['go-task', 'dev:infra'], 'infra.log');
  await command(['go-task', 'dev:persona'], 'persona.log');
  stack = Bun.spawn(['bun', 'services/auth/scripts/dev-stack.ts', 'start'], {
    cwd: root,
    env,
    stdout: Bun.file(resolve(directory, 'stack.log')),
    stderr: Bun.file(resolve(directory, 'stack-errors.log')),
  });
  evidence.stackPid = stack.pid;
  await ready(`${origins.kernel}/v1/definitions`, stack);
  await ready(`${origins.web}/en`, stack);
  await ready(`${origins.issuer}/.well-known/openid-configuration`, stack);
  const seedEnv = Object.fromEntries(
    (await readFile(resolve(root, '.temp/local-stack/seed.env'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  const credential = {
    accountKeyPath: seedEnv.REZICS_DEV_PERSONA_ACCOUNT_KEY!,
    account: seedEnv.REZICS_DEV_PERSONA_ACCOUNT!,
    client: seedEnv.REZICS_DEV_PERSONA_CLIENT!,
    authOrigin: origins.issuer,
  };
  const tokenProvider = await createAccountTokenProvider({
    ...credential,
    scopes: [...IMPORTER_SCOPES, 'subject:read'],
  });
  const reviewToken = await createAccountTokenProvider({
    ...credential,
    scopes: [...IMPORTER_SCOPES, 'subject:read', 'context:accept', 'context:adopt'],
  });
  const importer = createImportTransport({ origin: origins.kernel, tokenProvider });
  const review = createImportTransport({ origin: origins.kernel, tokenProvider: reviewToken });
  const publicClient = createPublicBulkClient({ origin: origins.kernel });
  journal = new ShowcaseJournal(resolve(directory, 'showcase.sqlite'));
  console.log('books journey: proposing real source families');
  const input = {
    tables,
    path: resolve(directory, 'state.sqlite'),
    port: captureShowcaseCommands(importer, journal),
    destination: { origin: origins.kernel },
    journal,
    review,
    publicClient,
  };
  const first = await importShowcaseBooks(input);
  evidence.selected = first.selected;
  evidence.identities = first.identities;
  evidence.conversions = first.conversions;
  evidence.gaps = first.gaps;
  assert.deepEqual(first.selected.series, ['499', '2815']);
  for (const key of ['26', '5329', '10862']) assert(first.selected.volumes.includes(key));
  for (const key of ['person:1466', 'person:1467', 'person:128', '233'])
    assert(first.identities[key], `Missing ${key}`);
  console.log('books journey: separate authorized acceptance and adoption');
  const publication = await publishShowcase({
    plan: showcaseBooksToCrossMediaPlan(first.planned),
    result: first,
    aliases: crossMediaAliases,
    journal,
    review,
    publicClient,
    vocabularyRequirements: first.creditVocabularyRequirements ?? [],
  });
  evidence.publication = publication;
  await writeFile(resolve(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  const ids = first.identities;
  const subjects = new Map<string, any>();
  for (const [key, identity] of Object.entries(ids)) {
    const read = await publicClient.readSubject(identity.id);
    assert.equal(read.subject.type, identity.type, key);
    subjects.set(key, read.subject);
  }
  evidence.current = Object.fromEntries(subjects);
  const values = (key: string, property: string) => subjects.get(key).statements?.[property] ?? [];
  for (const [key, property, target] of [
    ['5329', 'wdt:P179', '2815'],
    ['10862', 'wdt:P179', '2815'],
    ['2815', 'schema:author', 'person:1466'],
    ['2815', 'schema:illustrator', 'person:1467'],
    ['2815', 'schema:publisher', 'person:128'],
  ])
    assert(
      values(key!, property!).some((row: any) => row.value.content === ids[target!]!.id),
      `${key} missing ${property} → ${target}`,
    );
  // The symmetric counterpart is stored once on its canonical side; the series reads it through its inverse links.
  const counterpart = (await (
    await fetch(
      `${origins.kernel}/v1/subjects/${ids['2815']!.id}/links?property=${encodeURIComponent('rezics:crossMediaCounterpart')}`,
    )
  ).json()) as { links: { summary: { id: string } }[] };
  assert(
    counterpart.links.some((link) => link.summary.id === ids['233']!.id),
    '2815 lacks its inverse anime counterpart',
  );
  assert(
    values('233', 'schema:name').some(
      (row: any) =>
        JSON.stringify(row.value.content) ===
        JSON.stringify({ language: 'und', text: '劇場版 空の境界 第一章 俯瞰風景' }),
    ),
    'anime 233 lacks its exact und name',
  );
  for (const key of first.selected.volumes) {
    assert.equal(values(key, 'schema:isbn').length, 0);
    assert.equal(values(key, 'schema:numberOfPages').length, 0);
  }
  const again = await importShowcaseBooks({ ...input, prior: publication });
  assert.deepEqual(again.identities, first.identities, 'Reopen replaced native identities');
  console.log('books journey: current native identities', JSON.stringify(ids));
  browser = await chromium.launch({ headless: true });
  async function visit(page: Page, persona: string, key: string) {
    const identity = ids[key]!;
    const url = `${origins.web}/en/subjects/${identity.id}/book`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.locator('h1').waitFor({ timeout: 30_000 });
    const text = await page.locator('body').innerText();
    const read = await publicClient.readSubject(identity.id);
    assert.equal(read.subject.id, identity.id);
    await page.screenshot({ path: resolve(directory, `${persona}-${key.replace(':', '-')}.png`), fullPage: true });
    visits.push({ persona, sourceKey: key, nativeId: identity.id, type: identity.type, url: page.url(), text });
    assert(!/Internal Server Error|Something went wrong/.test(text), `Broken page ${key}`);
    return page.locator('a[href*="/subjects/"]');
  }
  const password = JSON.parse(await readFile(resolve(root, '.temp/local-stack/keys.json'), 'utf8')).password;
  for (const persona of ['anonymous', 'member', 'reviewer']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    if (persona !== 'anonymous') {
      await page.goto(`${origins.web}/auth/sign-in`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel(/email/i).fill('developer@rezics.test');
      await page.locator('input[name="password"]').fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL((url: URL) => url.origin === origins.web, { timeout: 60_000 });
    }
    for (const series of first.selected.series) {
      await visit(page, persona, series);
      const related = first.planned.members.filter(
        (member) =>
          member.family === first.families.find((family) => family.seriesId === series)?.id &&
          ids[member.key] &&
          member.key !== series,
      );
      for (const member of related) {
        const link = page.locator(`a[href*="/subjects/${ids[member.key]!.id}/"]`).first();
        assert(await link.count(), `${persona} series ${series} lacks navigation to ${member.key}`);
        await link.click();
        await page.waitForLoadState('networkidle');
        assert(page.url().includes(ids[member.key]!.id), `Wrong destination ${member.key}`);
        await page.screenshot({
          path: resolve(directory, `${persona}-via-${member.key.replace(':', '-')}.png`),
          fullPage: true,
        });
        visits.push({
          persona,
          from: series,
          sourceKey: member.key,
          nativeId: ids[member.key]!.id,
          url: page.url(),
          text: await page.locator('body').innerText(),
        });
        await page.goBack({ waitUntil: 'networkidle' });
        assert(page.url().includes(ids[series]!.id), 'Return lost the series identity');
      }
    }
    await context.close();
  }
  evidence.state = 'passed';
  console.log('books journey: passed anonymous, member and reviewer current API/page walk');
} finally {
  await writeFile(resolve(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  journal?.close();
  await browser?.close();
  if (stack) {
    stack.kill('SIGTERM');
    await stack.exited;
  }
  // These unique containers were created by this invocation; retained development stacks are never touched.
  for (const suffix of ['db', 'search']) {
    const child = Bun.spawn(['docker', 'rm', '-f', '-v', `${handle}-${suffix}`], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await child.exited;
  }
}
