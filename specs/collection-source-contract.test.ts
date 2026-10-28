import { expect, test } from 'bun:test';
import type { AuthoritativeTime } from '../services/kernel/src/command/command.ts';
import {
  createCollectionSource,
  type CanonicalCollectionPrefix,
  type CollectionSource,
  type CollectionSourceCall,
  type CollectionSourceAfter,
  type NativeIdentityBasis,
  type PreparedCollectionSource,
  type RawStoredCollectionPrefix,
} from '../services/kernel/src/library/collection-source.ts';
import { compareListingStamp } from '../services/kernel/src/library/listing-freshness-contract.ts';
import { PROBLEMS, ProblemError } from '../services/kernel/src/http/problem.ts';
import { encodeListCursor, decodeListCursor } from '../services/kernel/src/tokens/list-cursor.ts';

test('specification factory exposes the exact ABI and every method throws existing retryable dependency unavailable', async () => {
  const source = createCollectionSource({
    get pool(): Parameters<typeof createCollectionSource>[0]['pool'] {
      throw new Error('A specification stub must not query');
    },
    get access(): Parameters<typeof createCollectionSource>[0]['access'] {
      throw new Error('A specification stub must not authorize');
    },
  });
  expect(Object.keys(source).sort()).toEqual(['containsSubject', 'prefix', 'prepare', 'readRawStoredPrefix']);
  for (const method of Object.values(source)) {
    // No invented T, Access implementation or native fixture is needed to prove an explicit unimplemented method.
    let failure: unknown;
    try {
      await method(undefined as never);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProblemError);
    expect((failure as ProblemError).code).toBe('dependency_unavailable');
  }
  expect(PROBLEMS.dependency_unavailable.retryable).toBe(true);
});

test('source observations retain partition-local bigint precision independently from structural compatibility', () => {
  const a = { partition: 4, epoch: 2, position: 9007199254740992n };
  expect(compareListingStamp(a, { ...a, position: a.position + 1n })).toBe(-1);
  expect(compareListingStamp(a, { ...a, epoch: 3, position: 0n })).toBe(-1);
  expect(() => compareListingStamp(a, { ...a, partition: 5 })).toThrow();
});

test('existing encrypted codec keeps basis in position so valid stale differs from invalid binding and tamper', async () => {
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) };
  const binding = { route: 'collection-source-contract', viewer: null, query: { limit: 1 } };
  const position = { epoch: 1, after: ['private-rejected-key', 'a'.repeat(64)] };
  const now = new Date('2026-10-28T00:00:00Z');
  const token = await encodeListCursor(ring, binding, position, now);
  expect(token.length).toBeLessThanOrEqual(4096);
  expect(Buffer.from(token, 'base64url').toString()).not.toContain('private-rejected-key');
  const decoded = await decodeListCursor(ring, binding, token, now);
  expect(decoded).toEqual({ ok: true, ...position });
  if (!decoded.ok) throw new Error('Valid encrypted cursor must decode');
  expect(decoded.after[1]).not.toBe('b'.repeat(64)); // Caller returns stale, without changing AAD.
  expect(await decodeListCursor(ring, { ...binding, query: { limit: 2 } }, token, now)).toEqual({
    ok: false,
    reason: 'invalid',
  });
  const bytes = Buffer.from(token, 'base64url');
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  expect(await decodeListCursor(ring, binding, bytes.toString('base64url'), now)).toEqual({
    ok: false,
    reason: 'invalid',
  });
});

test('shared codec retains eight keys UTF8 limits anonymous timeless account lifetime and retirement', async () => {
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
  const anonymous = { route: 'collection-source-contract', viewer: null, query: {} };
  const now = new Date('2026-10-28T00:00:00Z');
  const later = new Date(now.getTime() + 16 * 60_000);
  const position = { epoch: 1, after: Array.from({ length: 8 }, () => 'é'.repeat(128)) };
  const token = await encodeListCursor(ring, anonymous, position, now);
  expect(await encodeListCursor(ring, anonymous, position, later)).toBe(token);
  expect((await decodeListCursor(ring, anonymous, token, later)).ok).toBe(true);
  await expect(encodeListCursor(ring, anonymous, { epoch: 1, after: Array(9).fill('x') }, now)).rejects.toThrow();
  await expect(encodeListCursor(ring, anonymous, { epoch: 1, after: ['é'.repeat(129)] }, now)).rejects.toThrow();
  const account = { ...anonymous, viewer: '00000000-0000-7000-8000-000000000001' };
  const accountToken = await encodeListCursor(ring, account, { epoch: 1, after: ['x'] }, now);
  expect(await decodeListCursor(ring, account, accountToken, later)).toEqual({ ok: false, reason: 'expired' });
  const retired = { current: 2, keys: new Map([[2, new Uint8Array(32).fill(7)]]) };
  expect(await decodeListCursor(retired, anonymous, token, now)).toEqual({ ok: false, reason: 'invalid' });
  expect(await decodeListCursor(retired, account, accountToken, now)).toEqual({ ok: false, reason: 'invalid' });
});

/** Compile-only negative fixtures; inputs would have to come from the real owner/Core. Never executed. */
function abiFixtures(
  owner: CollectionSource,
  call: CollectionSourceCall,
  raw: RawStoredCollectionPrefix,
  canonical: CanonicalCollectionPrefix,
  at: AuthoritativeTime,
) {
  const sameT: AuthoritativeTime = at;
  void owner.prefix({ ...call, at: sameT, afterSubjectId: null });
  void owner.readRawStoredPrefix({ ...call, afterStoredSubjectId: null });
  // @ts-expect-error Raw stored order never supplies canonical coverage.
  const invalidPrefix: CanonicalCollectionPrefix = raw;
  // @ts-expect-error Semantic supplies a structural digest reference, never a branded string.
  const identity: NativeIdentityBasis = 'ready';
  const semanticBasis: Readonly<{ digest: string }> = canonical.observation.basis.identity;
  const compatible: NativeIdentityBasis = semanticBasis;
  // @ts-expect-error A prepared source is an owner-issued handle, not a client observation.
  const source: PreparedCollectionSource = { observation: canonical.observation };
  // @ts-expect-error T cannot be supplied by the request as a Date.
  void owner.containsSubject({ ...call, at: new Date(), subjectId: 'x' });
  // @ts-expect-error Strict before-call allocation is mandatory.
  void owner.prefix({ source: call.source, actor: call.actor, at, deadline: call.deadline, afterSubjectId: null });
  // @ts-expect-error Raw progress fields cannot masquerade as canonical coverage.
  raw.coveredThrough;
  void [invalidPrefix, identity, source, compatible];
}
void abiFixtures;

import type {
  CollectionAliasProgress,
  CollectionSubjectMembership,
  ContainsCollectionSubject,
} from '../services/kernel/src/library/collection-source.ts';

test('one pending alias group fits the exact shared eight-key encrypted handoff without moving the settled boundary', async () => {
  const progress: CollectionAliasProgress = {
    subjectId: '00000000-0000-7000-8000-000000000003',
    basisDigest: 'b'.repeat(64),
    aliasAfter: '00000000-0000-7000-8000-000000000002',
    sourceAfter: '1:5:00000000-0000-7000-8000-000000000002:00000000-0000-7000-8000-000000000004',
  };
  const basisDigest = 'a'.repeat(64);
  const settled = '00000000-0000-7000-8000-000000000001';
  const after = [
    basisDigest,
    settled,
    progress.subjectId,
    31,
    progress.aliasAfter!,
    progress.sourceAfter!,
    progress.basisDigest,
    1,
  ];
  expect(after).toHaveLength(8);
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(6)]]) };
  const binding = { route: 'collection-source-contract', viewer: null, query: { target: progress.subjectId } };
  const now = new Date('2026-10-28T00:00:00Z');
  const position = { epoch: 1, after };
  const token = await encodeListCursor(ring, binding, position, now);
  expect(token.length).toBeLessThanOrEqual(4096);
  const decoded = await decodeListCursor(ring, binding, token, now);
  expect(decoded).toEqual({ ok: true, ...position });
  if (!decoded.ok) throw new Error('The admitted compact alias handoff must round-trip');
  expect(decoded.after[1]).toBe(settled); // Inner keyset progress never settles the canonical group.
  const reconstructed: CollectionAliasProgress = {
    subjectId: decoded.after[2] as string,
    basisDigest: decoded.after[6] as string,
    aliasAfter: decoded.after[4] as string,
    sourceAfter: decoded.after[5] as CollectionSourceAfter,
  };
  expect(reconstructed).toEqual(progress);
  for (const secret of [progress.subjectId, progress.aliasAfter!, progress.sourceAfter!, progress.basisDigest])
    expect(Buffer.from(token, 'base64url').toString()).not.toContain(secret);
  expect(await decodeListCursor(ring, { ...binding, query: { target: settled } }, token, now)).toEqual({
    ok: false,
    reason: 'invalid',
  });
});

/** Compile-only: direct target eligibility accepts the same resumable source evidence as union membership. */
function aliasProgressFixtures(
  owner: CollectionSource,
  call: CollectionSourceCall,
  progress: CollectionAliasProgress,
  result: CollectionSubjectMembership,
) {
  const input: ContainsCollectionSubject = { ...call, subjectId: progress.subjectId, progress };
  void owner.containsSubject(input);
  if (result.result === true) {
    const hint: ContainsCollectionSubject = { ...input, positiveEvidence: result.positiveEvidence };
    void owner.containsSubject(hint);
  }
  // @ts-expect-error Alias progress is not a reusable positive witness key.
  const invalidHint: ContainsCollectionSubject = { ...input, positiveEvidence: progress };
  if (result.result === 'not_proven') {
    const next: CollectionAliasProgress | null = result.progress;
    void next;
  }
  // @ts-expect-error Unknown must explicitly distinguish real group progress from readiness without progress.
  const missingProgress: CollectionSubjectMembership = {
    subjectId: progress.subjectId,
    observation: call.source.observation,
    work: { reservationId: call.allowance.reservationId, used: call.allowance.remaining },
    result: 'not_proven',
    reason: 'owner_repair',
  };
  const evidence: CollectionSubjectMembership = {
    subjectId: progress.subjectId,
    observation: call.source.observation,
    work: { reservationId: call.allowance.reservationId, used: call.allowance.remaining },
    result: true,
    // @ts-expect-error Group progress is never itself a current positive membership witness.
    positiveEvidence: progress,
  };
  // @ts-expect-error Raw stored progress cannot substitute for canonical membership group progress.
  void owner.containsSubject({ ...call, subjectId: progress.subjectId, progress: { afterStoredSubjectId: 'x' } });
  void [missingProgress, evidence, invalidHint];
}
void aliasProgressFixtures;

/** Exact structural compatibility with the accepted independent Semantic result, without an absent import. */
function acceptedIdentityFixtures(
  semantic: { state: 'ready'; basis: Readonly<{ digest: string }> } | { state: 'not_ready' },
  dimensions: import('../services/kernel/src/library/collection-source.ts').WorkDimensions,
) {
  if (semantic.state === 'ready') {
    const ownerReference: NativeIdentityBasis = semantic.basis;
    const semanticReference: Readonly<{ digest: string }> = ownerReference;
    void semanticReference;
  }
  const { identityMetadataRows, ...withoutMetadata } = dimensions;
  const metadataRows: number = identityMetadataRows;
  // @ts-expect-error Both 4096-home sweeps require their own explicit admitted work dimension.
  const invalid: import('../services/kernel/src/library/collection-source.ts').WorkDimensions = withoutMetadata;
  const { nativeRows, ...withoutNativeRows } = dimensions;
  const chargedRows: number = nativeRows;
  // @ts-expect-error Native row-work needs a separate plan-proved reservation axis.
  const invalidRows: import('../services/kernel/src/library/collection-source.ts').WorkDimensions = withoutNativeRows;
  // @ts-expect-error A nested token/vector is not the fixed native source tuple format.
  const nested: CollectionSourceAfter = '["cursor1","cursor2"]';
  // @ts-expect-error There are exactly six native source driver discriminators.
  const extraDriver: CollectionSourceAfter = '1:6:subject:fact';
  void [metadataRows, invalid, chargedRows, invalidRows, nested, extraDriver];
}
void acceptedIdentityFixtures;

test('all six fixed source composites fit the shared encrypted eight-key position for both viewer kinds', async () => {
  const uuid = '00000000-0000-7000-8000-000000000001';
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) };
  const now = new Date('2026-10-28T00:00:00Z');
  for (const driver of [0, 1, 2, 3, 4, 5] as const) {
    const sourceAfter: CollectionSourceAfter = `1:${driver}:${uuid}:${uuid}`;
    expect(Buffer.byteLength(sourceAfter, 'utf8')).toBe(77);
    for (const viewer of [null, uuid]) {
      const binding = { route: 'collection-source-contract', viewer, query: { target: uuid } };
      const position = { epoch: 1, after: ['a'.repeat(64), '', uuid, 31, uuid, sourceAfter, 'b'.repeat(64), 1] };
      const token = await encodeListCursor(ring, binding, position, now);
      expect(token.length).toBeLessThanOrEqual(4096);
      expect(await decodeListCursor(ring, binding, token, now)).toEqual({ ok: true, ...position });
      expect(Buffer.from(token, 'base64url').toString()).not.toContain(sourceAfter);
    }
  }
});
