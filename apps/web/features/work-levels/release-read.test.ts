import { describe, expect, test } from 'bun:test';
import type { MainClient } from '../discover/types.ts';
import type { Answer } from '../work-page/books-edition-page.read.ts';
import type { SuppliedClient } from '../work-page/read.ts';
import { realizations, releases } from './fixtures.ts';
import { readFollowedRealizations, readRealization, readReleaseRealizations } from './read.ts';
import type { Realization, Release } from './types.ts';

const iri = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
if (!realizations.ok || !releases.ok) throw new Error('Expected edition fixtures');
const original: Realization = { ...realizations.data.items[0]!, id: iri(1), work: iri(2), revision: iri(11),
  language: 'ja', evidence: 'https://example.test/evidence/first' };
const corrected: Realization = { ...original, revision: iri(12), language: 'en', evidence: 'https://example.test/evidence/corrected' };
const coverage: Release['coverage'] = [{ ...releases.data.items[0]!.coverage[0]!,
  work: original.work, realization: original.id, revision: original.revision }];

type Request = { work: string; realization: string; query: { actingSubject?: string; revision?: string } };
function clientFor(answer: (request: Request) => Answer<Realization>) {
  const requests: Request[] = [];
  const main = { v1: { works: ({ id }: { id: string }) => ({
    realizations: ({ realization }: { realization: string }) => ({
      get: async ({ query }: Pick<Request, 'query'>) => {
        const request = { work: id, realization, query };
        requests.push(request);
        return answer(request);
      },
    }),
  }) } } as unknown as MainClient;
  const client: SuppliedClient = { main, actingSubject: iri(99), signedIn: true };
  return { client, requests };
}
const ok = (data: Realization): Answer<Realization> => ({ data, error: null });

describe('Release realization selections', () => {
  test('coverage reads R1 and E1 after the realization head changes to R2 and E2', async () => {
    const { client, requests } = clientFor(({ query }) => ok(query.revision === original.revision ? original : corrected));
    const selected = await readReleaseRealizations(coverage, client);
    expect(selected.get(original.id)).toEqual({ ok: true, data: original });
    expect(requests).toEqual([{ work: original.work.slice(-36), realization: original.id.slice(-36),
      query: { actingSubject: iri(99), revision: original.revision } }]);
    const head = await readRealization(original.work.slice(-36), original.id.slice(-36), undefined, client);
    expect(head).toEqual({ ok: true, data: corrected });
    expect(requests[1]!.query.revision).toBeUndefined();
    expect(original.evidence).not.toBe(corrected.evidence);
    expect(original.language).not.toBe(corrected.language);
  });

  test('a selected revision refusal remains missing, denied or unavailable without a head fallback', async () => {
    for (const [status, failure] of [[404, 'missing'], [403, 'sign-in'], [503, 'unavailable']] as const) {
      const problem = { error: `selected_revision_${status}` };
      const { client, requests } = clientFor(() => ({ data: null, error: { status, value: problem } }));
      const selected = await readReleaseRealizations(coverage, client);
      expect(selected.get(original.id)).toEqual({ ok: false, failure, status, problem });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.query.revision).toBe(original.revision);
    }
  });

  test('legacy coverage without a realization does not fabricate a read', async () => {
    const { client, requests } = clientFor(() => ok(corrected));
    expect(await readReleaseRealizations([{ ...coverage[0]!, realization: null, revision: null }], client)).toEqual(new Map());
    expect(requests).toHaveLength(0);
  });

  test('source continuity fetches the pin despite an already loaded head and deduplicates only exact selections', async () => {
    const follows = (revision: string, id: number): Realization => ({ ...corrected, id: iri(id),
      source: { kind: 'realization', work: original.work, realization: original.id, revision } });
    const { client, requests } = clientFor(({ query }) => ok({ ...original, revision: query.revision! }));
    const selected = await readFollowedRealizations([
      corrected, follows(original.revision, 3), follows(original.revision, 4), follows(iri(13), 5),
    ], client);
    expect(requests.map(request => request.query.revision)).toEqual([original.revision, iri(13)]);
    expect(selected.map(item => item.revision)).toEqual([original.revision, iri(13)]);
    expect(selected[0]).toEqual({ id: original.id, work: original.work, revision: original.revision,
      read: { ok: true, data: original } });
    const alreadyLoaded = clientFor(() => { throw new Error('An exact loaded pin needs no read'); });
    expect(await readFollowedRealizations([original, follows(original.revision, 3)], alreadyLoaded.client)).toEqual([]);
    expect(alreadyLoaded.requests).toHaveLength(0);
  });

  test('an unavailable followed revision retains its selected identity and refusal', async () => {
    const { client } = clientFor(() => ({ data: null, error: { status: 503 } }));
    const follower: Realization = { ...corrected, id: iri(3),
      source: { kind: 'realization', work: original.work, realization: original.id, revision: original.revision } };
    expect(await readFollowedRealizations([corrected, follower], client)).toEqual([
      { id: original.id, work: original.work, revision: original.revision,
        read: { ok: false, failure: 'unavailable', status: 503 } },
    ]);
  });
});
