import { expect, test } from 'bun:test';
import recorded from '../src/kernel/recorded/search-typed.json';
import { readSearchOutcome } from '../src/search/search-recovery';

test('legacy identity failures hide the whole page without extra reads; an explicit valid retry recovers', async () => {
  const hit = recorded.subjects[0]!;
  const subjects = [hit, { id: hit.id, type: 'schema:Person', labels: {}, summary: null }];
  const valid = { subjects, next: 'native-next', as_of: recorded.as_of };
  for (const invalid of [
    [hit, { ...hit, id: 'another-subject' }],
    [hit, { ...hit, type: 'schema:CreativeWork' }],
    [hit, hit],
    [subjects[1], subjects[1]],
  ]) {
    let reads = 0;
    const send = async () => ({ status: 200, data: ++reads === 1 ? { ...valid, subjects: invalid } : valid });
    expect(await readSearchOutcome({}, send)).toEqual({ recovery: { status: 'unavailable' } });
    expect(reads).toBe(1);
    expect(await readSearchOutcome({}, send)).toEqual({ recovery: { status: 'ready' }, result: valid });
    expect(reads).toBe(2);
  }
});
