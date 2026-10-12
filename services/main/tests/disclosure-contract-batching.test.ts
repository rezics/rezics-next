import { expect, test } from 'bun:test';
import { chunkDisclosureSubmission, DISCLOSURE_SUBMISSION_LIMIT } from '../src/modules/disclosure/contract-batching.ts';
import { DISCLOSURE_COST, DisclosureUnavailable, type DisclosureDecision } from '../src/modules/disclosure/read.ts';

for (const size of [0, 1, 64, 65, 501, 512, 1_024, 1_536, 2_048]) {
  test(`${size} inputs preserve order, duplicates and measured costs in bounded sequential submissions`, async () => {
    const repeated = { decision: 'hidden' as DisclosureDecision };
    const inputs = Array.from({ length: size }, (_, index) => index % 3 === 0 ? repeated
      : { decision: index % 3 === 1 ? 'visible' as const : 'tombstone' as const });
    const chunks: number[] = [], offsets: number[] = [], statements: string[] = [];
    let active = 0;
    const result = await chunkDisclosureSubmission(inputs, async (chunk, offset) => {
      expect(++active).toBe(1);
      chunks.push(chunk.length);
      offsets.push(offset);
      const before = statements.length;
      // Count every statement, including transaction protocol and owner work.
      for (const sql of ['BEGIN', 'recovery', 'owner', 'COMMIT']) statements.push(sql);
      await Promise.resolve();
      active--;
      return { results: chunk.map(item => item.decision), cost: {
        statements: statements.length - before, ownerStatements: 1, recoveryStatements: 1,
      } };
    });
    const expectedChunks = Math.ceil(size / DISCLOSURE_COST.batch);
    expect(result.results).toEqual(inputs.map(item => item.decision));
    expect(result.submissions).toBe(expectedChunks);
    expect(chunks).toEqual(Array.from({ length: expectedChunks }, (_, index) =>
      Math.min(64, size - index * 64)));
    expect(offsets).toEqual(chunks.map((_chunk, index) => index * 64));
    expect(result.cost).toEqual(size ? {
      statements: statements.length, ownerStatements: expectedChunks, recoveryStatements: expectedChunks,
    } : {});
  });
}

test('the overall cap refuses 2,049 before any callback for every contract result shape', async () => {
  expect(DISCLOSURE_SUBMISSION_LIMIT).toBe(2_048);
  let work = 0;
  for (const result of ['decision', 'selection', 'capture', 'fence']) {
    await expect(chunkDisclosureSubmission(Array(2_049).fill(result), async chunk => {
      work++;
      return { results: chunk, cost: {} };
    })).rejects.toBeInstanceOf(DisclosureUnavailable);
  }
  expect(work).toBe(0);
});

test('capture objects retain identity across chunk boundaries and regrouping', async () => {
  const repeated = { selection: 'same occurrence', fenceBasis: 'captured cut' };
  const inputs = Array.from({ length: 65 }, () => repeated);
  const captured = await chunkDisclosureSubmission(inputs, async chunk => ({ results: chunk, cost: {} }));
  expect(captured.results.every(cut => cut === repeated)).toBe(true);
  const fenced = await chunkDisclosureSubmission([...captured.results].reverse(), async chunk => ({
    results: chunk, cost: {},
  }));
  expect(fenced.results).toHaveLength(65);
  expect(fenced.results.every(cut => cut === repeated)).toBe(true);
});

test('failure returns no partial result and does not submit later chunks', async () => {
  const submitted: number[] = [];
  await expect(chunkDisclosureSubmission(Array(129).fill('target'), async (chunk, offset) => {
    submitted.push(offset);
    if (offset === 64) throw new Error('owner unavailable');
    return { results: chunk, cost: {} };
  })).rejects.toBeInstanceOf(DisclosureUnavailable);
  expect(submitted).toEqual([0, 64]);
});

test('incomplete results and invalid measured costs fail closed', async () => {
  for (const results of [[], ['extra', 'extra']]) {
    await expect(chunkDisclosureSubmission(['target'], async () => ({ results, cost: {} })))
      .rejects.toBeInstanceOf(DisclosureUnavailable);
  }
  for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(chunkDisclosureSubmission(['target'], async chunk => ({ results: chunk, cost: { statements: count } })))
      .rejects.toBeInstanceOf(DisclosureUnavailable);
  }
  await expect(chunkDisclosureSubmission(Array(65).fill('target'), async chunk => ({
    results: chunk, cost: { statements: Number.MAX_SAFE_INTEGER },
  }))).rejects.toBeInstanceOf(DisclosureUnavailable);
});

test('callbacks cannot extend accepted input; counters sum sparse and prototype-named keys', async () => {
  const inputs = Array(65).fill('target') as string[];
  const result = await chunkDisclosureSubmission(inputs, async (chunk, offset) => {
    inputs.push(...Array(1_024).fill('late'));
    expect(Object.isFrozen(chunk)).toBe(true);
    return { results: chunk, cost: offset === 0 ? JSON.parse('{"__proto__":1,"statements":2}')
      : JSON.parse('{"__proto__":2,"other":3}') };
  });
  expect(result.results).toHaveLength(65);
  expect(result.cost).toEqual(JSON.parse('{"__proto__":3,"statements":2,"other":3}'));
  expect(Object.getPrototypeOf(result.cost)).toBe(Object.prototype);
});
