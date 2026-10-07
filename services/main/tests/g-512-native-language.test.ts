import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { FusekiClient, type CommandEnvelope, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { activateMetadataWork, CONTINUITY, GRAPHS, hash, ID, metadataWorkRequestDigest,
  prepareComponent, PROFILE, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { readComponentState, readWorkPayloadForRevision } from '../src/modules/work/history.ts';
import { titleControlCommand, titleControlDigest, changeTitleControl, TITLE_PROFILE,
  TITLE_PROFILE_V1, type TitleControlIntent } from '../src/modules/work/title-control.ts';
import { reconcileRetainedTitleControl } from '../src/modules/work/reconcile-title-control.ts';
import { createRealmSpace, spaceCreationDigest, SPACE_REALM_PROFILE } from '../src/modules/space/create.ts';
import { changeWorkProtection, proposeWorkCorrection, reviewWorkCorrection, workProtectionDigest,
  type WorkEditorialBasis } from '../src/modules/protection/work.ts';
import { reconcileRetainedWorkProtection } from '../src/modules/protection/reconcile-restored.ts';
import { protectionReceiptIri } from '../src/modules/protection/receipt-family.ts';
import type { RecoveryTriple } from '../src/modules/protection/recovery-evidence.ts';
import { PROTECTION_RULE } from '../src/modules/protection/schema.ts';
import { reconcileRetainedWorkCreate, reconcileRetainedRealmSpaceCreate } from '../src/modules/work/reconcile-restored.ts';
import { protectionRoutes } from '../src/routes/protection.ts';
import { publicTitleProjection } from '../src/modules/content-publication/title-projection.ts';
import { SourceNativeWorkAttachmentStore } from '../src/modules/source/native-work-attachment.ts';
import { contentRoutes } from '../src/routes/content.ts';
import { workRoutes } from '../src/routes/works.ts';
import { sourceSupportRoutes } from '../src/routes/source-supports.ts';
import { spaceRoutes } from '../src/routes/spaces.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { RegisteredAdmission, AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { COMMAND_MODULE_VERSION } from '../src/infrastructure/profile.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { relayCoverage, type MainCloudEvent } from '../src/modules/outbox/relay.ts';

const root = resolve(import.meta.dir, '../../..');
const ids = Array.from({ length: 10 }, (_, n) => ID + `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`);
const work = ids[0]!, head = ids[1]!, main = ids[2]!, actor = ids[3]!;
const lit = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });
type Binding = NonNullable<SparqlResult['results']>['bindings'][number];
const object = (update: string, predicate: string) => {
  const match = new RegExp(`rv:${predicate} ("(?:[^"\\\\]|\\\\.)*"|<[^>]+>|rv:[A-Za-z]+|[0-9]+)`).exec(update);
  if (!match) return undefined;
  const value = match[1]!;
  return value[0] === '"' ? JSON.parse(value) as string : value[0] === '<' ? value.slice(1, -1)
    : value.startsWith('rv:') ? RV + value.slice(3) : value;
};
const manifest = (command: CommandEnvelope, component: string, directory: string, profile = PROFILE) => {
  const state = command.update.split(`rv:component <${component}>`).slice(1);
  for (const tail of state) {
    const value = object(tail, 'manifest');
    if (!value) continue;
    try { return { manifest: value, state: readComponentState(directory, value, component, profile) }; }
    catch { /* Other revisions have another profile. */ }
  }
  throw new Error(`No ${profile} manifest for ${component}`);
};

/** Captures the production writer envelope. It deliberately does not emulate Jena policy/CAS. */
class CapturingFuseki extends FusekiClient {
  commands: CommandEnvelope[] = [];
  receipts = new Map<string, Binding>();
  priorManifest = '';
  language = 'ja';
  name?: { value: string; language: string };
  proposal?: Binding;
  constructor() { super('http://localhost:1/rezics'); }
  override async commandHealth() { return { moduleVersion: COMMAND_MODULE_VERSION,
    instanceId: '11111111-1111-4111-8111-111111111111', publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
    profiles: Object.fromEntries(Object.entries(profileRegistry).map(([id, value]) => [id, value.sha256])) }; }
  override async query(query: string): Promise<SparqlResult> {
    if (query.includes('ASK')) return { boolean: !query.includes('rv:InvalidProfile') };
    // This fixture's Work has no closed descriptive capability type.
    if (query.includes('SELECT ?type WHERE')) return { results: { bindings: [] } };
    if (query.includes('SELECT ?cursor')) return { results: { bindings: [{ cursor: lit('1') }] } };
    if (query.includes('SELECT ?work ?operation ?manifest')) return { results: { bindings: [{
      work: uri(work), operation: uri(ids[4]!), manifest: uri(this.priorManifest), model: uri(PROFILE), shape: uri(PROFILE),
      dataset: uri('urn:rezics:dataset:product'), epoch: lit('epoch'), sequence: lit('1'),
    }] } };
    if (query.includes('SELECT ?main ?type')) return { results: { bindings: [{ main: uri(main), type: uri('https://schema.org/CreativeWork'),
      workManifest: uri(this.priorManifest) }] } };
    if (query.includes('SELECT ?work ?recipe WHERE')) {
      // The shared native recipe returns serialized RDF literals, including the proposed title.
      // Accept only this fixture's one-Work bounded request, never an unknown projection query.
      const match = /^PREFIX rv: <https:\/\/rezics\.com\/vocab\/> SELECT \?work \?recipe WHERE \{\s+\{ BIND\(<([^>]+)> AS \?work\)\s+BIND\(rv:rankedText\(rv:publicTitle, "", 64, "", ("(?:[^"\\]|\\.)*")\) AS \?recipe\) \}\s+\} LIMIT 2$/u.exec(query);
      if (!match || match[1] !== work) throw new Error(`Unexpected catalogue recipe query: ${query}`);
      const scope = JSON.parse(JSON.parse(match[2]!)) as {
        catalogueNames: { work: string; override?: { replacementTitle?: { value: string; language: string } } };
      };
      if (scope.catalogueNames.work !== work) throw new Error('Unexpected catalogue recipe Work');
      const replacement = scope.catalogueNames.override?.replacementTitle;
      const names = replacement
        ? [`${JSON.stringify('Original name')}@en`, `${JSON.stringify(replacement.value)}@${replacement.language}`]
        : [`${JSON.stringify('元の名前')}@${this.language}`, `${JSON.stringify('Original name')}@en`];
      return { results: { bindings: [{ work: uri(work), recipe: lit(JSON.stringify({ names })) }] } };
    }
    if (query.includes('SELECT ?work ?name ?namePredicate ?state')) return { results: { bindings: [{
      work: uri(work), name: { ...lit('元の名前'), 'xml:lang': this.language },
      namePredicate: uri('http://www.w3.org/2000/01/rdf-schema#label'),
    }, { work: uri(work), name: { ...lit('Original name'), 'xml:lang': 'en' },
      namePredicate: uri('https://schema.org/name') }] } };
    // Catalogue projection drops the replaced label in SPARQL. This double does not execute SPARQL,
    // so it applies that same filter before returning the surviving names.
    if (query.includes('SELECT ?work ?name ?state') && query.includes('schema:alternateName')) {
      const filter = /FILTER\(\?namePredicate != rdfs:label \|\| \?name != ("(?:[^"\\]|\\.)*")@([A-Za-z0-9-]+)\)/.exec(query);
      const bindings: Binding[] = [];
      const dropsPriorLabel = filter !== null && JSON.parse(filter[1]!) === '元の名前' && filter[2] === this.language;
      if (!dropsPriorLabel) bindings.push({ work: uri(work), name: { ...lit('元の名前'), 'xml:lang': this.language } });
      bindings.push({ work: uri(work), name: { ...lit('Original name'), 'xml:lang': 'en' } });
      return { results: { bindings } };
    }
    if (query.includes('SELECT ?main WHERE')) return { results: { bindings: [{ main: uri(main) }] } };
    if (query.includes('SELECT ?admission WHERE')) return { results: { bindings: [{ admission: lit('proposal-admission') }] } };
    if (query.includes('SELECT ?main ?manifest')) return { results: { bindings: [{ main: uri(main), manifest: uri(this.priorManifest) }] } };
    if (query.includes('SELECT ?head ?protection')) return { results: { bindings: [{ head: uri(head) }] } };
    if (query.includes('SELECT ?head ?count')) return { results: { bindings: [{}] } };
    if (query.includes('SELECT ?work ?head ?protection')) return { results: { bindings: this.proposal ? [this.proposal] : [] } };
    // A Realm read is reached only after the Zone probe finds no Zone-only Space.
    if (query.includes('SELECT ?zone ?owner ?name')) return { results: { bindings: [] } };
    if (query.includes('SELECT ?realm ?owner ?name')) return { results: { bindings: this.name ? [{
      realm: uri(ids[4]!), owner: uri(actor), name: { ...lit(this.name.value), 'xml:lang': this.name.language },
      spaceRevision: uri(ids[5]!), realmRevision: uri(ids[6]!), selectionPolicy: uri(ids[7]!),
      membershipPolicy: uri(ids[8]!), reviewPolicy: uri(ids[9]!),
    }] : [] } };
    if (query.includes('?outcome')) {
      const row = [...this.receipts].find(([receipt]) => query.includes(`<${receipt}>`))?.[1];
      return { results: { bindings: row ? [query.includes('?id ?epoch ?scope ?dataEpoch') ? { ...row, epoch: row.authorityEpoch! } : row] : [] } };
    }
    throw new Error(`Unexpected query: ${query.slice(0, 160)}`);
  }
  override async commandWithReceipt(command: CommandEnvelope) {
    this.commands.push(command);
    const block = /GRAPH <urn:rezics:graph:receipts> \{([\s\S]*?)\}/.exec(command.update.split('INSERT')[1]!)?.[1]?.replace(/<https:\/\/rezics\.com\/vocab\/([A-Za-z]+)>/g, 'rv:$1') ?? '';
    const row: Binding = { digest: lit(command.digest), sequence: lit('1') };
    for (const [variable, predicate] of Object.entries({ outcome: 'outcome', admissionId: 'admissionId', id: 'admissionId',
      authority: 'authorityEpoch', authorityEpoch: 'authorityEpoch', scope: 'admittedScope', epoch: 'dataEpoch', dataEpoch: 'dataEpoch',
      action: 'action', recordedAction: 'action', work: 'work', main: 'mainVersion', workRevision: 'workRevision', mainRevision: 'mainRevision',
      revision: 'workRevision', protection: 'protectionRevision', proposal: 'proposalRevision', decision: 'decision',
      review: 'reviewOutcome', control: 'titleControl', operation: 'operation', space: 'space', realm: 'realm',
      spaceRevision: 'spaceRevision', realmRevision: 'realmRevision', owner: 'owner' })) {
      const value = object(block, predicate);
      if (value !== undefined) row[variable] = value.startsWith('https:') || value.startsWith('urn:') ? uri(value) : lit(value);
    }
    if (row.control && object(command.update, 'controlIntent')) {
      row.intent = lit(object(command.update, 'controlIntent')!);
      const revisions = command.update.split('rv:controlIntent')[1]!;
      row.manifest = uri(object(revisions, 'manifest')!);
      const tail = command.update.split(`rv:component <${work}>`).find(part => part.includes(`rv:modelRevision <${PROFILE}>`));
      row.workManifest = uri(tail ? object(tail, 'manifest')! : this.priorManifest);
    }
    this.receipts.set(command.receipt, row);
    return { status: 'committed' as const, position: { datasetId: 'urn:rezics:dataset:product', dataEpoch: 'epoch', sequence: '1' } };
  }
}

function fixture(language = 'ja') {
  mkdirSync(resolve(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(resolve(root, '.temp/g-512-'));
  const fuseki = new CapturingFuseki(); fuseki.language = language;
  fuseki.priorManifest = `urn:rezics:sha256:${prepareComponent(directory, work, { mainVersion: main,
    continuityProfile: CONTINUITY, title: '元の名前', language,
    localizedTitle: { value: 'Original name', language: 'en' }, description: { value: '説明', language: 'ja' } })}`;
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: directory,
    lineage: { dataEpoch: 'epoch', routingEpoch: '1' }, titleAdmissionKey: 'a'.repeat(64) };
  const account = { verify: async () => ({}) } as unknown as MainWorkDependencies['account'];
  let admission: RegisteredAdmission;
  const access = {
    register: async (input: { action: string; scope: string; requestDigest: string; idempotencyKey: string }) => {
      admission = { id: '00000000-0000-4000-8000-000000000010', principalId: 'principal', actingSubject: actor,
        ...input, authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: 'claimed', dispatchEligible: true, replayed: false }; return admission;
    }, claim: async () => admission, recordGraphOutcome: async () => {},
    issueTitleAdmission: async () => ({ payload: 'proof', signature: 'a'.repeat(64) }),
  } as unknown as MainWorkDependencies['access'] & Pick<AccessAdmissionRegistry, 'issueTitleAdmission'>;
  const signer = { issue: async () => ({ payload: 'proof', signature: 'a'.repeat(64) }) } as unknown as NonNullable<MainWorkDependencies['protectionSigner']>;
  const basis: WorkEditorialBasis = { work, expectedHead: head, expectedProtection: null, expectedControl: null,
    expectedControlEpoch: '0', expectedRuleRevision: PROTECTION_RULE, actingSubject: actor,
    reason: 'Correct the native title', evidence: [], idempotencyKey: 'g-512' };
  const title: TitleControlIntent = { work, expectedHead: head, basis: { head: null, protection: null, epoch: '0' },
    action: 'work.edit', title: '新しい名前', source: null };
  const admitted = (action: string, requestDigest: string, scope = `work:edit:${work}`): RegisteredAdmission => ({
    id: '00000000-0000-4000-8000-000000000010', principalId: 'principal', actingSubject: actor, action,
    scope, requestDigest, idempotencyKey: 'g-512', authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'claimed', dispatchEligible: true, replayed: false,
  });
  return { directory, fuseki, env, account, access, signer, basis, title, admitted,
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
const request = new Request('http://rezics.test');

for (const [submitted, language] of [['ja', 'ja'], ['zh-Hant', 'zh-Hant'], ['und', 'und'],
  ['zh-hant', 'zh-Hant'], ['ja-jp', 'ja-JP']] as const) {
  test(`G-512 command matrix preserves canonical ${submitted} through create/edit/source/protect/review/replay`, async () => {
    const f = fixture(language);
    try {
      const created = await activateMetadataWork(f.env, { title: '作品', language: submitted,
        admission: f.admitted('work.create', metadataWorkRequestDigest('作品', undefined, submitted), 'work:create:root') });
      expect(metadataWorkRequestDigest('作品', undefined, submitted)).toBe(metadataWorkRequestDigest('作品', undefined, language));
      expect(f.fuseki.commands[0]!.update).toContain(`rdfs:label "作品"@${language}`);
      expect((await readWorkPayloadForRevision(f.env,
        manifest(f.fuseki.commands[0]!, created.work, f.directory).manifest, created.work)).language).toBe(language);
      f.fuseki.receipts.clear(); f.fuseki.commands = [];
      for (const action of ['work.edit', 'work.title.apply'] as const) {
        for (const declared of [submitted, undefined]) {
          const intent: TitleControlIntent = { ...f.title, action, ...(declared ? { language: declared } : {}),
            source: action === 'work.edit' ? null : { binding: ids[4]!, record: ids[5]!, observation: ids[6]!,
              conversion: ids[7]!, proposal: ids[8]!, initialHead: head, mapping: 'open-library-work-map-v1' } };
          const command = await titleControlCommand(f.env, f.admitted(action, titleControlDigest(intent)), intent);
          expect(command.update).toContain(`rdfs:label "新しい名前"@${language}`);
          expect(command.update).toContain(`?titleUnit rv:publicTitle "Original name"@en, "新しい名前"@${language} .`);
          expect(command.update).not.toContain(`rv:publicTitle "元の名前"@${language}`);
          const saved = manifest(command, work, f.directory);
          expect((await readWorkPayloadForRevision(f.env, saved.manifest, work)).language).toBe(language);
          expect(saved.state.localizedTitle).toEqual({ value: 'Original name', language: 'en' });
          const control = manifest(command, work, f.directory, TITLE_PROFILE).state;
          expect(control.language).toBe(language);
          if (declared) expect((control.intent as TitleControlIntent).language).toBe(language);
          expect(command.update).toContain('rv:controlField "title"');
          expect(command.update).toContain(`rv:controlLanguage "${language}"`);
          expect(command.update).toContain(`rv:head <${head}> ; rdfs:label ?oldTitle`);
        }
      }
      await changeWorkProtection(f.env, f.account, f.access, f.signer, request, { ...f.basis, action: 'confirm' });
      expect(f.fuseki.commands.at(-1)!.update).toContain(`rv:controlLanguage "${language}"`);
      f.fuseki.receipts.clear();
      await proposeWorkCorrection(f.env, f.account, f.access, f.signer, request,
        { ...f.basis, title: '訂正した名前', predecessor: null,
          ...(submitted !== language ? { language: submitted } : {}) });
      const proposalCommand = f.fuseki.commands.at(-1)!;
      const candidate = manifest(proposalCommand, work, f.directory);
      expect(candidate.state.language).toBe(language);
      const intent = JSON.parse(object(proposalCommand.update, 'proposalIntent')!) as Record<string, string>;
      const proposalTail = proposalCommand.update.split('a rv:RevisionAnchor, rv:CorrectionProposal')[1]!;
      f.fuseki.proposal = { work: uri(work), head: uri(head), protection: uri(RV + 'Absent'), control: uri(RV + 'Absent'),
        controlEpoch: lit('0'), candidate: uri(intent.candidate!), digest: lit(object(proposalTail, 'candidateDigest')!),
        manifest: uri(candidate.manifest), admission: lit('proposal-admission'), intent: lit(JSON.stringify(intent)) };
      f.fuseki.receipts.clear();
      await reviewWorkCorrection(f.env, f.account, f.access, f.signer, request, { ...f.basis,
        proposalRevision: intent.proposal!, candidateDigest: f.fuseki.proposal.digest!.value,
        expectedDecisionHead: null, outcome: 'approved' });
      expect(f.fuseki.commands.at(-1)!.update).toContain(`"訂正した名前"@${language}`);
      f.fuseki.receipts.clear();
      const input = { ...f.title, language: submitted, actingSubject: actor, idempotencyKey: 'edit-replay' };
      const first = await changeTitleControl(f.env, f.account, f.access, request, input);
      const count = f.fuseki.commands.length;
      const replay = await changeTitleControl(f.env, f.account, f.access, request, { ...input, language });
      expect(replay).toEqual({ ...first, replayed: true });
      expect(f.fuseki.commands).toHaveLength(count);
    } finally { f.cleanup(); }
  });
}

test('G-512 explicit title and correction language can differ from the prior head', async () => {
  const f = fixture('ja');
  try {
    const intent = { ...f.title, language: 'zh-Hant' };
    const command = await titleControlCommand(f.env, f.admitted('work.edit', titleControlDigest(intent)), intent);
    expect(command.update).toContain('rdfs:label "新しい名前"@zh-Hant');
    await proposeWorkCorrection(f.env, f.account, f.access, f.signer, request,
      { ...f.basis, title: '新的名稱', language: 'zh-Hant', predecessor: null });
    expect(manifest(f.fuseki.commands.at(-1)!, work, f.directory).state.language).toBe('zh-Hant');
    await expect(titleControlCommand(f.env,
      f.admitted('work.title.return', titleControlDigest({ ...f.title, action: 'work.title.return', language: 'zh-Hant',
        source: { binding: ids[4]!, record: ids[5]!, observation: ids[6]!, conversion: ids[7]!, proposal: ids[8]!, initialHead: head,
          mapping: 'open-library-work-map-v1' } })),
      { ...f.title, action: 'work.title.return', language: 'zh-Hant', source: { binding: ids[4]!, record: ids[5]!, observation: ids[6]!,
        conversion: ids[7]!, proposal: ids[8]!, initialHead: head, mapping: 'open-library-work-map-v1' } })).rejects.toThrow('return must preserve');
  } finally { f.cleanup(); }
});

test('G-512 unknown creation uses und; title digests bind explicit language and keep v1 omission bytes', () => {
  expect(publicTitleProjection('作品')).toBe('\"作品\"@und');
  expect(publicTitleProjection('作品', 'de-u-co-phonebk')).toBe('\"作品\"@de-u-co-phonebk');
  expect(publicTitleProjection('作品', 'zh-hant')).toBe('\"作品\"@zh-Hant');
  expect(metadataWorkRequestDigest('作品')).toBe(metadataWorkRequestDigest('作品', undefined, 'und'));
  const f = fixture();
  try {
    const intent = f.title;
    expect(titleControlDigest(intent)).toBe(hash(JSON.stringify({ profile: 'work-title-control-v1', work,
      expectedHead: head, basis: { head: intent.basis.head, epoch: intent.basis.epoch, protection: intent.basis.protection }, action: 'work.edit', title: intent.title, source: null })));
    expect(titleControlDigest({ ...intent, language: 'ja' })).not.toBe(titleControlDigest({ ...intent, language: 'en' }));
    expect(titleControlDigest({ ...intent, language: 'zh-hant' })).toBe(titleControlDigest({ ...intent, language: 'zh-Hant' }));
    expect(() => titleControlDigest({ ...intent, language: 'ja"; DROP' })).toThrow();
    const proposal = { ...f.basis, title: 'same bytes', predecessor: null };
    expect(workProtectionDigest('work-title-correction-v1', { ...proposal, language: 'zh-hant' }))
      .toBe(workProtectionDigest('work-title-correction-v1', { ...proposal, language: 'zh-Hant' }));
    expect(workProtectionDigest('work-title-correction-v1', { ...proposal, language: 'ja' }))
      .not.toBe(workProtectionDigest('work-title-correction-v1', { ...proposal, language: 'zh-Hant' }));
  } finally { f.cleanup(); }
});

for (const [submitted, language] of [['zh-hant', 'zh-Hant'], ['ja-jp', 'ja-JP']] as const) {
  test(`G-512 Space creation canonicalizes ${submitted} before its digest, manifest and label`, async () => {
    const f = fixture();
    try {
      const input = { name: '読者の会', language: submitted, actingSubject: actor };
      const digest = spaceCreationDigest(input);
      expect(digest).toBe(spaceCreationDigest({ ...input, language }));
      const admitted = f.admitted('space.create', digest, 'space:create:root');
      const receipt = await createRealmSpace(f.env, admitted, input);
      const command = f.fuseki.commands[0]!;
      expect(command.update).toContain(`rdfs:label "読者の会"@${language}`);
      expect(manifest(command, receipt.space!, f.directory, SPACE_REALM_PROFILE).state.language).toBe(language);
      expect(await createRealmSpace(f.env, admitted, { ...input, language })).toEqual(receipt);
      expect(f.fuseki.commands).toHaveLength(1);
    } finally { f.cleanup(); }
  });
}

test('G-512 Arabic Space creation retains its immutable language and API read direction', async () => {
  const f = fixture();
  try {
    const input = { name: 'مجتمع القراء', language: 'ar', actingSubject: actor };
    const receipt = await createRealmSpace(f.env, f.admitted('space.create', spaceCreationDigest(input), 'space:create:root'), input);
    const command = f.fuseki.commands[0]!;
    expect(command.update).toContain(`rdfs:label "مجتمع القراء"@ar`);
    expect(manifest(command, receipt.space!, f.directory, SPACE_REALM_PROFILE).state.language).toBe('ar');
    f.fuseki.name = { value: input.name, language: 'ar' };
    const app = new Elysia().use(spaceRoutes(f.fuseki, { environment: f.env, account: f.account, access: f.access } as MainWorkDependencies));
    const response = await app.handle(new Request(`http://localhost/v1/spaces/${receipt.space!.slice(ID.length)}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: input.name, language: 'ar', direction: 'rtl' });
  } finally { f.cleanup(); }
});

function retainedPool(envelope: MainCloudEvent): Pool {
  const body = JSON.stringify(envelope), data = envelope.data;
  const client = { release() {}, async query(sql: string) {
    if (sql.includes('FROM relay.checkpoint')) return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'epoch', sequence: '1' }] };
    if (sql.includes('UNION ALL')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM relay.delivered_batch AS batch')) return { rows: [{ sequence: '1', batch_id: data.batchId,
      routing_epoch: data.routingEpoch, event_count: 1, actual_count: '1' }] };
    if (sql.includes('FROM relay.delivered_event AS event')) return { rows: [{ source: envelope.source,
      event_id: envelope.id, sequence: '1', body }] };
    return { rows: [] };
  } };
  return { connect: async () => client } as unknown as Pool;
}

for (const [language, returning] of [['ja', false], ['zh-Hant', false], ['en', false], ['zh-hant', true]] as const) {
  test(`G-512 held restore replays ${language} ${returning ? 'return' : 'edit'} manifests, including legacy English v1`, async () => {
    const f = fixture(language);
    try {
      const intent: TitleControlIntent = { ...f.title, ...(language === 'en' || returning ? {} : { language }),
        ...(returning ? { action: 'work.title.return', title: '元の名前', source: { binding: ids[4]!, record: ids[5]!,
          observation: ids[6]!, conversion: ids[7]!, proposal: ids[8]!, initialHead: head, mapping: 'open-library-work-map-v1' } } : {}) };
      const input = { ...intent, actingSubject: actor, idempotencyKey: 'g-512' };
      const effect = await changeTitleControl(f.env, f.account, f.access, request, input);
      effect.replayed = true;
      if (language === 'en') {
        effect.controlManifest = `urn:rezics:sha256:${prepareComponent(f.directory, work,
          { intent, control: effect.control, revision: effect.revision, operation: effect.operation }, TITLE_PROFILE_V1)}`;
      }
      const event = `urn:rezics:event:${hash(effect.receipt)}`;
      const envelope: MainCloudEvent = { specversion: '1.0', source: 'https://rezics.com/services/main',
        type: 'com.rezics.work.title-control.v1', id: event, datacontenttype: 'application/json',
        data: { batchId: `urn:rezics:outbox:${hash(effect.receipt)}`, sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' },
          routingEpoch: '1', ordinal: 0, receipt: { id: effect.receipt, action: effect.action, outcome: 'succeeded', admissionId: effect.admissionId,
            requestDigest: effect.requestDigest, authorityEpoch: effect.authorityEpoch, scope: effect.scope, titleControl: effect } } };
      const relay = retainedPool(envelope), coverage = await relayCoverage(relay, 'g-512');
      const client = { release() {}, async query(sql: string) {
        if (sql.includes('recovery_fence')) return { rows: [{ open: false }] };
        if (sql.includes('FROM access.admission')) return { rows: [{ action: effect.action, scope_id: effect.scope,
          state: 'sealed', request_digest: effect.requestDigest, authority_epoch: effect.authorityEpoch,
          graph_receipt: effect.receipt, graph_outcome: 'succeeded', graph_data_epoch: 'epoch', graph_sequence: '1',
          principal_id: 'principal', acting_subject: actor, idempotency_key: 'g-512' }] };
        return { rows: [] };
      } };
      const access = { connect: async () => client } as unknown as Pool;
      f.fuseki.receipts.clear(); f.env.lineage = { dataEpoch: 'restored', routingEpoch: '2' };
      const result = await reconcileRetainedTitleControl(f.env, access, relay, coverage, '1');
      expect(result.replayed).toBe(false);
      const recovered = f.fuseki.commands.at(-1)!;
      if (returning) {
        expect(recovered.update.split('INSERT')[1]!.split('WHERE')[0]).not.toContain('rdfs:label');
        expect(recovered.update).toContain('rv:controlLanguage "zh-Hant"');
      } else expect(recovered.update).toContain(`rdfs:label "新しい名前"@${language}`);
      expect(recovered.update).toContain('rv:restoreHold true');
      expect(recovered.validations.at(-1)!.profile).toBe(language === 'en' ? 'work-title-control-v1' : 'work-title-control-v2');
      expect((await reconcileRetainedTitleControl(f.env, access, relay, coverage, '1')).replayed).toBe(true);
      if (language !== 'en') {
        const count = f.fuseki.commands.length;
        effect.controlManifest = `urn:rezics:sha256:${prepareComponent(f.directory, work,
          { intent, language: 'en', control: effect.control, revision: effect.revision, operation: effect.operation }, TITLE_PROFILE)}`;
        const corruptRelay = retainedPool(envelope), corruptCoverage = await relayCoverage(corruptRelay, 'g-512');
        await expect(reconcileRetainedTitleControl(f.env, access, corruptRelay, corruptCoverage, '1')).rejects.toThrow('immutable title content differs');
        expect(f.fuseki.commands).toHaveLength(count);
      }
    } finally { f.cleanup(); }
  });
}

test('G-512 every claimed restore writer uses the retained Work payload language', () => {
  const workRecovery = readFileSync(resolve(root, 'services/main/src/modules/work/reconcile-restored.ts'), 'utf8');
  expect(workRecovery).not.toContain('${lit(payload.title)}@en');
  expect(workRecovery).not.toContain('${lit(spaceState.name)}@en');
  const protectionRecovery = readFileSync(resolve(root, 'services/main/src/modules/protection/reconcile-restored.ts'), 'utf8');
  expect(protectionRecovery).not.toContain('${lit(intent.title!)}@en');
  for (const file of ['work-contents/read.ts', 'continue/chapters.ts']) {
    expect(readFileSync(resolve(root, `services/main/src/modules/${file}`), 'utf8')).not.toMatch(/untitled chapter|未命名章节/u);
  }
});

function accessFor(envelope: MainCloudEvent): Pool {
  const effect = envelope.data.receipt;
  const client = { release() {}, async query(sql: string) {
    if (sql.includes('recovery_fence')) return { rows: [{ open: false }] };
    if (sql.includes('FROM access.admission')) return { rows: [{ action: effect.action, scope_id: effect.scope,
      state: 'sealed', request_digest: effect.requestDigest, authority_epoch: effect.authorityEpoch,
      graph_receipt: effect.id, graph_outcome: 'succeeded', graph_data_epoch: 'epoch', graph_sequence: '1',
      acting_subject: actor }] };
    return { rows: [] };
  } };
  return { connect: async () => client } as unknown as Pool;
}

for (const language of ['ja', 'zh-Hant']) {
  test(`G-512 create restore keeps ${language} from the immutable Work manifest`, async () => {
    const f = fixture(language);
    try {
      const created = await activateMetadataWork(f.env, { title: '作品', language,
        admission: f.admitted('work.create', metadataWorkRequestDigest('作品', undefined, language), 'work:create:root') });
      const command = f.fuseki.commands[0]!;
      const operation = object(command.update, 'operation')!;
      const envelope: MainCloudEvent = { specversion: '1.0', source: 'https://rezics.com/services/main',
        type: 'com.rezics.work.created.v1', id: `urn:rezics:event:${hash(operation)}`, datacontenttype: 'application/json',
        data: { batchId: `urn:rezics:outbox:${hash(created.receipt)}`, sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' },
          routingEpoch: '1', ordinal: 0, receipt: { id: created.receipt, action: 'work.create', outcome: 'succeeded',
            admissionId: created.admissionId, requestDigest: command.digest, authorityEpoch: '1', scope: 'work:create:root', operation,
            work: created.work, workRevision: created.workRevision, mainVersion: created.mainVersion, mainRevision: created.mainRevision,
            workManifest: manifest(command, created.work, f.directory).manifest,
            mainManifest: manifest(command, created.mainVersion, f.directory).manifest } } };
      const relay = retainedPool(envelope), coverage = await relayCoverage(relay, 'g-512');
      f.fuseki.receipts.clear(); f.env.lineage = { dataEpoch: 'restored', routingEpoch: '2' };
      await reconcileRetainedWorkCreate(f.env, accessFor(envelope), relay, coverage, '1');
      expect(f.fuseki.commands.at(-1)!.update).toContain(`rdfs:label "作品"@${language}`);
    } finally { f.cleanup(); }
  });
}

test('G-512 Space and protected correction HTTP commands accept languages outside the UI catalogs', async () => {
  const f = fixture('ja');
  try {
    const dependencies = { environment: f.env, account: f.account, access: f.access, protectionSigner: f.signer } as MainWorkDependencies;
    const app = new Elysia().use(spaceRoutes(f.fuseki, dependencies)).use(protectionRoutes(dependencies));
    const post = (path: string, body: unknown) => app.handle(new Request(`http://localhost${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'g-512' }, body: JSON.stringify(body),
    }));
    const space = await post('/v1/spaces', { profile: 'space-realm-v2', name: 'مجتمع القراء', language: 'ar', capabilities: ['realm'], actingSubject: actor });
    expect(space.status).toBe(201);
    const created = await space.json() as { space: string; realm: string; spaceRevision: string; realmRevision: string };
    const command = f.fuseki.commands[0]!, operation = object(command.update, 'operation')!;
    const envelope: MainCloudEvent = { specversion: '1.0', source: 'https://rezics.com/services/main',
      type: 'com.rezics.space.created.v1', id: `urn:rezics:event:${hash(operation)}`, datacontenttype: 'application/json',
      data: { batchId: `urn:rezics:outbox:${hash(command.receipt)}`, sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' },
        routingEpoch: '1', ordinal: 0, receipt: { id: command.receipt, action: 'space.create', outcome: 'succeeded',
          admissionId: '00000000-0000-4000-8000-000000000010', requestDigest: command.digest, authorityEpoch: '1', scope: 'space:create:root',
          operation, ...created, owner: actor, spaceManifest: manifest(command, created.space, f.directory, SPACE_REALM_PROFILE).manifest,
          realmManifest: manifest(command, created.realm, f.directory, SPACE_REALM_PROFILE).manifest } } };
    const relay = retainedPool(envelope), coverage = await relayCoverage(relay, 'g-512');
    f.fuseki.receipts.clear(); f.env.lineage = { dataEpoch: 'restored', routingEpoch: '2' };
    await reconcileRetainedRealmSpaceCreate(f.env, accessFor(envelope), relay, coverage, '1');
    expect(f.fuseki.commands.at(-1)!.update).toContain('rdfs:label "مجتمع القراء"@ar');
    f.fuseki.receipts.clear(); f.env.lineage = { dataEpoch: 'epoch', routingEpoch: '1' };
    const { idempotencyKey: _key, ...basis } = f.basis;
    const correction = await post('/v1/work-title-corrections', { profile: 'work-title-correction-v1', ...basis,
      title: '新的名稱', language: 'zh-Hant', predecessor: null });
    expect(correction.status).toBe(201);
    expect(manifest(f.fuseki.commands.at(-1)!, work, f.directory).state.language).toBe('zh-Hant');
    f.fuseki.receipts.clear();
    const writes = f.fuseki.commands.length;
    const invalid = await post('/v1/work-title-corrections', { profile: 'work-title-correction-v1', ...basis,
      title: '新的名稱', language: 'zh--Hant', predecessor: null });
    expect(invalid.status).toBe(422);
    const malformed = await post('/v1/work-title-corrections', { profile: 'work-title-correction-v1', ...basis,
      title: '新的名稱', language: 'ja-12', predecessor: null });
    // The shared language schema rejects malformed RFC 5646 syntax before dispatch.
    expect(malformed.status).toBe(422);
    expect(f.fuseki.commands).toHaveLength(writes);
  } finally { f.cleanup(); }
});

test('G-512 legacy English activation receipts remain replayable without permitting a fresh English default', async () => {
  const f = fixture();
  try {
    const legacy = f.admitted('work.create', metadataWorkRequestDigest('Legacy', undefined, 'en'), 'work:create:root');
    const created = await activateMetadataWork(f.env, { title: 'Legacy', language: 'en', admission: legacy });
    const count = f.fuseki.commands.length;
    expect(await activateMetadataWork(f.env, { title: 'Legacy', admission: legacy })).toEqual({ ...created, replayed: true });
    expect(f.fuseki.commands).toHaveLength(count);
    f.fuseki.receipts.clear();
    await expect(activateMetadataWork(f.env, { title: 'Legacy', admission: legacy })).rejects.toThrow('admission digest');
    expect(f.fuseki.commands).toHaveLength(count);
  } finally { f.cleanup(); }
});

for (const language of ['ja', 'zh-Hant', undefined]) {
  test(`G-512 reviewed correction restore preserves ${language ?? 'omitted head language'}`, async () => {
    const f = fixture('ja');
    try {
      const action = 'work.correction.review', admissionId = '00000000-0000-4000-8000-000000000010';
      const input = { ...f.basis, proposalRevision: ids[4]!, candidateDigest: 'a'.repeat(64),
        expectedDecisionHead: null, outcome: 'approved' as const };
      const operation = ID + admissionId, receipt = protectionReceiptIri(admissionId, action);
      const decision = `urn:rezics:correction-decision:${hash(input.proposalRevision)}`, control = ids[5]!, revision = ids[6]!;
      const intent = { ...input, action, title: '訂正した名前', titleLanguage: language ?? 'ja', decision, control, operation };
      const batch = `urn:rezics:outbox:${hash(receipt)}`, event = `urn:rezics:event:${hash(receipt)}`;
      const triples: RecoveryTriple[] = [];
      const add = (graph: string, subject: string, predicate: string, value: string) => triples.push({ graph, subject,
        predicate: RV + predicate, object: value.startsWith('urn:') || value.startsWith('https:') ? uri(value) : lit(value) });
      for (const subject of [decision, control]) {
        for (const [key, value] of Object.entries({ operation, dataEpoch: 'epoch', sequence: '1' })) add(GRAPHS.revisions, subject, key, value);
      }
      add(GRAPHS.revisions, decision, 'decisionIntent', JSON.stringify(intent));
      add(GRAPHS.revisions, control, 'modelRevision', TITLE_PROFILE);
      add(GRAPHS.revisions, control, 'controlLanguage', intent.titleLanguage);
      add(GRAPHS.revisions, control, 'controlField', 'title');
      for (const [key, value] of Object.entries({ action, admissionId, requestDigest: workProtectionDigest('work-title-correction-review-v1', input),
        authorityEpoch: '1', admittedScope: `work:review:${work}`, dataEpoch: 'epoch', sequence: '1', work, operation,
        outcome: RV + 'Succeeded', proposalRevision: input.proposalRevision, decision, reviewOutcome: RV + 'Accepted',
        workRevision: revision, titleControl: control })) add(GRAPHS.receipts, receipt, key, value);
      add(GRAPHS.outbox, batch, 'event', event); add(GRAPHS.outbox, event, 'receipt', receipt);
      const envelope = { specversion: '1.0', source: 'https://rezics.com/services/main',
        type: 'com.rezics.work.correction-reviewed.v1', id: event, datacontenttype: 'application/json',
        data: { batchId: batch, sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' }, routingEpoch: '1', ordinal: 0,
          recovery: triples, receipt: { id: receipt, action, outcome: 'succeeded', admissionId,
            requestDigest: workProtectionDigest('work-title-correction-review-v1', input), authorityEpoch: '1', scope: `work:review:${work}`, work, operation } } } as unknown as MainCloudEvent;
      const relay = retainedPool(envelope), coverage = await relayCoverage(relay, 'g-512');
      const access = accessFor(envelope);
      // The recovery verifier also binds the retained transport actor and key.
      const baseConnect = access.connect.bind(access);
      const recoveryAccess = { connect: async () => {
        const client = await baseConnect();
        const query = client.query.bind(client);
        return { release: () => client.release(), query: async (sql: string) => {
          const result = await query(sql);
          if (sql.includes('FROM access.admission')) result.rows[0].idempotency_key = 'g-512';
          return result;
        } };
      } } as unknown as Pool;
      f.env.lineage = { dataEpoch: 'restored', routingEpoch: '2' };
      await reconcileRetainedWorkProtection(f.env, recoveryAccess, relay, coverage, '1');
      expect(f.fuseki.commands.at(-1)!.update).toContain(`"訂正した名前"@${language ?? 'ja'}`);
      expect(f.fuseki.commands.at(-1)!.validations.some(value => value.profile === 'work-title-control-v2')).toBe(true);
    } finally { f.cleanup(); }
  });
}

test('G-512 source-confirm HTTP adapter carries explicit and omitted title language to its command owner', async () => {
  const f = fixture();
  try {
    let submitted: { language?: string } | undefined;
    const dependencies = { environment: f.env, account: f.account,
      access: { ...f.access, activePrincipalId: async () => '00000000-0000-4000-8000-000000000010' },
      sourceAdoptions: { applyTitle: async (_principal: string, _request: Request, _work: string, _proposal: string,
        input: { language?: string }) => { submitted = input; return null; } },
    } as unknown as MainWorkDependencies;
    const app = new Elysia().use(sourceSupportRoutes(f.fuseki, dependencies));
    for (const language of ['ja', 'zh-Hant', undefined]) {
      submitted = undefined;
      const response = await app.handle(new Request(`http://localhost/v1/works/${work.slice(ID.length)}/source-title-applications/${ids[4]!.slice(ID.length)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          profile: 'native-work-source-title-application-v1', expectedHead: head, actingSubject: actor,
          titleControl: f.title.basis, confirmedTitle: '新しい名前', ...(language ? { language } : {}),
        }),
      }));
      expect(response.status).toBe(404); // The stub has no proposal; validation must still reach the owner.
      expect(submitted).toBeDefined();
      expect(submitted!.language).toBe(language);
    }
  } finally { f.cleanup(); }
});

for (const language of ['ja', 'zh-Hant', undefined]) {
  test(`G-512 Work HTTP create and edit preserve ${language ?? 'omitted language'}`, async () => {
    const f = fixture('ja');
    try {
      const dependencies = { environment: f.env, account: f.account, access: f.access } as MainWorkDependencies;
      const app = new Elysia().use(workRoutes(f.fuseki, dependencies)).use(contentRoutes(f.fuseki, dependencies));
      const post = (path: string, body: unknown) => app.handle(new Request(`http://localhost${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'g-512' }, body: JSON.stringify(body),
      }));
      const created = await post('/v1/works', { profile: 'metadata-only-v1', authoring: 'own-work', title: '作品', actingSubject: actor,
        ...(language ? { language } : {}) });
      expect(created.status).toBe(201);
      expect(f.fuseki.commands.at(-1)!.update).toContain(`rdfs:label "作品"@${language ?? 'und'}`);
      f.fuseki.receipts.clear();
      const edited = await post('/v1/content-edits', { profile: 'metadata-only-v1', work, expectedHead: head,
        title: '新しい名前', titleControl: f.title.basis, actingSubject: actor, ...(language ? { language } : {}) });
      expect(edited.status).toBe(200);
      expect(f.fuseki.commands.at(-1)!.update).toContain(`rdfs:label "新しい名前"@${language ?? 'ja'}`);
      const count = f.fuseki.commands.length;
      const replayed = await post('/v1/content-edits', { profile: 'metadata-only-v1', work, expectedHead: head,
        title: '新しい名前', titleControl: f.title.basis, actingSubject: actor, ...(language ? { language } : {}) });
      expect(replayed.status).toBe(200);
      expect(await replayed.json()).toMatchObject({ replayed: true });
      expect(f.fuseki.commands).toHaveLength(count);
      const invalid = await post('/v1/works', { profile: 'metadata-only-v1', authoring: 'own-work', title: '作品', actingSubject: actor, language: 'ja-12' });
      expect(invalid.status).toBe(400);
      expect(f.fuseki.commands).toHaveLength(count);
    } finally { f.cleanup(); }
  });
}

for (const language of ['ja', 'zh-Hant']) {
  test(`G-512 source attachment confirms and replays the retained ${language} Work language`, async () => {
    const f = fixture(language);
    try {
      const principalId = '00000000-0000-4000-8000-000000000010';
      const binding = ids[5]!, proposal = ids[6]!, record = ids[7]!;
      const row = { id: ids[8]!.slice(ID.length), binding_id: binding.slice(ID.length), proposal_id: proposal.slice(ID.length),
        record_id: record.slice(ID.length), principal_id: principalId, work, work_revision: head, title: '元の名前',
        acting_subject: actor, idempotency_key: 'g-512', created_at: new Date('2026-09-30T00:00:00Z'),
        authority_proof: { principalId, actingSubject: actor, scope: `work:edit:${work}`, action: 'work.edit',
          grantId: principalId, representationId: principalId } };
      const pool = { query: async () => ({ rows: [row] }) } as unknown as Pool;
      const proposals = { read: async () => ({ proposal, record, candidateTitle: row.title, observation: ids[4]!,
        conversion: ids[9]!, graphReceipt: 'urn:rezics:receipt:source', rightsEvidence: [] }) } as unknown as ConstructorParameters<typeof SourceNativeWorkAttachmentStore>[1];
      const adoptions = { readSupport: async () => ({ binding, currentHead: head }) } as unknown as ConstructorParameters<typeof SourceNativeWorkAttachmentStore>[2];
      const access = {} as ConstructorParameters<typeof SourceNativeWorkAttachmentStore>[4];
      const store = new SourceNativeWorkAttachmentStore(pool, proposals, adoptions, f.env, access);
      const principal = {} as Parameters<typeof store.attach>[0];
      const input = { proposal, expectedHead: head, confirmedTitle: row.title, titleLanguage: language, actingSubject: actor };
      const replayed = await store.attach(principal, principalId, work, 'g-512', input);
      expect(replayed?.replayed).toBe(true);
      expect(replayed?.attachment.titleLanguage).toBe(language);
      await expect(store.attach(principal, principalId, work, 'g-512', { ...input, titleLanguage: 'en' }))
        .rejects.toThrow('source attachment language changed');
      expect(f.fuseki.commands).toHaveLength(0);
    } finally { f.cleanup(); }
  });
}
