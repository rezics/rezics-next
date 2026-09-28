import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dryRunLines, parseOptions, steps } from '../../../scripts/dev/seed/cli.ts';
import { bookConcepts, freeConcepts, genreConcepts, seededBookIds }
  from '../../../scripts/dev/seed/genres-plan.ts';
import { firstSeedTypes, people, realms, seedKey, semanticTypes, works } from '../../../scripts/dev/seed/plan.ts';
import { type SeedApi, SeedApiError } from '../../../scripts/dev/seed/api.ts';
import { devResetPlan, devResetTarget } from '../../../scripts/dev/reset.ts';
import { seedWorks } from '../../../scripts/dev/seed/works-step.ts';
import { seedContributions } from '../../../scripts/dev/seed/contributions-step.ts';
import { checkPublicReads } from '../../../scripts/dev/seed/checks-step.ts';
import { seedChapterProgress } from '../../../scripts/dev/seed/progress.ts';
import { prepareHomeV2Chapters } from '../../../scripts/dev/seed/home-v2.ts';
import { derivedId } from '../../../services/main/src/modules/structure/graph.ts';
import { refreshSeedTokens, type SeedState, type WorkReceipt }
  from '../../../scripts/dev/seed/state.ts';
import { openLibraryFixtureFetch } from '../../../scripts/dev/seed/open-library-fixtures.ts';
import { demoClassics } from '../../fixtures/sources/open-library.ts';
import { officialHubItems, officialMods, publicTexts, zoneContent, extraWorks }
  from '../../../scripts/dev/seed/official-plan.ts';

describe('dev seed plan', () => {
  test('every demo Book has two to four usable Concepts and the genre vocabulary covers both languages', () => {
    const assigned = new Set(Object.keys(bookConcepts));
    expect(assigned).toEqual(new Set(seededBookIds));
    const labels = { ...genreConcepts, ...freeConcepts };
    for (const concepts of Object.values(bookConcepts)) {
      expect(concepts.length).toBeGreaterThanOrEqual(2);
      expect(concepts.length).toBeLessThanOrEqual(4);
      expect(new Set(concepts).size).toBe(concepts.length);
      for (const concept of concepts) expect(labels[concept]).toBeTruthy();
    }
    expect(Object.values(genreConcepts).some(label => label.includes('玄幻'))).toBe(true);
    expect(Object.values(genreConcepts).some(label => label.includes('悬疑'))).toBe(true);
  });

  test('official mod and Hub cards have typed public Works and bounded distinct native seeds', () => {
    const extra = new Map(extraWorks.map(work => [work.id, work]));
    expect(officialMods.length).toBeGreaterThanOrEqual(4);
    for (const mod of officialMods) {
      expect(mod.nativeId).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(extra.get(mod.id)?.type).toBe('mod');
      expect(zoneContent.mods.adopt).toContain(mod.id);
    }
    for (const item of officialHubItems) {
      expect(extra.get(item.id)?.type).toBe(item.kind);
      expect(zoneContent['ai-workshop'].adopt).toContain(item.id);
      expect(item.content.length).toBeGreaterThan(80);
    }
    expect(new Set([...officialMods, ...officialHubItems].map(item => item.id)).size)
      .toBe(officialMods.length + officialHubItems.length);
  });
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
    expect(new Set(works.map(work => work.type))).toEqual(new Set(['book', 'document', 'recipe', 'prompt', 'skill', 'mod']));
    expect(works.filter(work => work.excerpt).length).toBeGreaterThanOrEqual(5);
  });

  test('uses stable bounded operation keys and valid type IRIs', () => {
    const keys = works.map(work => seedKey('work', work.id));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(key => /^[A-Za-z0-9:_./-]{1,128}$/.test(key))).toBe(true);
    expect(semanticTypes('book')).toEqual(['https://schema.org/Book']);
    expect(semanticTypes('recipe')).toEqual(['https://schema.org/Recipe']);
    expect(semanticTypes('document')).toEqual(['https://schema.org/DigitalDocument']);
    expect(semanticTypes('prompt')).toEqual(['https://rezics.com/vocab/PromptTemplate']);
    expect(semanticTypes('skill')).toEqual(['https://rezics.com/vocab/SkillPackage']);
    expect(semanticTypes('mod')).toEqual(['https://rezics.com/vocab/ModPackage']);
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
    // Each Work names its language and kind, so a Chinese serial is not recorded as English.
    expect(calls.find(call => call.key === seedKey('work', 'serial'))?.body)
      .toMatchObject({ language: 'zh-Hans', semanticTypes: ['https://schema.org/Book'] });
    expect(calls.find(call => call.key === seedKey('work', 'prompt'))?.body)
      .toMatchObject({ language: 'en', semanticTypes: ['https://rezics.com/vocab/PromptTemplate'] });
    expect(state.created.size).toBe(works.length - demoClassics.length);
  });

  test('replays a Work an earlier seed recorded without language and kind', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const attempted = new Set<string>();
    const api = { post: async (_path: string, body: Record<string, unknown>, _token: string, key: string) => {
      calls.push(body);
      if (!attempted.has(key)) {
        attempted.add(key);
        throw new SeedApiError('Main /v1/works', 409, '{"code":"idempotency_conflict"}');
      }
      const work = works.find(work => seedKey('work', work.id) === key)!;
      // Main requires language now; the old missing language was digested as English.
      expect(body).toMatchObject({ language: 'en', semanticTypes: firstSeedTypes(work.type) });
      return { work: `https://rezics.com/id/${'1'.repeat(36)}`, mainVersion: 'v', workRevision: 'r',
        mainRevision: 'm', replayed: true } satisfies WorkReceipt;
    } } as unknown as SeedApi;
    const state = { api, sessions: people.map(person => ({ id: person.id, accountId: person.id,
      token: person.id, actingSubject: `https://rezics.com/id/${person.id}` })),
    penAgents: new Map([['moonlight', 'https://rezics.com/id/moonlight']]),
    created: new Map(), optional: async () => null } as unknown as SeedState;
    await seedWorks(state);
    const retried = calls.filter((_body, index) => index % 2 === 1);
    expect(retried.find(body => body.title === 'Bilingual book club discussion prompt'))
      .toMatchObject({ semanticTypes: ['https://schema.org/DigitalDocument'] });
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
        optional: async (label: string, operation: () => Promise<unknown>) =>
          label.startsWith('Work author check ') ? operation() : null,
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

  describe('the home serial reads in order', () => {
    const ref = (digit: string) => `https://rezics.com/id/${digit.repeat(36)}`;
    const serial = { work: ref('1'), mainVersion: ref('9') };
    const author = { id: 'mei', token: 'mei', actingSubject: ref('c') };
    const structure = ref('5');
    const titles = works.find(work => work.id === 'serial')!.chapters!.map(chapter => chapter.title);
    type Item = { occurrence: string; role: string; label: { value: string } | null; target: string | null;
      selectedRevision: string | null };
    /** Main as the seed sees it: the serial's contents, and the commands it sends. */
    function main(initial: Item[] | null) {
      let items = initial;
      let head = ref('8');
      const posts: Array<{ path: string; key: string; body: { operations?: Array<Record<string, unknown>> } }> = [];
      const api = {
        get: async () => {
          if (!items) throw new SeedApiError('Main contents', 404, '{}');
          return { compositionRevision: head, items };
        },
        post: async (path: string, body: { title?: string; operations?: Array<{ op: string; occurrence: string }> },
          _token: string, key: string) => {
          posts.push({ path, key, body });
          if (path === '/v1/compositions') return { structure, revision: head };
          if (path.endsWith('/chapters')) {
            const seed = `${serial.work}\0${author.actingSubject}\0${key}\0chapter`;
            const work = derivedId(`${seed}\0work`);
            items = [...items ?? [], { occurrence: ref(String(items?.length ?? 0)), role: 'chapter',
              label: { value: body.title! }, target: work, selectedRevision: `urn:rezics:content:revision:${work.slice(-36)}` }];
            return { work, compositionRevision: head };
          }
          if (path.endsWith('/changes')) {
            const moved = body.operations!.map(operation => items!.find(item => item.occurrence === operation.occurrence)!);
            items = [...moved, ...items!.filter(item => !moved.includes(item))];
            head = ref('7');
            return { revision: head };
          }
          if (path === '/v1/content-drafts') return { revisionId: 'revision', sourcePosition: { dataEpoch: 'epoch' } };
          if (path === '/v1/content-publications') return { decision: 'decision', status: 'active' };
          return {};
        },
        endpoints: { main: 'http://main.test' },
      } as unknown as SeedApi;
      return { api, posts, items: () => items };
    }
    const grants: string[] = [];
    const grant = async (list: readonly { scope: string }[]) => { grants.push(...list.map(item => item.scope)); };

    test('a clean stack makes each chapter a part of the Book, in plan order', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => Response.json({ reference: { byteDigest: 'digest' } })) as unknown as typeof fetch;
      try {
        const stack = main(null);
        const arranged = await prepareHomeV2Chapters(stack.api, author, new Map([['serial', serial]]), grant);
        const made = stack.posts.filter(post => post.path.endsWith('/chapters'));
        expect(made.map(post => (post.body as { title: string }).title)).toEqual(titles);
        expect(made.every(post => (post.body as { position: string }).position === 'last')).toBe(true);
        expect(stack.posts.filter(post => post.path.endsWith('/changes'))).toEqual([]);
        expect(stack.items()!.map(item => item.label?.value)).toEqual(titles);
        expect(arranged.occurrences).toEqual(stack.items()!.map(item => item.occurrence));
        // No standalone Work stands for a chapter.
        expect(works.some(work => work.id.startsWith('serial-ch'))).toBe(false);
      } finally { globalThis.fetch = originalFetch; }
    });

    test('an existing stack keeps its chapters and moves them into order once', async () => {
      const chapter = (index: number, digit: string) => ({ occurrence: ref(digit), role: 'chapter',
        label: { value: titles[index]! }, target: ref(String(index + 2)), selectedRevision: 'urn:rezics:content:revision:x' });
      const stack = main([chapter(1, 'a'), chapter(0, 'b'), chapter(2, 'd')]);
      const arranged = await prepareHomeV2Chapters(stack.api, author, new Map([['serial', serial]]), grant);
      const changes = stack.posts.filter(post => post.path.endsWith('/changes'));
      expect(changes).toHaveLength(1);
      expect(changes[0]!.body.operations).toEqual([
        { op: 'move', occurrence: ref('b'), parent: structure, position: 'first' },
        { op: 'move', occurrence: ref('a'), parent: structure, position: { after: ref('b') } },
        { op: 'move', occurrence: ref('d'), parent: structure, position: { after: ref('a') } }]);
      expect(stack.posts.some(post => post.path.endsWith('/chapters') || post.path === '/v1/content-drafts')).toBe(false);
      expect(arranged.occurrences).toEqual([ref('b'), ref('a'), ref('d')]);
      await prepareHomeV2Chapters(stack.api, author, new Map([['serial', serial]]), grant);
      expect(stack.posts.filter(post => post.path.endsWith('/changes'))).toHaveLength(1);
    });

    test('each reader is in one chapter, having finished the ones before it', async () => {
      const writes: Array<{ path: string; completed: boolean }> = [];
      const api = { put: async (path: string, body: { completed: boolean }) => {
        writes.push({ path, completed: body.completed });
        return {};
      } } as unknown as SeedApi;
      const readers = ['a', 'b', 'c'].map(id => ({ id, token: id, actingSubject: ref(id) }));
      await seedChapterProgress(api, readers, { structure, occurrences: [ref('b'), ref('a'), ref('d')] });
      const at = (digit: string) => `/occurrences/${digit.repeat(36)}/progress`;
      expect(writes.map(write => [write.path.slice(write.path.indexOf('/occurrences')), write.completed])).toEqual([
        [at('b'), true],
        [at('b'), true], [at('a'), false],
        [at('b'), true], [at('a'), true], [at('d'), false]]);
    });
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
      'seedLibrary', 'seedChapters', 'seedModeration', 'seedHomeFeed',
      'seedProfileCredits', 'seedProfileBios', 'seedProfileFollows', 'seedOfficialZones', 'seedRecipes', 'seedBookConcepts',
      'seedOfficialThemes',
      // Shelves, ratings and votes wait for readable classics and community Realms (G-385).
      'seedProfileShelves', 'seedCommunityRealms', 'seedCommunityDiscussions', 'seedReadingLives',
      'seedRatings', 'seedReviews', 'seedCommunityVotes', 'seedCoReaders',
      'checkPublicReads', 'printSeedReport',
    ]);
  });
});
