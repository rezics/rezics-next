/** Opt-in real Auth/API/media-worker/Web journey. Run with `dev-stack.ts walk -- bun .../showcase-books-journey.ts`. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createAccountTokenProvider, IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { BOOK_OWNER_GRANT_ACTIONS, grantOrdinaryOwnerActions } from '../../../importer/src/ordinary-owner-grants.ts';
import { createImportTransport } from '../../../importer/src/import-client.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import { crossMediaAliases, type CrossMediaTables } from '../../../importer/src/cross-media-seed.ts';
import { showcaseBooksToCrossMediaPlan } from '../../../importer/src/showcase-books.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import source from './showcase-books-source.json';
import { importShowcaseBooks } from '../../../importer/src/selected-import.ts';

const root = resolve(import.meta.dir, '../../../..');
// Playwright is installed with the web app; only the calls this journey makes are typed here.
type Page = any;
const { chromium } = createRequire(resolve(root, 'apps/web/package.json'))('playwright') as {
  chromium: { launch(options: { headless: boolean }): Promise<any> };
};
const directory = resolve(root, '.temp/book-journey', randomUUID().slice(0, 8));
await mkdir(directory, { recursive: true, mode: 0o700 });
type StackOrigins = { web: string; issuer: string; native: string; kernel: string };
function stackOrigins(): StackOrigins {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is missing; run this journey under dev-stack.ts walk`);
    return new URL(value).origin;
  };
  return {
    web: required('REZICS_LOCAL_STACK_WEB_ORIGIN'),
    issuer: required('REZICS_LOCAL_STACK_ISSUER_ORIGIN'),
    native: required('REZICS_LOCAL_STACK_NATIVE_ORIGIN'),
    kernel: required('REZICS_LOCAL_STACK_KERNEL_ORIGIN'),
  };
}
/** The surrounding walk owns infrastructure; this helper only captures journey command output. */
async function command(args: string[], log: string) {
  const file = resolve(directory, log);
  const errors = `${file}.err`;
  const child = Bun.spawn(args, { cwd: root, env: process.env, stdout: Bun.file(file), stderr: Bun.file(errors) });
  const code = await child.exited;
  assert.equal(code, 0, `${args.join(' ')} exited ${code}: ${await Bun.file(errors).slice(-4096).text()}`);
}
const tables: CrossMediaTables = {
  async *rows(provider, table) {
    assert.equal(provider, 'bangumi');
    yield* source.rows[table as keyof typeof source.rows];
  },
};
const evidence: Record<string, unknown> = {
  snapshot: {
    archive: 'dump-2026-10-20.210332Z.zip',
    sha256: '9fe8de272398ff4bd12994b73e25aac37cca631372383f6aadc503528623aa93',
    tableDigests: source.digests,
  },
  visits: [],
};
const visits = evidence.visits as Record<string, unknown>[];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let journal: ShowcaseJournal | undefined;
try {
  const origins = stackOrigins();
  evidence.origins = origins;
  console.log('books journey: using the admitted dev-stack walk');
  await command(['bun', 'services/auth/scripts/dev-stack.ts', 'persona'], 'persona.log');
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
  const grantorToken = await createAccountTokenProvider({
    ...credential,
    scopes: [...IMPORTER_SCOPES, 'subject:read', 'context:accept', 'context:adopt', 'access:grant'],
  });
  await grantOrdinaryOwnerActions({
    accountId: credential.account,
    actions: BOOK_OWNER_GRANT_ACTIONS,
    post: async ({ path, body, idempotencyKey }) => {
      const response = await fetch(`${origins.kernel}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await grantorToken()}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(idempotencyKey),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    },
  });
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
  // A BookSeries admits publisher but not author or illustrator; those source credits stay exact gaps.
  assert(
    first.creditGaps.some(
      (gap: any) => gap.path === '/subject-persons/2815/1466/position' && gap.reason === 'property_not_admitted',
    ),
    'Kara author must stay an exact property_not_admitted gap',
  );
  for (const path of ['/subject-persons/499/6023/position', '/subject-persons/499/5839/position'])
    assert(
      first.creditGaps.some((gap: any) => gap.path === path && gap.reason === 'property_not_admitted'),
      `${path} must stay an exact property_not_admitted gap`,
    );
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
    ['26', 'wdt:P179', '499'],
    ['5329', 'wdt:P179', '2815'],
    ['10862', 'wdt:P179', '2815'],
  ])
    assert(
      values(key!, property!).some((row: any) => row.value.content === ids[target!]!.id),
      `${key} missing ${property} → ${target}`,
    );
  for (const series of first.selected.series) {
    const publishers = first.planned.credits.filter(
      (credit) => credit.kind === 'staff' && credit.work === series && credit.roleCode === 2004,
    );
    assert(publishers.length > 0, `series ${series} has no selected publisher source row`);
    const current = subjects.get(series);
    for (const credit of publishers) {
      const identity = ids[credit.person];
      assert(identity, `series ${series} publisher ${credit.person} has no current identity`);
      assert.equal(identity.type, 'schema:Organization', `series ${series} publisher is an Organization`);
      const citation = `https://bgm.tv/subject/${series}#${credit.path}`;
      const statement = values(series, 'schema:publisher').find((row: any) => row.value?.content === identity.id);
      assert(statement, `series ${series} lacks current schema:publisher → ${credit.person}`);
      assert(
        statement.references?.some((reference: any) =>
          reference.parts?.some((part: any) => part.value?.content === citation),
        ),
        `series ${series} publisher ${credit.person} lacks ${citation}`,
      );
    }
    assert(current, `series ${series} has no independent current read`);
  }
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
    const url = `${origins.web}/en${identity.route}`;
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
      const familyId = first.families.find((family) => family.seriesId === series)?.id;
      const related = first.planned.members.filter(
        (member) =>
          member.family === familyId &&
          ['volume', 'publisher', 'anime'].includes(member.role) &&
          ids[member.key] &&
          member.key !== series,
      );
      for (const member of related) {
        const link = page.locator(`a[href*="/subjects/${ids[member.key]!.id}/"]`).first();
        assert(await link.count(), `${persona} series ${series} lacks navigation to ${member.key}`);
        const href = await link.getAttribute('href');
        assert(href, `${persona} series ${series} has an empty target link for ${member.key}`);
        const destination = new URL(href, origins.web);
        const via = destination.searchParams.get('via');
        assert(via, `${persona} series ${series} link to ${member.key} lacks return navigation`);
        assert(
          new URL(via, origins.web).pathname.includes(`/subjects/${ids[series]!.id}/`),
          `${persona} series ${series} return for ${member.key} points at another source page`,
        );
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
  journal?.close();
  try {
    await browser?.close();
  } finally {
    await writeFile(resolve(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
}
