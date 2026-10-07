import { describe, expect, test } from 'bun:test';
import { SeedApiError } from './api.ts';
import {
  readOrCreateOfficialZone,
  updateOfficialZonePresentation,
  type OfficialZoneHead,
  type ZoneSeedApi,
} from './zones.ts';

const zone = 'https://rezics.com/id/00000000-0000-4000-a000-000000000010';
const space = 'https://rezics.com/id/00000000-0000-4000-a000-000000000011';
const actor = 'https://rezics.com/id/00000000-0000-4000-a000-000000000012';
const realm = 'https://rezics.com/id/00000000-0000-4000-a000-000000000013';
const revision = 'https://rezics.com/id/00000000-0000-4000-a000-000000000014';
const zoneId = zone.slice(-36);
const layout = { profile: 'zone-presentation-v1', modules: [{ id: 'picks' }] };
const plain = { profile: 'zone-presentation-v1', modules: [{ id: 'picks', label: 'Picks' }] };

function head(
  presentation: unknown,
  defaultRealm: string | null = realm,
  zoneSpace: string | null = space,
): OfficialZoneHead {
  return { revision, configuration: { space: zoneSpace, defaultRealm, official: {}, presentation } };
}

function problem(status: number, code: string): SeedApiError {
  return new SeedApiError(`Main /v1/zones`, status, JSON.stringify({ code }));
}

interface Call {
  method: string;
  path: string;
  body?: unknown;
  key?: string;
  token: string;
}

function client(respond: (call: Call, calls: Call[]) => unknown) {
  const calls: Call[] = [];
  const api = {
    async get<T>(path: string, token: string): Promise<T> {
      const call = { method: 'GET', path, token };
      calls.push(call);
      if (path === '/v1/themes/execution-control') {
        if (token === 'denied') throw problem(403, 'theme_approval_denied');
        return { disabled: false } as T;
      }
      return (await respond(call, calls)) as T;
    },
    async post<T>(path: string, body: unknown, token: string, key: string): Promise<T> {
      const call = { method: 'POST', path, body, key, token };
      calls.push(call);
      return (await respond(call, calls)) as T;
    },
    async put<T>(path: string, body: unknown, token: string, key: string): Promise<T> {
      const call = { method: 'PUT', path, body, key, token };
      calls.push(call);
      return (await respond(call, calls)) as T;
    },
  } satisfies ZoneSeedApi;
  return { api, calls, writes: () => calls.filter((call) => call.method !== 'GET'),
    operator: { operatorApi: api, operatorToken: 'operator' as const } };
}

const identity = { zone, actor, token: 'steward' };

describe('Official Zone placement on a persistent stack', () => {
  test('an existing Zone with the seed layout is only read', async () => {
    const fixture = client(() => head(layout));
    const found = await readOrCreateOfficialZone(fixture.api, {
      ...identity,
      ...fixture.operator,
      space,
      key: 'dev-seed:v1:zone:fiction',
    });
    expect(found).toEqual(head(layout));
    await updateOfficialZonePresentation(fixture.api, {
      ...identity,
      token: 'operator',
      head: found,
      defaultRealm: realm,
      candidates: [
        { variant: '', presentation: layout },
        { variant: ':plain', presentation: plain },
      ],
      key: (current, variant) => `config:${current.slice(-4)}${variant}`,
    });
    expect(fixture.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
    expect(fixture.writes()).toEqual([]);
  });

  test('a changed presentation is updated and a second pass writes nothing', async () => {
    let current = head({ profile: 'zone-presentation-v1', modules: [] });
    const fixture = client((call) => {
      if (call.method === 'GET') return current;
      current = head(layout, realm);
      return { revision, replayed: false };
    });
    const found = await readOrCreateOfficialZone(fixture.api, {
      ...identity,
      ...fixture.operator,
      space,
      key: 'dev-seed:v1:zone:fiction',
    });
    await updateOfficialZonePresentation(fixture.api, {
      ...identity,
      token: 'operator',
      head: found,
      defaultRealm: realm,
      candidates: [
        { variant: '', presentation: layout },
        { variant: ':plain', presentation: plain },
      ],
      key: (currentRevision, variant) => `config:${currentRevision.slice(-4)}${variant}`,
    });
    expect(fixture.writes()).toEqual([
      {
        method: 'PUT',
        path: `/v1/zones/${zoneId}/configuration`,
        token: 'operator',
        key: `config:${revision.slice(-4)}`,
        body: {
          expectedHead: revision,
          actingSubject: actor,
          defaultRealm: realm,
          official: {},
          presentation: layout,
        },
      },
    ]);
    const before = fixture.calls.length;
    const again = await readOrCreateOfficialZone(fixture.api, {
      ...identity,
      ...fixture.operator,
      space,
      key: 'dev-seed:v1:zone:fiction',
    });
    await updateOfficialZonePresentation(fixture.api, {
      ...identity,
      token: 'operator',
      head: again,
      defaultRealm: realm,
      candidates: [
        { variant: '', presentation: layout },
        { variant: ':plain', presentation: plain },
      ],
      key: () => 'unused',
    });
    expect(fixture.calls.slice(before).map((call) => call.method)).toEqual(['GET', 'GET']);
  });

  test('a missing Zone is created with the original body, then its layout is written', async () => {
    let stored: OfficialZoneHead | null = null;
    const fixture = client((call) => {
      if (call.method === 'GET') {
        if (!stored) throw problem(404, 'zone_unavailable');
        return stored;
      }
      if (call.method === 'POST') {
        stored = head(null);
        return { zone, replayed: false };
      }
      stored = head(layout);
      return { revision };
    });
    const found = await readOrCreateOfficialZone(fixture.api, {
      ...identity,
      ...fixture.operator,
      space,
      key: 'dev-seed:v1:zone:books',
    });
    expect(found.configuration.presentation).toBeNull();
    await updateOfficialZonePresentation(fixture.api, {
      ...identity,
      head: found,
      defaultRealm: realm,
      candidates: [{ variant: '', presentation: layout }],
      key: () => 'dev-seed:v1:official-zone:books:first',
    });
    const create = fixture.calls.find((call) => call.method === 'POST');
    expect(create).toMatchObject({
      path: '/v1/zones',
      key: 'dev-seed:v1:zone:books',
      token: 'steward',
      body: { zone, space, disclosure: 'public', actingSubject: actor },
    });
    expect(fixture.writes().map((call) => call.method)).toEqual(['POST', 'PUT']);
  });

  test('a missing named Zone keeps its name and language on the first create', async () => {
    let stored: OfficialZoneHead | null = null;
    const fixture = client((call) => {
      if (call.method === 'GET') {
        if (!stored) throw problem(404, 'zone_unavailable');
        return stored;
      }
      stored = head(null);
      return { zone, replayed: false };
    });
    await readOrCreateOfficialZone(fixture.api, {
      ...identity,
      ...fixture.operator,
      space,
      key: 'dev-seed:v1:wiki-zone:franchise-wiki',
      name: 'Franchise Wiki',
      language: 'en',
    });
    expect(fixture.writes()).toEqual([
      {
        method: 'POST',
        path: '/v1/zones',
        token: 'steward',
        key: 'dev-seed:v1:wiki-zone:franchise-wiki',
        body: {
          zone,
          space,
          name: 'Franchise Wiki',
          language: 'en',
          disclosure: 'public',
          actingSubject: actor,
        },
      },
    ]);
  });

  test('a drifted create key is not fatal when the Zone can be read afterwards', async () => {
    let reads = 0;
    const fixture = client((call) => {
      if (call.method === 'GET') {
        reads += 1;
        if (reads === 1) throw problem(404, 'zone_unavailable');
        return head(layout);
      }
      throw problem(409, 'idempotency_conflict');
    });
    const found = await readOrCreateOfficialZone(fixture.api, {
      ...identity,
      ...fixture.operator,
      space,
      key: 'dev-seed:v1:zone:mods',
    });
    await updateOfficialZonePresentation(fixture.api, {
      ...identity,
      head: found,
      defaultRealm: realm,
      candidates: [{ variant: '', presentation: layout }],
      key: () => 'unused',
    });
    expect(fixture.writes().map((call) => [call.method, call.path])).toEqual([
      ['POST', '/v1/zones'],
    ]);
    expect(fixture.calls.filter((call) => call.method === 'GET')).toHaveLength(3);
  });

  test('a create conflict leaves the failure in place when the Zone is still absent', async () => {
    const fixture = client((call) => {
      if (call.method === 'GET') throw problem(404, 'zone_unavailable');
      throw problem(409, 'idempotency_conflict');
    });
    await expect(
      readOrCreateOfficialZone(fixture.api, {
        ...identity,
        ...fixture.operator,
        space,
        key: 'dev-seed:v1:zone:games',
      }),
    ).rejects.toThrow('idempotency_conflict');
  });

  test('a denied operator is not treated as an absent Zone', async () => {
    const fixture = client((call) => {
      if (call.method === 'GET') throw problem(404, 'zone_unavailable');
      return { zone };
    });
    await expect(
      readOrCreateOfficialZone(fixture.api, {
        ...identity,
        operatorApi: fixture.api,
        operatorToken: 'denied',
        space,
        key: 'dev-seed:v1:zone:denied',
      }),
    ).rejects.toThrow('Seed operator is not authorized');
    expect(fixture.writes()).toEqual([]);
  });

  test('other create and read failures propagate without a second write', async () => {
    const refused = client(() => {
      throw problem(403, 'official_zone_denied');
    });
    await expect(
      readOrCreateOfficialZone(refused.api, {
        ...identity,
        ...refused.operator,
        space,
        key: 'dev-seed:v1:zone:kitchen',
      }),
    ).rejects.toThrow('official_zone_denied');
    expect(refused.writes()).toEqual([]);

    const rejected = client((call) => {
      if (call.method === 'GET') throw problem(404, 'zone_unavailable');
      throw problem(409, 'zone_conflict');
    });
    await expect(
      readOrCreateOfficialZone(rejected.api, {
        ...identity,
        ...rejected.operator,
        space,
        key: 'dev-seed:v1:zone:software',
      }),
    ).rejects.toThrow('zone_conflict');
    expect(rejected.writes()).toHaveLength(1);
  });

  test('localized tab labels fall back to the plain layout without a second write when it already matches', async () => {
    const fixture = client((call) => {
      if (
        call.method === 'PUT' &&
        (call.body as { presentation: unknown }).presentation === layout
      ) {
        throw problem(400, 'invalid_zone_configuration');
      }
      return { revision };
    });
    await updateOfficialZonePresentation(fixture.api, {
      ...identity,
      head: head(plain),
      defaultRealm: realm,
      candidates: [
        { variant: '', presentation: layout },
        { variant: ':plain', presentation: plain },
      ],
      key: (_current, variant) => `config${variant}`,
    });
    expect(fixture.writes().map((call) => call.key)).toEqual(['config']);
  });

  test('an existing Zone whose default Realm differs from the plan keeps it when the layout already matches', async () => {
    const kept = 'https://rezics.com/id/00000000-0000-4000-a000-000000000099';
    const absent = client((call) => {
      if (call.path.startsWith('/v1/realms/')) throw problem(404, 'realm_unavailable');
      return { revision };
    });
    await updateOfficialZonePresentation(absent.api, {
      ...identity,
      head: head(layout, kept),
      defaultRealm: realm,
      candidates: [
        { variant: '', presentation: layout },
        { variant: ':plain', presentation: plain },
      ],
      key: () => 'unused',
    });
    expect(absent.writes()).toEqual([]);
    expect(absent.calls.map((call) => call.path)).toEqual([
      `/v1/realms/${realm.slice(-36)}?${new URLSearchParams({ actingSubject: actor })}`,
    ]);

    const elsewhere = 'https://rezics.com/id/00000000-0000-4000-a000-000000000098';
    const otherSpace = client((call) => {
      if (call.path.startsWith('/v1/realms/')) {
        return { profile: 'realm-read-v1', id: realm, space: elsewhere };
      }
      return { revision };
    });
    await updateOfficialZonePresentation(otherSpace.api, {
      ...identity,
      head: head(layout, kept),
      defaultRealm: realm,
      candidates: [{ variant: '', presentation: layout }],
      key: () => 'unused',
    });
    expect(otherSpace.writes()).toEqual([]);
  });

  test('a layout change on an existing Zone still writes, using the current Realm when the plan is elsewhere', async () => {
    const kept = 'https://rezics.com/id/00000000-0000-4000-a000-000000000099';
    const elsewhere = 'https://rezics.com/id/00000000-0000-4000-a000-000000000098';
    const fixture = client((call) => {
      if (call.path.startsWith('/v1/realms/')) {
        return { profile: 'realm-read-v1', id: realm, space: elsewhere };
      }
      return { revision };
    });
    await updateOfficialZonePresentation(fixture.api, {
      ...identity,
      head: head({ profile: 'zone-presentation-v1', modules: [] }, kept),
      defaultRealm: realm,
      candidates: [{ variant: '', presentation: layout }],
      key: (current, variant) => `config:${current.slice(-4)}${variant}`,
    });
    expect(fixture.writes()).toEqual([
      {
        method: 'PUT',
        path: `/v1/zones/${zoneId}/configuration`,
        token: 'steward',
        key: `config:${revision.slice(-4)}`,
        body: {
          expectedHead: revision,
          actingSubject: actor,
          defaultRealm: kept,
          official: {},
          presentation: layout,
        },
      },
    ]);
  });

  test('a planned Realm that resolves on the Zone Space replaces the current default', async () => {
    const kept = 'https://rezics.com/id/00000000-0000-4000-a000-000000000099';
    const fixture = client((call) => {
      if (call.path.startsWith('/v1/realms/')) return { profile: 'realm-read-v1', id: realm, space };
      return { revision };
    });
    await updateOfficialZonePresentation(fixture.api, {
      ...identity,
      head: head(layout, kept),
      defaultRealm: realm,
      candidates: [{ variant: '', presentation: layout }],
      key: () => 'dev-seed:v1:official-zone:mods:planned',
    });
    expect(fixture.writes()).toEqual([
      {
        method: 'PUT',
        path: `/v1/zones/${zoneId}/configuration`,
        token: 'steward',
        key: 'dev-seed:v1:official-zone:mods:planned',
        body: {
          expectedHead: revision,
          actingSubject: actor,
          defaultRealm: realm,
          official: {},
          presentation: layout,
        },
      },
    ]);
  });

  test('a Realm read failure other than absence stops the update before any write', async () => {
    const kept = 'https://rezics.com/id/00000000-0000-4000-a000-000000000099';
    const fixture = client(() => {
      throw problem(503, 'realm_read_unavailable');
    });
    await expect(
      updateOfficialZonePresentation(fixture.api, {
        ...identity,
        head: head(layout, kept),
        defaultRealm: realm,
        candidates: [{ variant: '', presentation: layout }],
        key: () => 'unused',
      }),
    ).rejects.toThrow('realm_read_unavailable');
    expect(fixture.writes()).toEqual([]);
  });
});
