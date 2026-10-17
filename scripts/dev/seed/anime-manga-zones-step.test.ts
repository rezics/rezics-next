import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { catalogueIntakePath } from '../../../tests/fixtures/catalogue/intake.ts';
import { checkFirstPartyBundle } from '../../../services/main/src/modules/theme/first-party-bundle.ts';
import { animeMangaSamplePlan, applyAnimeMangaZones, createCatalogueSpace, type CatalogueSample } from './anime-manga-zones-step.ts';
import { officialTheme } from './official-plan.ts';
import { approveOfficialPackage } from './official-theme-step.ts';
import { seedKey } from './plan.ts';
import type { HttpResult, SeedPort } from './vn-catalogue-step.ts';

const native = (suffix: string) => `https://rezics.com/id/00000000-0000-4000-a000-${suffix.padStart(12, '0')}`;

test('official catalogue Spaces use delegated operator creation and preserve earlier member-created Spaces', async () => {
  const spec = { id:'anime',name:'Anime',language:'en',routeSegment:'anime',preset:'editorial' as const,
    mountSegment:'catalogue',navigation:[],browse:[],announcement:'',sharedMember:'' };
  for (const retained of [true,false]) {
    let memberWrites=0, operatorWrites=0;
    const receipt = { space:native('2'),realm:native('3') };
    const port:SeedPort = { actingSubject:native('1'),grant:async()=>{},
      request:async(method,path)=> {
        if(method!=='GET') { memberWrites++; throw new Error('Member creation quota must not be spent'); }
        if(!retained) return {status:404,body:{}};
        return {status:200,body:path.includes('/zones/') ? {configuration:{...receipt,defaultRealm:receipt.realm}} : {id:receipt.realm,space:receipt.space}};
      },
      spaceRequest:async()=>{operatorWrites++;return {status:201,body:receipt};},
    };
    expect(await createCatalogueSpace(port,spec,native('4'))).toMatchObject(receipt);
    expect(memberWrites).toBe(0);
    expect(operatorWrites).toBe(retained?0:1);
  }
});

test('the sample has a page of each format filter, mixed languages, a long series and the absent cases', () => {
  const plan = animeMangaSamplePlan();
  const anime = plan.filter(sample => sample.zone === 'anime');
  const manga = plan.filter(sample => sample.zone === 'manga');
  const platform = (sample: (typeof plan)[number]) =>
    sample.subject.kind === 'bangumi' ? sample.subject.source.platform : null;
  const tags = (sample: (typeof plan)[number]): readonly string[] => {
    if (sample.subject.kind !== 'bangumi' || !Array.isArray(sample.subject.source.meta_tags)) return [];
    return sample.subject.source.meta_tags.filter((tag): tag is string => typeof tag === 'string');
  };

  expect(anime.filter(sample => platform(sample) === 1)).toHaveLength(22);
  expect(manga.filter(sample => platform(sample) === 1001)).toHaveLength(22);
  expect(anime.map(platform)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 99]));
  expect(manga.some(sample => sample.subject.kind === 'one-shot')).toBe(true);
  expect(manga.map(platform)).toContain(999);
  expect(plan.some(sample => sample.language === 'ja')).toBe(true);
  expect(plan.some(sample => sample.language === 'en')).toBe(true);

  const long = plan.find(sample => sample.key === 'long-tv');
  expect(long?.subject.kind === 'bangumi' && long.subject.source.eps).toBe(1155);
  expect(long?.year).toBe(1980);
  expect(plan.find(sample => sample.key === 'long-manga')?.year).toBe(1995);
  expect(anime.filter(sample => tags(sample).includes('未放送')).map(sample => sample.year)).toEqual([1981]);
  expect(anime.some(sample => tags(sample).includes('取消'))).toBe(true);
  expect(manga.some(sample => tags(sample).includes('未发售'))).toBe(true);
  expect(manga.some(sample => tags(sample).includes('腰斩'))).toBe(true);
  expect(plan.filter(sample => sample.year === null).map(sample => sample.key).sort()).toEqual([
    'anime-unclassified', 'manga-3', 'manga-unclassified', 'one-shot-en', 'tv-3',
  ]);
  expect(new Set(plan.map(sample => sample.key)).size).toBe(plan.length);
});

test('package approval records the built files and slots, and another account reviews it', async () => {
  const ownerCalls: string[] = [];
  const reviewCalls: { path: string; body: unknown }[] = [];
  const recorded: { bundle: { slots: string[]; files: { path: string; digest: string; gzipBytes: number }[];
    packageDigest: string } | null } = { bundle: null };
  const zone = native('11');
  const revision = native('12');
  const bytes = new TextEncoder().encode('_next/static/anime.js');
  const manifest = {
    entry: { src: 'zones/official/anime/index.tsx', file: '_next/static/anime.js' },
    style: { src: 'zones/official/anime/anime.css?raw', file: '_next/static/anime-css.js' },
  };
  await approveOfficialPackage({
    slug: 'anime', zone, owner: native('1'), reviewer: native('2'),
    manifest, chunk: async path => new TextEncoder().encode(path),
    request: async (method, path, body) => {
      ownerCalls.push(`${method} ${path.split('?')[0]}`);
      if (method === 'POST' && path === '/v1/themes') return { status: 201, body: { theme: officialTheme('anime') } };
      if (method === 'POST' && path.includes('/revisions') && !path.includes('/reviews')) {
        recorded.bundle = (body as { bundle: NonNullable<typeof recorded.bundle> }).bundle;
        return { status: 201, body: { operation: revision } };
      }
      if (method === 'POST' && path.includes('/first-party-activations')) return { status: 201, body: {} };
      return { status: 500, body: { unexpected: path } };
    },
    review: async (method, path, body) => {
      reviewCalls.push({ path, body });
      expect(method).toBe('POST');
      return { status: 201, body: {} };
    },
  });
  expect(ownerCalls.some(call => call.includes('/reviews'))).toBe(false);
  expect(reviewCalls).toHaveLength(1);
  expect(reviewCalls[0]?.path).toContain(`/revisions/${revision.slice(-36)}/reviews`);
  expect(reviewCalls[0]?.body).toMatchObject({ decision: 'approved', actingSubject: native('2') });
  if (!recorded.bundle) throw new Error('revision was not posted');
  const bundle = recorded.bundle;
  expect(checkFirstPartyBundle(bundle).bundle.slots).toEqual([
    'browseHeader', 'cataloguePanel', 'footer', 'workCard',
  ]);
  const entry = bundle.files.find(file => file.path.endsWith('anime.js'));
  expect(entry?.digest).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(entry?.gzipBytes).toBe(gzipSync(bytes).byteLength);
  expect(bundle.packageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
});

const DATE = 'http://www.w3.org/2001/XMLSchema#date';
const publication = {
  component: 'https://rezics.com/id/00000000-0000-4000-a000-0000000000aa',
  revision: 'https://rezics.com/id/00000000-0000-4000-a000-0000000000bb',
};

test('catalogue samples are catalogue Works and record a dated year on the seeded property', async () => {
  const actor = `https://rezics.com/id/${randomUUID()}`;
  const epoch = `anime-manga-${randomUUID()}`;
  const dated: CatalogueSample = { key: 'dated', zone: 'anime', title: 'Dated series', language: 'ja', year: 1980,
    subject: { kind: 'bangumi', source: { id: 1, type: 2, platform: 1, eps: 12, meta_tags: ['已完结'] } } };
  const quiet: CatalogueSample = { key: 'quiet', zone: 'manga', title: 'No year', language: 'en', year: null,
    subject: { kind: 'bangumi', source: { id: 2, type: 1, platform: 1001 } } };
  const writes: { method: string; path: string; body: unknown; response: unknown }[] = [];
  const grants: string[] = [];
  const works = new Map<string, string>();
  const request: SeedPort['request'] = async (method, path, body) => {
    const pathname = path.split('?')[0]!;
    const response = respond(method, pathname, epoch, body, works);
    writes.push({ method, path: pathname, body, response: response.body });
    return response;
  };
  const port: SeedPort = {
    actingSubject: actor, request,
    grant: async (scope, action) => { grants.push(`${action} ${scope}`); },
  };
  try {
    await applyAnimeMangaZones(port, [dated, quiet]);
    const created = writes.filter(item => item.method === 'POST' && item.path === '/v1/works');
    expect(created).toHaveLength(2);
    for (const item of created) {
      expect(item.body).toMatchObject({
        profile: 'metadata-only-v1', authoring: 'catalogue', grain: 'new-creative-scope', actingSubject: actor,
      });
    }
    expect(grants).toContain('catalogue.verify catalogue:verify:root');
    const datedWork = works.get('Dated series');
    const quietWork = works.get('No year');
    const years = writes.filter(item => item.method === 'POST' && item.path === '/v1/statements'
      && (item.body as { value?: { datatype?: string } }).value?.datatype === DATE);
    expect(years).toHaveLength(1);
    expect(years[0]?.body).toMatchObject({
      subject: datedWork, predicate: publication.component, relationDefinition: publication.revision,
      value: { kind: 'literal', lexical: '1980-01-01', datatype: DATE, language: null },
    });
    const statement = (years[0]?.response as { statement: string }).statement;
    const decisions = writes.filter(item => item.method === 'POST' && item.path === '/v1/statement-decisions'
      && (item.body as { target?: { statement?: string } }).target?.statement === statement);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.body).toMatchObject({
      acceptance: { kind: 'global' }, outcome: 'accepted', expectedDecisionHead: null, actingSubject: actor,
    });
    expect(writes.some(item => item.method === 'POST' && item.path === '/v1/statements'
      && (item.body as { subject?: string }).subject === quietWork
      && (item.body as { value?: { datatype?: string } }).value?.datatype === DATE)).toBe(false);
    const themes = writes.filter(item => item.method === 'PUT' && item.path.endsWith('/configuration'))
      .map(item => (item.body as { presentation?: { official?: { theme?: string } } }).presentation?.official?.theme);
    expect(themes).toEqual([officialTheme('anime'), officialTheme('manga')]);
  } finally {
    for (const sample of [dated, quiet]) {
      rmSync(catalogueIntakePath(epoch, actor, seedKey('catalogue-work', sample.key)), { force: true });
    }
  }
});

function respond(method: string, pathname: string, epoch: string, body: unknown, works: Map<string, string>): HttpResult {
  const id = `https://rezics.com/id/${randomUUID()}`;
  const ok = (value: unknown, status = 200): HttpResult => ({ status, body: value });
  if (method === 'GET' && pathname === '/v1/lexicon/definitions/statement-first-publication-date-v1') {
    return ok({ kind: 'property', lifecycle: 'active', definition: publication.component,
      revision: publication.revision, roles: [] });
  }
  if (method === 'GET' && pathname.endsWith('/configuration')) {
    return ok({ revision: id, name: 'Zone', language: 'en', configuration: { defaultRealm: null, official: null,
      presentation: null } });
  }
  if (method === 'GET' && pathname.startsWith('/v1/collections/')) {
    return ok({ structure: id, revision: id, next: null, occurrences: [] });
  }
  if (method === 'GET' && pathname.startsWith('/v1/zones/')) return ok({ revision: id, mounts: [] });
  if (method === 'GET' && pathname.endsWith('/metadata')) return { status: 404, body: {} };
  if (method === 'POST' && pathname === '/v1/catalogue/candidates') {
    return ok({ candidateReceipt: randomUUID(), sourcePosition: { dataEpoch: epoch } });
  }
  if (method === 'POST' && pathname === '/v1/classification-vocabulary') {
    return ok({ scheme: id, schemeHead: id, concept: id, definitionRevision: id });
  }
  if (method === 'POST' && pathname === '/v1/semantic/changes') return ok({ component: id, revision: id });
  if (method === 'POST' && pathname === '/v1/contexts') return ok({ context: id, semanticRevision: id });
  if (method === 'POST' && pathname.endsWith('/spoiler-hints')) return ok({});
  if (method === 'POST' && pathname === '/v1/works') {
    const title = (body as { title?: string }).title ?? '';
    works.set(title, id);
    return ok({ work: id, mainVersion: `https://rezics.com/id/${randomUUID()}`, workRevision: id, mainRevision: id,
      replayed: false }, 201);
  }
  if (method === 'POST' && pathname === '/v1/spaces') {
    return ok({ space: `https://rezics.com/id/${randomUUID()}`, realm: `https://rezics.com/id/${randomUUID()}` });
  }
  if (method === 'POST' && pathname === '/v1/statements') return ok({ statement: id, meaningKey: id });
  if (method === 'POST' && pathname === '/v1/statement-decisions') return ok({});
  if (method === 'POST' && pathname === '/v1/contributions') return ok({ contribution: id, draftRevision: id });
  if (method === 'POST' && pathname === '/v1/contribution-publications') return ok({ publicationDecision: id });
  if (method === 'POST' && pathname === '/v1/publication-selections') return ok({});
  if (method === 'POST' && pathname === '/v1/zones' || method === 'POST' && pathname === '/v1/collections') return ok({});
  if (method === 'POST' && pathname.endsWith('/changes')) return ok({ revision: id });
  if (method === 'POST' && pathname.endsWith('/mounts')) return ok({});
  if (method === 'PUT') return ok({ revision: id });
  throw new Error(`unhandled ${method} ${pathname}`);
}
