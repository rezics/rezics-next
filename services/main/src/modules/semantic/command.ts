import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRejected, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { profileValidations, COMMAND_MODULE_VERSION, type ProfileId } from '../../infrastructure/profile.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { CancelledActivation, DATASET, GRAPHS, IdempotencyConflict, PendingActivation, RV, hash, iri, lit,
  prepareComponent, prepareWorkComponent, type WorkActivationEnvironment } from '../work/activate.ts';
import { readWorkComponentState } from '../work/history.ts';
import { MODEL_COMPONENT, PROFILES } from './schema.ts';
import { ModelGenerationChanged } from './generation-guard.ts';

/**
 * Shared graph command path of the semantic families. It reuses the Work family
 * pattern: one receipt per Access admission in the receipts graph, the control
 * epoch/routing/sequence guard, immutable `rezics-manifest-v1` objects and one
 * outbox batch. Product mutations record one event so relay and recovery can
 * retain their exact source position; terminal cancellations have zero events.
 */
export type SemanticAdmission = Pick<RegisteredAdmission,
  'id' | 'scope' | 'action' | 'requestDigest' | 'authorityEpoch' | 'expiresAt'>;

export type SemanticRejection = 'stale-head' | 'retired-definition' | 'unavailable-reference' | 'generation-changed'
  | 'star-violation';

export class SemanticChangeRejected extends Error {
  constructor(readonly code: 'invalid' | 'unsupported' | 'identity-axiom' | 'schema-axiom' | 'reserved-owner'
    | 'unavailable-reference' | 'retired-definition' | 'star-violation' | 'too-large', message: string) { super(message); }
}
export class StaleSemanticHead extends Error {}
export class SemanticTargetUnavailable extends Error {}

export interface SemanticTerminal {
  outcome: 'succeeded' | 'cancelled';
  reason?: SemanticRejection | 'invalid-profile';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  component?: string;
  revision?: string;
  expectedHead?: string;
}

const REASONS: Record<string, SemanticRejection> = {
  [`${RV}StaleHead`]: 'stale-head', [`${RV}RetiredDefinition`]: 'retired-definition',
  [`${RV}UnavailableReference`]: 'unavailable-reference', [`${RV}GenerationChanged`]: 'generation-changed',
  [`${RV}StarViolation`]: 'star-violation',
};
const REASON_TERMS = Object.fromEntries(Object.entries(REASONS).map(([term, reason]) =>
  [reason, `rv:${term.slice(RV.length)}`])) as
  Record<SemanticRejection, string>;

export function familyReceiptIri(admissionId: string, family: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0${family}`)}`;
}

export async function readSemanticTerminal(env: WorkActivationEnvironment, receipt: string): Promise<SemanticTerminal | null> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?outcome ?reason ?kind ?digest ?admissionId ?authorityEpoch ?scope ?sequence ?epoch ?component ?revision ?expected WHERE {
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} rv:outcome ?outcome ; rv:requestDigest ?digest ; rv:admissionId ?admissionId ;
          rv:authorityEpoch ?authorityEpoch ; rv:admittedScope ?scope ; rv:sequence ?sequence ; rv:dataEpoch ?epoch .
        OPTIONAL { ${iri(receipt)} rv:reason ?reason }
        OPTIONAL { ${iri(receipt)} rv:rejectionKind ?kind }
        OPTIONAL { ${iri(receipt)} rv:component ?component ; rv:revision ?revision }
        OPTIONAL { ${iri(receipt)} rv:expectedHead ?expected }
      }
    }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.outcome || !row.digest || !row.admissionId || !row.authorityEpoch
    || !row.scope || !row.sequence || !row.epoch) throw new Error('semantic receipt is incomplete or ambiguous');
  const outcome = row.outcome.value === `${RV}Succeeded` ? 'succeeded'
    : row.outcome.value === `${RV}Cancelled` ? 'cancelled' : null;
  if (!outcome) throw new Error('unknown semantic receipt outcome');
  if ((outcome === 'succeeded') !== Boolean(row.component && row.revision)) {
    throw new Error('semantic receipt result differs from its outcome');
  }
  const reason = row.kind?.value === `${RV}InvalidProfile` ? 'invalid-profile'
    : row.reason ? REASONS[row.reason.value] : undefined;
  return { outcome, ...(reason ? { reason } : {}), receipt, admissionId: row.admissionId.value,
    requestDigest: row.digest.value, authorityEpoch: row.authorityEpoch.value, scope: row.scope.value,
    dataEpoch: row.epoch.value, sequence: row.sequence.value,
    ...(row.component ? { component: row.component.value, revision: row.revision!.value } : {}),
    ...(row.expected ? { expectedHead: row.expected.value } : {}) };
}

/** Same key, same intent: the one terminal receipt; any other binding conflicts. */
export function checkedSemanticTerminal(terminal: SemanticTerminal, admission: Pick<SemanticAdmission,
  'id' | 'scope' | 'authorityEpoch'>, digest: string): SemanticTerminal {
  if (terminal.admissionId !== admission.id || terminal.requestDigest !== digest
    || terminal.authorityEpoch !== admission.authorityEpoch || terminal.scope !== admission.scope) {
    throw new IdempotencyConflict('semantic receipt does not match its admission');
  }
  if (terminal.outcome === 'cancelled') {
    if (terminal.reason === 'generation-changed') {
      throw new ModelGenerationChanged('model generation changed after semantic preparation');
    }
    if (terminal.reason === 'stale-head') throw new StaleSemanticHead('expected semantic head is stale');
    if (terminal.reason === 'retired-definition') {
      throw new SemanticChangeRejected('retired-definition', 'relation definition revision is not current');
    }
    if (terminal.reason === 'unavailable-reference') {
      throw new SemanticChangeRejected('unavailable-reference', 'a referenced resource is unavailable');
    }
    if (terminal.reason === 'star-violation') {
      throw new SemanticChangeRejected('star-violation', 'the occurrence breaks its definition\'s star constraint');
    }
    if (terminal.reason === 'invalid-profile') throw new CommandRejected({ status: 'invalid' });
    throw new CancelledActivation('semantic admission was cancelled before dispatch');
  }
  return terminal;
}

const controlGuard = (env: WorkActivationEnvironment) =>
  `GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
    rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`;

/**
 * Record a typed terminal rejection under the command's own receipt. The caller's
 * `condition` restates the observed rejection basis, so the original command and
 * this rejection race on one receipt identity and exactly one commits.
 */
export async function sealSemanticRejection(env: WorkActivationEnvironment, receipt: string, digest: string,
  admission: Pick<SemanticAdmission, 'id' | 'scope' | 'authorityEpoch'>, reason: SemanticRejection,
  condition: string): Promise<SemanticTerminal | null> {
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0${reason}`)}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
        rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
        rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ; rv:reason ${REASON_TERMS[reason]} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 0 . }
    }
    WHERE {
      ${controlGuard(env)}
      ${condition}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  try { await env.fuseki.commandWithReceipt({ receipt, digest, update, validations: [], deadlineMs: 10_000 }); }
  catch { /* resolve the same receipt after an ambiguous response */ }
  return readSemanticTerminal(env, receipt);
}

/** Terminal cancellation of an admission that may no longer dispatch; it races the original. */
export async function cancelSemanticAdmission(env: WorkActivationEnvironment, receipt: string,
  admission: Pick<SemanticAdmission, 'id' | 'scope' | 'authorityEpoch' | 'requestDigest'>): Promise<void> {
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0cancel`)}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
        rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
        rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 0 . }
    }
    WHERE {
      ${controlGuard(env)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest, update,
    validations: [], deadlineMs: 10_000 }); }
  catch { /* resolve the same receipt after a lost response */ }
}

export interface SemanticWrite {
  receipt: string;
  digest: string;
  admission: SemanticAdmission;
  /** Guarded DELETE/INSERT graph blocks without control, receipt or outbox parts. */
  deletes: string;
  inserts: string;
  where: string;
  receiptFields: string;
  validations: CommandValidation[];
  /** Owner event class; defaults to the semantic or relation change event. */
  event?: string;
}

/** Compose and send the one guarded update; outcomes resolve from the receipt. */
export async function sendSemanticWrite(env: WorkActivationEnvironment, write: SemanticWrite): Promise<void> {
  const eventKind = write.event ?? (write.admission.action === 'relation.change' ? 'RelationChangedEvent' : 'SemanticChangedEvent');
  if (!/^[A-Z][A-Za-z0-9]*Event$/.test(eventKind)) throw new Error('invalid semantic event class');
  const batch = `urn:rezics:outbox:${hash(write.receipt)}`;
  const event = `urn:rezics:event:${hash(`${write.receipt}\0semantic-write`)}`;
  const update = `PREFIX rv: <${RV}>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      ${write.deletes}
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      ${write.inserts}
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(write.receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(write.digest)} ; rv:admissionId ${lit(write.admission.id)} ;
        rv:authorityEpoch ${lit(write.admission.authorityEpoch)} ; rv:admittedScope ${lit(write.admission.scope)} ;
        rv:outcome rv:Succeeded ; ${write.receiptFields} rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:${eventKind} ;
          rv:ordinal 0 ; rv:action ${lit(write.admission.action)} ;
          rv:receipt ${iri(write.receipt)} . }
    }
    WHERE {
      ${controlGuard(env)}
      ${write.where}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(write.receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  try {
    const result = await validatedCommand(env, { receipt: write.receipt, digest: write.digest, update,
      validations: write.validations, deadlineMs: 10_000 }, write.admission);
    if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
  } catch (error) {
    if (error instanceof CommandRejected) throw error;
    /* a lost response resolves from the receipt */
  }
}

export async function assertSemanticDispatchable(env: WorkActivationEnvironment, admission: SemanticAdmission,
  receipt: string, digest: string): Promise<SemanticTerminal | null> {
  if (!/^[0-9a-f-]{36}$/.test(admission.id) || !/^[0-9]+$/.test(admission.authorityEpoch)) {
    throw new Error('invalid semantic admission');
  }
  if (digest !== admission.requestDigest) throw new IdempotencyConflict('semantic change digest differs');
  await assertNotInvalidProfileReceipt(env.fuseki, receipt);
  const existing = await readSemanticTerminal(env, receipt);
  if (existing) return checkedSemanticTerminal(existing, admission, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('semantic admission expired');
  return null;
}

export async function validationsFor(env: WorkActivationEnvironment, profile: ProfileId,
  entries: readonly { role: string; focus: readonly string[] }[]): Promise<CommandValidation[]> {
  return profileValidations(env.fuseki, profile, entries.filter(entry => entry.focus.length).map(entry => ({
    shape: `https://rezics.com/definition/${profile}/${entry.role}-shape`, focus: entry.focus,
    graphs: [GRAPHS.current, GRAPHS.revisions] })));
}

/** Store exact component state; resolution never reads the current projection. */
export async function sealComponentState(env: WorkActivationEnvironment, component: string, profile: string,
  state: object): Promise<string> {
  const digest = env.workObjects ? await prepareWorkComponent(env.workObjects, component, state, profile)
    : prepareComponent(env.objectDirectory, component, state, profile);
  return `urn:rezics:sha256:${digest}`;
}

export async function readComponent(env: WorkActivationEnvironment, manifest: string, component: string,
  profile: string): Promise<Record<string, unknown>> {
  return readWorkComponentState(env, manifest, component, profile);
}

/* ---------------------------------------------------------------- model generation */

const manifestBytes = readFileSync(join(import.meta.dir, '../../../../../generated/model/manifest.json'));
export const MODEL_MANIFEST_SHA256 = hash(manifestBytes);
/** The generation that validated this Main build's profiles; revisions pin it exactly. */
export const ACTIVE_GENERATION = `urn:rezics:model-generation:${MODEL_MANIFEST_SHA256}`;

/**
 * Record this build's first model generation and current head in one command.
 * A later generation needs an explicit reviewed activation operation.
 */
export async function ensureModelGeneration(env: WorkActivationEnvironment): Promise<string> {
  const present = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(ACTIVE_GENERATION)} a rv:ModelGeneration }
    GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ${iri(ACTIVE_GENERATION)} } }`);
  if (present.boolean === true) return ACTIVE_GENERATION;
  const manifest = await sealComponentState(env, ACTIVE_GENERATION, PROFILES.generation, {
    modelManifestSha256: MODEL_MANIFEST_SHA256, commandModule: COMMAND_MODULE_VERSION, entailment: 'none' });
  const receipt = `urn:rezics:receipt:${hash(`${ACTIVE_GENERATION}\0model-generation`)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0model-generation`)}`;
  const operation = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
  const digest = hash(JSON.stringify({ family: 'model-generation-v1', manifest: MODEL_MANIFEST_SHA256 }));
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} a rv:ModelComponent ;
        rv:generationHead ${iri(ACTIVE_GENERATION)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(ACTIVE_GENERATION)} a rv:ModelGeneration, rv:RevisionAnchor ;
        rv:component <urn:rezics:model:product> ; rv:generationNumber ?number ; rv:manifest ${iri(manifest)} ;
        rv:commandModuleVersion ${lit(COMMAND_MODULE_VERSION)} ; rv:entailmentProfile rv:NoEntailment ;
        rv:identityInference rv:Excluded ; rv:validationPosture rv:RejectOnViolation ;
        rv:operation ${iri(operation)} ; rv:modelRevision ${iri(PROFILES.generation)} ;
        rv:shapeRevision ${iri(PROFILES.generation)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
        rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${hash(receipt)}`)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ModelGenerationRecordedEvent ; rv:ordinal 0 ; rv:action "model.generation.record" ;
          rv:receipt ${iri(receipt)} . }
    }
    WHERE {
      ${controlGuard(env)}
      { SELECT (COUNT(?g) AS ?count) WHERE { GRAPH ${iri(GRAPHS.revisions)} { ?g a rv:ModelGeneration } } }
      BIND(?count + 1 AS ?number)
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(ACTIVE_GENERATION)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} ?headP ?headO } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const validations = await validationsFor(env, 'semantic-model-generation-v1',
    [{ role: 'generation', focus: [ACTIVE_GENERATION] }, { role: 'head', focus: [MODEL_COMPONENT] }]);
  try {
    const result = await env.fuseki.commandWithReceipt({ receipt, digest, update, validations, deadlineMs: 10_000 });
    if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
  } catch (error) { if (error instanceof CommandRejected) throw error; }
  const committed = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(ACTIVE_GENERATION)} a rv:ModelGeneration }
    GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ${iri(ACTIVE_GENERATION)} } }`);
  if (committed.boolean !== true) throw new PendingActivation('model generation is not recorded');
  return ACTIVE_GENERATION;
}
