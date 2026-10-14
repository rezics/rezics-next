import { expect, spyOn, test } from 'bun:test';
import { realmReadRoutes } from '../src/routes/realm-reads.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { RealmProfileUnavailable } from '../src/modules/realm-profile/schema.ts';
import { AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { WorkReadInvalid, WorkReadLimit, WorkReadMissing, WorkReadUnavailable }
  from '../src/modules/work/read-session.ts';
import { SearchIndexUnavailable } from '../src/modules/work/search-readiness.ts';

const realm = '00000000-0000-4000-8000-000000000001';
const paths = ['', '/join-page', '/zone', '/works', '/decisions', `/decisions/${realm}`];
const coded = <T extends Error>(error: T, code: string) => Object.assign(error, { code });

test('uncoded dependency throws retain distinct useful reasons without exposing raw messages', async () => {
  const reasons: unknown[] = [];
  for (const message of ['Dependency connection closed', 'Dependency response truncated']) {
    const output = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = realmReadRoutes({ environment: {
        lineage: { dataEpoch: 'fault-epoch', routingEpoch: '1' },
        fuseki: { query: async () => { throw new Error(message); } },
      } } as unknown as MainWorkDependencies);
      const response = await app.handle(new Request(`http://main.local/v1/realms/${realm}/zone`));
      expect(response.status).toBe(503);
      expect(output.mock.calls).toHaveLength(1);
      const line = String(output.mock.calls[0]![0]);
      const event = JSON.parse(line) as Record<string, unknown>;
      expect(event['error.class']).toBe('Error');
      expect(line).not.toContain(message);
      reasons.push(event['error.code']);
    } finally { output.mockRestore(); }
  }
  expect(reasons[0]).toBeDefined();
  expect(reasons[1]).toBeDefined();
  expect(reasons[0]).not.toBe(reasons[1]);
});

for (const path of paths) {
  test(`Realm ${path || 'header'}: every unavailable branch emits one useful original fault`, async () => {
    const cases = [
      { error: new WorkReadUnavailable('Realm Zone relation is ambiguous'),
        response: 'realm_read_unavailable', reason: 'realm_zone_relation_is_ambiguous', original: 'WorkReadUnavailable' },
      { error: new WorkReadUnavailable('Realm Zone presentation is unavailable', {
        cause: coded(new Error('Hidden Zone dependency data'), 'zone_object_missing'),
      }), response: 'realm_read_unavailable', reason: 'realm_zone_presentation_is_unava', original: 'WorkReadUnavailable' },
      { error: new RealmProfileUnavailable('Realm public profile is invalid'),
        response: 'realm_read_unavailable', reason: 'realm_profile_invalid', original: 'RealmProfileUnavailable' },
      { error: new RealmProfileUnavailable('Realm public profile is ambiguous'),
        response: 'realm_read_unavailable', reason: 'realm_profile_ambiguous', original: 'RealmProfileUnavailable' },
      { error: new AdmissionUnavailable('Realm count is unavailable'),
        response: 'dependency_unavailable', reason: 'realm_count_unavailable', original: 'AdmissionUnavailable' },
      { error: coded(new SearchIndexUnavailable('Private dependency details'), 'search_cut_unavailable'),
        response: 'search_index_unavailable', reason: 'search_cut_unavailable', original: 'SearchIndexUnavailable' },
      { error: coded(new Error('Bearer secret; hidden Realm record'), 'ECONNRESET'),
        response: 'dependency_unavailable', reason: 'ECONNRESET', original: 'Error' },
    ];
    for (const item of cases) {
      const output = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const app = realmReadRoutes({ environment: {
          lineage: { dataEpoch: 'fault-epoch', routingEpoch: '1' },
          fuseki: { query: async () => { throw item.error; } },
        } } as unknown as MainWorkDependencies);
        const response = await app.handle(new Request(`http://main.local/v1/realms/${realm}${path}`));
        expect(response.status).toBe(503);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect((await response.json() as { code: string }).code).toBe(item.response);
        expect(output.mock.calls).toHaveLength(1);
        const line = String(output.mock.calls[0]![0]);
        const event = JSON.parse(line) as Record<string, unknown>;
        expect(event.event).toBe('worker_fault');
        expect(event['error.code']).toBe(item.reason);
        expect([event['error.class'], ...(event['error.chain.classes'] as string[] ?? [])]).toContain(item.original);
        expect(line).not.toContain('secret');
        expect(line).not.toContain('hidden Realm');
        expect(line).not.toContain('Hidden Zone');
        if (item.error.cause) expect(event['error.chain.codes']).toContain('zone_object_missing');
      } finally { output.mockRestore(); }
    }
  });
  test(`Realm ${path || 'header'}: ordinary refusals emit no fault`, async () => {
    for (const error of [new WorkReadMissing('Hidden Realm'), new WorkReadInvalid('Invalid read'), new WorkReadLimit('Read limit')]) {
      const output = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const app = realmReadRoutes({ environment: {
          lineage: { dataEpoch: 'fault-epoch', routingEpoch: '1' },
          fuseki: { query: async () => { throw error; } },
        } } as unknown as MainWorkDependencies);
        const response = await app.handle(new Request(`http://main.local/v1/realms/${realm}${path}`));
        expect(response.status).toBe(error instanceof WorkReadMissing ? 404 : error instanceof WorkReadInvalid ? 400 : 422);
        expect(output.mock.calls).toHaveLength(0);
      } finally { output.mockRestore(); }
    }
  });
}
