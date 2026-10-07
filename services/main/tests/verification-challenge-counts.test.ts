import { expect, mock, test } from 'bun:test';
import type { Pool } from 'pg';
import { VerificationStore } from '../src/modules/verification/store.ts';

interface ChallengeHead { revision: string; open_count: number; resolved: number }
const claim = 'https://rezics.com/id/00000000-0000-0000-0000-000000000001';
const unrelated = 'https://rezics.com/id/00000000-0000-0000-0000-000000000002';

function headStore(heads: ReadonlyMap<string, ChallengeHead>, readError?: Error) {
  const reads: { sql: string; parameters: unknown[] }[] = [];
  const commands: string[] = [];
  const release = mock(() => {});
  const query = async (sql: string, parameters: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/.test(normalized)) {
      commands.push(normalized);
      return { rows: [] };
    }
    // Summary reads must stay possible even when retained history is unavailable.
    // Enforce one keyed head read rather than accepting a history-counting query
    // that happens to return the same small-fixture result.
    expect(normalized).not.toMatch(/\b(JOIN|COUNT)\b|verification\.challenge(?:_resolution)?\b/i);
    expect(normalized).toMatch(/\bFROM verification\.challenge_head(?:\s+\w+)? WHERE (?:\w+\.)?claim = \$1$/i);
    expect(parameters).toHaveLength(1);
    reads.push({ sql: normalized, parameters });
    if (readError) throw readError;
    const row = heads.get(String(parameters[0]));
    return { rows: row ? [row] : [] };
  };
  const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
  return { store: new VerificationStore(pool), reads, commands, release };
}

test('challenge summary reads an absent claim as zero without consulting retained history', async () => {
  const fixture = headStore(new Map());
  expect(await fixture.store.challengeState(claim)).toEqual({ revision: null, open: 0, resolved: 0 });
  expect(fixture.reads).toHaveLength(1);
  expect(fixture.reads[0]?.parameters).toEqual([claim]);
  expect(fixture.commands.at(-1)).toBe('COMMIT');
  expect(fixture.release).toHaveBeenCalledTimes(1);
});

test('challenge summary returns exact counts and an opaque revision from its own claim head', async () => {
  const revision = '9007199254740993';
  const fixture = headStore(new Map([
    [claim, { revision, open_count: 13, resolved: 2_000_000_000 }],
    [unrelated, { revision: '77', open_count: 999, resolved: 888 }],
  ]));
  expect(await fixture.store.challengeState(claim)).toEqual({ revision, open: 13, resolved: 2_000_000_000 });
  expect(fixture.reads).toHaveLength(1);
  expect(fixture.reads[0]?.parameters).toEqual([claim]);
});

test('challenge summary query work is identical for zero and large retained-count heads', async () => {
  const empty = headStore(new Map([[claim, { revision: '1', open_count: 0, resolved: 0 }]]));
  const large = headStore(new Map([
    [claim, { revision: '200000001', open_count: 3, resolved: 200_000_000 }],
    ...Array.from({ length: 1000 }, (_, index): [string, ChallengeHead] => [
      `urn:unrelated:claim:${index}`, { revision: '9000', open_count: 100, resolved: 200_000_000 },
    ]),
  ]));
  expect(await empty.store.challengeState(claim)).toEqual({ revision: '1', open: 0, resolved: 0 });
  expect(await large.store.challengeState(claim)).toEqual({ revision: '200000001', open: 3, resolved: 200_000_000 });
  expect(empty.reads).toHaveLength(1);
  expect(large.reads).toEqual(empty.reads);
});

test('a failed head read is propagated instead of presenting an empty challenge summary', async () => {
  const failure = new Error('head storage unavailable');
  const fixture = headStore(new Map(), failure);
  await expect(fixture.store.challengeState(claim)).rejects.toBe(failure);
  expect(fixture.commands.at(-1)).toBe('ROLLBACK');
  expect(fixture.commands).not.toContain('COMMIT');
  expect(fixture.release).toHaveBeenCalledTimes(1);
});
