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

test('launch-style serving verification reads a non-public first manifest sample with operator authority', async () => {
  const target = {} as RestoredContext;
  const manifest = {
    entities: { publicUnits: 100 },
    samples: [{
      index: 0,
      work: sampleWork,
      agent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
    }],
  };
  const sample = manifest.samples[0]!;
  const requests: Request[] = [];
  const app = {
    handle: async (request: Request) => {
      requests.push(request);
      if (new URL(request.url).pathname === '/health/ready')
        return Response.json({ status: 'ready' });
      if (
        request.headers.get('authorization') !== 'Bearer qa-owner' ||
        new URL(request.url).searchParams.get('actingSubject') !== sample.agent
      )
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      return Response.json({ id: sample.work });
    },
  };
  const probes = {
    sample: { work: sample.work, actingSubject: sample.agent },
  } as Parameters<typeof verifyRecoveryServing>[2];

  await verifyRecoveryServing(target, target, probes, app);

  expect(sample.index).toBe(0);
  expect(sample.index > 0 && sample.index <= manifest.entities.publicUnits).toBe(false);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.headers.get('authorization')).toBe('Bearer qa-owner');
  expect(new URL(requests[1]!.url).searchParams.get('actingSubject')).toBe(sample.agent);
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
