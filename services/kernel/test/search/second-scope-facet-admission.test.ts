import { expect, mock, test } from 'bun:test';
import { ProblemError } from '../../src/http/problem.ts';
import type { FilterRelease } from '@rezics/filter';
import { encodeSearchCursor } from '../../src/search/cursor.ts';
import type { FacetDiscoveryProvider, FacetNativePlan } from '../../src/search/facet-discovery-native.ts';
import {
  authenticateFacetCursors,
  facetCursorBinding,
  facetCursorReleaseBinding,
  validateFacetCursorRelease,
  type FacetCursorInput,
} from '../../src/search/facet-discovery-runtime.ts';
import { admitScopedFacetRequest, readScopedFacetDiscovery } from '../../src/search/scoped-facet-admission.ts';
import type { ScopedFacetAdmission } from '../../src/search/scoped-facet-source.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const ring: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const denied = new ProblemError('not_found');
const conditionTree = { not: { or: [{ subject: { realm: 'r-1' } }, { true: true }] } };
const readerPrincipal = 'account:10000000-0000-4000-8000-000000000001';

function fixture() {
  const scope: ScopedFacetAdmission = {
    identity: { source: 'subject-index', meaning: 'effective-query', population: 'current', authorization: 'reader' },
    request: { conditionTree },
  };
  const capture = mock(async ({ plan }: { plan: FacetNativePlan }) => {
    expect(plan.scope).toBe(scope);
    return {
      status: 'unready' as const,
      reason: 'source_pending' as const,
      cost: {
        inputKeys: 0,
        candidates: 0,
        accessPoints: 0,
        dependencyPoints: 0,
        engineSearches: 0,
        engineIteratorSteps: 0,
        outputSlots: 0,
        resultWrites: 0,
        frontierWrites: 0,
      },
    };
  });
  const page = mock(async () => {
    throw new Error('unready scoped request reached native paging');
  });
  const release = {} as FilterRelease;
  const provider = {
    source: 'subject-index',
    generation: 1,
    meaning: { release },
    operations: { captureFacet: capture, pageFacets: page },
  } as unknown as FacetDiscoveryProvider;
  const admit = mock(async () => {
    const now = Date.now();
    return {
      principal: 'account:reader' as const,
      text: undefined,
      filter: undefined,
      originalFilter: undefined,
      release,
      languages: undefined,
      now,
      context: { deadline: now + 10_000 },
      scope,
    };
  });
  return { provider, capture, page, admit, scope, release };
}

test('scoped admission forwards every condition reference and rejects before producer I/O', async () => {
  const { provider, capture, page } = fixture();
  const admit = mock(async (request: { conditions?: unknown }) => {
    expect(request.conditions).toEqual(conditionTree);
    throw denied;
  });

  await expect(
    readScopedFacetDiscovery(
      ring,
      provider,
      { scope: { kind: 'realm', id: 'r-1' }, conditions: conditionTree, facets: [{ property: 'type' }] },
      admit,
    ),
  ).rejects.toBe(denied);
  expect(admit).toHaveBeenCalledTimes(1);
  expect(capture).not.toHaveBeenCalled();
  expect(page).not.toHaveBeenCalled();
});

test('admitted scoped facets remain preparing until scoped native operations exist', async () => {
  const { provider, capture, page, admit, scope } = fixture();

  await expect(
    readScopedFacetDiscovery(
      ring,
      provider,
      { scope: { kind: 'collection', id: 'c-1' }, conditions: conditionTree, facets: [{ property: 'type' }] },
      admit,
    ),
  ).rejects.toMatchObject({ code: 'index_not_ready' });
  expect(admit).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture.mock.calls[0]?.[0].plan.scope).toBe(scope);
  expect(page).not.toHaveBeenCalled();
});

test('opaque continuations bind scope, principal, conditions and dynamic admission changes', async () => {
  const now = Date.now();
  const facet = { property: 'type', size: 10 };
  const input: FacetCursorInput = {
    principal: readerPrincipal,
    text: undefined,
    originalFilter: undefined,
    languages: ['en'],
    now,
    facets: [facet],
    scopeBinding: { request: 'b'.repeat(64), admission: 'a'.repeat(64) },
  };
  const release = {} as FilterRelease;
  const releaseBinding = facetCursorReleaseBinding(release, input.scopeBinding);
  const cursor = await encodeSearchCursor(
    ring,
    facetCursorBinding(input, facet),
    {
      generation: 1,
      after: ['facet-v3', 'obs', 'build', '1', 'key', 'source', 'c'.repeat(64), releaseBinding],
    },
    now,
  );
  const resumed = { ...input, facets: [{ ...facet, cursor }] };
  const [position] = await authenticateFacetCursors(ring, resumed);

  await expect(
    authenticateFacetCursors(ring, {
      ...resumed,
      principal: 'account:10000000-0000-4000-8000-000000000002',
    }),
  ).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(
    authenticateFacetCursors(ring, {
      ...resumed,
      scopeBinding: { request: 'd'.repeat(64), admission: 'a'.repeat(64) },
    }),
  ).rejects.toMatchObject({ code: 'invalid_request' });
  const admitted = await admitScopedFacetRequest(
    { scope: { kind: 'realm', id: 'r-1' }, conditions: conditionTree, facets: [{ property: 'type' }] },
    fixture().admit,
  );
  const changedConditions = await admitScopedFacetRequest(
    {
      scope: { kind: 'realm', id: 'r-1' },
      conditions: { not: { or: [{ subject: { realm: 'r-2' } }, { true: true }] } },
      facets: [{ property: 'type' }],
    },
    fixture().admit,
  );
  expect(admitted.scopeBinding?.request).not.toEqual(changedConditions.scopeBinding?.request);
  expect(() =>
    validateFacetCursorRelease([position], release, { request: 'b'.repeat(64), admission: 'e'.repeat(64) }),
  ).toThrow(expect.objectContaining({ code: 'search_restart_required' }));
  expect(() =>
    validateFacetCursorRelease([position], { changed: true } as unknown as FilterRelease, input.scopeBinding),
  ).toThrow(expect.objectContaining({ code: 'search_restart_required' }));
  expect(facetCursorBinding(input, facet).request).not.toEqual(
    facetCursorBinding({ ...input, languages: ['zh-Hant'] }, facet).request,
  );
  expect(facetCursorBinding(input, facet).request).not.toEqual(
    facetCursorBinding({ ...input, facets: [{ ...facet, size: 11 }] }, { ...facet, size: 11 }).request,
  );
});
