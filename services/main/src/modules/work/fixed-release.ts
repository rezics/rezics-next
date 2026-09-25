import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { readExactContributionDraft } from '../contribution/history.ts';
import { PUBLICATION_PROFILE } from '../contribution/publish.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  prepareWorkComponent, IdempotencyConflict, type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { readComponentState, readWorkComponentState, RevisionCorrupt,
  RevisionNotFound, RevisionUnavailable } from './history.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';

const PROFILE = 'https://rezics.com/definition/fixed-native-text-release-v1';
const SHAPE = `${PROFILE}/release-shape`;
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export class InvalidFixedRelease extends Error {}
export class FixedReleaseUnavailable extends Error {}
export class FixedReleaseStale extends Error {}

export interface FixedReleaseInput {
  work: string;
  mainVersion: string;
  expectedMainRevision: string;
  expectedSelection: string;
  actingSubject: string;
  idempotencyKey: string;
}

export interface FixedRelease {
  release: string;
  work: string;
  mainVersion: string;
  mainRevision: string;
  selection: string;
  contribution: string;
  publicationDecision: string;
  selectedDraft: string;
  language: string;
  bodyDigest: string;
  body: string;
  sealedBy: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

interface Terminal {
  outcome: 'succeeded' | 'cancelled';
  release: string | null;
  receipt: string;
  admissionId: string;
  requestDigest: string;
  scope: string;
  authorityEpoch: string;
  dataEpoch: string;
  sequence: string;
}

export function fixedReleaseDigest(input: FixedReleaseInput): string {
  if (![input.work, input.mainVersion, input.expectedMainRevision,
    input.expectedSelection, input.actingSubject].every(value => nativeId.test(value))
    || !/^[A-Za-z0-9:_./-]{1,128}$/.test(input.idempotencyKey)) {
    throw new InvalidFixedRelease('invalid fixed release intent');
  }
  return hash(JSON.stringify({ family: 'fixed-native-text-release-v1',
    work: input.work, mainVersion: input.mainVersion,
    expectedMainRevision: input.expectedMainRevision,
    expectedSelection: input.expectedSelection,
    actingSubject: input.actingSubject, idempotencyKey: input.idempotencyKey }));
}

export function fixedReleaseReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0fixed-native-text-release-v1`)}`;
}

export async function readFixedReleaseTerminal(
  env: WorkActivationEnvironment, admissionId: string): Promise<Terminal | null> {
  const receipt = fixedReleaseReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?release ?digest ?admission ?scope ?authorityEpoch ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?admission ; rv:admittedScope ?scope ;
        rv:authorityEpoch ?authorityEpoch ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:fixedRelease ?release }
    }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const outcome = row.outcome?.value === `${RV}Succeeded` ? 'succeeded'
    : row.outcome?.value === `${RV}Cancelled` ? 'cancelled' : null;
  if (rows.length !== 1 || !outcome || !row.digest || !row.admission || !row.scope
    || !row.authorityEpoch || !row.epoch || !/^[0-9]+$/.test(row.sequence?.value ?? '')
    || (outcome === 'succeeded') !== !!row.release) {
    throw new RevisionCorrupt('fixed release receipt is incomplete');
  }
  return { outcome, release: row.release?.value ?? null, receipt,
    admissionId: row.admission.value, requestDigest: row.digest.value,
    scope: row.scope.value, authorityEpoch: row.authorityEpoch.value,
    dataEpoch: row.epoch.value, sequence: row.sequence!.value };
}

function matches(terminal: Terminal, admission: RegisteredAdmission, digest: string): boolean {
  return terminal.admissionId === admission.id && terminal.requestDigest === digest
    && terminal.scope === admission.scope && terminal.authorityEpoch === admission.authorityEpoch;
}

async function sealCancelled(env: WorkActivationEnvironment, admission: RegisteredAdmission): Promise<void> {
  const receipt = fixedReleaseReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0cancel`)}`;
  await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 . }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` });
}

export async function sealFixedReleaseAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<Terminal> {
  if (admission.action !== 'release.seal') throw new Error('unsupported release admission');
  if (!await readFixedReleaseTerminal(env, admission.id)) await sealCancelled(env, admission);
  const terminal = await readFixedReleaseTerminal(env, admission.id);
  if (!terminal || !matches(terminal, admission, admission.requestDigest)) {
    throw new Error('fixed release cancellation outcome is unavailable');
  }
  return terminal;
}

interface Candidate {
  contribution: string;
  publicationDecision: string;
  selectedDraft: string;
  language: string;
  body: string;
  bodyDigest: string;
}

async function candidate(env: WorkActivationEnvironment, input: FixedReleaseInput): Promise<Candidate> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?contribution ?decision ?draft ?language ?manifest WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .
        ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} ;
          rv:head ${iri(input.expectedMainRevision)} ;
          rv:selectionHead ${iri(input.expectedSelection)} .
        ?contribution a rv:TextContribution ; rv:work ${iri(input.work)} ;
          rv:publicationHead ?decision .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(input.expectedMainRevision)} a rv:RevisionAnchor ;
          rv:component ${iri(input.mainVersion)} .
        ${iri(input.expectedSelection)} a rv:PublicationSelection ;
          rv:mainVersion ${iri(input.mainVersion)} ; rv:mainRevision ${iri(input.expectedMainRevision)} ;
          rv:contribution ?contribution ; rv:publicationDecision ?decision ;
          rv:selectedDraft ?draft ; rv:language ?language .
        ?decision a rv:PublicationDecision ; rv:component ?contribution ;
          rv:selectedDraft ?draft ; rv:language ?language ;
          rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public ;
          rv:manifest ?manifest .
      }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.contribution || !rows[0]?.decision
    || !rows[0]?.draft || !rows[0]?.language || !rows[0]?.manifest) {
    throw new FixedReleaseUnavailable('eligible current native selection is unavailable');
  }
  const row = rows[0]!;
  const contribution = row.contribution.value;
  const publicationDecision = row.decision.value;
  const selectedDraft = row.draft.value;
  const language = row.language.value;
  const publication = readComponentState(env.objectDirectory, row.manifest.value,
    contribution, PUBLICATION_PROFILE);
  if (publication.work !== input.work || publication.contribution !== contribution
    || publication.selectedDraft !== selectedDraft || publication.language !== language
    || publication.rightsBasis !== 'original-contribution' || publication.disclosure !== 'public') {
    throw new RevisionCorrupt('publication manifest differs from selected decision');
  }
  const exact = await readExactContributionDraft(env, contribution, selectedDraft, async () => true);
  if (exact.work !== input.work || exact.language !== language
    || exact.author !== publication.author || Buffer.byteLength(exact.body, 'utf8') > 65536) {
    throw new RevisionCorrupt('selected draft differs from publication');
  }
  return { contribution, publicationDecision, selectedDraft, language,
    body: exact.body, bodyDigest: hash(exact.body) };
}

async function currentState(env: WorkActivationEnvironment, input: FixedReleaseInput): Promise<
  'eligible' | 'stale' | 'unavailable'> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?selection WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.work)} rv:mainVersion ${iri(input.mainVersion)} .
      ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} ; rv:head ?head .
      OPTIONAL { ${iri(input.mainVersion)} rv:selectionHead ?selection }
    }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.head) return 'unavailable';
  if (rows[0].head.value !== input.expectedMainRevision
    || rows[0].selection?.value !== input.expectedSelection) return 'stale';
  return 'eligible';
}

async function activate(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: FixedReleaseInput, digest: string, selected: Candidate): Promise<void> {
  const release = ID + Bun.randomUUIDv7();
  const receipt = fixedReleaseReceiptIri(admission.id);
  const manifestState = { work: input.work, mainVersion: input.mainVersion,
    mainRevision: input.expectedMainRevision, selection: input.expectedSelection,
    contribution: selected.contribution, publicationDecision: selected.publicationDecision,
    selectedDraft: selected.selectedDraft, language: selected.language,
    bodyDigest: selected.bodyDigest, sealedBy: input.actingSubject };
  const manifest = env.workObjects
    ? await prepareWorkComponent(env.workObjects, release, manifestState, PROFILE)
    : prepareComponent(env.objectDirectory, release, manifestState, PROFILE);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0fixed-release`)}`;
  const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(release)} a rv:FixedRelease ; rv:work ${iri(input.work)} ;
          rv:mainVersion ${iri(input.mainVersion)} ; rv:mainRevision ${iri(input.expectedMainRevision)} ;
          rv:selection ${iri(input.expectedSelection)} ; rv:contribution ${iri(selected.contribution)} ;
          rv:publicationDecision ${iri(selected.publicationDecision)} ;
          rv:selectedDraft ${iri(selected.selectedDraft)} ; rv:language ${lit(selected.language)} ;
          rv:bodyDigest ${lit(selected.bodyDigest)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:sealedBy ${iri(input.actingSubject)} ; rv:modelRevision ${iri(PROFILE)} ;
          rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:admittedScope ${lit(admission.scope)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:outcome rv:Succeeded ;
          rv:fixedRelease ${iri(release)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:FixedReleaseSealedEvent ; rv:ordinal 0 ;
          rv:action "release.seal" ; rv:receipt ${iri(receipt)} ;
          rv:fixedRelease ${iri(release)} ; rv:work ${iri(input.work)} . }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .
        ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} ;
          rv:head ${iri(input.expectedMainRevision)} ;
          rv:selectionHead ${iri(input.expectedSelection)} .
        ${iri(selected.contribution)} a rv:TextContribution ; rv:work ${iri(input.work)} ;
          rv:publicationHead ${iri(selected.publicationDecision)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(input.expectedMainRevision)} a rv:RevisionAnchor ; rv:component ${iri(input.mainVersion)} .
        ${iri(input.expectedSelection)} a rv:PublicationSelection ;
          rv:mainVersion ${iri(input.mainVersion)} ; rv:mainRevision ${iri(input.expectedMainRevision)} ;
          rv:contribution ${iri(selected.contribution)} ;
          rv:publicationDecision ${iri(selected.publicationDecision)} ;
          rv:selectedDraft ${iri(selected.selectedDraft)} ; rv:language ${lit(selected.language)} .
        ${iri(selected.publicationDecision)} a rv:PublicationDecision ;
          rv:component ${iri(selected.contribution)} ; rv:selectedDraft ${iri(selected.selectedDraft)} ;
          rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public .
        ${iri(selected.selectedDraft)} a rv:RevisionAnchor ;
          rv:component ${iri(selected.contribution)} . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(release)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const validations = await profileValidations(env.fuseki, 'fixed-native-text-release-v1', [{
    shape: SHAPE, focus: [release],
    graphs: [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.control],
  }], { release, work: input.work, main: input.mainVersion,
    revision: input.expectedMainRevision, selection: input.expectedSelection,
    contribution: selected.contribution, decision: selected.publicationDecision,
    draft: selected.selectedDraft, language: selected.language, digest: selected.bodyDigest,
    manifest: `urn:rezics:sha256:${manifest}`, actor: input.actingSubject,
    receipt, scope: admission.scope, epoch: admission.authorityEpoch });
  const result = await validatedCommand(env, { receipt, digest, update,
    validations, deadlineMs: 10_000 }, admission);
  if (result.status === 'invalid' || result.status === 'unknown-profile'
    || result.status === 'conflict') throw new CommandRejected(result);
}

/** One admitted command pins a single exact native text selection. */
export async function createAdmittedFixedRelease(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, input: FixedReleaseInput,
): Promise<{ release: string; receipt: string; replayed: boolean }> {
  const digest = fixedReleaseDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `release:seal:${input.mainVersion}`, action: 'release.seal',
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  await assertNotInvalidProfileReceipt(env.fuseki, fixedReleaseReceiptIri(registered.id));
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealFixedReleaseAdmission(env, admission);
      } else {
        const state = await currentState(env, input);
        if (state !== 'eligible') {
          await sealFixedReleaseAdmission(env, admission);
          if (state === 'stale') throw new FixedReleaseStale('Main Version head or selection changed');
          throw new FixedReleaseUnavailable('Main Version is unavailable');
        }
        let selected: Candidate;
        try { selected = await candidate(env, input); }
        catch (error) {
          if (error instanceof FixedReleaseUnavailable) {
            await sealFixedReleaseAdmission(env, admission);
          }
          throw error;
        }
        try { await activate(env, admission, input, digest, selected); }
        catch (error) {
          if (error instanceof IdempotencyConflict || error instanceof CommandRejected) throw error;
          const current = await currentState(env, input);
          if (current !== 'eligible') await sealFixedReleaseAdmission(env, admission);
        }
      }
    }
    const terminal = await readFixedReleaseTerminal(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'fixed-release');
    await access.recordGraphOutcome(registered.id, terminal);
    if (!matches(terminal, registered, digest)) {
      throw new IdempotencyConflict('fixed release receipt differs from admission');
    }
    if (terminal.outcome !== 'succeeded' || !terminal.release) {
      throw new FixedReleaseUnavailable('fixed release admission was cancelled');
    }
    return { release: terminal.release, receipt: terminal.receipt,
      replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof InvalidFixedRelease
      || error instanceof FixedReleaseStale || error instanceof FixedReleaseUnavailable
      || error instanceof CommandRejected || error instanceof RevisionCorrupt
      || error instanceof RevisionUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'fixed-release');
  }
}

/** Exact read checks the immutable manifest and the retained draft bytes. */
export async function readFixedRelease(env: WorkActivationEnvironment, release: string,
  canReadWork: (work: string) => Promise<boolean>): Promise<FixedRelease> {
  if (!nativeId.test(release)) throw new InvalidFixedRelease('invalid release identity');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?work ?main ?revision ?selection ?contribution ?decision ?draft ?language
    ?digest ?manifest ?actor ?model ?shape ?dataset ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(release)} a rv:FixedRelease ; rv:work ?work ; rv:mainVersion ?main ;
        rv:mainRevision ?revision ; rv:selection ?selection ; rv:contribution ?contribution ;
        rv:publicationDecision ?decision ; rv:selectedDraft ?draft ; rv:language ?language ;
        rv:bodyDigest ?digest ; rv:manifest ?manifest ; rv:sealedBy ?actor ;
        rv:modelRevision ?model ; rv:shapeRevision ?shape ; rv:datasetId ?dataset ;
        rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) throw new RevisionNotFound('fixed release is unavailable');
  const row = rows[0]!;
  const work = row.work?.value;
  if (!work || !await canReadWork(work)) throw new RevisionNotFound('fixed release is unavailable');
  if (rows.length !== 1 || !row.main || !row.revision || !row.selection
    || !row.contribution || !row.decision || !row.draft || !row.language
    || !row.digest || !row.manifest || !row.actor || row.model?.value !== PROFILE
    || row.shape?.value !== PROFILE || row.dataset?.value !== DATASET || !row.epoch
    || !/^[0-9]+$/.test(row.sequence?.value ?? '') || !/^[0-9a-f]{64}$/.test(row.digest.value)) {
    throw new RevisionCorrupt('fixed release anchor is incomplete');
  }
  const state = await readWorkComponentState(env, row.manifest.value, release, PROFILE);
  const fields = { work, mainVersion: row.main.value, mainRevision: row.revision.value,
    selection: row.selection.value, contribution: row.contribution.value,
    publicationDecision: row.decision.value, selectedDraft: row.draft.value,
    language: row.language.value, bodyDigest: row.digest.value, sealedBy: row.actor.value };
  for (const [key, value] of Object.entries(fields)) {
    if (state[key] !== value) throw new RevisionCorrupt(`fixed release manifest differs: ${key}`);
  }
  const exact = await readExactContributionDraft(env, fields.contribution,
    fields.selectedDraft, async () => true);
  if (exact.work !== work || exact.language !== fields.language
    || hash(exact.body) !== fields.bodyDigest) {
    throw new RevisionCorrupt('fixed release body differs from sealed digest');
  }
  return { release, ...fields, body: exact.body, sourcePosition: {
    datasetId: 'product', dataEpoch: row.epoch.value, sequence: row.sequence!.value } };
}
