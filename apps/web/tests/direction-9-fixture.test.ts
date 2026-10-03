import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  directionFixture,
  parallel,
  PublicCommands,
  resetAdmission,
  resetSubmission,
  seedDirection,
  type DirectionFixture,
  type PublicRequest,
} from './direction-9-fixture.ts';

describe('Direction 9 public fixture commands', () => {
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

  test('shared-dataset recipe isolates four admission journeys and exceeds both picker windows', async () => {
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
              : { generation: '0' },
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
          }),
        };
      },
    });
    const fixture = await seedDirection(api, actor, api);
    expect(commands.length).toBeLessThan(120);
    expect(commands.some((command) => command.path.endsWith('/classification-vocabulary'))).toBe(
      false,
    );
    expect(new Set(fixture.privateSpaces.map((space) => space.realm)).size).toBe(4);
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
    expect(commands.filter((command) => command.path.endsWith('/rating-observations')).length).toBe(
      21,
    );
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
  });
});
