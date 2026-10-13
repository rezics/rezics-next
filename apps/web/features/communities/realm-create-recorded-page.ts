import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import { browserMainApi } from '../api/browser.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import {
  createCommunityWithReadback, founderRealmReads, stepAfterCreation,
  type CommunityCreationIntent,
} from './create-form.tsx';

/**
 * The community creation page, from the creation receipt and the Realm it names.
 * The form and the recorded page call the same mapping, so a story cannot show
 * an identity or a refusal the answers did not carry.
 */

const recordedOrigin = 'https://recorded.invalid';
/** One key for the receipt and its readback. The transport matches the body, not the header. */
const recordedCreationKey = 'recorded:create';

export interface RealmCreationProblem {
  status: number;
  title: string;
  code: string;
}

export interface RealmCreationIdentity {
  realm: string;
  space: string;
  spaceRevision: string;
  realmRevision: string;
  owner: string;
  name: string;
  handle: string;
  replayed: boolean;
  visibility: string;
  listing: string | null;
  admission: string | null;
  sourcePosition: { datasetId: string; dataEpoch: string; sequence: string };
}

export interface RealmHeaderFacts {
  id: string;
  space: string;
  revision: string;
  name: string;
  visibility: string;
  listing: string;
  admission: string;
}

export type RealmCreationStep =
  | { step: 'write'; realm: string }
  | { step: 'owned'; realm: string }
  | { step: 'taken' }
  | { step: 'keep' };

export type RealmCreationMapped =
  | { kind: 'created'; identity: RealmCreationIdentity }
  | { kind: 'owned'; realm: string }
  | { kind: 'taken' }
  | { kind: 'refusal'; problem: RealmCreationProblem }
  | { kind: 'discrepancy'; detail: string };

export interface RealmCreationRecordedLoad {
  mapped: RealmCreationMapped;
}

type CreationAnswer = {
  data: unknown;
  error: { status: number; value?: unknown } | null;
  response?: unknown;
};

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function sameText(left: string, right: string, label: string): string | null {
  return left === right ? null : `${label} ${JSON.stringify(left)} is not ${JSON.stringify(right)}`;
}

/** The problem sentence the creation response carried, or why that sentence is unreadable. */
export function realmCreationProblem(status: number, value: unknown): RealmCreationProblem | { detail: string } {
  if (!value || typeof value !== 'object') return { detail: `creation problem body is ${JSON.stringify(value)}` };
  const body = value as Record<string, unknown>;
  if (!text(body.title)) return { detail: 'creation problem title is not a string' };
  if (!text(body.code)) return { detail: 'creation problem code is not a string' };
  if (typeof body.status === 'number' && body.status !== status) {
    return { detail: `creation problem status ${body.status} is not response status ${status}` };
  }
  return { status, title: body.title, code: body.code };
}

function positionOf(value: unknown): RealmCreationIdentity['sourcePosition'] | { detail: string } {
  if (!value || typeof value !== 'object') return { detail: 'creation sourcePosition is not a record' };
  const position = value as Record<string, unknown>;
  if (!text(position.datasetId) || !text(position.dataEpoch) || !text(position.sequence)) {
    return { detail: 'creation sourcePosition is missing datasetId, dataEpoch or sequence' };
  }
  return { datasetId: position.datasetId, dataEpoch: position.dataEpoch, sequence: position.sequence };
}

function receiptOf(data: unknown, stepRealm: string): Omit<RealmCreationIdentity, 'name' | 'handle' | 'visibility' | 'listing' | 'admission'> | { detail: string } {
  if (!data || typeof data !== 'object') return { detail: 'creation receipt is not a record' };
  const receipt = data as Record<string, unknown>;
  if (!text(receipt.realm)) return { detail: 'creation receipt realm is not a string' };
  const realm = sameText(receipt.realm, stepRealm, 'creation receipt realm');
  if (realm) return { detail: realm };
  if (!text(receipt.space)) return { detail: 'creation receipt space is not a string' };
  if (!text(receipt.spaceRevision)) return { detail: 'creation receipt spaceRevision is not a string' };
  if (!text(receipt.realmRevision)) return { detail: 'creation receipt realmRevision is not a string' };
  if (!text(receipt.owner)) return { detail: 'creation receipt owner is not a string' };
  if (typeof receipt.replayed !== 'boolean') return { detail: 'creation receipt replayed is not a boolean' };
  const capabilities = receipt.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.includes('realm')) {
    return { detail: 'creation receipt capabilities do not include realm' };
  }
  const sourcePosition = positionOf(receipt.sourcePosition);
  if ('detail' in sourcePosition) return sourcePosition;
  return {
    realm: receipt.realm,
    space: receipt.space,
    spaceRevision: receipt.spaceRevision,
    realmRevision: receipt.realmRevision,
    owner: receipt.owner,
    replayed: receipt.replayed,
    sourcePosition,
  };
}

/** What the creation page can show from one receipt. A header, when the page read one, names the Realm. */
export function mapRealmCreation(input: {
  response: CreationAnswer;
  name: string;
  handle: string;
  visibility: string;
  actingSubject: string;
  step: RealmCreationStep;
  realm?: RealmHeaderFacts | null;
}): RealmCreationMapped {
  const { response, step } = input;
  if (step.step === 'owned') return { kind: 'owned', realm: step.realm };
  if (step.step === 'taken') return { kind: 'taken' };
  if (step.step === 'keep') {
    const error = response.error;
    if (!error) return { kind: 'discrepancy', detail: 'creation was kept without a problem' };
    const problem = realmCreationProblem(error.status, error.value);
    return 'detail' in problem ? { kind: 'discrepancy', detail: problem.detail } : { kind: 'refusal', problem };
  }
  const receipt = receiptOf(response.data, step.realm);
  if ('detail' in receipt) return { kind: 'discrepancy', detail: receipt.detail };
  const owner = sameText(receipt.owner, input.actingSubject, 'creation owner');
  if (owner) return { kind: 'discrepancy', detail: owner };
  const header = input.realm;
  if (!header) {
    return { kind: 'created', identity: { ...receipt, name: input.name, handle: input.handle,
      visibility: input.visibility, listing: null, admission: null } };
  }
  let detail = '';
  const note = (item: string | null) => {
    if (item) detail = detail ? `${detail}; ${item}` : item;
  };
  note(sameText(header.id, receipt.realm, 'realm header id'));
  note(sameText(header.space, receipt.space, 'realm header space'));
  note(sameText(header.revision, receipt.realmRevision, 'realm header revision'));
  note(sameText(header.name, input.name, 'realm header name'));
  note(sameText(header.visibility, input.visibility, 'realm header visibility'));
  if (detail) return { kind: 'discrepancy', detail };
  return { kind: 'created', identity: { ...receipt, name: header.name, handle: input.handle,
    visibility: header.visibility, listing: header.listing, admission: header.admission } };
}

function creationIntent(body: unknown): {
  intent: CommunityCreationIntent; name: string; handle: string; actingSubject: string;
  visibility: 'public' | 'restricted' | 'private';
} | { detail: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { detail: 'creation request body is absent' };
  const record = body as Record<string, unknown>;
  if (record.profile !== 'space-realm-v2') return { detail: `creation profile ${JSON.stringify(record.profile)} is not space-realm-v2` };
  if (!text(record.name)) return { detail: 'creation name is not a string' };
  if (!text(record.handle)) return { detail: 'creation handle is not a string' };
  if (!text(record.actingSubject)) return { detail: 'creation actingSubject is not a string' };
  const settings = record.initialSettings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { detail: 'creation initialSettings is absent' };
  const visibility = (settings as { visibility?: unknown }).visibility;
  if (visibility !== 'public' && visibility !== 'restricted' && visibility !== 'private') {
    return { detail: `creation visibility ${JSON.stringify(visibility)} is not public, restricted or private` };
  }
  return { intent: body as CommunityCreationIntent, name: record.name, handle: record.handle,
    actingSubject: record.actingSubject, visibility };
}

function headerFacts(data: unknown): RealmHeaderFacts | { detail: string } {
  if (!data || typeof data !== 'object') return { detail: 'realm header is not a record' };
  const record = data as Record<string, unknown>;
  const name = record.name;
  if (!name || typeof name !== 'object' || !text((name as { value?: unknown }).value)) {
    return { detail: 'realm header name.value is not a string' };
  }
  if (!text(record.id)) return { detail: 'realm header id is not a string' };
  if (!text(record.space)) return { detail: 'realm header space is not a string' };
  if (!text(record.revision)) return { detail: 'realm header revision is not a string' };
  if (!text(record.visibility)) return { detail: 'realm header visibility is not a string' };
  if (!text(record.listing)) return { detail: 'realm header listing is not a string' };
  if (!text(record.admission)) return { detail: 'realm header admission is not a string' };
  return {
    id: record.id, space: record.space, revision: record.revision,
    name: (name as { value: string }).value, visibility: record.visibility,
    listing: record.listing, admission: record.admission,
  };
}

function sampleOf(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].filter(sample => sample.label === label);
  if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${label}`);
  return found[0]!;
}

function isRealmHeader(sample: AnswerSample): boolean {
  return sample.method === 'GET' && /^\/v1\/realms\/[0-9a-f-]{36}$/.test(sample.path.split('?')[0] ?? '');
}

function transportError(answer: CreationAnswer): Error | null {
  if (answer.response || !answer.error) return null;
  const value = answer.error.value;
  return value instanceof Error ? value : new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

/** Replay the selected creation samples through the typed client and the shared mapping. */
export async function readRealmCreationRecorded(
  fetcher: typeof fetch,
  record: AnswerRecord,
  persona: AnswerPersona,
  selections: readonly RecordedSelection[],
): Promise<RealmCreationRecordedLoad> {
  const samples = selections.map(selection => sampleOf(record, persona, selection.label));
  const creation = samples.filter(sample => sample.method === 'POST' && sample.path.split('?')[0] === '/v1/spaces');
  if (creation.length !== 1) {
    return { mapped: { kind: 'discrepancy', detail: `expected one POST /v1/spaces sample, found ${creation.length}` } };
  }
  const extra = samples.filter(sample => sample !== creation[0] && !isRealmHeader(sample));
  if (extra.length > 0) {
    return { mapped: { kind: 'discrepancy', detail: `no realm creation reader for ${extra[0]!.method} ${extra[0]!.path}` } };
  }
  const parsed = creationIntent(creation[0]!.body);
  if ('detail' in parsed) return { mapped: { kind: 'discrepancy', detail: parsed.detail } };
  const { intent, name, handle, actingSubject, visibility } = parsed;
  const client = browserMainApi(recordedOrigin, { anonymous: persona === 'visitor', fetcher });
  const response = await createCommunityWithReadback(intent, recordedCreationKey, (body, operationKey) =>
    client.v1.spaces.post(body, { headers: { 'idempotency-key': operationKey } }));
  const failed = transportError(response);
  if (failed) throw failed;
  const step = await stepAfterCreation(response, handle, actingSubject, founderRealmReads(client));
  let realm: RealmHeaderFacts | null = null;
  if (step.step === 'write' && samples.some(isRealmHeader)) {
    const header = await client.v1.realms({ realm: step.realm.slice(-36) }).get({
      query: { actingSubject } });
    const headerFailed = transportError(header);
    if (headerFailed) throw headerFailed;
    if (header.error || header.data == null) {
      const status = header.error?.status ?? 'no status';
      const value = header.error ? JSON.stringify(header.error.value) : 'null';
      return { mapped: { kind: 'discrepancy', detail: `realm header answer was not a realm read (${status}): ${value}` } };
    }
    const facts = headerFacts(header.data);
    if ('detail' in facts) return { mapped: { kind: 'discrepancy', detail: facts.detail } };
    realm = facts;
  }
  return { mapped: mapRealmCreation({ response, name, handle, visibility, actingSubject, step, realm }) };
}
