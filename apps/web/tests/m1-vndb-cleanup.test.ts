import { expect, test } from 'bun:test';
import { createVndbJourney } from '../src/library/personal-list-import/controller';
import { VNDB_XML_BYTES, type VndbCommand, type VndbPort } from '../src/library/personal-list-import/contract';
import {
  VNDB_LIFECYCLE_TARGET,
  VNDB_LIFECYCLE_UPLOAD,
  VNDB_LIFECYCLE_XML,
  vndbLifecyclePage,
  vndbLifecyclePort,
  vndbLifecycleReviewedRow,
} from '../src/library/personal-list-import/lifecycle';
import type { VndbVisit } from '../src/library/personal-list-import/visit';

function visit(): VndbVisit {
  const controller = new AbortController();
  return {
    subject: VNDB_LIFECYCLE_TARGET,
    csrfToken: 'original-credential',
    controller,
    current: () => !controller.signal.aborted,
    retire: () => controller.abort(),
  };
}

function fixture() {
  const previews: Extract<VndbCommand, { kind: 'preview' }>[] = [];
  const page = vndbLifecyclePage([vndbLifecycleReviewedRow()]);
  const base = vndbLifecyclePort(page);
  const port: VndbPort = {
    ...base,
    async preview(command) {
      previews.push(command);
      return base.preview(command);
    },
  };
  return { port, previews };
}

test.each(['unknown', 'unavailable'] as const)(
  'VNDB %s cleanup freezes removal and continues only the newest explicit replacement',
  async (failure) => {
    const { port, previews } = fixture();
    const commands: Extract<VndbCommand, { kind: 'delete' }>[] = [];
    const acknowledged = Promise.withResolvers<Awaited<ReturnType<VndbPort['delete']>>>();
    port.delete = async (command) => {
      commands.push(command);
      if (commands.length > 1) return acknowledged.promise;
      return failure === 'unknown' ? { kind: 'unknown', command } : { kind: 'unavailable', status: 503 };
    };
    const journey = createVndbJourney({ port, visit: visit() });
    await journey.preview(VNDB_LIFECYCLE_XML);
    await journey.source();
    journey.openConfirm();
    await journey.preview('<replacement/>');
    expect(journey.snapshot()).toMatchObject({
      stage: 'cleanup',
      cleanupPending: true,
      sourceXML: null,
      page: null,
      rows: [],
      selection: [],
    });
    await journey.loadPage(0);
    await journey.source();
    await journey.confirm();
    expect(previews).toHaveLength(1);
    const retry = journey.retryUnknown();
    await journey.retryUnknown();
    journey.editReplacement();
    await journey.preview('<newer/>');
    expect(previews).toHaveLength(1);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    expect(commands[0]?.uploadId).toBe(VNDB_LIFECYCLE_UPLOAD);
    acknowledged.resolve({ kind: 'deleted' });
    await retry;
    expect(previews.map((command) => command.xml)).toEqual([VNDB_LIFECYCLE_XML, '<newer/>']);
    expect(journey.snapshot().cleanupPending).toBe(false);
  },
);

test.each(['edit', 'discard'] as const)('VNDB %s withdraws continuation without changing removal', async (change) => {
  const { port, previews } = fixture();
  const acknowledged = Promise.withResolvers<Awaited<ReturnType<VndbPort['delete']>>>();
  let calls = 0;
  port.delete = () => {
    calls += 1;
    return acknowledged.promise;
  };
  const journey = createVndbJourney({ port, visit: visit() });
  await journey.preview(VNDB_LIFECYCLE_XML);
  journey.openConfirm();
  await journey.confirm();
  const receipts = journey.snapshot().outcomes;
  expect(receipts.length).toBeGreaterThan(0);
  const replacing = journey.preview('<replacement/>');
  if (change === 'edit') journey.editReplacement();
  else await journey.discard();
  acknowledged.resolve({ kind: 'deleted' });
  await replacing;
  expect(calls).toBe(1);
  expect(previews).toHaveLength(1);
  expect(journey.snapshot()).toMatchObject({
    stage: change === 'edit' ? 'upload' : 'removed',
    cleanupPending: false,
    outcomes: receipts,
  });
  await journey.preview('<explicit-next/>');
  expect(previews).toHaveLength(2);
});

test.each(['account', 'credential', 'departure'] as const)(
  'VNDB %s retires pending replacement permanently',
  async (change) => {
    const { port, previews } = fixture();
    const current = visit();
    const acknowledged = Promise.withResolvers<Awaited<ReturnType<VndbPort['delete']>>>();
    port.delete = () => acknowledged.promise;
    const journey = createVndbJourney({ port, visit: current });
    await journey.preview(VNDB_LIFECYCLE_XML);
    const replacing = journey.preview('<replacement/>');
    if (change === 'departure') current.retire();
    else if (change === 'account') current.subject = 'other';
    else current.csrfToken = 'other';
    expect(journey.snapshot()).toMatchObject({ uploadId: null, cleanupPending: false, replacementPending: false });
    current.subject = VNDB_LIFECYCLE_TARGET;
    current.csrfToken = 'original-credential';
    acknowledged.resolve({ kind: 'deleted' });
    await replacing;
    await journey.retryUnknown();
    expect(journey.live()).toBe(false);
    expect(previews).toHaveLength(1);
  },
);

test('VNDB retains no replacement above the existing XML cap while removal is uncertain', async () => {
  const { port, previews } = fixture();
  let calls = 0;
  port.delete = async (command) => {
    calls += 1;
    return { kind: 'unknown', command };
  };
  const journey = createVndbJourney({ port, visit: visit() });
  await journey.preview(VNDB_LIFECYCLE_XML);
  await journey.preview('<replacement/>');
  await journey.preview('x'.repeat(VNDB_XML_BYTES + 1));
  expect(journey.snapshot()).toMatchObject({ cleanupPending: true, replacementPending: false });
  expect(calls).toBe(1);
  expect(previews).toHaveLength(1);
});
