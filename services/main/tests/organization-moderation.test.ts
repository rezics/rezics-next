import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { canonicalOrganizationPublication, moderationProofDigest, type OrganizationPublicationTarget }
  from '../src/modules/access/organization-publication.ts';
import { organizationRejectionInput } from '../src/modules/work/reject-organization-admitted.ts';
import { checkedRealmRejectionReceipt, realmRejectionDigest, realmRejectionReceiptIri }
  from '../src/modules/work/reject-realm.ts';
import { hash, ID } from '../src/modules/work/activate.ts';
import { realmSelectionSlotIri } from '../src/modules/work/select-realm.ts';
import { REVIEW_POLICY, SELECTION_POLICY } from '../src/modules/space/create.ts';

const target = (): OrganizationPublicationTarget => ({ realm: ID + randomUUID(), organizationSubject: ID + randomUUID(),
  participationId: randomUUID(), participationGeneration: '1', proposalId: randomUUID(), policyRevision: '1',
  work: ID + randomUUID(), mainVersion: ID + randomUUID(), expectedWorkHead: ID + randomUUID(),
  selection: ID + randomUUID(), contribution: ID + randomUUID(), publicationDecision: ID + randomUUID(),
  selectedDraft: ID + randomUUID(), actingSubject: ID + randomUUID(), representationId: randomUUID(), representationGeneration: '0' });

test('IAM23: every organization target identity changes intent and proof hashing survives JSONB key order', () => {
  const original = target();
  const digest = realmRejectionDigest(organizationRejectionInput(original));
  for (const key of Object.keys(original) as (keyof OrganizationPublicationTarget)[]) {
    const replacement = key.includes('Generation') || key === 'policyRevision' ? '2'
      : key.endsWith('Id') ? randomUUID() : ID + randomUUID();
    expect(realmRejectionDigest(organizationRejectionInput({ ...original, [key]: replacement }))).not.toBe(digest);
  }
  expect(canonicalOrganizationPublication(original)).toEqual(original);
  expect(moderationProofDigest({ target: original, principal: 'private', epoch: '0' }))
    .toBe(moderationProofDigest({ epoch: '0', principal: 'private', target: Object.fromEntries(Object.entries(original).reverse()) }));
});

test('IAM23: old generic rejection digests and immutable receipts retain their original meaning', () => {
  const t = target();
  const { organizationPublication: _organization, ...input } = organizationRejectionInput(t);
  const original = hash(JSON.stringify({ family: 'reject-realm-local-v1', context: input.context,
    work: input.work, mainVersion: input.mainVersion, expectedSelectionHead: input.expectedSelectionHead,
    decisionBasis: input.decisionBasis, reasonCode: input.reasonCode, actor: input.actingSubject,
    selectionPolicy: SELECTION_POLICY, reviewPolicy: REVIEW_POLICY }));
  expect(realmRejectionDigest(input)).toBe(original);
  const id = randomUUID(), receipt = { outcome: 'succeeded' as const,
    receipt: realmRejectionReceiptIri(id), admissionId: id, requestDigest: original,
    authorityEpoch: '0', scope: `publication:reject:${t.realm}`, dataEpoch: randomUUID(), sequence: '1',
    operation: ID + randomUUID(), work: t.work, mainVersion: t.mainVersion, realm: t.realm,
    slot: realmSelectionSlotIri(t.realm, t.mainVersion), rejection: ID + randomUUID(),
    expectedHead: t.selection, reasonCode: 'not-approved' as const };
  expect(checkedRealmRejectionReceipt(receipt, { id, principalId: randomUUID(), actingSubject: t.actingSubject,
    action: 'publication.reject', scope: receipt.scope, requestDigest: original, authorityEpoch: '0',
    idempotencyKey: 'legacy', expiresAt: new Date(0).toISOString(), state: 'sealed', dispatchEligible: false,
    replayed: true }, input, original)).toEqual(receipt);
});
