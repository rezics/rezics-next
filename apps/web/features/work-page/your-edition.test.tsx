import { expect, test } from 'bun:test';
import type { MainClient } from '../discover/types.ts';
import { mainTrackingApi } from '../tracking/api.ts';
import { editions, iri, saoOne } from '../tracking/fixtures.ts';

test('the saved realization is read directly at its saved revision, independently of edition pages', async () => {
  const chosen = { kind: 'realization' as const, resource: editions.realizations[0]!.id, revision: iri('saved') };
  const calls: unknown[] = [];
  const main = () => ({ v1: { works: (path: unknown) => ({ realizations: (target: unknown) => ({
    async get(options: unknown) {
      calls.push({ path, target, options });
      return { data: editions.realizations[0], error: null };
    },
  }) }) } });
  const api = mainTrackingApi(iri('agent'), main as unknown as () => MainClient);
  expect(await api.edition(saoOne, chosen)).toEqual({ ok: true, data: editions.realizations[0] });
  expect(calls).toEqual([{ path: { id: saoOne.split('/').at(-1) },
    target: { realization: chosen.resource.split('/').at(-1) }, options: {
      query: { actingSubject: iri('agent'), revision: chosen.revision },
    } }]);
});

test('the saved release is read directly and a failed detail read remains a failure', async () => {
  const chosen = { kind: 'release' as const, resource: editions.releases[0]!.id, revision: iri('saved') };
  const calls: unknown[] = [];
  let unavailable = false;
  const main = () => ({ v1: { works: (path: unknown) => ({ releases: (target: unknown) => ({
    async get(options: unknown) {
      calls.push({ path, target, options });
      return unavailable ? { data: null, error: { status: 503, value: null } }
        : { data: editions.releases[0], error: null };
    },
  }) }) } });
  const api = mainTrackingApi(iri('agent'), main as unknown as () => MainClient);
  expect(await api.edition(saoOne, chosen)).toEqual({ ok: true, data: editions.releases[0] });
  expect(calls[0]).toEqual({ path: { id: saoOne.split('/').at(-1) },
    target: { release: chosen.resource.split('/').at(-1) }, options: { query: { actingSubject: iri('agent') } } });
  unavailable = true;
  expect(await api.edition(saoOne, chosen)).toEqual({ ok: false, failure: 'unavailable', status: 503, problem: null });
});
