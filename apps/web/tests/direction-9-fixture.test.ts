import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PublicCommands, seedDirection, type PublicRequest } from './direction-9-fixture.ts';

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
        return { status: () => statuses.shift()!, json: async () => ({ agent: 'created' }) };
      },
    };
    const api = new PublicCommands(request, async () => {
      waits++;
    });
    expect(await api.write('/agents', { kind: 'person' })).toEqual({ agent: 'created' });
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

  test('fresh-dataset recipe isolates four admission journeys and exceeds both picker windows', async () => {
    const commands: { path: string; data: Record<string, unknown> }[] = [];
    const iri = () => `https://rezics.com/id/${randomUUID()}`;
    const actor = iri();
    const api = new PublicCommands({
      get: async () => ({ status: () => 200, json: async () => ({ generation: '0' }) }),
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
    expect(
      commands.filter((command) => command.path.endsWith('/rating-observations')).length,
    ).toBeGreaterThan(20);
    const chapters = commands.filter(
      (command) => command.path.includes('/compositions/') && command.path.endsWith('/changes'),
    );
    expect(chapters).toHaveLength(5);
    expect(chapters.flatMap((command) => command.data.operations as unknown[])).toHaveLength(80);
    expect(fixture.laterChapter.name).toContain('遠方 chapter 80');
    expect(commands.every((command) => command.path.startsWith('/api/main/v1/'))).toBe(true);
    expect(
      commands.filter((command) => command.path.endsWith('/contribution-publications')),
    ).toHaveLength(2);
    expect(commands.filter((command) => command.path.endsWith('/zones'))).toHaveLength(1);
  });
});
