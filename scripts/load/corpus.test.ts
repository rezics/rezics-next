import { expect, test } from 'bun:test';
import { accessTerminalProof } from './corpus.ts';

test('OPS05: Access load seals retain owner receipt identities from product commands', () => {
  const context = 'https://rezics.com/id/11111111-1111-4111-8111-111111111111';
  const claimed = { id: 'admission-id', requestDigest: 'claimed-digest',
    authorityEpoch: '7', scope: 'rating:context:realm-id' };
  const proof = accessTerminalProof({ receipt: 'urn:receipt', dataEpoch: 'epoch', sequence: '4',
    context, realm: 'https://rezics.com/id/22222222-2222-4222-8222-222222222222',
    revision: 'https://rezics.com/id/33333333-3333-4333-8333-333333333333',
    requestDigest: 'owner-digest', admissionId: 'owner-admission' }, claimed);
  expect(proof).toMatchObject({ outcome: 'succeeded', admissionId: claimed.id,
    requestDigest: claimed.requestDigest, authorityEpoch: claimed.authorityEpoch,
    scope: claimed.scope, context, sequence: '4' });
});
