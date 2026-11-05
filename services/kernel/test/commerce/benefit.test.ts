import { expect, test } from 'bun:test';
import {
  captureContentEditionSaleAuthority,
  captureCurrentContentEdition,
  ContentEditionUnavailableError,
  decodeCapturedContentEdition,
  nativeEditionAuthorityAvailability,
  requireCurrentContentEdition,
  sameCapturedContentEdition,
  withoutUnverifiedBenefit,
} from '../../src/commerce/benefit.ts';
import type { CheckoutDecision } from '../../src/commerce/model.ts';
import { newId } from '../../src/route/route.ts';
import type { ContentEditionSaleAuthority } from '../../src/content/edition-model.ts';

test('the real missing Content producer has only a typed unavailable result', async () => {
  expect(nativeEditionAuthorityAvailability()).toEqual({
    kind: 'unavailable',
    reason: 'content-edition-sale-port-pending',
  });
  await expect(captureCurrentContentEdition(newId(0x2200))).rejects.toBeInstanceOf(ContentEditionUnavailableError());
  await expect(requireCurrentContentEdition(null)).rejects.toBeInstanceOf(ContentEditionUnavailableError());
});

test('historic mapping remains unknown and cannot be inferred from arbitrary bytes', () => {
  expect(decodeCapturedContentEdition(null)).toBeNull();
  for (const value of [{ targetSubjectId: newId(0x2200) }, { kind: 'content-edition' }, { body: 'x'.repeat(4096) }])
    expect(() => decodeCapturedContentEdition(JSON.stringify(value))).toThrow();
});

test('unavailable authority preserves paid truth/evidence and suppresses grant and restore only', () => {
  for (const kind of ['grant', 'restore'] as const) {
    const decision: CheckoutDecision = {
      changed: true,
      settlement: 'paid',
      paymentIntentId: 'pi_paid',
      observedAt: '2026-10-31T00:00:00Z',
      newTransactions: [],
      entitlement: { kind },
    };
    expect(withoutUnverifiedBenefit(decision)).toEqual({ ...decision, entitlement: { kind: 'none' } });
    expect(decision.entitlement.kind).toBe(kind);
  }
  for (const entitlement of [
    { kind: 'none' },
    { kind: 'revoke', reason: 'refund' },
    { kind: 'reason', reason: 'dispute' },
  ] as const) {
    const decision: CheckoutDecision = {
      changed: true,
      settlement: 'paid',
      paymentIntentId: 'pi_paid',
      observedAt: '2026-10-31T00:00:00Z',
      newTransactions: [],
      entitlement,
    };
    expect(withoutUnverifiedBenefit(decision)).toBe(decision);
  }
});

// Closed-port conversion coverage, not a substitute for the native Content producer's verification.
function saleAuthority(): ContentEditionSaleAuthority {
  const revisionId = newId(0x2200);
  return {
    benefit: {
      kind: 'content-edition',
      resourceType: 'content.edition',
      resource: { route: 0x2200, id: newId(0x2200) },
      version: { revisionId, sha256: 'a'.repeat(64) },
      action: 'edition:read',
    },
    creatorAccountId: newId(0x1100),
    targetSubjectId: newId(0x3300),
    licence: 'CC-BY-4.0',
    source: { threadId: newId(0x2200), postId: newId(0x2200), revisionId, sha256: 'a'.repeat(64) },
    editionRevision: '2',
  };
}

test('native sale facts capture exact edition publication and version without copying source bytes', () => {
  const authority = saleAuthority();
  const capture = captureContentEditionSaleAuthority(authority.benefit.resource.id, authority);
  expect(capture).toMatchObject({
    benefit: authority.benefit,
    creatorAccountId: authority.creatorAccountId,
    targetSubjectId: authority.targetSubjectId,
    source: { threadId: authority.source.threadId, postId: authority.source.postId, licence: authority.licence },
    delivery: 'fixed-content-edition',
    acquisition: 'one-time-account-bound',
    quantity: 1,
  });
  expect(JSON.parse(capture.saleTermsReference)).toEqual([
    authority.benefit.resource.id,
    authority.benefit.version.revisionId,
    authority.benefit.version.sha256,
    authority.editionRevision,
  ]);
  expect(sameCapturedContentEdition(capture, decodeCapturedContentEdition(JSON.stringify(capture)))).toBe(true);
  expect(capture.benefit).not.toBe(authority.benefit);
  expect(Object.keys(capture.source).sort()).toEqual(['licence', 'postId', 'threadId']);
});

test('fresh sale refuses absent, retargeted or internally mismatched native source facts', () => {
  const authority = saleAuthority();
  const id = authority.benefit.resource.id;
  expect(() => captureContentEditionSaleAuthority(id, null)).toThrow(ContentEditionUnavailableError());
  expect(() =>
    captureContentEditionSaleAuthority(id, {
      ...authority,
      source: { ...authority.source, revisionId: newId(0x2200) },
    }),
  ).toThrow(ContentEditionUnavailableError());
  const exact = { ...authority, source: { ...authority.source, revisionId: authority.benefit.version.revisionId } };
  expect(() => captureContentEditionSaleAuthority(newId(0x2200), exact)).toThrow(ContentEditionUnavailableError());
  expect(() =>
    captureContentEditionSaleAuthority(id, { ...exact, source: { ...exact.source, sha256: 'b'.repeat(64) } }),
  ).toThrow(ContentEditionUnavailableError());
});

test('current sale must match every immutable captured native binding', () => {
  const authority = saleAuthority();
  const exact = { ...authority, source: { ...authority.source, revisionId: authority.benefit.version.revisionId } };
  const capture = captureContentEditionSaleAuthority(exact.benefit.resource.id, exact);
  const variants: ContentEditionSaleAuthority[] = [
    { ...exact, creatorAccountId: newId(0x1100) },
    { ...exact, targetSubjectId: newId(0x3300) },
    { ...exact, licence: 'CC-BY-SA-4.0' },
    { ...exact, editionRevision: '3' },
    { ...exact, source: { ...exact.source, threadId: newId(0x2200) } },
    { ...exact, source: { ...exact.source, postId: newId(0x2200) } },
    {
      ...exact,
      benefit: { ...exact.benefit, resource: { route: 0x2200, id: newId(0x2200) } },
    },
  ];
  const revisionId = newId(0x2200);
  variants.push({
    ...exact,
    benefit: { ...exact.benefit, version: { ...exact.benefit.version, revisionId } },
    source: { ...exact.source, revisionId },
  });
  variants.push({
    ...exact,
    benefit: { ...exact.benefit, version: { ...exact.benefit.version, sha256: 'b'.repeat(64) } },
    source: { ...exact.source, sha256: 'b'.repeat(64) },
  });
  variants.push({
    ...exact,
    benefit: { ...exact.benefit, resource: { route: 0x4400, id: newId(0x4400) } },
  });
  for (const current of variants) {
    expect(
      sameCapturedContentEdition(capture, captureContentEditionSaleAuthority(current.benefit.resource.id, current)),
    ).toBe(false);
  }
  expect(sameCapturedContentEdition(null, capture)).toBe(false);
  expect(sameCapturedContentEdition(capture, null)).toBe(false);
  for (const field of [{ kind: 'other' }, { resourceType: 'content.post' }, { action: 'post:read' }]) {
    expect(() =>
      decodeCapturedContentEdition(JSON.stringify({ ...capture, benefit: { ...capture.benefit, ...field } })),
    ).toThrow();
  }
});
