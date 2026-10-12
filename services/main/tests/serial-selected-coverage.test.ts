import { expect, test } from 'bun:test';
import { selectedSerialFixture, serialId, serialWork } from './serial-selected-fixture.ts';

test('selected Structure changes cannot reuse an old aggregate during unrelated stream lag', async () => {
  const f = selectedSerialFixture(); f.state.relayHead = '100'; f.state.currentHead = serialId(99);
  expect((await f.projection.batch([serialWork])).size).toBe(0);
  f.state.projectedHead = f.state.currentHead; f.state.count = f.state.children = 3;
  expect((await f.projection.batch([serialWork])).get(serialWork)?.chapterCount).toBe(3);
});

test('unchanged selected materialization survives unrelated relay backlog', async () => {
  const f = selectedSerialFixture(); f.state.relayHead = '100';
  expect((await f.projection.batch([serialWork])).get(serialWork)?.chapterCount).toBe(2);
});

for (const changed of ['publication', 'eligibility', 'revision'] as const) {
  test(`selected child ${changed} must match the materialized owner basis`, async () => {
    const f = selectedSerialFixture(); f.state[changed] = serialId(98);
    expect((await f.projection.batch([serialWork])).size).toBe(0);
    if (changed === 'publication') f.state.savedPublication = f.state.publication;
    if (changed === 'eligibility') f.state.savedEligibility = f.state.eligibility;
    if (changed === 'revision') f.state.savedRevision = f.state.revision;
    f.state.bodySequence = '41';
    expect((await f.projection.batch([serialWork])).size).toBe(0);
    f.state.graphCut = '41';
    expect((await f.projection.batch([serialWork])).get(serialWork)?.chapterCount).toBe(2);
  });
}

test('Access advancing during a read is qualified by its retained batch rather than the earlier relay head', async () => {
  const f = selectedSerialFixture(); f.state.advanceDuringAccess = true;
  expect((await f.projection.batch([serialWork])).get(serialWork)?.wordCount).toBe(480);
  expect(f.state.checkpoint).toBe('4');
  f.state.retained = false;
  expect((await f.projection.batch([serialWork])).size).toBe(0);
});

test('mixed summary and chapter materialization is incomplete', async () => {
  const f = selectedSerialFixture(); f.state.children = 1;
  expect((await f.projection.batch([serialWork])).size).toBe(0);
  f.state.children = 2; f.state.bodyEpoch = 'foreign';
  expect((await f.projection.batch([serialWork])).size).toBe(0);
});
