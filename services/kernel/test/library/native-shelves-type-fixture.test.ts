import { afterAll, beforeAll, expect, test } from 'bun:test';
import { observeShelfType, createShelfTypeSource } from '../../src/library/shelf-type-source.ts';
import { createLibraryDriver } from './support/outcome-driver.ts';
import { compileProfileRelease, profileTypes } from './support/native-conformance-profiles.ts';
import { publish, type NativeConformanceWorld } from './support/native-conformance.ts';
import { createNativeShelvesTypeFixture } from './support/native-shelves-type-fixture.ts';

let world: NativeConformanceWorld;
let fixture: ReturnType<typeof createNativeShelvesTypeFixture>;
beforeAll(async () => {
  world = await createLibraryDriver();
  await publish(world, await compileProfileRelease());
  fixture = createNativeShelvesTypeFixture(world);
}, 240000);
afterAll(async () => {
  await world?.close();
});

const revised = async (id: string) =>
  (
    await world.native.reader.query(
      `SELECT id,partition_no,epoch,position::text,event_seq,data FROM core.outbox
   WHERE type='com.rezics.subject.revised.v1' AND subject=$1 ORDER BY partition_no,position,event_seq`,
      [id],
    )
  ).rows;

test('primary-type binding emits the native identity revision and source stamp for the supplied subject', async () => {
  const subject = await world.native.subject(profileTypes.book);
  await world.native.hold();
  try {
    const { revision } = await fixture.changeSubjectType(subject.id, profileTypes.anime);
    const events = await revised(subject.id);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ id: subject.id, revision, kind: 'identity' });
    const observed = await observeShelfType({ pool: world.native.pool, source: createShelfTypeSource() }, subject.id);
    expect(observed).toEqual({
      binding: {
        sourceId: subject.id,
        stamp: {
          partition: events[0].partition_no,
          epoch: events[0].epoch,
          position: BigInt(events[0].position),
        },
      },
      source: { sourceId: subject.id, type: profileTypes.anime, stamp: observed.binding.stamp },
      survivorId: null,
    });
  } finally {
    await world.native.resume();
  }
}, 240000);

test('repeat and reverse delivery execute original consumers with unchanged event inputs and receipts', async () => {
  const subject = await world.native.subject(profileTypes.book);
  await fixture.changeSubjectType(subject.id, profileTypes.anime);
  await fixture.changeSubjectType(subject.id, profileTypes.game);
  await world.settle();
  const events = await revised(subject.id);
  expect(events).toHaveLength(2);
  const originals = (
    await world.native.reader.query<{ workflowId: string }>(
      `SELECT c.workflow_id AS "workflowId" FROM core.history_event_consumer c JOIN core.outbox e
     USING(partition_no,position,event_seq) WHERE e.type='com.rezics.subject.revised.v1' AND e.subject=$1`,
      [subject.id],
    )
  ).rows;
  expect(originals.length).toBeGreaterThanOrEqual(events.length);
  const receipts = await Promise.all(
    originals.map(({ workflowId }) => world.native.workClient.listWorkflowSteps(workflowId)),
  );
  for (const order of ['repeat', 'reverse'] as const) await fixture.redeliver({ subjectId: subject.id, order });
  const workflows = await world.native.workClient.listWorkflows({ limit: 10000 });
  for (const [index, { workflowId }] of originals.entries()) {
    const original = await world.native.workClient.getWorkflow(workflowId);
    const replays = workflows.filter((row) => row.forkedFrom === workflowId);
    expect(replays).toHaveLength(2);
    for (const replay of replays) {
      expect(replay.status).toBe('SUCCESS');
      expect((await world.native.workClient.getWorkflow(replay.workflowID))!.input).toEqual(original!.input);
      expect((await world.native.workClient.listWorkflowSteps(replay.workflowID))!.length).toBeGreaterThan(0);
    }
    expect(await world.native.workClient.listWorkflowSteps(workflowId)).toEqual(receipts[index]);
  }
  expect(await revised(subject.id)).toEqual(events);
}, 240000);
