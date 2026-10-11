import { expect, test } from 'bun:test';
import { restoreRecoverySet, type RestoredContext, type RestoreChecks } from '../restore.ts';
import { verifyRecoveryServing } from '../../../tests/qa/fault-recovery/g-727-recovery-checks.ts';

const sampleWork = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const probes = { sample: { work: sampleWork } } as Parameters<typeof verifyRecoveryServing>[2];

test('independent restore holds without the default or required serving callback', async () => {
  const incomplete = {
    verify: async () => {},
    reconcile: async () => Response.json({ state: 'reconciled', disposition: 'matched' }),
  } as unknown as RestoreChecks;
  const options = {
    set: '.temp/restore-serving-missing-set',
    frontier: '.temp/restore-serving-missing-frontier',
    project: 'rezics-qa-restore-serving-held',
    key: 'ab'.repeat(32),
  };

  for (const checks of [undefined, incomplete]) {
    await expect(
      restoreRecoverySet({ ...options, ...(checks ? { checks } : {}) }),
    ).rejects.toThrow(
      'Restore is held: configure exact read/search/takeout checks, authenticated owner reconciliation, and post-release serving verification',
    );
  }
});

test('serving probes refuse a different restored target before making requests', async () => {
  const reconciledTarget = {} as RestoredContext;
  const otherTarget = {} as RestoredContext;
  const requests: Request[] = [];
  const app = {
    handle: async (request: Request) => {
      requests.push(request);
      return Response.json({ status: 'ready' });
    },
  };

  await expect(
    verifyRecoveryServing(otherTarget, reconciledTarget, probes, app),
  ).rejects.toThrow('Serving verification received a different restored target');
  expect(requests).toHaveLength(0);
});

test('serving probes fail when a normal restored Work read fails after readiness', async () => {
  const target = {} as RestoredContext;
  const requests: string[] = [];
  const app = {
    handle: async (request: Request) => {
      requests.push(new URL(request.url).pathname);
      return requests.length === 1
        ? Response.json({ status: 'ready' })
        : Response.json({ status: 'unavailable' }, { status: 503 });
    },
  };

  await expect(verifyRecoveryServing(target, target, probes, app)).rejects.toThrow(
    'Restored target Work read returned 503',
  );
  expect(requests).toEqual(['/health/ready', `/v1/works/${sampleWork.slice(-36)}`]);
});
