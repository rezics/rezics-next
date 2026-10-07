import { describe, expect, test } from 'bun:test';
import { commandInstance, commandLane, writeNewest, type CommandResult, type WriteRound } from '../features/api/command.ts';

interface Intent { title: string; tags: string[] }
interface Record extends Intent { version: number }
type Result<T> = CommandResult<T, 'unavailable' | 'moved' | 'conflict' | 'denied'>;
const unavailable: Result<Record> = { ok: false, failure: 'unavailable' };
const intent: Intent = { title: 'A book', tags: ['fiction', 'read'] };
const held: Record = { ...intent, version: 2 };
const matches = (record: Record) => record.title === intent.title
  && JSON.stringify(record.tags) === JSON.stringify(intent.tags);
const versionOf = (record: Record) => record.version;
const round = (): WriteRound => ({ seq: 1, key: crypto.randomUUID(), afterConfirmed: false,
  superseded: () => false, confirm: () => {} });

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('browser command identity', () => {
  test('one action retains its identity until success or a definitive refusal', () => {
    const command = commandInstance();
    const first = command.id();
    expect(first).not.toBe('');
    expect(command.id()).toBe(first);
    command.finish({ ok: false, failure: 'unavailable' });
    expect(command.id()).toBe(first);
    command.finish({ ok: true });
    const second = command.id();
    expect(second).not.toBe(first);
    command.finish({ ok: false, failure: 'denied' });
    expect(command.id()).not.toBe(second);
    expect(commandInstance().id()).not.toBe(command.id());
  });

  test('lost responses replay the receipt; the next identical action creates a new record', async () => {
    const lane = commandLane<Intent, Result<Record>>(unavailable);
    const receipts = new Map<string, Record>();
    const keys: string[] = [];
    let responsesLost = 2;
    const apply = (choice: Intent, current: WriteRound) => writeNewest(current, 0, async () => {
      keys.push(current.key);
      const receipt = receipts.get(current.key) ?? { ...choice, version: receipts.size + 1 };
      receipts.set(current.key, receipt);
      if (responsesLost-- > 0) return unavailable;
      return { ok: true, data: receipt } as Result<Record>;
    }, async () => ({ ok: true, data: null }), matches, versionOf, false);
    expect(await lane.submit(intent, apply)).toEqual(unavailable);
    const replay = await lane.submit(intent, apply);
    expect(replay).toEqual({ ok: true, data: { ...intent, version: 1 } });
    expect(keys[0]).toBe(keys[1]);
    expect(keys[1]).toBe(keys[2]);
    const next = await lane.submit(intent, apply);
    expect(next).toEqual({ ok: true, data: { ...intent, version: 2 } });
    expect(keys[3]).not.toBe(keys[2]);
    expect(receipts.size).toBe(2);
  });

  test('transport exceptions retain the canonical intent, but changed fields start a new command', async () => {
    const lane = commandLane<Intent & { note?: string }, Result<Record>>(unavailable);
    const keys: string[] = [];
    const apply = async (_choice: Intent, current: WriteRound): Promise<Result<Record>> => {
      keys.push(current.key);
      throw new Error('transport lost');
    };
    expect(await lane.submit(intent, apply)).toEqual(unavailable);
    await lane.submit({ tags: [...intent.tags], note: undefined, title: intent.title }, apply);
    expect(keys[1]).toBe(keys[0]);
    await lane.submit({ ...intent, tags: ['read', 'fiction'] }, apply);
    expect(keys[2]).not.toBe(keys[1]);
    const other = commandLane<Intent, Result<Record>>(unavailable);
    await other.submit(intent, apply);
    expect(keys[3]).not.toBe(keys[0]);
  });

  test('a definitive refusal retires the lane key', async () => {
    const lane = commandLane<Intent, Result<Record>>(unavailable);
    const keys: string[] = [];
    const apply = async (_choice: Intent, current: WriteRound): Promise<Result<Record>> => {
      keys.push(current.key);
      return { ok: false, failure: 'denied' };
    };
    await lane.submit(intent, apply);
    await lane.submit(intent, apply);
    expect(keys[1]).not.toBe(keys[0]);
  });

  test('conflict recovery requires every intended field, and never reapplies a create', async () => {
    for (const record of [held, { ...held, tags: ['fiction'] }, null]) {
      let writes = 0;
      const result = await writeNewest(round(), 0, async (): Promise<Result<Record>> => {
        writes++;
        return { ok: false, failure: 'conflict' };
      }, async () => ({ ok: true, data: record }), matches, versionOf, false);
      expect(result).toEqual(record === held ? { ok: true, data: held } : { ok: false, failure: 'conflict' });
      expect(writes).toBe(1);
    }
  });

  test('a stale newest intent retries once at the fresh version with its original key', async () => {
    const versions: number[] = [];
    const keys: string[] = [];
    const current = round();
    const result = await writeNewest(current, 1, async (version): Promise<Result<Record>> => {
      versions.push(version);
      keys.push(current.key);
      return versions.length === 1 ? { ok: false, failure: 'moved' } : { ok: true, data: { ...held, version: 3 } };
    }, async () => ({ ok: true, data: { ...held, tags: [] } }), matches, versionOf);
    expect(versions).toEqual([1, 2]);
    expect(keys).toEqual([current.key, current.key]);
    expect(result).toEqual({ ok: true, data: { ...held, version: 3 } });
  });

  test('failed recovery reads preserve uncertainty and refusals do not trigger recovery', async () => {
    let writes = 0;
    const result = await writeNewest(round(), 1, async (): Promise<Result<Record>> => {
      writes++;
      return { ok: false, failure: 'moved' };
    }, async () => unavailable, matches, versionOf);
    expect(result).toEqual(unavailable);
    expect(writes).toBe(1);
    expect(await writeNewest(round(), 1, async (): Promise<Result<Record>> => ({ ok: false, failure: 'denied' }),
      async () => { throw new Error('must not read'); }, matches, versionOf)).toEqual({ ok: false, failure: 'denied' });
  });

  test('a 409 reapplies only the newest intent with at most one write in flight', async () => {
    const lane = commandLane<Intent, Result<Record>>(unavailable);
    const firstWrite = gate();
    let stored: Record = { title: 'Before', tags: [], version: 2 };
    let calls = 0;
    let active = 0;
    let peak = 0;
    const written: string[] = [];
    const sequences: number[] = [];
    const apply = (choice: Intent, current: WriteRound) => {
      sequences.push(current.seq);
      return writeNewest(current, 1, async (version): Promise<Result<Record>> => {
        active++;
        peak = Math.max(peak, active);
        if (++calls === 1) {
          await firstWrite.promise;
          active--;
          return { ok: false, failure: 'moved' };
        }
        if (version !== stored.version) {
          active--;
          return { ok: false, failure: 'moved' };
        }
        written.push(choice.title);
        stored = { ...choice, version: version + 1 };
        active--;
        return { ok: true, data: stored };
      }, async () => ({ ok: true, data: stored }), record => record.title === choice.title
        && JSON.stringify(record.tags) === JSON.stringify(choice.tags), versionOf);
    };
    const older = lane.submit({ ...intent, title: 'Older' }, apply);
    const replaced = lane.submit({ ...intent, title: 'Replaced' }, apply);
    const newest = lane.submit({ ...intent, title: 'Newest' }, apply);
    firstWrite.release();
    const outcomes = await Promise.all([older, replaced, newest]);
    expect(written).toEqual(['Newest']);
    expect(sequences).toEqual([1, 3]);
    expect(peak).toBe(1);
    for (const outcome of outcomes) expect(outcome).toEqual({ ok: true, data: stored });
  });

  test('a confirmed superseded read lets the newest intent accept its complete existing outcome', async () => {
    const lane = commandLane<Intent, Result<Record>>(unavailable);
    const recovery = gate();
    const reading = gate();
    let writes = 0;
    const apply = (choice: Intent, current: WriteRound) => writeNewest(current, 1,
      async (): Promise<Result<Record>> => {
        writes++;
        return { ok: false, failure: 'moved' };
      }, async () => {
        reading.release();
        await recovery.promise;
        return { ok: true, data: held };
      }, record => record.title === choice.title && JSON.stringify(record.tags) === JSON.stringify(choice.tags), versionOf);
    const older = lane.submit({ ...intent, tags: [] }, apply);
    await reading.promise;
    const newest = lane.submit(intent, apply);
    recovery.release();
    expect(await newest).toEqual({ ok: true, data: held });
    expect(await older).toEqual({ ok: true, data: held });
    expect(writes).toBe(1);
  });

  test('an unavailable superseded write skips replay and yields to the newest intent', async () => {
    const lane = commandLane<Intent, Result<Record>>(unavailable);
    const firstWrite = gate();
    const written: string[] = [];
    const apply = (choice: Intent, current: WriteRound) => writeNewest(current, 1,
      async (): Promise<Result<Record>> => {
        written.push(choice.title);
        if (written.length === 1) {
          await firstWrite.promise;
          return unavailable;
        }
        return { ok: true, data: { ...choice, version: 2 } };
      }, async () => { throw new Error('must not read'); }, matches, versionOf);
    const older = lane.submit({ ...intent, title: 'Older' }, apply);
    const newest = lane.submit(intent, apply);
    firstWrite.release();
    expect(await older).toEqual(await newest);
    expect(written).toEqual(['Older', intent.title]);
  });
});
