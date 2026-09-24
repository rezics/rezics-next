import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ContentCore } from '../../content/src/core.ts';
import type { AccessAdmissionRegistry, RegisteredAdmission } from '../src/modules/access/admission.ts';
import { contentDraftReceiptIri } from '../src/modules/content-publication/draft.ts';
import { strongRevokeWorkScope } from '../src/modules/work/strong-revoke.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

test('IAM07/WORK09: interrupted Content save is cancelled under the strong Access fence', async () => {
  const id = randomUUID();
  const scope = `content:draft:https://rezics.com/id/${randomUUID()}`;
  const admission: RegisteredAdmission = { id, principalId: randomUUID(),
    actingSubject: `https://rezics.com/id/${randomUUID()}`, scope,
    action: 'content.draft', idempotencyKey: `draft-${id}`,
    requestDigest: 'a'.repeat(64), authorityEpoch: '0',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'claimed', dispatchEligible: false, replayed: true };
  const steps: string[] = [];
  let sealed = false;
  const content = { cancelDraft: async (admissionId: string, digest: string) => {
    steps.push('content.cancel');
    expect(admissionId).toBe(id);
    expect(digest).toBe(admission.requestDigest);
    return { outcome: 'cancelled' as const, revisionId: null, predecessor: null,
      position: { owner: 'content' as const, dataEpoch: randomUUID(), sequence: '7' },
      replayed: false };
  } } as ContentCore;
  const access = {
    strongCloseScope: async () => {
      steps.push('access.fence');
      return { scope, authorityEpoch: '1', pending: sealed ? 0 : 1 };
    },
    listUnsealed: async () => sealed ? [] : [admission],
    recordGraphOutcome: async (admissionId: string, proof: { outcome: string;
      receipt: string; requestDigest: string; dataEpoch: string; sequence: string }) => {
      steps.push('access.seal');
      expect(admissionId).toBe(id);
      expect(proof).toMatchObject({ outcome: 'cancelled',
        receipt: contentDraftReceiptIri(id), requestDigest: admission.requestDigest,
        sequence: '7' });
      sealed = true;
    },
  } as unknown as AccessAdmissionRegistry;
  const progress = await strongRevokeWorkScope({} as WorkActivationEnvironment,
    access, scope, '0', content);
  expect(progress).toMatchObject({ status: 'complete', pending: 0 });
  expect(steps).toEqual(['access.fence', 'content.cancel', 'access.seal', 'access.fence']);
});
