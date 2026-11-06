import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { composeSemanticDomain, composeSemanticIdentityParticipants } from '../../src/composition/semantic.ts';
import { stepLibraryIdentityEpoch } from '../../src/library/identity-epoch-participant.ts';
import { createIdentityEpochParticipants } from '../../src/semantic/application/identity-epoch-participants.ts';
import type { IdentityJobRef, IdentityStepProgress } from '../../src/semantic/contract/identity-values.ts';
import {
  identityEpochNext,
  identityEpochReceiptLocator,
  identityEpochWorkflowId,
  type IdentityEpochObservation,
} from '../../src/semantic/core/identity-epoch-sequence.ts';

const job: IdentityJobRef = { jobId: '018f0000-0000-7000-8000-000000000001', epoch: 7n };

function observation(overrides: Partial<IdentityEpochObservation> = {}): IdentityEpochObservation {
  return {
    job,
    jobState: 'pending',
    mappingComplete: true,
    searchComplete: true,
    libraryComplete: true,
    control: {
      publishedEpoch: 6n,
      pendingJob: job.jobId,
      pendingEpoch: job.epoch,
      prepareJob: job.jobId,
      prepareEpoch: job.epoch,
    },
    ...overrides,
  };
}

function progress(overrides: Partial<IdentityStepProgress> = {}): IdentityStepProgress {
  const receipt = {
    job,
    step: 'search-canonical-index' as const,
    version: 1 as const,
    native: { partition: 3, epoch: 7, position: 12n, transactionId: 'tx-1' },
  };
  return {
    job,
    frontier: { after: ['key'], segment: 1 },
    state: 'more',
    work: { rows: 1, points: 0, statements: 2, bytes: 64, engineRequests: 0 },
    receipt,
    ...overrides,
  };
}

test('fixed participant composition keeps exactly the two named ports and is frozen', async () => {
  const calls: unknown[] = [];
  const native = { id: 'pool' };
  const search = async (handle: unknown) => {
    calls.push(['search', handle]);
    return progress();
  };
  const library = async (handle: unknown) => {
    calls.push(['library', handle]);
    return progress();
  };
  // An extra key is supplied on purpose: the installed composition must drop it rather than expose it.
  const supplied = {
    version: 1 as const,
    'search-canonical-index': search,
    'library-private-follow-counts': library,
    mapping: async () => progress(),
  };
  const installed = createIdentityEpochParticipants<typeof native>(supplied);

  expect(Object.isFrozen(installed)).toBe(true);
  expect(Object.keys(installed).sort()).toEqual(['library-private-follow-counts', 'search-canonical-index', 'version']);
  expect(installed.version).toBe(1);
  expect(installed['search-canonical-index']).toBe(search);
  expect(installed['library-private-follow-counts']).toBe(library);
  await installed['search-canonical-index'](native, job);
  await installed['library-private-follow-counts'](native, job);
  expect(calls).toEqual([
    ['search', native],
    ['library', native],
  ]);
});

test('next-step derivation orders mapping, Search, Library and publication, and refuses contradictory control', () => {
  expect(identityEpochNext(observation({ jobState: 'preparing', mappingComplete: false }))).toBe('preparing');
  expect(
    identityEpochNext(
      observation({
        jobState: 'preparing',
        control: { publishedEpoch: 6n, pendingJob: null, pendingEpoch: null, prepareJob: null, prepareEpoch: null },
      }),
    ),
  ).toBe('reservation-lost');
  expect(identityEpochNext(observation({ mappingComplete: false }))).toBe('mapping');
  expect(identityEpochNext(observation({ searchComplete: false }))).toBe('search-canonical-index');
  expect(identityEpochNext(observation({ searchComplete: true, libraryComplete: false }))).toBe(
    'library-private-follow-counts',
  );
  expect(identityEpochNext(observation())).toBe('publish');
  expect(identityEpochNext(observation({ jobState: 'cancelling' }))).toBe('cancelling');
  expect(
    identityEpochNext(
      observation({
        jobState: 'published',
        control: { publishedEpoch: 7n, pendingJob: null, pendingEpoch: null, prepareJob: null, prepareEpoch: null },
      }),
    ),
  ).toBe('published');
  expect(
    identityEpochNext(
      observation({
        jobState: 'published',
        control: { publishedEpoch: 6n, pendingJob: null, pendingEpoch: null, prepareJob: null, prepareEpoch: null },
      }),
    ),
  ).toBe('publication-control-disagrees');
  expect(
    identityEpochNext(
      observation({
        control: { publishedEpoch: 6n, pendingJob: null, pendingEpoch: null, prepareJob: null, prepareEpoch: null },
      }),
    ),
  ).toBe('reservation-lost');
});

test('producer progress is bounded to its own job and step, and empty pages cannot advance', () => {
  expect(identityEpochReceiptLocator(job, 'search-canonical-index', progress())).toEqual({
    ok: true,
    locator: {
      job: { jobId: job.jobId, epoch: '7' },
      step: 'search-canonical-index',
      version: 1,
      native: { partition: 3, epoch: 7, position: '12', transactionId: 'tx-1' },
    },
  });
  expect(identityEpochReceiptLocator(job, 'library-private-follow-counts', progress())).toEqual({
    ok: false,
    reason: 'invalid-progress',
  });
  expect(
    identityEpochReceiptLocator(
      job,
      'search-canonical-index',
      progress({ frontier: { after: Array.from({ length: 9 }, (_, index) => index), segment: 1 } }),
    ),
  ).toEqual({ ok: false, reason: 'invalid-progress' });
  expect(
    identityEpochReceiptLocator(
      job,
      'search-canonical-index',
      progress({ work: { rows: 0, points: 0, statements: 1, bytes: 0, engineRequests: 0 } }),
    ),
  ).toEqual({ ok: false, reason: 'no-progress' });
  expect(
    identityEpochReceiptLocator(
      job,
      'search-canonical-index',
      progress({ state: 'complete', work: { rows: 0, points: 0, statements: 1, bytes: 0, engineRequests: 0 } }),
    ).ok,
  ).toBe(true);
});

test('workflow identifiers are stable per job and distinct per continuation segment', () => {
  expect(identityEpochWorkflowId({ jobId: job.jobId, epoch: '7' })).toBe(`semantic:identity:${job.jobId}:7`);
  expect(identityEpochWorkflowId({ jobId: job.jobId, epoch: '7' }, 2)).toBe(
    `semantic:identity:${job.jobId}:7:segment:2`,
  );
});

test('ordinary composition binds the real Search and Library participants and stays unavailable without Search configuration', () => {
  expect(composeSemanticIdentityParticipants({ env: {} })).toBeNull();
  expect(composeSemanticDomain({ env: {} })).toBeNull();
  const routeKey = Buffer.alloc(32, 7).toString('base64url');
  const env = { OPENSEARCH_URL: 'http://127.0.0.1:9200', KERNEL_ROUTE_KEY: routeKey };
  const participants = composeSemanticIdentityParticipants({ env });
  expect(participants).not.toBeNull();
  expect(Object.isFrozen(participants)).toBe(true);
  expect(participants?.['library-private-follow-counts']).toBe(stepLibraryIdentityEpoch);
  expect(typeof participants?.['search-canonical-index']).toBe('function');
  const domain = composeSemanticDomain({ env });
  expect(domain).not.toBeNull();
  expect(domain?.version).toBe(1);
  expect(domain?.ports.identityEpoch['library-private-follow-counts']).toBe(stepLibraryIdentityEpoch);
  expect(domain?.ports.contentLifecycle.importedTupleRoute(new Uint8Array(32), 'vndb', 'v1')).toBeTypeOf('number');
  expect(domain?.ports.contentLifecycle.checkCovers).toBeTypeOf('function');
  expect(domain?.ports.ratingReview.identityEpochChanged().name).toBe('VoteReviewStaleError');
  expect(domain?.ports.hashing.sha256Hex('a')).toHaveLength(64);
  expect(Object.keys(domain!.ports).sort()).toEqual([
    'contentLifecycle',
    'facts',
    'hashing',
    'identityEpoch',
    'libraryCustody',
    'ratingReview',
    'routing',
    'searchCurrentness',
    'version',
  ]);
});

test('contract, core and application sources import only their own layers, identity-core and Definitions', () => {
  const semantic = fileURLToPath(new URL('../../src/semantic/', import.meta.url));
  const layers = ['contract', 'core', 'application'];
  const local = /^\.\/[\w-]+\.ts$/;
  const sibling = new RegExp(`^\\.\\./(${layers.join('|')}|identity-core)/[\\w-]+\\.ts$`);
  const allowed = /^(?:@rezics\/definitions(?:\/validate)?)$/;
  const violations: string[] = [];
  for (const layer of layers) {
    for (const file of readdirSync(`${semantic}${layer}`).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(`${semantic}${layer}/${file}`, 'utf8');
      for (const [, specifier] of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (!local.test(specifier!) && !sibling.test(specifier!) && !allowed.test(specifier!))
          violations.push(`${layer}/${file} -> ${specifier}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
