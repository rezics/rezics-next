import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import creation from '../../../../tests/qa/fixtures/outcomes/realm/create-a-realm.json';
import { BFF_PREFIX } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { mapRealmCreation, readRealmCreationRecorded, type RealmCreationIdentity, type RealmCreationMapped } from './realm-create-recorded-page.ts';

const record = creation as AnswerRecord;
const founders = ['stranger', 'member', 'owner', 'moderator', 'operator'] as const satisfies readonly AnswerPersona[];
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sample(persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found || !found.answer || typeof found.answer !== 'object') throw new Error(`Missing ${persona} sample ${label}`);
  return found;
}

async function replay(persona: AnswerPersona, selections: readonly RecordedSelection[]) {
  const transport = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(transport.dispose);
  const loaded = await readRealmCreationRecorded(transport.fetcher, record, persona, selections);
  if (loaded.mapped.kind === 'discrepancy') throw new Error(loaded.mapped.detail);
  return loaded;
}

function created(mapped: RealmCreationMapped): RealmCreationIdentity {
  if (mapped.kind !== 'created') throw new Error(`expected a created Realm, received ${mapped.kind}`);
  return mapped.identity;
}

type Receipt = {
  realm: string; space: string; spaceRevision: string; realmRevision: string; owner: string; replayed: boolean;
  sourcePosition: { datasetId: string; dataEpoch: string; sequence: string };
};
type Header = {
  id: string; space: string; revision: string; visibility: string; listing: string; admission: string;
  name: { value: string };
};
type Problem = { title: string; code: string; status: number };
type CreationBody = { name: string; handle: string; actingSubject: string };

function expectIdentity(identity: RealmCreationIdentity, receipt: AnswerSample, header: AnswerSample) {
  const answer = receipt.answer as Receipt;
  const named = header.answer as Header;
  const body = receipt.body as CreationBody;
  expect(identity).toEqual({
    realm: answer.realm,
    space: answer.space,
    spaceRevision: answer.spaceRevision,
    realmRevision: answer.realmRevision,
    owner: answer.owner,
    name: named.name.value,
    handle: body.handle,
    replayed: answer.replayed,
    visibility: named.visibility,
    listing: named.listing,
    admission: named.admission,
    sourcePosition: answer.sourcePosition,
  });
  expect(identity.owner).toBe(body.actingSubject);
  expect(named.id).toBe(answer.realm);
  expect(named.space).toBe(answer.space);
  expect(named.revision).toBe(answer.realmRevision);
  expect(named.name.value).toBe(body.name);
}

test('Only an HTTP 202 maps to pending, retaining its operation identity', () => {
  const receipt = sample('stranger', 'creation-receipt');
  const body = receipt.body as CreationBody;
  const data = { operationId: 'initialization', status: 'reconciling' };
  const map = (status: number) => mapRealmCreation({ response: {
    data, error: null, response: new Response(null, { status }),
  }, name: body.name, handle: body.handle, actingSubject: body.actingSubject, visibility: 'private', step: { step: 'keep' } });
  expect(map(202)).toEqual({ kind: 'pending', operationId: 'initialization' });
  expect(map(200).kind).toBe('discrepancy');
  expect(map(503).kind).toBe('discrepancy');
});

test('A partial receipt or a different owner cannot authorize the production form to continue', () => {
  const receipt = sample('stranger', 'creation-receipt');
  const body = receipt.body as CreationBody;
  const answer = receipt.answer as Receipt;
  const otherOwner = (sample('member', 'creation-receipt').body as CreationBody).actingSubject;
  for (const data of [{ realm: answer.realm }, { ...answer, owner: otherOwner }]) {
    const mapped = mapRealmCreation({ response: { data, error: null },
      name: body.name, handle: body.handle, actingSubject: body.actingSubject, visibility: 'private',
      step: { step: 'write', realm: answer.realm } });
    expect(mapped.kind).toBe('discrepancy');
  }
});

test('stranger creation receipt keeps the recorded realm identity', async () => {
  const receipt = sample('stranger', 'creation-receipt');
  const header = sample('stranger', 'created-realm-header');
  const loaded = await replay('stranger', [
    { label: 'creation-receipt', state: 'populated' },
    { label: 'created-realm-header', state: 'populated' },
  ]);
  expectIdentity(created(loaded.mapped), receipt, header);
  expect(receipt.status).toBe(201);
  expect(header.status).toBe(200);
  expect((receipt.answer as Receipt).replayed).toBe(false);
});

test('a replayed creation receipt keeps the same realm and records the replay', async () => {
  const receipt = sample('stranger', 'form-creation');
  const header = sample('stranger', 'created-realm-header');
  const loaded = await replay('stranger', [
    { label: 'form-creation', state: 'populated' },
    { label: 'created-realm-header', state: 'populated' },
  ]);
  expectIdentity(created(loaded.mapped), receipt, header);
  expect(receipt.status).toBe(200);
  expect((receipt.answer as Receipt).replayed).toBe(true);
});

for (const persona of founders.filter(persona => persona !== 'stranger')) {
  test(`${persona} creation receipt keeps that person's recorded realm`, async () => {
    const receipt = sample(persona, 'creation-receipt');
    const header = sample(persona, 'created-realm-header');
    const loaded = await replay(persona, [
      { label: 'creation-receipt', state: 'populated' },
      { label: 'created-realm-header', state: 'populated' },
    ]);
    expectIdentity(created(loaded.mapped), receipt, header);
    expect(receipt.status).toBe(201);
  });
}

test('visitor creation stays the recorded sign-in refusal', async () => {
  const refused = sample('visitor', 'form-creation');
  const answer = refused.answer as Problem;
  const loaded = await replay('visitor', [{ label: 'form-creation', state: 'error' }]);
  expect(loaded.mapped).toEqual({
    kind: 'refusal',
    problem: { status: refused.status, title: answer.title, code: answer.code },
  });
  expect(refused.status).toBe(401);
  expect(answer.status).toBe(401);
});

test('owner creation past quota stays the recorded authority refusal', async () => {
  const refused = sample('owner', 'creation-quota-denied');
  const answer = refused.answer as Problem;
  const loaded = await replay('owner', [{ label: 'creation-quota-denied', state: 'error' }]);
  expect(loaded.mapped).toEqual({
    kind: 'refusal',
    problem: { status: refused.status, title: answer.title, code: answer.code },
  });
  expect(refused.status).toBe(403);
});

test('a changed creation intent preserves the idempotency conflict problem', () => {
  const receipt = sample('stranger', 'form-creation');
  const body = receipt.body as CreationBody;
  const problem = { status: 409, title: 'Idempotency key conflicts with another request', code: 'idempotency_conflict' };
  expect(mapRealmCreation({ response: { data: null, error: { status: 409, value: problem } },
    name: body.name, handle: body.handle, actingSubject: body.actingSubject, visibility: 'private',
    step: { step: 'keep' } })).toEqual({ kind: 'refusal', problem });
});
