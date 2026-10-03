import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  directionFixture,
  parallel,
  PublicCommands,
  resetAdmission,
  resetSubmission,
  seedDirection,
  seedRatingPopulations,
  prepareSubmissionReview,
  seedWikiPosition,
  type DirectionFixture,
  type PublicRequest,
} from './direction-9-fixture.ts';

describe('Direction 9 public fixture commands', () => {
  function wikiRecipe(options: { missing?: boolean; fallback?: boolean; document?: boolean } = {}) {
    const iri = () => `https://rezics.com/id/${randomUUID()}`;
    const space = iri(), zone = iri(), work = iri(), structure = iri();
    const fixture = { owner: iri(), actor: iri(), work: { work: iri() }, story: { work: iri() } } as DirectionFixture;
    const items = Array.from({ length: 3 }, (_, index) => ({
      occurrence: iri(), structure, labels: [{ value: `Chapter ${index + 1}`, language: 'en' }],
    }));
    const writes: { path: string; data: Record<string, unknown> }[] = [];
    let failAfter: number | undefined;
    let head = iri();
    const api = new PublicCommands({
      get: async (path) => {
        const url = new URL(path, 'http://fixture.test');
        let body: unknown;
        if (url.pathname.endsWith('/addresses/resolve'))
          body = { holder: space, capabilities: { zone } };
        else if (url.pathname.endsWith('/presentation'))
          body = { official: 'franchise-wiki', execution: { state: options.fallback ? 'fallback' : 'package' } };
        else if (url.pathname.endsWith('/routes')) {
          expect(url.searchParams.get('path')).toBe('/franchise');
          body = options.document ? { kind: 'document' } : { kind: 'index', items: [{ id: work, title: {} }] };
        } else if (url.pathname.includes('/reading-positions/')) {
          expect(url.pathname).toEndWith(work.slice(-36));
          const q = url.searchParams.get('q') ?? '';
          const selected = items.filter((item) => item.labels.some((label) => label.value.includes(q)));
          const limit = Number(url.searchParams.get('limit') ?? 50);
          body = { items: selected.slice(0, limit), complete: selected.length <= limit,
            nextCursor: selected.length > limit ? 'next' : null };
        } else if (url.pathname.includes('/compositions/')) body = { revision: head };
        else throw new Error(`Unexpected wiki read ${path}`);
        return { status: () => options.missing && url.pathname.endsWith('/addresses/resolve') ? 404 : 200,
          json: async () => body };
      },
      fetch: async (path, options) => {
        if (failAfter === writes.length) throw new Error('interrupted setup');
        const data = options.data as Record<string, unknown>;
        expect(data.expectedHead).toBe(head);
        writes.push({ path, data });
        for (const operation of data.operations as { label: { value: string; language: string } }[])
          items.push({ occurrence: iri(), structure, labels: [operation.label] });
        head = iri();
        return { status: () => 200, json: async () => ({ revision: head }) };
      },
    });
    return { api, fixture, items, writes, space, zone, work, interruptAfter: (count?: number) => { failAfter = count; } };
  }

  test('wiki positions extend the seeded package story beyond page one and reuse its chapters', async () => {
    const recipe = wikiRecipe();
    const wiki = await seedWikiPosition(recipe.api, recipe.fixture);
    expect(wiki).toMatchObject({ space: recipe.space, zone: recipe.zone, work: recipe.work, mount: 'franchise' });
    expect(wiki.work).not.toBe(recipe.fixture.story.work);
    expect(recipe.items).toHaveLength(54);
    expect(recipe.items.at(-1)?.occurrence).toBe(wiki.laterChapter.occurrence);
    expect(recipe.items.slice(0, 50).some((item) => item.occurrence === wiki.laterChapter.occurrence)).toBe(false);
    expect(wiki.laterChapter.name).toContain('遠方 chapter 51');
    expect(recipe.writes).toHaveLength(4);
    expect(recipe.writes.every(({ path, data }) =>
      path === `/api/main/v1/compositions/${recipe.items[0]!.structure.slice(-36)}/changes`
      && data.actingSubject === recipe.fixture.owner,
    )).toBe(true);
    expect(await seedWikiPosition(recipe.api, recipe.fixture)).toEqual(wiki);
    expect(recipe.writes).toHaveLength(4);
  });

  test('an interrupted wiki extension resumes without replacing seeded chapters or repeating inserts', async () => {
    const recipe = wikiRecipe();
    const originals = recipe.items.map((item) => item.occurrence);
    recipe.interruptAfter(1);
    await expect(seedWikiPosition(recipe.api, recipe.fixture)).rejects.toThrow('interrupted setup');
    expect(recipe.items).toHaveLength(19);
    recipe.interruptAfter();
    await seedWikiPosition(recipe.api, recipe.fixture);
    expect(recipe.items).toHaveLength(54);
    expect(recipe.items.slice(0, 3).map((item) => item.occurrence)).toEqual(originals);
    expect(new Set(recipe.items.map((item) => item.labels[0]!.value)).size).toBe(54);
  });

  for (const [options, message] of [
    [{ missing: true }, 'seeded official franchise-wiki Space and Zone'],
    [{ fallback: true }, 'active franchise-wiki package approval'],
    [{ document: true }, 'story in the franchise mount'],
  ] as const)
    test(`wiki setup fails without ${message}`, async () => {
      const recipe = wikiRecipe(options);
      await expect(seedWikiPosition(recipe.api, recipe.fixture)).rejects.toThrow(message);
      expect(recipe.writes).toHaveLength(0);
    });

  test('pending and unavailable outcomes keep the exact command and idempotency key', async () => {
    const attempts: unknown[] = [];
    const statuses = [202, 503, 201];
    let waits = 0;
    const request: PublicRequest = {
      get: async () => {
        throw new Error('unexpected GET');
      },
      fetch: async (path, options) => {
        attempts.push({ path, ...options });
        const status = statuses.shift()!;
        return { status: () => status, json: async () => ({ agent: 'created' }) };
      },
    };
    const api = new PublicCommands(request, async () => {
      waits++;
    });
    expect(await api.write<{ agent: string }>('/agents', { kind: 'person' })).toEqual({
      agent: 'created',
    });
    expect(waits).toBe(2);
    expect(attempts).toHaveLength(3);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[2]).toEqual(attempts[0]);
  });

  for (const status of [400, 401, 403, 409, 422]) {
    test(`HTTP ${status} is a fixture failure and cannot become a retry or feature skip`, async () => {
      let calls = 0;
      const api = new PublicCommands(
        {
          get: async () => {
            throw new Error('unexpected GET');
          },
          fetch: async () => {
            calls++;
            return { status: () => status, json: async () => ({ code: 'fixture_denied' }) };
          },
        },
        async () => {
          throw new Error('must not wait');
        },
      );
      await expect(api.write('/spaces', {})).rejects.toThrow(`HTTP ${status} (fixture_denied)`);
      expect(calls).toBe(1);
    });
  }

  test('persistent uncertainty is bounded and errors do not disclose response bodies', async () => {
    let calls = 0;
    const api = new PublicCommands(
      {
        get: async () => {
          throw new Error('unexpected GET');
        },
        fetch: async () => {
          calls++;
          return {
            status: () => 503,
            json: async () => ({ code: 'unavailable', password: 'private-fixture-password' }),
          };
        },
      },
      async () => {},
    );
    await expect(api.write('/agents', {})).rejects.toThrow('HTTP 503 (unavailable)');
    expect(calls).toBe(40);
  });

  test('rate-limited writes respect Retry-After and retain the intent', async () => {
    const keys: string[] = [];
    const delays: number[] = [];
    const api = new PublicCommands(
      {
        get: async () => {
          throw new Error('unexpected GET');
        },
        fetch: async (_path, options) => {
          keys.push(options.headers['idempotency-key']!);
          return {
            status: () => (keys.length === 1 ? 429 : 201),
            json: async () => ({}),
            headers: () => ({ 'retry-after': '2' }),
          };
        },
      },
      async (ms) => {
        delays.push(ms);
      },
    );
    await api.write('/spaces', {});
    expect(delays).toEqual([2000]);
    expect(new Set(keys).size).toBe(1);
  });

  test('independent commands run concurrently with a maximum of four', async () => {
    let active = 0,
      maximum = 0;
    const result = await parallel(
      Array.from({ length: 26 }, (_, index) => index),
      async (value) => {
        maximum = Math.max(maximum, ++active);
        await Bun.sleep(1);
        active--;
        return value;
      },
    );
    expect(maximum).toBe(4);
    expect(result).toEqual(Array.from({ length: 26 }, (_, index) => index));
  });

  test('stable fixture command keys survive losing a local manifest', async () => {
    const keys: string[] = [];
    const request: PublicRequest = {
      get: async () => {
        throw new Error('unexpected GET');
      },
      fetch: async (_path, options) => {
        keys.push(options.headers['idempotency-key']!);
        return { status: () => 201, json: async () => ({}) };
      },
    };
    for (let run = 0; run < 2; run++)
      await new PublicCommands(request)
        .reusable('direction-9:actor')
        .write('/spaces', { name: 'stable' });
    expect(keys[0]).toBe(keys[1]);
  });

  test('a denied parallel command stops new writes and drains in-flight outcomes', async () => {
    const completed: number[] = [];
    const started: number[] = [];
    await expect(
      parallel(
        Array.from({ length: 26 }, (_, index) => index),
        async (index) => {
          started.push(index);
          if (index === 0) throw new Error('denied');
          await Bun.sleep(1);
          completed.push(index);
        },
      ),
    ).rejects.toThrow('denied');
    expect(started).toEqual([0, 1, 2, 3]);
    expect(completed).toEqual([1, 2, 3]);
  });

  test('ready projections do not wait, and missing budget policy fails immediately', async () => {
    let waits = 0;
    const api = new PublicCommands(
      {
        get: async (path) => ({
          status: () => (path === '/api/main/v1/ready' ? 200 : 503),
          json: async () =>
            path === '/api/main/v1/ready' ? { ready: true } : { code: 'rate_limit_unclassified' },
        }),
        fetch: async () => {
          throw new Error('unexpected write');
        },
      },
      async () => {
        waits++;
      },
    );
    expect(await api.until<{ ready: boolean }>('/ready', (value) => value.ready)).toEqual({
      ready: true,
    });
    await expect(api.until('/missing-policy', () => false)).rejects.toThrow(
      'rate_limit_unclassified',
    );
    expect(waits).toBe(0);
  });

  test('reusing a live manifest reads its identity and issues no setup writes', async () => {
    const fixture = { actor: 'actor', work: { work: 'work' } } as DirectionFixture;
    const api = new PublicCommands({
      get: async () => ({ status: () => 200, json: async () => ({ holder: 'work' }) }),
      fetch: async () => {
        throw new Error('reuse must not write');
      },
    });
    expect(
      await directionFixture(api, 'actor', api, {
        load: () => fixture,
        save: () => {
          throw new Error('reuse must not save');
        },
      }),
    ).toBe(fixture);
  });

  test('only an interrupted admission and current membership reset; terminal history remains', async () => {
    const commands: { path: string; data: unknown }[] = [];
    const fixture = { actor: 'actor' } as DirectionFixture;
    const space = { space: 'space', realm: 'realm', name: 'private' };
    const api = new PublicCommands({
      get: async (path) => ({
        status: () => 200,
        json: async () =>
          path.includes('/basis')
            ? { state: 'joined', membershipGeneration: '7', policyRevision: '2' }
            : {
                items: [
                  { id: 'old', state: 'accepted' },
                  { id: 'pending', state: 'pending', requestGeneration: '0' },
                ],
                nextCursor: null,
              },
      }),
      fetch: async (path, options) => {
        commands.push({ path, data: options.data });
        return { status: () => 201, json: async () => ({}) };
      },
    });
    expect([...(await resetAdmission(api, fixture, space))]).toEqual(['old', 'pending']);
    expect(commands.map((command) => command.path)).toEqual([
      '/api/main/v1/realms/realm/join-requests/pending/withdraw',
      '/api/main/v1/access/membership-changes',
    ]);
    expect(commands[1]!.data).toMatchObject({
      action: 'leave',
      expectedGeneration: '7',
      expectedPolicyRevision: '2',
    });
  });

  test('a fresh requester has no intent to reset when the private owner returns 404', async () => {
    const api = new PublicCommands({
      get: async (path) => ({
        status: () => (path.includes('/mine?') ? 404 : 200),
        json: async () => ({ state: 'absent', membershipGeneration: '0', policyRevision: '0' }),
      }),
      fetch: async () => {
        throw new Error('fresh admission must not write');
      },
    });
    expect(
      (
        await resetAdmission(api, { actor: 'actor' } as DirectionFixture, {
          space: 'space',
          realm: 'realm',
          name: 'private',
        })
      ).size,
    ).toBe(0);
  });

  test('submission reset withdraws only this journey’s pending Work in its Realm', async () => {
    const writes: string[] = [];
    const api = new PublicCommands({
      get: async () => ({
        status: () => 200,
        json: async () => ({
          items: [
            { id: 'mine', realm: 'realm', work: 'work', revision: 'head' },
            { id: 'other-realm', realm: 'other', work: 'work' },
            { id: 'other-work', realm: 'realm', work: 'other' },
          ],
          nextCursor: null,
        }),
      }),
      fetch: async (path) => {
        writes.push(path);
        return { status: () => 201, json: async () => ({}) };
      },
    });
    await resetSubmission(api, { actor: 'actor', work: { work: 'work' } } as DirectionFixture, {
      space: 'space',
      realm: 'realm',
      name: 'community',
    });
    expect(writes).toEqual(['/api/main/v1/realms/realm/submissions/mine/withdrawals']);
  });

  test('submission preparation makes review reversible and preserves unrelated Realm settings', async () => {
    const calls: unknown[] = [];
    const settings = {
      visibility: 'public',
      whoMaySubmit: 'granted',
      rules: [],
      reviewMode: 'open',
      reviewRequired: false,
    };
    const api = new PublicCommands({
      get: async () => ({
        status: () => 200,
        json: async () => ({ generation: '7', settings, ruleBasis: { revision: '4' } }),
      }),
      fetch: async (_path, options) => {
        calls.push(options);
        return { status: () => 200, json: async () => ({}) };
      },
    });
    await prepareSubmissionReview(api, { owner: 'owner' } as DirectionFixture, {
      space: 'space',
      realm: 'realm',
      name: 'community',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      data: {
        actingSubject: 'owner',
        expectedGeneration: '7',
        expectedRulesRevision: '4',
        settings: { ...settings, reviewMode: 'mandatory', reviewRequired: true },
      },
    });
  });

  for (const administrator of [false, true])
    test(`shared-dataset recipe isolates four admission journeys and exceeds both picker windows (${administrator ? 'administrator setup' : 'owner setup'})`, async () => {
      const commands: { path: string; data: Record<string, unknown> }[] = [];
      const iri = () => `https://rezics.com/id/${randomUUID()}`;
      const actor = iri();
      const api = new PublicCommands({
        get: async (path) => ({
          status: () => 200,
          json: async () =>
            path.includes('/concepts?')
              ? { items: [{ concept: iri(), label: 'Published topic' }] }
              : path.includes('/concepts/')
                ? { name: { value: 'Published topic' } }
                : { generation: '0', roles: [] },
        }),
        fetch: async (path, options) => {
          const data = options.data as Record<string, unknown>;
          commands.push({ path, data });
          return {
            status: () => 201,
            json: async () => ({
              agent: iri(),
              concept: iri(),
              space: iri(),
              realm: iri(),
              work: iri(),
              mainVersion: iri(),
              contribution: iri(),
              draftRevision: iri(),
              publicationDecision: iri(),
              context: iri(),
              structure: iri(),
              revision: iri(),
              occurrences: Array.from({ length: 16 }, iri),
              digest: 'a'.repeat(64),
              generation: '1',
            }),
          };
        },
      });
      const owner = iri();
      const fixture = await seedDirection(
        api,
        actor,
        api,
        undefined,
        administrator ? { api, actor: owner } : undefined,
      );
      await seedRatingPopulations(api, fixture);
      expect(
        commands.filter(
          (command) => command.data.actingSubject === (administrator ? owner : fixture.manager),
        ).length,
      ).toBeLessThan(120);
      expect(commands.some((command) => command.path.endsWith('/classification-vocabulary'))).toBe(
        false,
      );
      expect(new Set(fixture.privateSpaces.map((space) => space.realm)).size).toBe(4);
      expect(commands.filter((command) => command.path.endsWith('/management'))).toHaveLength(26);
      const settings = commands.filter((command) => command.path.endsWith('/settings'));
      expect(
        settings.filter(
          (command) => (command.data.settings as { visibility: string }).visibility === 'private',
        ),
      ).toHaveLength(4);
      expect(
        settings.filter(
          (command) => (command.data.settings as { listing: string }).listing === 'unlisted',
        ),
      ).toHaveLength(1);
      expect(fixture.spaces.length - settings.length).toBeGreaterThan(20);
      expect(
        commands.filter((command) => command.path.endsWith('/rating-observations')).length,
      ).toBe(21);
      const chapters = commands.filter(
        (command) => command.path.includes('/compositions/') && command.path.endsWith('/changes'),
      );
      expect(chapters).toHaveLength(4);
      expect(chapters.flatMap((command) => command.data.operations as unknown[])).toHaveLength(51);
      expect(fixture.laterChapter.name).toContain('遠方 chapter 51');
      expect(commands.every((command) => command.path.startsWith('/api/main/v1/'))).toBe(true);
      expect(
        commands.filter((command) => command.path.endsWith('/contribution-publications')),
      ).toHaveLength(2);
      expect(commands.filter((command) => command.path.endsWith('/zones'))).toHaveLength(1);
      if (administrator) {
        expect(
          commands
            .filter((command) =>
              ['/spaces', '/rating-contexts', '/rating-observations', '/zones'].some((path) =>
                command.path.endsWith(path),
              ),
            )
            .every((command) => command.data.actingSubject === owner),
        ).toBe(true);
        const assignments = commands.filter(
          (command) =>
            command.path.endsWith('/role-changes') &&
            (command.data.change as { kind: string }).kind === 'assignment',
        );
        expect(assignments).toHaveLength(4);
        expect(
          assignments.every(
            (command) => (command.data.change as { member: string }).member === fixture.manager,
          ),
        ).toBe(true);
        expect(
          commands
            .filter((command) => command.path.endsWith('/role-changes'))
            .every((command) => command.data.impactDigest === 'a'.repeat(64)),
        ).toBe(true);
        expect(
          commands
            .filter((command) => command.path.endsWith('/works'))
            .every((command) => command.data.actingSubject === actor),
        ).toBe(true);
      }
    });
});
