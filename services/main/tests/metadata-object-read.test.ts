import { expect, test } from 'bun:test';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { hash, prepareWorkComponent, RV } from '../src/modules/work/activate.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import { readWorkEditTerminalReceipt, sealMetadataWorkEditAdmission, workEditReceiptIri }
  from '../src/modules/work/edit.ts';
import { setWorkMetadata } from '../src/modules/work/metadata-command.ts';
import { readWorkEdition, readWorkEditions } from '../src/modules/work/metadata-read.ts';
import { editionV2Digest, metadataDigest, METADATA_DETAILS_V2, METADATA_PROFILE, type MetadataEditionState,
  type MetadataEditionStateV2 } from '../src/modules/work/metadata-schema.ts';
import { WorkReadSession, WorkReadUnavailable } from '../src/modules/work/read-session.ts';

const id = (value: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const work = id(1), edition = id(2), revision = id(3);
const term = (value: string, type = 'uri') => ({ type, value });
const rows = (bindings: NonNullable<SparqlResult['results']>['bindings']): SparqlResult => ({ results: { bindings } });
const v1: MetadataEditionState = { kind: 'edition', id: edition, status: 'active',
  title: { value: 'A retained edition', language: 'en' }, contentLanguage: 'en', editionStatement: null,
  publisher: null, publicationYear: 2001, isbn13: null };
const v2: MetadataEditionStateV2 = { kind: 'edition', id: edition, status: 'active',
  title: v1.title, contentLanguages: ['en', 'ja'], titleLanguage: 'en', tracklistLanguage: null,
  originalLanguages: ['ja'], isTranslation: true, editionStatement: null,
  publisher: null, publicationYear: 2001, isbn13: null };

async function fixture(state: MetadataEditionState | MetadataEditionStateV2, profile: string,
  retained = { intent: { work, expectedHead: null, state }, revision }) {
  const bytes = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    async put(value) { const digest = hash(value); bytes.set(digest, new Uint8Array(value)); return digest; },
    async get(digest) {
      const value = bytes.get(digest);
      if (!value) throw new ObjectUnavailable('Missing fixture object');
      return value;
    },
  };
  const manifest = await prepareWorkComponent(objects, edition, retained, profile);
  let graphModel = profile, graphRevision = revision;
  const graph = new FusekiClient('http://metadata.invalid/rezics');
  graph.query = async query => {
    if (query.includes('SELECT ?head ?main ?mainHead')) return rows([{ head: term(id(4)), main: term(id(5)),
      mainHead: term(id(6)), public: term('true', 'literal') }]);
    if (query.includes('SELECT ?selection ?language')) return rows([]);
    const anchor = { revision: term(graphRevision), manifest: term(`urn:rezics:sha256:${manifest}`), model: term(graphModel) };
    if (query.includes('SELECT ?revision ?status ?state')) return rows([{ ...anchor, status: term(`${RV}${state.status === 'active' ? 'Active' : 'Withdrawn'}`) }]);
    if (query.includes('SELECT ?edition ?revision ?state')) return rows([{ ...anchor, edition: term(edition) }]);
    if (query.includes('SELECT ?edition ?revision')) return rows(state.status === 'active'
      ? [{ edition: term(edition), revision: term(graphRevision) }] : []);
    throw new Error(`Unexpected metadata query: ${query}`);
  };
  const deps = { environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/metadata-object-read-unavailable', workObjects: objects } } as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request('http://main.test/v1/works/example/editions'), {},
    { dataEpoch: 'epoch', sequence: '1' });
  session.summaries = async () => [{ status: 'available', type: 'work', name: { value: 'Work', language: 'en' },
    avatar: { kind: 'none' } }] as never;
  return { session, bytes, manifest, setModel: (value: string) => { graphModel = value; },
    setRevision: (value: string) => { graphRevision = value; } };
}

test('Edition list and exact read hydrate both model profiles from retained object payloads', async () => {
  for (const [state, profile] of [[v1, METADATA_PROFILE], [v2, METADATA_DETAILS_V2]] as const) {
    const { session } = await fixture(state, profile);
    const listed = await readWorkEditions(session, work, 'en');
    expect(listed.items).toEqual([{ ...state, revision }]);
    const exact = await readWorkEdition(session, work, edition);
    expect(exact).toMatchObject({ id: edition, revision, status: 'active', record: state });
  }
});

test('A withdrawn retained edition keeps its conditional-edit head without returning the record', async () => {
  const { session } = await fixture({ ...v2, status: 'withdrawn' }, METADATA_DETAILS_V2);
  expect((await readWorkEditions(session, work)).items).toEqual([]);
  expect(await readWorkEdition(session, work, edition)).toMatchObject({ id: edition, revision,
    status: 'withdrawn', record: null });
});

test('Edition object reads reject a mismatched Work, revision and pinned model', async () => {
  const foreignWork = await fixture(v1, METADATA_PROFILE,
    { intent: { work: id(9), expectedHead: null, state: v1 }, revision });
  await expect(readWorkEdition(foreignWork.session, work, edition)).rejects.toBeInstanceOf(WorkReadUnavailable);
  const wrongHead = await fixture(v1, METADATA_PROFILE);
  wrongHead.setRevision(id(10));
  await expect(readWorkEdition(wrongHead.session, work, edition)).rejects.toBeInstanceOf(WorkReadUnavailable);
  const wrongModel = await fixture(v1, METADATA_PROFILE);
  wrongModel.setModel(METADATA_DETAILS_V2);
  await expect(readWorkEdition(wrongModel.session, work, edition)).rejects.toBeInstanceOf(WorkReadUnavailable);
  const wrongStateProfile = await fixture(v1, METADATA_DETAILS_V2);
  await expect(readWorkEdition(wrongStateProfile.session, work, edition)).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('Missing or corrupt retained edition objects produce an unavailable read', async () => {
  for (const corrupt of [false, true]) {
    const value = await fixture(v1, METADATA_PROFILE);
    if (corrupt) value.bytes.set(value.manifest, new TextEncoder().encode('{}'));
    else value.bytes.delete(value.manifest);
    await expect(readWorkEdition(value.session, work, edition)).rejects.toBeInstanceOf(WorkReadUnavailable);
  }
});

function admissionFor(digest: string): RegisteredAdmission {
  return { id: id(20).slice(-36), principalId: 'editor', actingSubject: id(7), scope: `work:edit:${work}`,
    action: 'work.edit', idempotencyKey: 'custodied-edition', requestDigest: digest, authorityEpoch: '1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'sealed', dispatchEligible: false, replayed: true };
}
function terminalFor(admission: RegisteredAdmission) {
  return { outcome: 'succeeded' as const, receipt: workEditReceiptIri(admission.id), admissionId: admission.id,
    requestDigest: admission.requestDigest, authorityEpoch: admission.authorityEpoch, scope: admission.scope,
    dataEpoch: 'epoch', sequence: '1', work, component: edition, revision, predecessor: id(8) };
}

test('Strong closure resolves a retired edition command from the owner without graph cancellation', async () => {
  const admission = admissionFor(metadataDigest({ work, expectedHead: id(8), state: v1 }));
  const terminal = terminalFor(admission);
  const graph = new FusekiClient('http://metadata.invalid/rezics');
  graph.query = async () => { throw new Error('Retired receipt must resolve from custody'); };
  graph.commandWithReceipt = async () => { throw new Error('Successful owner result must not be cancelled'); };
  const env = { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, objectDirectory: '.temp/metadata-closure',
    receiptCustody: { resolve: async () => terminal } as never };
  expect(await readWorkEditTerminalReceipt(env, admission.id)).toMatchObject({ outcome: 'succeeded',
    receipt: terminal.receipt, work, revision, predecessor: id(8) });
  expect(await sealMetadataWorkEditAdmission(env, admission)).toMatchObject({ outcome: 'succeeded', receipt: terminal.receipt });
});

test('Strong closure dispatches cancellation inside the custody lock and reads the result after release', async () => {
  const admission = admissionFor('a'.repeat(64));
  let locked = false, cancelled = false, guarded = false;
  const graph = new FusekiClient('http://metadata.invalid/rezics');
  graph.commandWithReceipt = async () => {
    expect(locked).toBe(true); cancelled = true; return { status: 'guard-unmatched' };
  };
  graph.query = async () => {
    expect(locked).toBe(false);
    return rows(cancelled ? [{ outcome: term(`${RV}Cancelled`), digest: term(admission.requestDigest, 'literal'),
      admissionId: term(admission.id, 'literal'), authorityEpoch: term(admission.authorityEpoch, 'literal'),
      scope: term(admission.scope, 'literal'), sequence: term('1', 'literal'), epoch: term('epoch', 'literal') }] : []);
  };
  const env = { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, objectDirectory: '.temp/metadata-closure',
    receiptCustody: {
      resolve: async () => { expect(locked).toBe(false); return null; },
      guardCancellation: async (_receipt: string, dispatch: () => Promise<void>) => {
        guarded = true; locked = true;
        try { await dispatch(); return null; } finally { locked = false; }
      },
    } as never };
  expect((await sealMetadataWorkEditAdmission(env, admission)).outcome).toBe('cancelled');
  expect(guarded).toBe(true);
});

test('Successful edition replay retires after Access records the owner result, and survives unavailable retirement', async () => {
  for (const state of [v1, v2]) for (const unavailable of [false, true]) {
    const intent = { work, expectedHead: id(8), state };
    const profile = 'contentLanguages' in state ? 'work-metadata-details-v2' : 'work-metadata-details-v1';
    const digest = 'contentLanguages' in state ? editionV2Digest({ ...intent, state }) : metadataDigest({ ...intent, state });
    const admission = admissionFor(digest), terminal = terminalFor(admission), steps: string[] = [];
    const graph = new FusekiClient('http://metadata.invalid/rezics');
    graph.query = async query => ({ boolean: query.includes('restoreHold') });
    const deps = { environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
      objectDirectory: '.temp/metadata-retirement', receiptCustody: {
        resolve: async () => terminal,
        retire: async (receipt: string) => {
          expect(receipt).toBe(terminal.receipt); steps.push('retire');
          if (unavailable) throw new ObjectUnavailable('Retirement unavailable');
        },
      } }, account: { verify: async () => ({ issuer: 'account', subject: 'editor' }) },
      access: { register: async () => admission, recordGraphOutcome: async () => { steps.push('record'); } },
    } as unknown as MainWorkDependencies;
    const result = await setWorkMetadata(deps, new Request('http://main.test/v1/works/example/metadata'),
      { ...intent, profile, actingSubject: id(7), idempotencyKey: admission.idempotencyKey });
    expect(result).toMatchObject({ work, component: edition, revision, receipt: terminal.receipt, replayed: true });
    expect(steps).toEqual(['record', 'retire']);
  }
});
