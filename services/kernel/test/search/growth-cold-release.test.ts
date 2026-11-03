import { expect, test } from 'bun:test';
import { runColdReleaseHistory, runColdReleasePayloads } from './support/cold-release-growth.ts';

test('cold and warm native Search release reads stay anchored as activation and release history grows', async () => {
  const history = [];
  for (const rows of [1, 64, 4096]) history.push(await runColdReleaseHistory(rows));
  const payloads = await runColdReleasePayloads();

  console.info(`Search release history native work: ${JSON.stringify(history)}`);
  console.info(`Search release payload native work: ${JSON.stringify(payloads)}`);

  expect(new Set(history.map(({ digest }) => digest)).size).toBe(1);
  expect(new Set(history.map(({ canonicalBytes }) => canonicalBytes)).size).toBe(1);
  expect(history.map(({ activationRows, releaseRows }) => [activationRows, releaseRows])).toEqual([
    [1, 1],
    [64, 64],
    [4096, 4096],
  ]);
  for (const sample of [...history, ...payloads.samples]) {
    expect(sample.cold.bodyReads).toBe(1);
    expect(sample.warm.bodyReads).toBe(0);
    expect(sample.warmReusesRelease).toBe(true);
    expect(sample.immutable).toBe(true);
    expect(sample.cold.cost.statements).toBe(2);
    expect(sample.warm.cost.statements).toBe(2);
    expect(sample.cold.cost.plans).toBe(2);
    expect(sample.warm.cost.plans).toBe(2);
    expect(sample.cold.cost.removedRows).toBeGreaterThanOrEqual(0);
    expect(sample.cold.bodyResponseBytes).toBeGreaterThanOrEqual(sample.canonicalBytes);
    expect(sample.cold.native.statements.some((statement) => /semantic\.definition_activation/i.test(statement))).toBe(
      true,
    );
    expect(sample.cold.native.statements.some((statement) => /SELECT\s+body\s+FROM\s+semantic\.definition_release/i.test(statement))).toBe(
      true,
    );
    expect(sample.warm.native.statements.some((statement) => /SELECT\s+digest\s+FROM\s+semantic\.definition_release/i.test(statement))).toBe(
      true,
    );
  }

  const leastExamined = Math.min(...history.map(({ cold }) => cold.cost.examinedRows));
  const leastBuffers = Math.min(...history.map(({ cold }) => cold.cost.buffers));
  // The pointer and release key are two point-read anchors; this margin tolerates small-table plan changes while rejecting a history scan.
  for (const sample of history) {
    expect(sample.cold.cost.examinedRows).toBeLessThanOrEqual(leastExamined + 4);
    expect(sample.warm.cost.examinedRows).toBeLessThanOrEqual(leastExamined + 4);
    expect(sample.cold.cost.removedRows).toBeLessThanOrEqual(4);
    expect(sample.cold.cost.buffers).toBeLessThanOrEqual(leastBuffers + 4);
    expect(sample.warm.cost.buffers).toBeLessThanOrEqual(leastBuffers + 4);
  }
  expect(new Set(history.map(({ cold }) => cold.bodyResponseBytes)).size).toBe(1);
  expect(new Set(payloads.samples.map(({ digest }) => digest)).size).toBe(payloads.samples.length);

  expect(payloads.samples.map(({ payloadBytes }) => payloadBytes)).toEqual(
    [...payloads.samples].map(({ payloadBytes }) => payloadBytes).sort((a, b) => a - b),
  );
  for (let index = 1; index < payloads.samples.length; index++) {
    const previous = payloads.samples[index - 1]!;
    const current = payloads.samples[index]!;
    expect(current.payloadBytes).toBeGreaterThan(previous.payloadBytes);
    expect(current.canonicalBytes - previous.canonicalBytes).toBe(current.payloadBytes - previous.payloadBytes);
    expect(current.cold.bodyResponseBytes - previous.cold.bodyResponseBytes).toBe(
      current.canonicalBytes - previous.canonicalBytes,
    );
  }
}, 600_000);
