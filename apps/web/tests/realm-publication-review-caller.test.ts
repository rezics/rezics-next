import { expect, test } from 'bun:test';
import { createPublicationDraft, type PublicationTarget } from '../src/community/publication-subject-picker';
import type { PublicationChange, PublicationOutcome } from '../src/community/publication-controls';
import type { PublicationPreparationResult, PublicationPrepare } from '../src/community/realm-publication-preparation';
import { preparationFixture } from './realm-publication-preparation-fixture';

const work: PublicationTarget = {
  id: 'original',
  title: 'Chosen work',
  labels: { en: 'Chosen work' },
  types: [],
  cover: null,
};
const later = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('one selected native preparation distinguishes absence and every terminal verdict before an explicit command', async () => {
  for (const verdict of [null, 'adopt', 'reject', 'withdraw'] as const) {
    const reads: unknown[] = [];
    const writes: PublicationChange[] = [];
    const native = preparationFixture('reader', () => (verdict === null ? null : 'native-head'), verdict ?? 'adopt');
    const prepare: PublicationPrepare = async (input) => {
      reads.push(input);
      const result = await native(input);
      if (result.kind === 'ready') result.preparation.subject.currentId = 'terminal-reference';
      return result;
    };
    const draft = createPublicationDraft(
      'realm',
      async (input) => {
        writes.push(input);
        return { kind: 'saved', head: 'result' };
      },
      () => {},
      () => [{ ...work, publicationId: 'shelf-head' }],
      true,
      undefined,
      prepare,
    );
    expect(reads).toHaveLength(0);
    await draft.choose(work);
    expect(reads).toEqual([{ realmId: 'realm', subjectId: 'original' }]);
    expect(writes).toHaveLength(0);
    expect(draft.getSnapshot().preparation?.current?.verdict ?? null).toBe(verdict);
    expect(draft.getSnapshot().preparation?.subject.currentId).toBe('terminal-reference');
    if (verdict === null) {
      await draft.change('withdraw');
      expect(writes).toHaveLength(0);
    }
    await draft.change(verdict === null ? 'publish' : 'reject');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ subjectId: 'original', ifMatch: verdict === null ? null : '"native-head"' });
    expect(writes[0]?.expectedHead).toBe(verdict === null ? undefined : 'native-head');
    expect(reads).toHaveLength(1);
    await draft.change('publish');
    expect(writes).toHaveLength(1); // A result is not fresh preparation for a second decision.
  }
});

test('unknown reads cannot resolve or replace the sealed command; conflict review reads and never writes', async () => {
  let head = 'first';
  let result: PublicationOutcome = { kind: 'unavailable' };
  const writes: PublicationChange[] = [];
  const draft = createPublicationDraft(
    'realm',
    async (input) => {
      writes.push(input);
      return result;
    },
    () => {},
    () => [],
    true,
    undefined,
    preparationFixture('reader', () => head),
  );
  await draft.choose(work);
  await draft.change('withdraw');
  const original = structuredClone(writes[0]!);
  head = 'later-rejected-head';
  await draft.inspect();
  expect(draft.getSnapshot().outcome).toEqual({ kind: 'unavailable' });
  await draft.choose({ ...work, id: 'other' });
  await draft.change('reject');
  expect(writes).toHaveLength(1);
  result = { kind: 'conflict', currentHead: null };
  await draft.retry();
  expect(writes[1]).toEqual(original);
  await draft.change('reject');
  expect(writes).toHaveLength(2);
  await draft.review();
  expect(writes).toHaveLength(2);
  result = { kind: 'saved', head: 'new-result' };
  await draft.change('reject');
  expect(writes[2]).toMatchObject({ subjectId: 'original', expectedHead: head, action: 'reject' });
  expect(writes[2]?.idempotencyKey).not.toBe(original.idempotencyKey);
});

test('replacement and retirement fence late preparation; unavailable and denied preparation expose no command', async () => {
  const pending = later<PublicationPreparationResult>();
  let writes = 0;
  const draft = createPublicationDraft(
    'realm',
    async () => {
      writes++;
      return { kind: 'denied' };
    },
    () => {},
    () => [],
    true,
    undefined,
    () => pending.promise,
  );
  const first = draft.choose(work);
  draft.retire();
  pending.resolve(await preparationFixture('reader', () => 'head')({ realmId: 'realm', subjectId: 'original' }));
  await first;
  expect(draft.getSnapshot()).toEqual({ target: null, outcome: null, busy: false });
  for (const kind of ['denied', 'unavailable'] as const) {
    const visit = createPublicationDraft(
      'realm',
      async () => {
        writes++;
        return { kind: 'denied' };
      },
      () => {},
      () => [],
      true,
      undefined,
      async () => ({ kind }),
    );
    await visit.choose(work);
    expect(visit.getSnapshot().target).toBeNull();
    expect(visit.getSnapshot().preparation).toBeNull();
    await visit.change('publish', work); // Selecting again still cannot command.
  }
  const unavailable = createPublicationDraft(
    'realm',
    async () => {
      writes++;
      return { kind: 'denied' };
    },
    () => {},
    () => [],
  );
  await unavailable.choose(work);
  expect(unavailable.getSnapshot().preparationState).toBe('unavailable');
  expect(writes).toBe(0);
});
