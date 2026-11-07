import { expect, test } from 'bun:test';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { ProblemError } from '../../src/http/problem-error.ts';
import { createSearchAccessFacetObservation } from '../../src/composition/search-access.ts';
import {
  classifyFacetAccessFailure,
  passthroughFacetAccessObservation,
} from '../../src/search/facet-access-port.ts';
import {
  createScopedFacetApplication,
  createServiceScopeFacetPorts,
} from '../../src/search/scoped-facet-application.ts';
import { ScopeWork, scopeAllowance, zeroScopeWork } from '../../src/search/scope-execution.ts';
import type { PublicFilterConsumerContext } from '../../src/search/public-filter-consumer-contract.ts';

const identity = {
  source: 'collection-members-v1',
  meaning: 'a'.repeat(64),
  population: 'b'.repeat(64),
  authorization: 'c'.repeat(64),
};
const context = {} as PublicFilterConsumerContext;
const resource = { kind: 'collection' as const, id: '11111111-1111-4111-8111-111111111111' };

function throwingScope(error: unknown) {
  return {
    async evaluate() {
      throw error;
    },
    work() {
      return { reservationId: 'facet-access', used: zeroScopeWork() };
    },
    async sourcePrefix() {
      throw error;
    },
  };
}

function requestFor(error: unknown) {
  const work = new ScopeWork(scopeAllowance(100, 'facet-access'));
  return {
    scope: throwingScope(error),
    prepared: {
      basis: { canonical: 'canon', profile: 'profile', release: 'release', query: 'query', index: 'idx' },
    },
    work,
    identity,
    progress: null,
    reported: zeroScopeWork(),
  };
}

test('Search vocabulary maps Access unavailable and listed HTTP codes to native closed statuses', () => {
  expect(classifyFacetAccessFailure({ name: 'AccessUnavailableError' })).toBe('unready');
  expect(classifyFacetAccessFailure({ code: 'search_restart_required' })).toBe('changed');
  expect(classifyFacetAccessFailure({ code: 'not_found' })).toBe('unavailable');
  expect(classifyFacetAccessFailure({ code: 'index_not_ready' })).toBe('unready');
  expect(classifyFacetAccessFailure({ code: 'invalid_request' })).toBeUndefined();
});

test('composition maps Access unavailable onto an unready Collection observation', async () => {
  const ports = createServiceScopeFacetPorts(resource, createSearchAccessFacetObservation());
  const observed = await ports.observe(requestFor(new AccessUnavailableError('contention')), context);
  expect(observed.status).toBe('unready');
  expect('identity' in observed).toBe(false);
});

test('composition maps restart and missing-source HTTP problems onto native candidate pages', async () => {
  const ports = createServiceScopeFacetPorts(resource, createSearchAccessFacetObservation());
  const restarted = await ports.readCandidates(
    requestFor(new ProblemError('search_restart_required')),
    null,
    1,
    context,
  );
  expect(restarted.status).toBe('changed');
  const missing = await ports.readCandidates(requestFor(new ProblemError('not_found')), null, 1, context);
  expect(missing.status).toBe('unavailable');
});

test('unmapped failures still throw through the Access observation port', async () => {
  const ports = createServiceScopeFacetPorts(resource, createSearchAccessFacetObservation());
  await expect(ports.observe(requestFor(new ProblemError('invalid_request')), context)).rejects.toMatchObject({
    code: 'invalid_request',
  });
});

test('passthrough observation does not swallow Access unavailability', async () => {
  const ports = createServiceScopeFacetPorts(resource, passthroughFacetAccessObservation);
  await expect(ports.observe(requestFor(new AccessUnavailableError('deadline')), context)).rejects.toBeInstanceOf(
    AccessUnavailableError,
  );
});

test('the live application constructs source and Collection admission from the same port', async () => {
  const application = createScopedFacetApplication({ access: createSearchAccessFacetObservation() });
  expect(application.source).toBeDefined();
  expect(application.access).toBeDefined();
  const observed = await application
    .collectionPorts(resource)
    .observe(requestFor(new AccessUnavailableError('overloaded')), context);
  expect(observed.status).toBe('unready');
});
