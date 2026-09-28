import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dryRunLines, parseOptions, steps } from '../../../scripts/dev/seed/cli.ts';
import { people, realms, seedKey, semanticTypes, works } from '../../../scripts/dev/seed/plan.ts';
import type { SeedApi } from '../../../scripts/dev/seed/api.ts';
import { devResetPlan, devResetTarget } from '../../../scripts/dev/reset.ts';
import { seedWorks } from '../../../scripts/dev/seed/works-step.ts';
import { seedContributions } from '../../../scripts/dev/seed/contributions-step.ts';
import { checkPublicReads } from '../../../scripts/dev/seed/checks-step.ts';
import { seedChapterProgress } from '../../../scripts/dev/seed/progress.ts';
import { refreshSeedTokens, type SeedState, type WorkReceipt }
  from '../../../scripts/dev/seed/state.ts';
import { openLibraryFixtureFetch } from '../../../scripts/dev/seed/open-library-fixtures.ts';
import { demoClassics } from '../../fixtures/sources/open-library.ts';
import { publicTexts } from '../../../scripts/dev/seed/official-plan.ts';

describe('dev seed plan', () => {
  test('contains distinct stable Accounts, Works and Realms across both languages', () => {
    expect(people).toHaveLength(7);
    expect(new Set(people.map(person => person.email)).size).toBe(people.length);
    expect(works.length).toBeGreaterThanOrEqual(25);
    expect(works.length).toBeLessThanOrEqual(40);
    expect(new Set(works.map(work => work.id)).size).toBe(works.length);
    expect(realms.map(realm => realm.id)).toEqual([
      'fiction', 'books', 'mods', 'ai-workshop', 'software', 'kitchen',
    ]);
    expect(realms.every(realm => realm.featured.length > 0
      && realm.featured.every(id => works.some(work => work.id === id)))).toBe(true);
    expect(new Set(works.map(work => work.language))).toEqual(new Set(['en', 'zh-Hans']));
    expect(new Set(works.map(work => work.type))).toEqual(new Set(['book', 'document', 'recipe']));
    expect(works.filter(work => work.excerpt).length).toBeGreaterThanOrEqual(5);
  });

  test('uses stable bounded operation keys and valid type IRIs', () => {
    const keys = works.map(work => seedKey('work', work.id));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(key => /^[A-Za-z0-9:_./-]{1,128}$/.test(key))).toBe(true);
    expect(semanticTypes('book')).toEqual(['https://schema.org/Book']);
    expect(semanticTypes('recipe')).toEqual(['https://schema.org/Recipe']);
    expect(semanticTypes('document')).toEqual(['https://schema.org/DigitalDocument']);
  });

  test('attributes original Works to their creators and leaves imported classics unclaimed by demo authors', () => {
    expect(works.find(work => work.id === 'serial')?.author).toBe('mei');
    expect(works.find(work => work.id === 'moonlight-story')?.author).toBe('moonlight');
    for (const id of ['pride', 'alice', 'journey-west', 'jane-eyre']) {
      expect(works.find(work => work.id === id)?.author).toBeUndefined();
    }
  });

  test('locks a Work, linked edition and every referenced author for each imported classic', async () => {
    const root = resolve(import.meta.dir, '../../..');
    const lock = JSON.parse(readFileSync(`${root}/tests/fixtures/fixtures.lock.json`, 'utf8')) as {
      entries: { id: string; requestUrl: string; sha256: string; fetchedAt: string;
        reuseBasis: string }[] };
    const entries = new Map(lock.entries.map(entry => [entry.id, entry]));
    const fetcher = openLibraryFixtureFetch(root);
    expect(demoClassics).toHaveLength(14);
    for (const classic of demoClassics) {
      expect(publicTexts[classic.id]?.text).toMatch(/^(Reading note|导读)\n/);
      const workEntry = entries.get(`work-${classic.work}`)!;
      const editionEntry = entries.get(`edition-${classic.edition}`)!;
      expect(workEntry.requestUrl).toBe(`https://openlibrary.org/works/${classic.work}.json`);
      expect(editionEntry.requestUrl).toBe(`https://openlibrary.org/books/${classic.edition}.json`);
      expect(new Date(workEntry.fetchedAt).toISOString()).toBe(workEntry.fetchedAt);
      expect(workEntry.reuseBasis).toContain('CC0');
      const work = await (await fetcher(workEntry.requestUrl)).json() as {
        authors: { author: { key: string } }[] };
      const edition = await (await fetcher(editionEntry.requestUrl)).json() as {
        works: { key: string }[] };
      expect(edition.works).toContainEqual({ key: `/works/${classic.work}` });
      expect(work.authors.length).toBeGreaterThan(0);
      for (const author of work.authors) {
        const id = author.author.key.slice('/authors/'.length);
        const authorEntry = entries.get(`author-${id}`)!;
        expect(authorEntry?.requestUrl).toBe(`https://openlibrary.org/authors/${id}.json`);
        expect((await (await fetcher(authorEntry.requestUrl)).json() as { name: string }).name)
          .toBeTruthy();
      }
    }
    expect((await fetcher('https://openlibrary.org/works/OL1W.json')).status).toBe(404);
  });

  test('renews expired demo and operator tokens before a long seed phase', async () => {
    const calls: string[] = [];
    const state = { api: { token: async (cookie: string) => {
      calls.push(cookie); return `new-${cookie}`;
    } },
    sessions: [
      { cookie: 'expired', token: 'old', issuedAt: Date.now() - 121_000 },
      { cookie: 'fresh', token: 'current', issuedAt: Date.now() },
    ], operatorSession: { api: { token: async (cookie: string) => {
      calls.push(cookie); return `new-${cookie}`;
    } }, cookie: 'operator', token: 'old-operator', issuedAt: Date.now() - 121_000 },
    } as unknown as SeedState;
    await refreshSeedTokens(state);
    expect(calls).toEqual(['expired', 'operator']);
    expect(state.sessions.map(session => session.token)).toEqual(['new-expired', 'current']);
    expect(state.operatorSession?.token).toBe('new-operator');
  });

  test('creates every original Work under its author', async () => {
    const calls: Array<{ body: Record<string, unknown>; key: string }> = [];
    const api = { post: async (_path: string, body: Record<string, unknown>, token: string, key: string) => {
      calls.push({ body, key });
      if (key === seedKey('work', 'bun')) expect(token).toBe('daniel');
      return { work: `https://rezics.com/id/${'1'.repeat(36)}`, mainVersion: 'v',
        workRevision: 'r', mainRevision: 'm', replayed: false } satisfies WorkReceipt;
    } } as unknown as SeedApi;
    const state = { api, sessions: people.map(person => ({ id: person.id, accountId: person.id,
      token: person.id, actingSubject: `https://rezics.com/id/${person.id}` })),
    penAgents: new Map([['moonlight', 'https://rezics.com/id/moonlight']]),
    created: new Map(), optional: async () => null } as unknown as SeedState;
    await seedWorks(state);
    expect(calls.find(call => call.key === seedKey('work', 'pride'))).toBeUndefined();
    expect(calls.find(call => call.key === seedKey('work', 'moonlight-story'))?.body)
      .toMatchObject({ authoring: 'own-work', actingSubject: 'https://rezics.com/id/moonlight' });
    expect(calls.find(call => call.key === seedKey('work', 'bun'))?.body)
      .toMatchObject({ authoring: 'own-work', actingSubject: 'https://rezics.com/id/daniel' });
    expect(calls.filter(call => call.key === seedKey('work', 'serial')).map(call => call.body.authoring))
      .toEqual(['own-work']);
    expect(state.created.size).toBe(works.length - demoClassics.length);
  });

  test('reset targets only the fixed dev project or this worktree and refuses displaced object paths', () => {
    const root = '/checkout/.temp/worktrees/g-341';
    expect(devResetTarget(root, true)).toEqual({ profile: 'qa', runId: 'wt-g-341', accountsApp: true });
    const plan = devResetPlan(root, devResetTarget(root, true));
    expect(plan.volumes).toEqual(['rezics-qa-wt-g-341_postgres_data',
      'rezics-qa-wt-g-341_fuseki_data', 'rezics-qa-wt-g-341_rustfs_data']);
    expect(plan.files.every(file => file.startsWith(`${plan.dir}/`))).toBe(true);
    expect(() => devResetPlan(root, { profile: 'qa', runId: 'other' })).toThrow('fixed dev project');
    expect(() => devResetPlan(root, devResetTarget(root, true), {
      MAIN_OBJECT_DIRECTORY: '/checkout/.temp/stack/rezics-dev/objects',
      MAIN_CANDIDATE_DIRECTORY: `${plan.dir}/candidates`,
    })).toThrow('Saved dev object paths differ');
  });

  test('reports a seeded Work with neither native nor retained source author', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => new Response(JSON.stringify(
      String(input).includes('/v1/works?') ? { items: [{}] } : {}), { status: 200 })) as typeof fetch;
    try {
      const findings = new Set<string>();
      const state = { endpoints: { main: 'http://localhost:3001' }, findings,
        created: new Map([['pride', { work: `https://rezics.com/id/${'1'.repeat(36)}` }],
          ['serial', { work: `https://rezics.com/id/${'2'.repeat(36)}` }]]),
        sessions: [{ id: 'mei', token: 'token', actingSubject: 'https://rezics.com/id/mei' }],
        api: { get: async (path: string) => ({ items: path.includes('22222222')
          && path.includes('/agent-credits') ? [{ role: 'author' }] : [] }) },
        optional: async (_label: string, operation: () => Promise<unknown>) => operation(),
      } as unknown as SeedState;
      await checkPublicReads(state);
      expect(findings).toContain('Work pride has no credited author');
      expect(findings).not.toContain('Work serial has no credited author');
    } finally { globalThis.fetch = originalFetch; }
  });

  test('original text contributions use the credited author session', async () => {
    const calls: Array<{ key: string; actor: string; token: string }> = [];
    const state = { api: { post: async (_path: string, body: { actingSubject: string }, token: string,
      key: string) => {
      calls.push({ key, actor: body.actingSubject, token });
      return { contribution: 'contribution', draftRevision: 'revision' };
    } },
    sessions: people.map(person => ({ id: person.id, token: person.id,
      actingSubject: `https://rezics.com/id/${person.id}` })),
    penAgents: new Map([['moonlight', 'https://rezics.com/id/moonlight']]),
    created: new Map(works.map(work => [work.id, { work: `https://rezics.com/id/${work.id}` }])),
    publicForRealm: new Map(), optional: async (label: string, operation: () => Promise<unknown>) =>
      label === 'Text contribution' ? operation() : null,
    } as unknown as SeedState;
    await seedContributions(state);
    expect(calls.find(call => call.key === seedKey('contribution', 'bun')))
      .toMatchObject({ token: 'daniel', actor: 'https://rezics.com/id/daniel' });
    expect(calls.find(call => call.key === seedKey('contribution', 'moonlight-story')))
      .toMatchObject({ token: 'mei', actor: 'https://rezics.com/id/moonlight' });
    expect(calls.find(call => call.key === seedKey('contribution', 'pride'))).toBeUndefined();
  });

  test('replaces the old parent-as-chapter placement with three child Works on rerun', async () => {
    const ref = (digit: string) => `https://rezics.com/id/${digit.repeat(36)}`;
    const receipt = (digit: string) => ({ work: ref(digit), mainVersion: ref('9') });
    const created = new Map([['serial', receipt('1')], ['serial-ch1', receipt('2')],
      ['serial-ch2', receipt('3')], ['serial-ch3', receipt('4')]]);
    const structure = ref('5');
    let children = [
      { occurrence: ref('6'), state: 'active', role: 'chapter', target: ref('1') },
      { occurrence: ref('7'), state: 'active', role: 'chapter', target: ref('3') },
    ];
    const migrations: Array<{ operations: Array<{ op: string; target?: string }> }> = [];
    const progress: string[] = [];
    const api = {
      post: async (_path: string, body: { operations?: Array<{ op: string; target?: string }> },
        _token: string, key: string) => {
        if (key === seedKey('composition', 'serial')) return { structure, revision: ref('8') };
        if (key === seedKey('composition-remove-parent-chapter', 'serial')) {
          migrations.push({ operations: body.operations! });
          children = [children[1]!];
        }
        if (key === seedKey('composition-add-real-chapters', 'serial')) {
          migrations.push({ operations: body.operations! });
          children = [children[0]!,
            { occurrence: ref('a'), state: 'active', role: 'chapter', target: ref('2') },
            { occurrence: ref('b'), state: 'active', role: 'chapter', target: ref('4') }];
        }
        return { revision: ref('8'), occurrences: [] };
      },
      get: async () => ({ revision: ref('8'), occurrences: children }),
      put: async (path: string) => { progress.push(path); return {}; },
    } as unknown as SeedApi;
    const owner = { token: 'token', actingSubject: ref('c') };
    const readers = ['a', 'b', 'c'].map(id => ({ id, token: id, actingSubject: ref(id) }));
    await seedChapterProgress(api, owner, readers, created);
    await seedChapterProgress(api, owner, readers, created);
    expect(migrations).toHaveLength(2);
    expect(migrations.flatMap(migration => migration.operations.map(operation => operation.op)))
      .toEqual(['remove', 'insert', 'insert']);
    expect(migrations[1]!.operations
      .map(operation => operation.target)).toEqual([ref('2'), ref('4')]);
    expect(progress).toHaveLength(6);
  });

  test('accepts only the documented CLI switches', () => {
    expect(parseOptions([])).toEqual({ dryRun: false, resetOwn: false });
    expect(parseOptions(['--dry-run', '--reset-own'])).toEqual({ dryRun: true, resetOwn: true });
    expect(() => parseOptions(['--remove-all'])).toThrow('Usage:');
  });

  test('dry run prints every demo sign-in and keeps one ordered list of seed steps', () => {
    const lines = dryRunLines();
    for (const person of people) {
      expect(lines).toContain(`  ${person.name}: ${person.email} / ${person.password}`);
    }
    expect(steps.map(step => step.name)).toEqual([
      'seedAccounts', 'seedClassics', 'seedWorks', 'seedContributions', 'seedRealms', 'seedAdoptions',
      'seedRatings', 'seedLibrary', 'seedChapters', 'seedModeration', 'seedHomeFeed',
      'seedProfileCredits', 'seedProfileBios', 'seedProfileShelves', 'seedProfileFollows', 'seedOfficialZones',
      'checkPublicReads', 'printSeedReport',
    ]);
  });
});
