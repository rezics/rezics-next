// Staged C6 private original-source probe. It belongs at tests/qa/integration/
// private-original-source.test.ts (relative imports below assume that place) and
// runs only inside the isolated QA integration tier. Nothing here changes production.
//
// Selected private head after an edit is the EDIT head. Each selected head needs its
// own exact immutable CREATE or EDIT revision source; the initial creator comes from
// the original CREATE receipt, never from the current actor or draft head.
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync }
  from 'node:fs';
import { join, resolve } from 'node:path';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { activateTextContribution, textContributionDigest, textContributionReceiptIri }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { editTextContributionDraft, textContributionEditDigest, textContributionEditReceiptIri }
  from '../../../services/main/src/modules/contribution/edit.ts';
import { readExactContributionDraft, readOriginalContributionCreateSource }
  from '../../../services/main/src/modules/contribution/history.ts';
import { PRIVATE_SEARCH_GRAPH, privateDraftUnit }
  from '../../../services/main/src/modules/contribution/private-projection.ts';
import { activateMetadataWork, GRAPHS, ID, metadataWorkRequestDigest, RV,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { RevisionCorrupt, RevisionNotFound, RevisionUnavailable }
  from '../../../services/main/src/modules/work/history.ts';

const root = resolve(import.meta.dir, '../../..');
const allow = async () => true;

function requireStack(): void {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
}

async function fixture() {
  requireStack();
  const directory = join(root, '.temp', `private-original-source-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env: WorkActivationEnvironment = {
    fuseki: new FusekiClient(Bun.env.FUSEKI_URL!),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
    objectDirectory: join(directory, 'objects'),
  };
  const creator = ID + randomUUID();
  const editor = ID + randomUUID();
  const admission = (actor: string, scope: string, action: string,
    requestDigest: string): RegisteredAdmission => {
    const id = randomUUID();
    return { id, principalId: randomUUID(), actingSubject: actor, scope, action,
      idempotencyKey: `private-original-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'claimed',
      dispatchEligible: true, replayed: false };
  };
  const title = `Private original source ${randomUUID()}`;
  const created = await activateMetadataWork(env, { title,
    admission: admission(creator, 'work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
  const firstTerm = `origin${randomUUID().replaceAll('-', '')}`;
  const secondTerm = `edited${randomUUID().replaceAll('-', '')}`;
  const firstInput = { work: created.work, language: 'en-us',
    body: `Original ${firstTerm} café 日本語 🙂 body`, actingSubject: creator };
  const createAdmission = admission(creator, `contribution:create:${created.work}`,
    'contribution.create', textContributionDigest(firstInput));
  const first = await activateTextContribution(env, createAdmission, firstInput);
  if (!first.contribution || !first.draftRevision) throw new Error('create receipt is incomplete');
  const editInput = { contribution: first.contribution, expectedHead: first.draftRevision,
    body: `Edited ${secondTerm} 编辑 body`, actingSubject: editor };
  const editAdmission = admission(editor, `contribution:edit:${first.contribution}`,
    'contribution.edit', textContributionEditDigest(editInput));
  const edited = await editTextContributionDraft(env, editAdmission, editInput);
  if (!edited.draftRevision) throw new Error('edit receipt is incomplete');
  return { env, directory, creator, editor, firstInput, createAdmission, first, editInput,
    editAdmission, edited, contribution: first.contribution!, firstTerm, secondTerm,
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

async function graphSnapshot(env: WorkActivationEnvironment, contribution: string) {
  const rows = async (query: string) => (await env.fuseki.query(query)).results?.bindings ?? [];
  const sequence = await rows(`SELECT ?n WHERE { GRAPH <${GRAPHS.control}> {
    <urn:rezics:dataset:product> <${RV}sequence> ?n } }`);
  const receipts = await rows(`SELECT ?s ?p ?o WHERE { GRAPH <${GRAPHS.receipts}> { ?s ?p ?o .
    ?s <${RV}contribution> <${contribution}> } } ORDER BY ?s ?p ?o`);
  const revisions = await rows(`SELECT ?s ?p ?o WHERE { GRAPH <${GRAPHS.revisions}> { ?s ?p ?o .
    ?s <${RV}component> <${contribution}> } } ORDER BY ?s ?p ?o`);
  const current = await rows(`SELECT ?p ?o WHERE { GRAPH <${GRAPHS.current}> {
    <${contribution}> ?p ?o } } ORDER BY ?p ?o`);
  const priv = await rows(`SELECT ?s ?p ?o WHERE { GRAPH <${PRIVATE_SEARCH_GRAPH}> { ?s ?p ?o .
    ?s <${RV}contribution> <${contribution}> } } ORDER BY ?s ?p ?o`);
  return JSON.stringify({ sequence, receipts, revisions, current, priv });
}

function objectFiles(env: WorkActivationEnvironment): Record<string, string> {
  return Object.fromEntries(readdirSync(env.objectDirectory).filter(name => /^[0-9a-f]{64}$/.test(name))
    .map(name => [name, createHash('sha256').update(readFileSync(join(env.objectDirectory, name))).digest('hex')]));
}

async function manifestOf(env: WorkActivationEnvironment, revision: string): Promise<string> {
  const rows = (await env.fuseki.query(`SELECT ?m WHERE { GRAPH <${GRAPHS.revisions}> {
    <${revision}> <${RV}manifest> ?m } }`)).results?.bindings ?? [];
  expect(rows).toHaveLength(1);
  return rows[0]!.m!.value.slice(-64);
}

test('private original source: create then edit keeps the original CREATE source and selects the exact EDIT head', async () => {
  const f = await fixture();
  try {
    const { env, contribution } = f;
    // Original CREATE: actor, bytes, digest, source position come from the CREATE receipt and its
    // immutable bytes, unchanged by the later edit and by a different editing actor.
    const create = await readOriginalContributionCreateSource(env, contribution, allow);
    expect(create).toMatchObject({ contribution, revision: f.first.draftRevision, work: f.firstInput.work,
      author: f.creator, language: 'en-us', body: f.firstInput.body,
      requestDigest: textContributionDigest(f.firstInput), admissionId: f.createAdmission.id,
      scope: f.createAdmission.scope, receipt: textContributionReceiptIri(f.createAdmission.id),
      sourcePosition: { datasetId: 'product', dataEpoch: f.first.dataEpoch, sequence: f.first.sequence } });
    expect(create.author).not.toBe(f.editor);
    expect(create.predecessor).toBeUndefined();

    // Selected EDIT head: exact immutable edit bytes, the ORIGINAL author, the edit position.
    const head = await readExactContributionDraft(env, contribution, f.edited.draftRevision!, allow);
    expect(head).toMatchObject({ contribution, revision: f.edited.draftRevision, work: f.firstInput.work,
      author: f.creator, language: 'en-us', body: f.editInput.body, predecessor: f.first.draftRevision,
      sourcePosition: { datasetId: 'product', dataEpoch: f.edited.dataEpoch, sequence: f.edited.sequence } });
    expect(f.edited.author).toBe(f.creator);
    expect(f.edited.requestDigest).toBe(textContributionEditDigest(f.editInput));
    // The create source after the edit is byte-for-byte the pre-edit source.
    expect(await readOriginalContributionCreateSource(env, contribution, allow)).toEqual(create);

    // Private search shows the selected current head, never the original CREATE body.
    const posting = async (unit: string, term: string) => (await env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX text: <http://jena.apache.org/text#>
      SELECT ?literal WHERE { GRAPH <${PRIVATE_SEARCH_GRAPH}> {
        (<${unit}> ?score ?literal ?graph ?predicate) text:query (rv:privateSearchBody ${JSON.stringify(term)} 2) } }`))
      .results?.bindings ?? [];
    const current = await posting(privateDraftUnit(f.edited.draftRevision!), f.secondTerm);
    expect(current).toHaveLength(1);
    // Jena canonicalises the language tag's region case (en-us is stored and returned as en-US).
    expect(current[0]!.literal!.value).toBe(f.editInput.body);
    expect(current[0]!.literal!['xml:lang']!.toLowerCase()).toBe('en-us');
    expect(await posting(privateDraftUnit(f.first.draftRevision!), f.firstTerm)).toEqual([]);

    // Erasure precondition for the exact admitted unit (Trust C6 owns erasure itself): exactly one
    // private unit for this contribution, naming only the selected head, and an unrelated
    // contribution's unit is a different subject.
    const units = (await env.fuseki.query(`SELECT ?u ?r WHERE { GRAPH <${PRIVATE_SEARCH_GRAPH}> {
      ?u <${RV}contribution> <${contribution}> ; <${RV}revision> ?r } }`)).results?.bindings ?? [];
    expect(units.map(row => [row.u!.value, row.r!.value])).toEqual(
      [[privateDraftUnit(f.edited.draftRevision!), f.edited.draftRevision]]);
  } finally { f.cleanup(); }
}, 120_000);

test('private original source: lost-ACK replay of CREATE and EDIT is read-only', async () => {
  const f = await fixture();
  try {
    const { env } = f;
    const graph = await graphSnapshot(env, f.contribution);
    const objects = objectFiles(env);
    const create = await activateTextContribution(env, f.createAdmission, f.firstInput);
    const edit = await editTextContributionDraft(env, f.editAdmission, f.editInput);
    expect(create).toEqual(f.first);
    expect(edit).toEqual(f.edited);
    expect(await graphSnapshot(env, f.contribution)).toBe(graph);
    expect(objectFiles(env)).toEqual(objects);
  } finally { f.cleanup(); }
}, 120_000);

test('private original source: corrupt or missing selected immutable bytes are refused per head', async () => {
  const f = await fixture();
  try {
    const { env, contribution } = f;
    const editManifest = await manifestOf(env, f.edited.draftRevision!);
    const createManifest = await manifestOf(env, f.first.draftRevision!);
    const payloadOf = (manifest: string) => JSON.parse(readFileSync(join(env.objectDirectory, manifest), 'utf8'))
      .payload.slice(7) as string;
    const editPayload = payloadOf(editManifest);
    const createPayload = payloadOf(createManifest);
    const withDamaged = async (object: string, damage: 'corrupt' | 'missing', run: () => Promise<void>) => {
      const path = join(env.objectDirectory, object);
      const original = readFileSync(path);
      const moved = `${path}.held`;
      try {
        if (damage === 'missing') renameSync(path, moved);
        else writeFileSync(path, Buffer.concat([original.subarray(0, original.length - 1), Buffer.from('X')]));
        await run();
      } finally {
        if (damage === 'missing') renameSync(moved, path); else writeFileSync(path, original);
      }
    };
    const before = objectFiles(env);
    for (const object of [editManifest, editPayload]) {
      await withDamaged(object, 'corrupt', async () => {
        await expect(readExactContributionDraft(env, contribution, f.edited.draftRevision!, allow))
          .rejects.toBeInstanceOf(RevisionCorrupt);
        // The CREATE source is an independent immutable object pair.
        expect((await readOriginalContributionCreateSource(env, contribution, allow)).body).toBe(f.firstInput.body);
      });
      await withDamaged(object, 'missing', async () => {
        await expect(readExactContributionDraft(env, contribution, f.edited.draftRevision!, allow))
          .rejects.toBeInstanceOf(RevisionUnavailable);
      });
    }
    for (const object of [createManifest, createPayload]) {
      await withDamaged(object, 'corrupt', async () => {
        await expect(readOriginalContributionCreateSource(env, contribution, allow))
          .rejects.toBeInstanceOf(RevisionCorrupt);
        expect((await readExactContributionDraft(env, contribution, f.edited.draftRevision!, allow)).body)
          .toBe(f.editInput.body);
      });
      await withDamaged(object, 'missing', async () => {
        await expect(readOriginalContributionCreateSource(env, contribution, allow))
          .rejects.toBeInstanceOf(RevisionUnavailable);
      });
    }
    expect(objectFiles(env)).toEqual(before);
    await expect(readExactContributionDraft(env, contribution, ID + randomUUID(), allow))
      .rejects.toBeInstanceOf(RevisionNotFound);
  } finally { f.cleanup(); }
}, 120_000);

// ---- Falsifiers: these are expected to FAIL until the named production hooks exist. ----

test('FALSIFIER missing hook: an original EDIT source reader reconciles the edit receipt with its immutable bytes', async () => {
  const history = await import('../../../services/main/src/modules/contribution/history.ts') as Record<string, unknown>;
  // history.ts exports readOriginalContributionCreateSource only. A selected EDIT head is read by
  // readExactContributionDraft (anchor + payload + current identity), which never consults the edit
  // receipt textContributionEditReceiptIri(admissionId) (digest, admission, author, language, expectedHead,
  // source position). The edit actor is not in the receipt: it must be proved against the Access
  // admission (acting_subject) by recomputing textContributionEditDigest; no admission-by-id read exists.
  expect(typeof history.readOriginalContributionEditSource).toBe('function');
});

test('FALSIFIER: a selected EDIT head whose edit receipt is gone or digest-forged is refused', async () => {
  const f = await fixture();
  try {
    const { env, contribution } = f;
    const receipt = textContributionEditReceiptIri(f.editAdmission.id);
    // Raw topology is the same writer the fault fixtures use; no production caller is changed.
    await env.fuseki.update(`DELETE { GRAPH <${GRAPHS.receipts}> { <${receipt}> <${RV}requestDigest> ?d } }
      INSERT { GRAPH <${GRAPHS.receipts}> { <${receipt}> <${RV}requestDigest> "${'0'.repeat(64)}" } }
      WHERE { GRAPH <${GRAPHS.receipts}> { <${receipt}> <${RV}requestDigest> ?d } }`);
    await expect(readExactContributionDraft(env, contribution, f.edited.draftRevision!, allow))
      .rejects.toBeInstanceOf(RevisionCorrupt);
    await env.fuseki.update(`DELETE WHERE { GRAPH <${GRAPHS.receipts}> { <${receipt}> ?p ?o } }`);
    await expect(readExactContributionDraft(env, contribution, f.edited.draftRevision!, allow))
      .rejects.toBeInstanceOf(RevisionCorrupt);
  } finally { f.cleanup(); }
}, 120_000);

test('FALSIFIER: a selected CREATE head whose create receipt is gone is refused by the head reader', async () => {
  requireStack();
  const directory = join(root, '.temp', `private-original-source-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env: WorkActivationEnvironment = {
    fuseki: new FusekiClient(Bun.env.FUSEKI_URL!),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
    objectDirectory: join(directory, 'objects') };
  try {
    const actor = ID + randomUUID();
    const admission = (scope: string, action: string, requestDigest: string): RegisteredAdmission => {
      const id = randomUUID();
      return { id, principalId: randomUUID(), actingSubject: actor, scope, action,
        idempotencyKey: `private-original-${id}`, requestDigest, authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'claimed',
        dispatchEligible: true, replayed: false };
    };
    const title = `Private create head ${randomUUID()}`;
    const work = await activateMetadataWork(env, { title,
      admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
    const input = { work: work.work, language: 'en', body: `Head ${randomUUID()} body`, actingSubject: actor };
    const create = admission(`contribution:create:${work.work}`, 'contribution.create', textContributionDigest(input));
    const first = await activateTextContribution(env, create, input);
    await env.fuseki.update(`DELETE WHERE { GRAPH <${GRAPHS.receipts}> {
      <${textContributionReceiptIri(create.id)}> ?p ?o } }`);
    await expect(readOriginalContributionCreateSource(env, first.contribution!, allow))
      .rejects.toBeInstanceOf(RevisionNotFound);
    // Private search (search-private.ts) selects the head through readExactContributionDraft; with the
    // original CREATE receipt gone it must not keep treating the head as authentic.
    await expect(readExactContributionDraft(env, first.contribution!, first.draftRevision!, allow))
      .rejects.toBeInstanceOf(RevisionCorrupt);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
