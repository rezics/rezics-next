import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  createKernelClient,
  type PersonalEntryAnnotationWrite,
  type PersonalEntrySourceAdmission,
  type PersonalEntrySourceCorrection,
} from '@rezics/client';
import {
  admitPrivateSourceObservation,
  correctPrivateSourceObservation,
  readPrivateEntry,
  writePrivateAnnotations,
} from '../src/library/rich-private-entry/native';
import { createLibraryEntry } from './native/library-navigation-fixture';
import { startNativeWebStack, type NativeWebStack } from './native/stack';

let stack: NativeWebStack | undefined;

beforeAll(async () => {
  stack = await startNativeWebStack();
}, 300_000);

afterAll(async () => {
  await stack?.stop();
}, 180_000);

test('generated private Entry writes commit, replay exactly and read back through native HTTP', async () => {
  const native = stack!;
  const alice = await native.authPersona('alice');
  const subject = await createLibraryEntry(native, 'alice', alice.authorization);
  const wire: { method: string; path: string; authorization: string | null; key: string | null; body: string }[] = [];
  let loseNextAcknowledgement = false;
  const client = createKernelClient(native.kernelOrigin, {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === 'GET' ? '' : await request.clone().text();
      wire.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get('authorization'),
        key: request.headers.get('idempotency-key'),
        body,
      });
      const response = await native.kernel(url.pathname + url.search, {
        method: request.method,
        headers: request.headers,
        ...(body ? { body } : {}),
      });
      if (loseNextAcknowledgement) {
        loseNextAcknowledgement = false;
        return Response.json({ code: 'deadline_exceeded' }, { status: 503 });
      }
      return response;
    }) as typeof fetch,
  });
  const entryResponse = await native.kernel(`/v1/libraryEntries/${subject.id}`, {
    headers: { authorization: alice.authorization },
  });
  expect(entryResponse.status).toBe(200);
  const { libraryEntry } = (await entryResponse.json()) as {
    libraryEntry: { incarnationId: string; revision: number };
  };
  const entryGuard = { incarnationId: libraryEntry.incarnationId, currentRevision: libraryEntry.revision };
  const read = async () => {
    const result = await readPrivateEntry(client, subject.id, alice.authorization);
    if (result.kind !== 'ready') throw new Error('Native private Entry read failed');
    return result.entry;
  };
  const save = async (
    note: PersonalEntryAnnotationWrite['note'],
    priority: PersonalEntryAnnotationWrite['priority'],
  ) => {
    const current = await read();
    const result = await writePrivateAnnotations(client, {
      subjectId: subject.id,
      body: { revision: current.annotationRevision, note, priority, entryGuard },
      key: crypto.randomUUID(),
      authorization: alice.authorization,
    });
    if (result.kind !== 'saved') throw new Error(`Native annotation write returned ${result.kind}`);
    return result.entry;
  };

  const firstKey = crypto.randomUUID();
  const current = await read();
  const firstBody: PersonalEntryAnnotationWrite = {
    revision: current.annotationRevision,
    note: { op: 'set', value: 'private note' },
    priority: { op: 'set', value: 7 },
    entryGuard,
  };
  const firstCommand = {
    subjectId: subject.id,
    body: firstBody,
    key: firstKey,
    authorization: alice.authorization,
  };
  loseNextAcknowledgement = true;
  expect(await writePrivateAnnotations(client, firstCommand)).toEqual({ kind: 'uncertain' });
  expect((await writePrivateAnnotations(client, firstCommand)).kind).toBe('saved');
  const annotationReplay = wire.filter((request) => request.path.endsWith('/annotations'));
  expect(annotationReplay).toHaveLength(2);
  expect(annotationReplay[0]).toEqual(annotationReplay[1]);
  expect(annotationReplay[0]!.key).toBe(JSON.stringify(firstKey));
  expect(annotationReplay[0]!.authorization).toBe(alice.authorization);
  expect((await read()).annotationRevision).toBe(current.annotationRevision + 1);

  await save({ op: 'set', value: 'changed note' }, { op: 'unchanged' });
  expect(await read()).toMatchObject({ note: 'changed note', priority: 7 });
  await save({ op: 'clear' }, { op: 'unchanged' });
  expect(await read()).toMatchObject({ note: null, priority: 7 });
  await save({ op: 'unchanged' }, { op: 'set', value: 12 });
  expect(await read()).toMatchObject({ note: null, priority: 12 });
  await save({ op: 'unchanged' }, { op: 'clear' });

  const admissionKey = crypto.randomUUID();
  const admission: PersonalEntrySourceAdmission = {
    provider: 'reviewed-provider',
    recordId: 'record-1',
    confirmReviewed: true,
    privacy: { status: 'known', meaning: 'private' },
    sourceCreated: { status: 'known', value: '2004-02-29T23:59:01.123+08:00' },
    sourceUpdated: { status: 'unknown', sourceValue: 'opaque-date' },
  };
  loseNextAcknowledgement = true;
  expect(
    await admitPrivateSourceObservation(client, {
      subjectId: subject.id,
      body: admission,
      key: admissionKey,
      authorization: alice.authorization,
    }),
  ).toEqual({ kind: 'uncertain' });
  expect(
    (
      await admitPrivateSourceObservation(client, {
        subjectId: subject.id,
        body: admission,
        key: admissionKey,
        authorization: alice.authorization,
      })
    ).kind,
  ).toBe('admitted');
  const admissionReplay = wire.filter((request) => request.path.endsWith('/sourceObservations'));
  expect(admissionReplay).toHaveLength(2);
  expect(admissionReplay[0]).toEqual(admissionReplay[1]);
  expect(admissionReplay[0]!.key).toBe(JSON.stringify(admissionKey));

  const beforeCorrection = await read();
  expect(beforeCorrection.sourceObservations).toHaveLength(1);
  const observation = beforeCorrection.sourceObservations[0]!;
  const correctionKey = crypto.randomUUID();
  const correction: PersonalEntrySourceCorrection = {
    provider: observation.provider,
    recordId: observation.recordId,
    revision: observation.revision,
    confirmReviewed: true,
    privacy: { op: 'set', value: { status: 'unknown', sourceValue: 'private_flag_v2' } },
    sourceCreated: { op: 'set', value: { status: 'absent' } },
    sourceUpdated: { op: 'set', value: { status: 'known', value: '2004-02' } },
  };
  const correctionCommand = {
    subjectId: subject.id,
    body: correction,
    key: correctionKey,
    authorization: alice.authorization,
  };
  loseNextAcknowledgement = true;
  expect(await correctPrivateSourceObservation(client, correctionCommand)).toEqual({ kind: 'uncertain' });
  expect((await correctPrivateSourceObservation(client, correctionCommand)).kind).toBe('saved');
  const correctionReplay = wire.filter((request) => request.path.endsWith('/sourceObservations'));
  expect(correctionReplay).toHaveLength(4);
  expect(correctionReplay[2]).toEqual(correctionReplay[3]);
  expect(correctionReplay[2]!.key).toBe(JSON.stringify(correctionKey));

  expect(await read()).toMatchObject({
    note: null,
    priority: null,
    annotationRevision: current.annotationRevision + 5,
    sourceObservations: [
      {
        provider: 'reviewed-provider',
        recordId: 'record-1',
        revision: observation.revision + 1,
        privacy: { status: 'unknown', sourceValue: 'private_flag_v2' },
        sourceCreated: { status: 'absent' },
        sourceUpdated: { status: 'known', value: '2004-02', precision: 'month', zone: 'unknown' },
      },
    ],
  });
});
