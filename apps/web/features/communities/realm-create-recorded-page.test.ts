import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import creation from '../../../../tests/qa/fixtures/outcomes/realm/create-a-realm.json';
import { BFF_PREFIX } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { readRealmCreationRecorded, type RealmCreationIdentity, type RealmCreationMapped } from './realm-create-recorded-page.ts';

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
  const receipt = sample('stranger', 'creation-replayed');
  const header = sample('stranger', 'created-realm-header');
  const loaded = await replay('stranger', [
    { label: 'creation-replayed', state: 'populated' },
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
  const refused = sample('visitor', 'creation-sign-in-required');
  const answer = refused.answer as Problem;
  const loaded = await replay('visitor', [{ label: 'creation-sign-in-required', state: 'error' }]);
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

test('a changed creation intent keeps the recorded idempotency conflict', async () => {
  const refused = sample('stranger', 'creation-intent-conflict');
  const answer = refused.answer as Problem;
  const loaded = await replay('stranger', [{ label: 'creation-intent-conflict', state: 'error' }]);
  expect(loaded.mapped).toEqual({
    kind: 'refusal',
    problem: { status: refused.status, title: answer.title, code: answer.code },
  });
  expect(refused.status).toBe(409);
});
