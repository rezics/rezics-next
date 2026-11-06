import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernelClient, type EntryAnnotationCorrectionSelection } from '@rezics/client';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture';
import {
  correctionNative,
  type CorrectionCommand,
} from '../../../../apps/web/src/library/selected-entry-correction/native';
import { SelectedCorrection } from '../../../../apps/web/src/library/selected-entry-correction/controller';

let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture({ projectLinks: false });
}, 360_000);
afterAll(async () => f?.close());

async function item(name: string): Promise<EntryAnnotationCorrectionSelection> {
  const subjectId = await f.createSubject('game', name);
  const entry = (await f.commands.putEntry(f.owner.actor, subjectId, { state: 'planned' }, entryKey())).value.entry;
  return {
    subjectId,
    incarnationId: entry.incarnationId!,
    currentRevision: entry.revision,
    note: { op: 'preserve' },
    priority: { op: 'preserve' },
  };
}
function receiver() {
  let lose = false;
  const requests: Request[] = [];
  const client = createKernelClient('http://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      const url = new URL(request.url);
      const response = await f.sendWithHeaders(
        'anonymous',
        request.method,
        url.pathname + url.search,
        request.method === 'POST' ? await request.json() : undefined,
        request.headers,
      );
      if (lose && url.pathname.endsWith('/confirm')) {
        lose = false;
        expect(response.status).toBe(200);
        throw new TypeError('acknowledgement lost');
      }
      return response;
    }) as typeof fetch,
  });
  let authorization = `Bearer ${f.owner.bearer}`;
  const original = correctionNative(client, authorization);
  const commands: CorrectionCommand[] = [];
  let refreshes = 0;
  const journey = new SelectedCorrection(
    {
      ...original,
      send: (command) => {
        commands.push(structuredClone(command));
        return original.send(command);
      },
    },
    () => true,
    async () => {
      refreshes++;
    },
  );
  return {
    journey,
    original,
    client,
    commands,
    requests,
    lose: () => {
      lose = true;
    },
    rotate: () => {
      authorization = 'Bearer changed';
    },
    refreshes: () => refreshes,
  };
}

test('generated mounted selected review crosses pages, reads native facts and replays original acceptance before cancellation', async () => {
  const items = await Promise.all(Array.from({ length: 6 }, (_, n) => item(`web correction ${n}`)));
  items[0] = { ...items[0]!, note: { op: 'set', value: 'reviewed private note' }, priority: { op: 'set', value: 3 } };
  items[2] = { ...items[2]!, priority: { op: 'set', value: 7 } };
  items[4] = { ...items[4]!, note: { op: 'clear' }, priority: { op: 'preserve' } };
  const r = receiver();
  const seed = await r.client
    .libraryEntries({ subjectId: items[4]!.subjectId })
    .annotations.put(
      { revision: 0, note: { op: 'set', value: 'clear this note' }, priority: { op: 'set', value: 9 } },
      { headers: entryHeaders() },
    );
  expect(seed.status).toBe(200);
  await r.journey.create(items);
  const initial = r.journey.snapshot().page!;
  expect(initial.items).toHaveLength(4);
  expect(initial.pageCount).toBe(2);
  expect(initial.items[0]!.operation).toEqual({ note: items[0]!.note, priority: items[0]!.priority });
  r.lose();
  await r.journey.confirm(0);
  expect(r.journey.snapshot().uncertain).toBe(true);
  const original = r.journey.snapshot().command;
  const committed = await r.original.personal(items[0]!.subjectId);
  expect(committed).toMatchObject({
    kind: 'ready',
    entry: { note: 'reviewed private note', priority: 3, annotationRevision: 1 },
  });
  await r.journey.reopen();
  expect(r.journey.snapshot().page!.items[0]!.outcome).toBe('accepted');
  expect(r.journey.snapshot().command).toBe(original); // Current reads cannot acknowledge original delivery.
  r.rotate();
  await r.journey.retry();
  expect(r.commands[1]).toEqual(r.commands[2]);
  const confirmations = r.requests.filter((request) => new URL(request.url).pathname.endsWith('/confirm'));
  expect(confirmations[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(r.commands[1]!.key));
  expect(confirmations[1]!.headers.get('authorization')).toBe(confirmations[0]!.headers.get('authorization'));
  expect(await confirmations[0]!.json()).toEqual(await confirmations[1]!.json());
  expect(r.journey.snapshot().current[items[0]!.subjectId]).toEqual(committed);
  expect(await r.original.personal(items[0]!.subjectId)).toEqual(committed);
  expect(r.refreshes()).toBe(1);
  await r.journey.confirm(1); // Guarded no-op retains absent annotation identity.
  expect(r.journey.snapshot().page!.items[1]!.outcome).toBe('unchanged');
  expect(await r.original.personal(items[1]!.subjectId)).toMatchObject({
    kind: 'ready',
    entry: { annotationRevision: 0, note: null, priority: null },
  });
  await r.journey.reopen(1);
  expect(r.journey.snapshot().page!.items).toHaveLength(2);
  await r.journey.confirm(4);
  expect(r.journey.snapshot().page!.items[0]!.outcome).toBe('accepted');
  expect(await r.original.personal(items[4]!.subjectId)).toMatchObject({
    kind: 'ready',
    entry: { note: null, priority: 9 },
  });
  await r.journey.cancel();
  expect(r.journey.snapshot().page!.state).toBe('cancelled');
  await r.journey.reopen(0);
  expect(r.journey.snapshot().page!.items.map((row) => row.outcome)).toEqual([
    'accepted',
    'unchanged',
    'not-started',
    'not-started',
  ]);
  expect(await r.original.personal(items[2]!.subjectId)).toMatchObject({ kind: 'ready', entry: { priority: null } });
  const forbidden = await r.client
    .libraryEntryAnnotationCorrections({ reviewId: initial.reviewId })
    .get({ headers: { authorization: `Bearer ${f.other.bearer}` } });
  expect(forbidden.status).toBe(404);
  const foreignConfirm = await r.client
    .libraryEntryAnnotationCorrections({ reviewId: initial.reviewId })
    .confirm.post(
      { epoch: initial.epoch, position: 0 },
      { headers: { authorization: `Bearer ${f.other.bearer}`, 'idempotency-key': JSON.stringify(entryKey()) } },
    );
  expect(foreignConfirm.status).toBe(404);
});

test('concurrent edits and removal/recreation require fresh deliberate native epochs without inheriting correction', async () => {
  const selected = await item('concurrent web correction');
  const r = receiver();
  await r.journey.create([{ ...selected, note: { op: 'set', value: 'old intent' } }]);
  const first = r.journey.snapshot().page!;
  const changed = await r.client
    .libraryEntries({ subjectId: selected.subjectId })
    .annotations.put(
      { revision: 0, note: { op: 'set', value: 'other edit' }, priority: { op: 'unchanged' } },
      { headers: entryHeaders() },
    );
  expect(changed.status).toBe(200);
  await r.journey.confirm(0);
  expect(r.journey.snapshot().page!.items[0]!.outcome).toBe('stale');
  expect(await r.original.personal(selected.subjectId)).toMatchObject({ kind: 'ready', entry: { note: 'other edit' } });
  await r.journey.cancel();
  const deliberate = receiver();
  await deliberate.journey.create([{ ...selected, note: { op: 'set', value: 'deliberate current intent' } }]);
  expect(deliberate.journey.snapshot().page!.epoch).not.toBe(first.epoch);
  await deliberate.journey.confirm(0);
  expect(await r.original.personal(selected.subjectId)).toMatchObject({
    kind: 'ready',
    entry: { note: 'deliberate current intent' },
  });
  const old = receiver();
  await old.journey.create([{ ...selected, note: { op: 'set', value: 'never inherit' } }]);
  expect(
    (
      await f.send(
        'owner',
        'DELETE',
        `/v1/libraryEntries/${selected.subjectId}?revision=${selected.currentRevision}&incarnationId=${selected.incarnationId}`,
      )
    ).status,
  ).toBe(204);
  const replacement = (await f.commands.putEntry(f.owner.actor, selected.subjectId, { state: 'planned' }, entryKey()))
    .value.entry;
  expect(replacement.incarnationId).not.toBe(selected.incarnationId);
  await old.journey.reopen();
  await old.journey.confirm(0);
  expect(old.journey.snapshot().page!.items[0]).toMatchObject({
    eligibility: 'stale',
    current: null,
    operation: null,
    outcome: 'stale',
  });
  const afterRecreation = await old.original.personal(selected.subjectId);
  expect(afterRecreation.kind === 'ready' && afterRecreation.entry.note).not.toBe('never inherit');
  const entry = await f.send('owner', 'GET', `/v1/libraryEntries/${selected.subjectId}`);
  expect((await entry.json()).entry).toMatchObject({ state: 'planned', incarnationId: replacement.incarnationId });
  await old.journey.cancel();
});

function entryHeaders() {
  return { authorization: `Bearer ${f.owner.bearer}`, 'idempotency-key': JSON.stringify(entryKey()) };
}
