import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { setFakeVerificationState } from '../src/kernel/fake/verification';

test.each(['pending', 'approved', 'rejected'] as const)(
  'the %s verification story resolves its catalogue person instead of the default book',
  async (state) => {
    setFakeVerificationState(state);
    try {
      const client = createKernelClient('https://kernel.example.test', { fetch: createStoryRecordedKernelFetch() });
      const verification = await client.accounts({ accountId: 'alice' }).verification.get();
      const id = verification.data?.verificationRequest?.catalogueSubjectId;
      expect(id).toBeDefined();
      const subject = await client.subjects({ id: id! }).get();
      expect(subject.status).toBe(200);
      expect(subject.data?.subject).toMatchObject({
        id,
        type: 'schema:Person',
        labels: { en: 'Haruka Aizawa' },
      });
    } finally {
      setFakeVerificationState('none');
    }
  },
);
