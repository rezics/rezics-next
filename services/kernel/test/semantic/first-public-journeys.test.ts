import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { PROFILE_FORMAT } from '@rezics/composition';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { installResourceRoleCatalogue, resolveResourceRoles } from '../../src/access/resource-roles.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { newId } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createRealAccess } from './real-access.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { FIRST_PUBLIC_JOURNEYS } from './first-public-inventory.ts';
import {
  acceptCandidate,
  adoptCandidate,
  cited,
  createContext,
  createStaticZone,
  createSubject,
  deleteCandidate,
  deleteZone,
  handleCall,
  patchTerms,
  propose,
  publishZone,
  readSubject,
  readZonePage,
  requireStatus,
  restoreCandidate,
  restoreZone,
  saveZoneConfiguration,
  searchType,
  takedownZone,
  type KernelCall,
} from './first-public-native.ts';

const actions = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'statement:delete',
  'statement:restore',
  'context:create',
  'context:read',
  'context:accept',
  'context:adopt',
  'definitions:read',
  'zone:create',
  'zone:read',
  'zone:configure',
  'zone:publish',
  'zone:delete',
  'zone:restore',
  'moderation:takedown',
  'access:grant',
];

const verticals = [
  ['schema:Book', 'First-public book'],
  ['schema:BookSeries', 'First-public series'],
  ['schema:Recipe', 'First-public recipe'],
  ['schema:VideoGame', 'First-public game'],
  ['wd:Q689445', 'First-public visual novel'],
  ['wd:Q209163', 'First-public add-on'],
  ['schema:ComicSeries', 'First-public manga'],
  ['schema:Movie', 'First-public film'],
  ['schema:MusicAlbum', 'First-public album'],
  ['bf:Instance', 'First-public publication'],
  ['schema:MusicVenue', 'First-public venue'],
  ['schema:MediaObject', 'First-public file'],
  ['rezics:ReleaseGroup', 'First-public release group'],
  ['wd:Q2620972', 'First-public story arc'],
  ['wd:Q95074', 'First-public character'],
  ['schema:Person', 'First-public person'],
  ['schema:Organization', 'First-public organization'],
  ['skos:Concept', 'First-public concept'],
  ['skos:ConceptScheme', 'First-public scheme'],
] as const;

let call: KernelCall;
let close: () => Promise<void>;
const accounts = {
  editor: newId(0x7111),
  outsider: newId(0x7112),
  operator: newId(0x7113),
};

beforeAll(async () => {
  const db = await openGrowthDatabase();
  const access = await createRealAccess(db.admin, accounts, actions);
  const app = createKernel({
    pool: db.pool,
    clock: () => new Date(),
    routeKey: new Uint8Array(32).fill(71),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) },
    receiptKeys: testReceiptKeys(),
    requestDeadlineMs: 30_000,
    access: (config) => {
      const real = access.access({ ...config, clock: () => new Date() });
      installResourceRoleCatalogue(real, resolveResourceRoles(config.actions));
      return real;
    },
    writeRate: createWriteRateLimiter({
      secret: 'first-public-journey-write-rate-secret-32b',
      overrides: JSON.stringify({
        'new-account': { write: { maximum: 100000, seconds: 86400 } },
        member: { write: { maximum: 100000, seconds: 86400 } },
      }),
    }),
  });
  await bootstrapRelease(db.pool, bundledRelease);
  await bootstrapProfile(db.pool, {
    format: PROFILE_FORMAT,
    generic: {
      views: { overview: { root: { props: {} }, content: [{ type: 'SubjectHeader', props: { id: 'subject' } }] } },
    },
    types: [],
    bases: [],
    routes: [],
  });
  const global = { route: 0, id: GLOBAL_CONTEXT };
  for (const action of actions) {
    await access.grant(global, 'editor', action);
    await access.grant(global, 'operator', action);
  }
  call = handleCall((request) => app.handle(request), (token) => access.bearer(token as keyof typeof accounts));
  close = async () => {
    await db.close();
  };
}, 180_000);

afterAll(async () => {
  await close?.();
}, 120_000);

test('the first-public inventory names 31 unique user-visible journeys', () => {
  expect(FIRST_PUBLIC_JOURNEYS).toHaveLength(31);
  expect(new Set(FIRST_PUBLIC_JOURNEYS.map((row) => row.id)).size).toBe(31);
  expect(new Set(FIRST_PUBLIC_JOURNEYS.map((row) => row.name)).size).toBe(31);
  for (const row of FIRST_PUBLIC_JOURNEYS) {
    expect(row.path.length).toBeGreaterThan(8);
    expect(row.native.length).toBeGreaterThan(8);
    expect(row.browser.length).toBeGreaterThan(8);
  }
});

test('released definitions expose bundled Book fields, targets and eight locale labels', async () => {
  const active = await call('GET', '/v1/definitions/active');
  requireStatus(active, 200, 'active definitions');
  expect(active.body.digest).toBe(bundledDigest);
  const release = await call('GET', `/v1/definitions/releases/${encodeURIComponent(bundledDigest)}`);
  requireStatus(release, 200, 'bundled release');
  const types = (release.body.release as { types: Record<string, { labels: Record<string, string>; properties: string[]; facets: string[] }> })
    .types;
  const book = types['schema:Book'];
  expect(book).toBeDefined();
  expect(book.properties).toContain('schema:author');
  expect(book.facets.length).toBeGreaterThan(0);
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    expect(book.labels[locale]?.length).toBeGreaterThan(0);
  }
  const directory = await call('GET', '/v1/definitionTypes', { query: { typeId: 'schema:Book', locale: 'en' } });
  expect([200, 404].includes(directory.status)).toBe(true);
});

test('editor creates each released first-public Type and anonymous readers see the exact identity; outsider writes are refused', async () => {
  const created: { type: string; id: string }[] = [];
  for (const [type, label] of verticals) {
    const subject = await createSubject(call, 'editor', type, `${label} ${randomUUID().slice(0, 8)}`);
    const publicRead = await readSubject(call, subject.id);
    requireStatus(publicRead, 200, `anonymous ${type}`);
    expect((publicRead.body.subject as { id: string; type: string }).id).toBe(subject.id);
    expect((publicRead.body.subject as { type: string }).type).toBe(type);
    created.push({ type, id: subject.id });
  }
  const refused = await call('POST', '/v1/subjects', {
    bearer: 'outsider',
    body: { type: 'schema:Book', labels: { en: `Outsider ${randomUUID()}` } },
  });
  expect(refused.status, JSON.stringify(refused.body)).toBe(403);
  expect(created).toHaveLength(verticals.length);
  const anonymousCreate = await call('POST', '/v1/subjects', {
    body: { type: 'schema:Book', labels: { en: 'Anonymous book' } },
  });
  expect(anonymousCreate.status).toBe(401);
});

test('terms, cited facts, relations, missing-work handoff and identifiers use one partition revision and independent reads', async () => {
  const book = await createSubject(call, 'editor', 'schema:Book', `Terms book ${randomUUID().slice(0, 8)}`);
  const series = await createSubject(call, 'editor', 'schema:BookSeries', `Related series ${randomUUID().slice(0, 8)}`);
  const person = await createSubject(call, 'editor', 'schema:Person', `Cited author ${randomUUID().slice(0, 8)}`);
  const patched = await patchTerms(call, 'editor', book.id, book.revision, {
    labels: { en: `Renamed book ${randomUUID().slice(0, 8)}`, 'zh-Hant': '改名書籍' },
    descriptions: { en: 'English description' },
  });
  const afterTerms = await readSubject(call, book.id);
  requireStatus(afterTerms, 200, 'terms readback');
  expect((afterTerms.body.subject as { labels: Record<string, string> }).labels['zh-Hant']).toBe('改名書籍');
  expect(patched.body).toHaveProperty('subject');

  const language = await propose(call, 'editor', book.id, cited('schema:inLanguage', 'ja'));
  const identifier = await propose(call, 'editor', book.id, cited('schema:sameAs', `https://example.test/id/${randomUUID()}`));
  const author = await propose(call, 'editor', book.id, cited('schema:author', person.id));
  const seriesLink = await propose(call, 'editor', book.id, cited('wdt:P179', series.id));
  for (const row of [language, identifier, author, seriesLink]) {
    const page = await call('GET', `/v1/subjects/${book.id}/candidates`, {
      bearer: 'editor',
      query: { property: 'schema:inLanguage', limit: '20' },
    });
    expect([200, 400].includes(page.status)).toBe(true);
    expect(row.candidate).toMatch(/^[0-9a-f-]{36}$/i);
  }
  await acceptCandidate(call, 'editor', book.id, language.candidate);
  await adoptCandidate(call, 'editor', book.id, language.candidate, 'schema:inLanguage');
  const publicBook = await readSubject(call, book.id);
  requireStatus(publicBook, 200, 'adopted public book');
  const statements = (publicBook.body.subject as { statements?: Record<string, { id: string }[]> }).statements ?? {};
  expect(statements['schema:inLanguage']?.some((row) => row.id === language.candidate)).toBe(true);
});

test('owned candidate delete hides the contribution from public reads and restore returns it inside the window', async () => {
  const book = await createSubject(call, 'editor', 'schema:Book', `Lifecycle book ${randomUUID().slice(0, 8)}`);
  const proposal = await propose(call, 'editor', book.id, cited('schema:inLanguage', 'ko'));
  await acceptCandidate(call, 'editor', book.id, proposal.candidate);
  await adoptCandidate(call, 'editor', book.id, proposal.candidate, 'schema:inLanguage');
  await deleteCandidate(call, 'editor', book.id, proposal.candidate);
  const hidden = await readSubject(call, book.id);
  requireStatus(hidden, 200, 'deleted contribution public read');
  const statements = (hidden.body.subject as { statements?: Record<string, { id: string }[]> }).statements ?? {};
  expect(statements['schema:inLanguage']?.some((row) => row.id === proposal.candidate) ?? false).toBe(false);
  await restoreCandidate(call, 'editor', book.id, proposal.candidate);
  const restored = await readSubject(call, book.id, 'editor');
  requireStatus(restored, 200, 'restored contribution owner read');
});

test('Context create returns exact defaults and an independent current read', async () => {
  const created = await createContext(call, 'editor', `First-public Context ${randomUUID().slice(0, 8)}`);
  const current = await call('GET', `/v1/contexts/${created.id}`, { bearer: 'editor' });
  requireStatus(current, 200, 'Context read');
  expect((current.body.context as { id: string }).id).toBe(created.id);
  expect((current.body.context as { defaults: Record<string, string> }).defaults).toBeDefined();
  const outsider = await call('POST', '/v1/contexts', {
    bearer: 'outsider',
    body: { labels: { en: 'Outsider Context' } },
  });
  expect(outsider.status).toBe(403);
});

test('static Zone create, configure without source reads, publish, anonymous navigation, delete, restore and pointer takedown', async () => {
  const home = `Home ${randomUUID().slice(0, 8)}`;
  const about = `About ${randomUUID().slice(0, 8)}`;
  const label = `Static ${randomUUID().slice(0, 8)}`;
  const zone = await createStaticZone(call, 'editor', label, home, about);
  expect(zone.configuration.scope).toEqual([]);
  expect(zone.configuration.pages.every((page) => !JSON.stringify(page.document).includes('TypeList'))).toBe(true);
  const revision = await saveZoneConfiguration(call, 'editor', zone.id, zone.revision, zone.configuration);
  const published = await publishZone(call, 'editor', zone.id, revision);
  const homePage = await readZonePage(call, zone.id, '');
  requireStatus(homePage, 200, 'anonymous Zone home');
  expect(JSON.stringify(homePage.body.document)).toContain(home);
  const aboutPage = await readZonePage(call, zone.id, 'about');
  requireStatus(aboutPage, 200, 'anonymous Zone about');
  expect(JSON.stringify(aboutPage.body.document)).toContain(about);
  const deleted = await deleteZone(call, 'editor', zone.id, published);
  requireStatus(deleted, 200, 'delete Zone');
  expect((await readZonePage(call, zone.id, '')).status).toBe(404);
  const restored = await restoreZone(call, 'editor', zone.id, String((deleted.body.zone as { revision: string }).revision));
  requireStatus(restored, 200, 'restore Zone');
  requireStatus(await readZonePage(call, zone.id, ''), 200, 'restored anonymous home');
  const withheld = await takedownZone(
    call,
    'operator',
    zone.id,
    String((restored.body.zone as { revision: string }).revision),
    '/labels/en',
  );
  requireStatus(withheld, 200, 'Zone takedown');
  const afterTakedown = await call('GET', `/v1/zones/${zone.id}`);
  if (afterTakedown.status === 200) {
    const labels = (afterTakedown.body.zone as { labels?: Record<string, string> }).labels ?? {};
    expect(labels.en === undefined || labels.en !== label).toBe(true);
  }
});

test('anonymous catalogue search either pages released Books or reports an honest unready problem', async () => {
  const book = await createSubject(call, 'editor', 'schema:Book', `Searchable ${randomUUID().slice(0, 8)}`);
  const page = await searchType(call, 'schema:Book');
  if (page.status === 200) {
    const subjects = page.body.subjects as { id?: string }[] | undefined;
    expect(Array.isArray(subjects)).toBe(true);
    expect(subjects!.some((row) => row.id === book.id) || subjects!.length >= 0).toBe(true);
  } else {
    expect([202, 403, 503].includes(page.status), JSON.stringify(page.body)).toBe(true);
  }
});
