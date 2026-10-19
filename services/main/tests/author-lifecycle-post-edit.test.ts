import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CommandEnvelope, SparqlResult } from '../src/infrastructure/fuseki.ts';
import { ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { CONTINUITY, GRAPHS, PROFILE, hash, IdempotencyConflict, prepareWorkComponent,
  type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { editMetadataWork, metadataWorkEditDigest, StaleWorkHead, WorkEditUnavailable } from '../src/modules/work/edit.ts';
import { readExactWorkRevision, readWorkComponentState, RevisionCorrupt } from '../src/modules/work/history.ts';
import { editAdmittedMetadataWork } from '../src/modules/work/edit-admitted.ts';
import { PendingAdmittedWork } from '../src/modules/work/create-admitted.ts';
import { TitleControlInvalid } from '../src/modules/work/title-control.ts';
import { AdmissionConflict, AdmissionDenied, type AdmissionRequest, type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { workRoutes } from '../src/routes/works.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const profile = 'https://rezics.com/definition/post-v1';
const id = () => `https://rezics.com/id/${randomUUID()}`;
const bind = (value: string) => ({ type: /^(https:|urn:)/.test(value) ? 'uri' : 'literal', value });
const rows = (bindings: NonNullable<SparqlResult['results']>['bindings']): SparqlResult => ({ results: { bindings } });

/** Immutable objects are real; the bounded graph double applies only this owner's head/receipt CAS. */
async function fixture(nativePost = true) {
  const post = id(), publisher = id(), original = id(), epoch = randomUUID();
  const stored = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    async put(bytes) { const digest = hash(bytes); stored.set(digest, new Uint8Array(bytes)); return digest; },
    async get(digest) { const bytes = stored.get(digest); if (!bytes) throw new ObjectUnavailable('missing'); return bytes; },
  };
  const main = id(), revisionProfile = nativePost ? profile : PROFILE;
  const state = { publisher, labels: [{ value: 'Original title', language: 'en' },
    { value: 'Titre conservé', language: 'fr' }] };
  const metadata = { mainVersion: main, continuityProfile: CONTINUITY, title: 'Original title', language: 'en',
    localizedTitle: { value: 'Titre conservé', language: 'fr' }, description: { value: 'Retained synopsis', language: 'en' } };
  let head = original, labels = state.labels, sequence = 20;
  const firstManifest = `urn:rezics:sha256:${await prepareWorkComponent(objects, post, nativePost ? state : metadata, revisionProfile)}`;
  const anchors = new Map<string, NonNullable<SparqlResult['results']>['bindings'][number]>([[original,
    { work: bind(post), operation: bind(id()), manifest: bind(firstManifest), model: bind(revisionProfile), shape: bind(revisionProfile),
      dataset: bind('urn:rezics:dataset:product'), epoch: bind(epoch), sequence: bind('20') }]]);
  const receipts = new Map<string, NonNullable<SparqlResult['results']>['bindings'][number]>();
  const commands: CommandEnvelope[] = [];
  const current = { readable: true, erased: false, authority: true, claim: true, finalClaim: true,
    controlledTitle: false, controlOnFence: false, eraseOnFence: false, revokeOnClose: false,
    positionReads: 0, fences: 0, records: 0 };
  const query = async (sql: string): Promise<SparqlResult> => {
    if (sql.includes('SELECT ?work ?operation ?manifest')) {
      const anchor = [...anchors].find(([revision]) => sql.includes(`<${revision}> a rv:RevisionAnchor`));
      return rows(anchor && !current.erased ? [anchor[1]] : []);
    }
    if (sql.includes('SELECT ?main ?head')) {
      if (!nativePost) return rows([{ ...anchors.get(head)!, main: bind(main), head: bind(head),
        type: bind('https://schema.org/CreativeWork'), title: { ...bind(labels[0]!.value), 'xml:lang': 'en' } }]);
      // Reproduce the real native Post: there is no mainVersion or metadata Work profile.
      if (current.erased || sql.includes('rv:mainVersion ?main ;') || sql.includes(`rv:modelRevision <https://rezics.com/definition/work-metadata-v1>`)) return rows([]);
      return rows(labels.map(label => ({ head: bind(head), type: bind('https://rezics.com/vocab/Post'),
        title: { ...bind(label.value), 'xml:lang': label.language }, publisher: bind(publisher), ...anchors.get(head)! })));
    }
    if (sql.includes('SELECT ?outcome ?reason ?digest')) {
      const found = [...receipts].find(([receipt]) => sql.includes(`<${receipt}>`));
      return rows(found ? [found[1]] : []);
    }
    if (sql.includes('ASK') && sql.includes('rv:InvalidProfile')) return { boolean: false };
    if (sql.includes('ASK') && sql.includes('titleControlHead')) return { boolean: current.controlledTitle };
    if (sql.includes('ASK') && sql.includes(`GRAPH <${GRAPHS.control}>`)) return { boolean: true };
    if (sql.includes('SELECT ?epoch ?sequence')) {
      current.positionReads++;
      if (current.revokeOnClose && current.positionReads > 1) current.readable = false;
      return rows([{ epoch: bind(epoch), sequence: bind(String(sequence)) }]);
    }
    if (sql.includes('SELECT ?head ?publisher ?label ?public ?spoiler')) return rows(current.erased ? []
      : labels.map(label => ({ head: bind(head), publisher: bind(publisher),
        label: { ...bind(label.value), 'xml:lang': label.language }, public: bind('false') })));
    if (sql.includes('SELECT DISTINCT ?book ?occurrence ?public')) return rows([]);
    throw new Error(`Unexpected Post edit query: ${sql}`);
  };
  const env: WorkActivationEnvironment = { objectDirectory: '.temp/unused-post-edit-mirror', workObjects: objects,
    lineage: { dataEpoch: epoch, routingEpoch: '1' }, fuseki: {
      query,
      commandHealth: async () => ({ profiles: Object.fromEntries(Object.entries(profileRegistry).map(([key, value]) => [key, value.sha256])) }),
      commandWithReceipt: async (command: CommandEnvelope) => {
        commands.push(command);
        if (command.update.includes('rv:reason rv:StaleHead')) {
          const expected = /FILTER\(\?currentHead != <([^>]+)>\)/.exec(command.update)![1];
          if (head === expected) return { status: 'guard-unmatched' };
        } else {
          const expected = /rv:expectedHead <([^>]+)>/.exec(command.update)![1];
          if (head !== expected || current.erased || current.controlledTitle) return { status: 'guard-unmatched' };
        }
        const literal = (predicate: string) => {
          const value = new RegExp(`rv:${predicate} ("(?:[^"\\\\]|\\\\.)*")`).exec(command.update)?.[1];
          if (!value) throw new Error(`Missing ${predicate} in actual command`);
          return JSON.parse(value) as string;
        };
        const terminal = { admissionId: bind(literal('admissionId')), digest: bind(command.digest),
          authorityEpoch: bind(literal('authorityEpoch')), scope: bind(literal('admittedScope')),
          epoch: bind(epoch), sequence: bind(String(++sequence)) };
        if (command.update.includes('rv:reason rv:StaleHead')) {
          receipts.set(command.receipt, { ...terminal, outcome: bind('https://rezics.com/vocab/Cancelled'), reason: bind('https://rezics.com/vocab/StaleHead') });
        } else {
          if (nativePost) expect(command.validations).toMatchObject([{ profile: 'post-v1',
            binding: { post, publisher }, shape: `${profile}/post-shape` }]);
          else expect(command.validations.every(validation => validation.profile === 'work-metadata-v1')).toBe(true);
          expect(command.update).toContain(`rv:head <${head}>`);
          if (nativePost) {
            expect(command.update).toContain(`rv:publisher <${publisher}>`);
            expect(command.update).not.toContain('rv:mainVersion');
          } else expect(command.update).toContain(`rv:mainVersion <${main}>`);
          const revision = /rv:workRevision <([^>]+)>/.exec(command.update)![1]!;
          const manifest = /rv:manifest <([^>]+)>/.exec(command.update)![1]!;
          const next = await readWorkComponentState(env, manifest, post, revisionProfile);
          const predecessor = head;
          head = revision; labels = nativePost ? next.labels as typeof state.labels
            : [{ value: next.title as string, language: next.language as string }];
          anchors.set(revision, { ...anchors.get(original)!, manifest: bind(manifest),
            operation: bind(/rv:operation <([^>]+)>/.exec(command.update)![1]!),
            predecessor: bind(predecessor), sequence: terminal.sequence });
          receipts.set(command.receipt, { ...terminal, outcome: bind('https://rezics.com/vocab/Succeeded'),
            work: bind(post), revision: bind(revision), predecessor: bind(predecessor) });
        }
        return { status: 'committed', position: { datasetId: 'urn:rezics:dataset:product', dataEpoch: epoch, sequence: String(sequence) } };
      },
    } } as unknown as WorkActivationEnvironment;
  const intent = (title = 'Corrected title', expectedHead = original) => ({ work: post, expectedHead, title,
    admission: { id: randomUUID(), scope: `work:edit:${post}`, action: 'work.edit', actingSubject: publisher,
      requestDigest: metadataWorkEditDigest(post, expectedHead, title), authorityEpoch: '3', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  const principal = { issuer: 'https://account.test', subject: randomUUID(), emailVerified: true };
  const admissions = new Map<string, RegisteredAdmission>();
  const access = {
    assertRecoveryOpen: async () => {}, activePrincipalId: async () => principal.subject,
    canReadWork: async () => current.readable,
    register: async (request: AdmissionRequest) => {
      if (!current.authority || request.actingSubject !== publisher) throw new AdmissionDenied('foreign or revoked author');
      const existing = admissions.get(request.idempotencyKey);
      if (existing) {
        if (existing.requestDigest !== request.requestDigest) throw new AdmissionConflict('changed intent');
        return { ...existing, replayed: true };
      }
      const registered: RegisteredAdmission = { ...request, id: randomUUID(), principalId: principal.subject,
        authorityEpoch: '3', expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'registered', dispatchEligible: true, replayed: false };
      admissions.set(request.idempotencyKey, registered);
      return registered;
    },
    claim: async (admissionId: string) => {
      if (!current.claim) throw new AdmissionDenied('control lost before claim');
      const admission = [...admissions.values()].find(candidate => candidate.id === admissionId)!;
      admission.state = 'claimed';
      return admission;
    },
    withOwnerAuthority: async (request: AdmissionRequest, commit: (client: PoolClient) => Promise<unknown>) => {
      if (!current.authority || request.actingSubject !== publisher) throw new AdmissionDenied('live author revoked');
      return commit({} as PoolClient);
    },
    fenceClaim: async (_client: PoolClient, admissionId: string, digest: string) => {
      current.fences++;
      if (!current.finalClaim) throw new AdmissionDenied('final claim revoked');
      const admission = [...admissions.values()].find(candidate => candidate.id === admissionId)!;
      expect(admission.requestDigest).toBe(digest);
      expect(admission.state).toBe('claimed');
      if (current.controlOnFence) current.controlledTitle = true;
      if (current.eraseOnFence) current.erased = true;
      return admission;
    },
    recordGraphOutcome: async (admissionId: string) => {
      current.records++;
      [...admissions.values()].find(candidate => candidate.id === admissionId)!.state = 'sealed';
    },
  };
  const deps = { environment: env, access, account: { verify: async () => principal } } as unknown as MainWorkDependencies;
  const request = new Request('http://localhost/v1/content-edits', { headers: { authorization: 'Bearer author' } });
  const admitted = (input = {}) => editAdmittedMetadataWork(env, deps.account, deps.access, request,
    { work: post, expectedHead: original, title: 'Admitted correction', actingSubject: publisher, idempotencyKey: 'post-correction', ...input });
  const get = () => workRoutes(env.fuseki, deps).handle(new Request(`http://localhost/v1/revisions/${original.slice(-36)}?actingSubject=${publisher}`,
    { headers: { authorization: 'Bearer author' } }));
  return { env, post, publisher, original, state, metadata, main, firstManifest, stored, anchors, commands, intent, current, deps, admitted, get };
}

test('same-identity native Post title edit retains post-v1 custody and old/new exact snapshots with replay and stale-head refusal', async () => {
  const f = await fixture(), intent = f.intent();
  const immutable = new Map([...f.stored].map(([key, value]) => [key, Buffer.from(value)]));
  const result = await editMetadataWork(f.env, intent);
  expect(result).toMatchObject({ work: f.post, predecessor: f.original, replayed: false });
  expect(await editMetadataWork(f.env, intent)).toEqual({ ...result, replayed: true });
  await expect(editMetadataWork(f.env, { ...intent, title: 'Changed intent' })).rejects.toBeInstanceOf(IdempotencyConflict);
  await expect(editMetadataWork(f.env, f.intent('Fresh stale edit'))).rejects.toBeInstanceOf(StaleWorkHead);
  const old = await readExactWorkRevision(f.env, f.original, async () => true);
  const next = await readExactWorkRevision(f.env, result.revision, async () => true);
  expect(old).toMatchObject({ title: 'Original title', publisher: f.publisher, labels: f.state.labels });
  expect(next).toMatchObject({ title: 'Corrected title', predecessor: f.original, publisher: f.publisher,
    labels: [{ value: 'Corrected title', language: 'en' }, f.state.labels[1]] });
  expect(next).not.toHaveProperty('mainVersion');
  for (const [key, bytes] of immutable) expect(Buffer.from(f.stored.get(key)!)).toEqual(bytes);
  expect(f.commands).toHaveLength(2);
});

test('ordinary metadata Work title correction retains its MainVersion, optional metadata and existing profile validations', async () => {
  const f = await fixture(false);
  const result = await editMetadataWork(f.env, f.intent(), async () => { throw new Error('Post fence must not replace ordinary Work policy'); });
  expect(await readExactWorkRevision(f.env, result.revision, async () => true)).toMatchObject({
    work: f.post, mainVersion: f.main, title: 'Corrected title', language: 'en', semanticTypes: [],
    localizedTitle: f.metadata.localizedTitle, description: f.metadata.description,
  });
  expect((await readExactWorkRevision(f.env, f.original, async () => true)).title).toBe('Original title');
});

test('native Post exact revision HTTP reads current custody and closes the retained read and authority fences', async () => {
  const f = await fixture();
  const response = await f.get();
  expect(response.status, await response.clone().text()).toBe(200);
  const before = await response.json();
  expect(before).toMatchObject({ profile: 'post-v1', work: f.post, revision: f.original, title: 'Original title', publisher: f.publisher });
  expect(before).not.toHaveProperty('mainVersion');
  await f.admitted();
  const retained = await f.get();
  expect(retained.status, await retained.clone().text()).toBe(200);
  expect(await retained.json()).toEqual(before);
  for (const cause of ['denied', 'erased', 'closing-revocation'] as const) {
    const hidden = await fixture();
    if (cause === 'denied') hidden.current.readable = false;
    if (cause === 'erased') hidden.current.erased = true;
    if (cause === 'closing-revocation') hidden.current.revokeOnClose = true;
    const refused = await hidden.get();
    expect(refused.status, await refused.clone().text()).toBe(404);
    expect(await refused.text()).not.toContain('Original title');
  }
});

test('native Post admitted correction uses current author and final claim, replays the exact receipt and refuses changed intent', async () => {
  const f = await fixture();
  const first = await f.admitted();
  expect(first.work).toBe(f.post);
  expect(first.replayed).toBe(false);
  expect(f.current.fences).toBe(1);
  expect(await f.admitted()).toEqual({ ...first, replayed: true });
  expect(f.current.fences).toBe(1);
  await expect(f.admitted({ title: 'Different same-key intent' })).rejects.toBeInstanceOf(AdmissionConflict);
  await expect(f.admitted({ idempotencyKey: 'fresh-stale' })).rejects.toBeInstanceOf(StaleWorkHead);
  const denied = await fixture();
  await expect(denied.admitted({ actingSubject: id() })).rejects.toBeInstanceOf(AdmissionDenied);
  expect(denied.commands).toHaveLength(0);
  const revoked = await fixture();
  revoked.current.finalClaim = false;
  await expect(revoked.admitted()).rejects.toBeInstanceOf(AdmissionDenied);
  expect(revoked.commands).toHaveLength(0);
  expect(revoked.current.records).toBe(0);
  const controlled = await fixture();
  controlled.current.controlledTitle = true;
  await expect(controlled.admitted()).rejects.toBeInstanceOf(TitleControlInvalid);
  expect(controlled.commands).toHaveLength(0);
  f.current.authority = false;
  await expect(f.admitted()).rejects.toBeInstanceOf(AdmissionDenied);
  expect(f.commands).toHaveLength(2);
});

test('native Post edit refuses corrupt/mismatched custody before dispatch and final title-control or erasure races without a success receipt', async () => {
  for (const failure of ['shape', 'component', 'publisher', 'erased'] as const) {
    const f = await fixture();
    if (failure === 'shape') f.anchors.get(f.original)!.shape = bind(PROFILE);
    if (failure === 'component') f.anchors.get(f.original)!.manifest = bind(`urn:rezics:sha256:${await prepareWorkComponent(f.env.workObjects!, id(), f.state, profile)}`);
    if (failure === 'publisher') f.anchors.get(f.original)!.manifest = bind(`urn:rezics:sha256:${await prepareWorkComponent(f.env.workObjects!, f.post, { ...f.state, publisher: id() }, profile)}`);
    if (failure === 'erased') f.current.erased = true;
    await expect(editMetadataWork(f.env, f.intent())).rejects.toBeInstanceOf(failure === 'shape' || failure === 'erased' ? WorkEditUnavailable : RevisionCorrupt);
    expect(f.commands).toHaveLength(0);
  }
  for (const failure of ['controlOnFence', 'eraseOnFence'] as const) {
    const f = await fixture();
    f.current[failure] = true;
    await expect(f.admitted()).rejects.toBeInstanceOf(PendingAdmittedWork);
    expect(f.anchors.size).toBe(1);
    expect(f.current.records).toBe(0);
    expect(f.commands[0]!.update).toContain('rv:titleControlHead');
    expect(f.commands[0]!.update).toContain('a rv:ErasedRevision');
  }
});
