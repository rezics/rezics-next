import { expect, test } from 'bun:test';
import { fenceAuthorNames, sourceReportedCredits } from '../src/modules/source/author-name-read.ts';
import { SOURCE_ADOPTION_READ_COST } from '../src/modules/source/native-work-adoption.ts';
import { WorkReadMoved, type WorkReadSession } from '../src/modules/work/read-session.ts';

const cap = SOURCE_ADOPTION_READ_COST.authorWorks;
const work = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
type Ref = { id: string; key: string; ordinal: number };

function harness(count: number) {
  const works = Array.from({ length: count }, (_, index) => work(index + 1));
  const canonical = new Map<string, Ref[]>(works.map(item => [item, [{ id: item, key: '/authors/OL1A', ordinal: 0 }]]));
  const calls: string[][] = [];
  const results: Map<string, Ref[]>[] = [];
  const reader = {
    deps: {
      sourceAdoptions: { authorReferences: async (batch: readonly string[]) => {
        calls.push([...batch]);
        if (batch.length > cap) throw new Error('invalid source author batch');
        const result = new Map(batch.map(item => [item, canonical.get(item) ?? []]));
        results.push(result);
        return result;
      } },
      sourceAuthorNames: { batch: async () => new Map() },
    },
    checkDeadline() {},
  } as unknown as WorkReadSession;
  return { works, canonical, calls, results, reader };
}

async function record(reader: WorkReadSession, works: readonly string[]) {
  for (let offset = 0; offset < works.length; offset += cap) {
    await sourceReportedCredits(reader, works.slice(offset, offset + cap));
  }
}

test('author binding fence rereads 65, 128 and 1000 works inside the adoption cap', async () => {
  for (const count of [65, 128, 1000]) {
    const { works, calls, reader } = harness(count);
    await record(reader, works);
    const recorded = calls.length;
    await fenceAuthorNames(reader);
    const fenceCalls = calls.slice(recorded);
    expect(fenceCalls.length).toBe(Math.ceil(count / cap));
    expect(fenceCalls.every(chunk => chunk.length > 0 && chunk.length <= cap)).toBe(true);
    expect(fenceCalls.flat()).toEqual(works);
  }
});

test('author binding fence merges to the same map one call returns for a small set', async () => {
  const { works, calls, results, reader } = harness(3);
  await sourceReportedCredits(reader, works);
  const direct = results[0]!;
  const marked = results.length;
  await fenceAuthorNames(reader);
  expect(calls.at(-1)).toEqual(works);
  const merged = new Map<string, Ref[]>();
  for (const part of results.slice(marked)) for (const [item, refs] of part) merged.set(item, refs);
  expect([...merged]).toEqual([...direct]);
});

test('author binding fence refuses when a binding past the first chunk moves', async () => {
  const { works, canonical, calls, reader } = harness(65);
  await record(reader, works);
  canonical.set(works[64]!, [{ id: works[64]!, key: '/authors/OL9A', ordinal: 4 }]);
  const marked = calls.length;
  await expect(fenceAuthorNames(reader)).rejects.toBeInstanceOf(WorkReadMoved);
  expect(calls.slice(marked).map(chunk => chunk.length)).toEqual([cap, 1]);
});
