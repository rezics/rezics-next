import { CommandRejected, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { readExactContributionDraft } from './history.ts';

export const PUBLICATION_PROFILE = 'https://rezics.com/definition/text-publication-v1';
const NONE = 'urn:rezics:none';

export class InvalidPublicationInput extends Error {}
export class StalePublicationHead extends Error {}
export class PublicationUnavailable extends Error {}

export interface PublishTextContributionInput {
  contribution: string;
  expectedDraftHead: string;
  expectedPublicationHead: string | null;
  rightsBasis: 'original-contribution';
  disclosure: 'public';
  actingSubject: string;
}

export interface TextPublicationReceipt {
  outcome: 'succeeded' | 'cancelled';
  reason?: 'stale-head';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  contribution?: string;
  publicationDecision?: string;
  selectedDraft?: string;
  predecessor?: string | null;
  work?: string;
  author?: string;
  language?: string;
}

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export function textPublicationDigest(input: PublishTextContributionInput): string {
  if (!nativeId.test(input.contribution) || !nativeId.test(input.expectedDraftHead)
    || (input.expectedPublicationHead !== null && !nativeId.test(input.expectedPublicationHead))
    || !nativeId.test(input.actingSubject)
    || input.rightsBasis !== 'original-contribution' || input.disclosure !== 'public') {
    throw new InvalidPublicationInput('invalid text publication input');
  }
  return hash(JSON.stringify({ family: 'publish-text-contribution-v1',
    contribution: input.contribution, expectedDraftHead: input.expectedDraftHead,
    expectedPublicationHead: input.expectedPublicationHead,
    rightsBasis: input.rightsBasis, disclosure: input.disclosure,
    actor: input.actingSubject }));
}

export function textPublicationReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0publish-text-contribution`)}`;
}

export async function readTextPublicationReceipt(
  env: WorkActivationEnvironment, admissionId: string,
): Promise<TextPublicationReceipt | null> {
  const receipt = textPublicationReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?reason ?digest ?id ?epoch ?scope ?dataEpoch ?sequence
    ?contribution ?decision ?selectedDraft ?predecessor ?work ?author ?language WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:contribution ?contribution ;
        rv:publicationDecision ?decision ; rv:selectedDraft ?selectedDraft ;
        rv:work ?work ; rv:author ?author ; rv:language ?language .
        OPTIONAL { ${iri(receipt)} rv:expectedHead ?predecessor } }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('publication receipt cardinality violation');
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const reason = value('reason') === `${RV}StaleHead` ? 'stale-head' : undefined;
  if (!outcome || !value('digest') || !value('id') || !value('epoch') || !value('scope')
    || !value('dataEpoch') || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (value('reason') && !reason)
    || (outcome === 'succeeded' && (!value('contribution') || !value('decision')
      || !value('selectedDraft') || !value('work') || !value('author')
      || !value('language') || reason))
    || (outcome === 'cancelled' && (value('contribution') || value('decision')
      || value('selectedDraft') || value('predecessor') || value('work')
      || value('author') || value('language')))) {
    throw new Error('publication receipt is incomplete');
  }
  return { outcome, ...(reason ? { reason } : {}), receipt,
    admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('epoch')!, scope: value('scope')!,
    dataEpoch: value('dataEpoch')!, sequence: value('sequence')!,
    ...(outcome === 'succeeded' ? { contribution: value('contribution'),
      publicationDecision: value('decision'), selectedDraft: value('selectedDraft'),
      predecessor: value('predecessor') ?? null, work: value('work'),
      author: value('author'), language: value('language') } : {}) };
}

function matches(receipt: TextPublicationReceipt, admission: RegisteredAdmission,
  digest: string): boolean {
  return receipt.admissionId === admission.id && receipt.requestDigest === digest
    && receipt.authorityEpoch === admission.authorityEpoch && receipt.scope === admission.scope;
}

export function checkedTextPublicationReceipt(
  receipt: TextPublicationReceipt, admission: RegisteredAdmission,
  input: PublishTextContributionInput, digest: string,
): TextPublicationReceipt {
  if (!matches(receipt, admission, digest)) throw new IdempotencyConflict('publication receipt differs');
  if (receipt.outcome === 'cancelled') {
    if (receipt.reason === 'stale-head') throw new StalePublicationHead('publication input is stale');
    throw new PublicationUnavailable('publication was cancelled');
  }
  if (receipt.contribution !== input.contribution
    || receipt.selectedDraft !== input.expectedDraftHead
    || receipt.predecessor !== input.expectedPublicationHead
    || receipt.author !== input.actingSubject) {
    throw new IdempotencyConflict('publication receipt targets another intent');
  }
  return receipt;
}

function priorTerm(input: PublishTextContributionInput): string {
  return iri(input.expectedPublicationHead ?? NONE);
}

async function sealStalePublication(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: PublishTextContributionInput,
  digest: string): Promise<TextPublicationReceipt | null> {
  const receipt = textPublicationReceiptIri(admission.id);
  const suffix = hash(`${receipt}\0stale`);
  const batch = `urn:rezics:outbox:${suffix}`;
  const event = `urn:rezics:event:${suffix}`;
  try { await env.fuseki.commandWithReceipt({ receipt, digest, validations: [], deadlineMs: 10_000,
    update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ;
          rv:reason rv:StaleHead ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ContributionPublicationRejectedEvent ; rv:ordinal 0 ;
          rv:action "contribution.publish" ; rv:receipt ${iri(receipt)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.contribution)} a rv:TextContribution ; rv:draftHead ?head .
        OPTIONAL { ${iri(input.contribution)} rv:publicationHead ?prior }
      }
      FILTER(?head != ${iri(input.expectedDraftHead)} ||
        COALESCE(?prior, ${iri(NONE)}) != ${priorTerm(input)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }); } catch { /* resolve ambiguous update by receipt */ }
  return readTextPublicationReceipt(env, admission.id);
}

export async function sealTextPublicationAdmission(
  env: WorkActivationEnvironment, admission: RegisteredAdmission,
): Promise<TextPublicationReceipt> {
  if (admission.action !== 'contribution.publish') throw new Error('unsupported publication admission');
  const existing = await readTextPublicationReceipt(env, admission.id);
  if (existing) {
    if (!matches(existing, admission, admission.requestDigest)) {
      throw new IdempotencyConflict('publication receipt differs from Access admission');
    }
    return existing;
  }
  const receipt = textPublicationReceiptIri(admission.id);
  const suffix = hash(`${receipt}\0cancel`);
  const batch = `urn:rezics:outbox:${suffix}`;
  const event = `urn:rezics:event:${suffix}`;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ContributionPublicationCancelledEvent ; rv:ordinal 0 ;
          rv:action "contribution.publish" ; rv:receipt ${iri(receipt)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }); } catch { /* resolve ambiguous update by receipt */ }
  const terminal = await readTextPublicationReceipt(env, admission.id);
  if (!terminal || !matches(terminal, admission, admission.requestDigest)) {
    throw new PendingActivation('publication cancellation is unknown');
  }
  return terminal;
}

async function validateCandidate(env: WorkActivationEnvironment, decision: string,
  contribution: string, work: string, author: string, selectedDraft: string): Promise<CommandValidation[]> {
  for (const value of [decision, contribution, work, author, selectedDraft]) iri(value);
  return profileValidations(env.fuseki, 'text-publication-v1', [{
    shape: `${PUBLICATION_PROFILE}/decision-shape`, focus: [decision],
    graphs: [GRAPHS.current, GRAPHS.revisions],
  }]);
}

/** Contributor-controlled public eligibility for one exact immutable draft. */
export async function publishTextContribution(
  env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: PublishTextContributionInput,
): Promise<TextPublicationReceipt> {
  const digest = textPublicationDigest(input);
  if (admission.action !== 'contribution.publish'
    || admission.scope !== `contribution:publish:${input.contribution}`
    || admission.actingSubject !== input.actingSubject
    || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('publication admission differs from intent');
  }
  const existing = await readTextPublicationReceipt(env, admission.id);
  if (existing) return checkedTextPublicationReceipt(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('publication admission expired');
  const current = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?work ?author ?language ?head ?prior WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.contribution)} a rv:TextContribution ; rv:work ?work ;
          rv:author ?author ; rv:language ?language ; rv:draftHead ?head .
        ?work a schema:CreativeWork .
        OPTIONAL { ${iri(input.contribution)} rv:publicationHead ?prior }
      }
    }`);
  const rows = current.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.work || !rows[0]?.author
    || !rows[0]?.language || !rows[0]?.head) {
    throw new PublicationUnavailable('Contribution is unavailable');
  }
  const row = rows[0]!;
  if (row.author!.value !== input.actingSubject) {
    throw new PublicationUnavailable('original contributor authority is required');
  }
  if (row.head!.value !== input.expectedDraftHead
    || (row.prior?.value ?? null) !== input.expectedPublicationHead) {
    const stale = await sealStalePublication(env, admission, input, digest);
    if (stale) return checkedTextPublicationReceipt(stale, admission, input, digest);
    throw new PendingActivation('stale publication was not sealed');
  }
  const exact = await readExactContributionDraft(env, input.contribution,
    input.expectedDraftHead, async () => true);
  if (exact.work !== row.work!.value || exact.author !== row.author!.value
    || exact.language !== row.language!.value) {
    throw new PublicationUnavailable('draft identity differs from current Contribution');
  }
  const decision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const validations = await validateCandidate(env, decision, exact.contribution, exact.work,
    exact.author, exact.revision);
  const manifest = prepareComponent(env.objectDirectory, exact.contribution,
    { contribution: exact.contribution, work: exact.work, author: exact.author,
      language: exact.language, selectedDraft: exact.revision,
      rightsBasis: input.rightsBasis, disclosure: input.disclosure,
      predecessor: input.expectedPublicationHead }, PUBLICATION_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('publication admission expired');
  const receipt = textPublicationReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  const predecessorTriple = input.expectedPublicationHead
    ? `rv:predecessor ${iri(input.expectedPublicationHead)} ;` : '';
  const receiptPredecessor = input.expectedPublicationHead
    ? `rv:expectedHead ${iri(input.expectedPublicationHead)} ;` : '';
  try {
    const result = await validatedCommand(env, { receipt, digest, validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.contribution)} rv:publicationHead ?prior }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.contribution)} rv:publicationHead ${iri(decision)} }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(decision)} a rv:PublicationDecision, rv:RevisionAnchor ;
          rv:component ${iri(input.contribution)} ; ${predecessorTriple}
          rv:operation ${iri(operation)} ;
          rv:contribution ${iri(input.contribution)} ; rv:work ${iri(exact.work)} ;
          rv:author ${iri(exact.author)} ; rv:language ${lit(exact.language)} ;
          rv:selectedDraft ${iri(exact.revision)} ;
          rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public ;
          rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(PUBLICATION_PROFILE)} ;
          rv:shapeRevision ${iri(PUBLICATION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:contribution ${iri(input.contribution)} ;
          rv:publicationDecision ${iri(decision)} ; rv:selectedDraft ${iri(exact.revision)} ;
          ${receiptPredecessor} rv:work ${iri(exact.work)} ; rv:author ${iri(exact.author)} ;
          rv:language ${lit(exact.language)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ContributionEligibilityRecordedEvent ; rv:ordinal 0 ;
          rv:action "contribution.publish" ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} ; rv:work ${iri(exact.work)} ;
          rv:contribution ${iri(input.contribution)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.contribution)} a rv:TextContribution ; rv:work ${iri(exact.work)} ;
          rv:author ${iri(exact.author)} ; rv:language ${lit(exact.language)} ;
          rv:draftHead ${iri(input.expectedDraftHead)} .
        ${iri(exact.work)} a schema:CreativeWork .
        OPTIONAL { ${iri(input.contribution)} rv:publicationHead ?prior }
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(input.expectedDraftHead)} a rv:RevisionAnchor ;
          rv:component ${iri(input.contribution)} .
      }
      FILTER(COALESCE(?prior, ${iri(NONE)}) = ${priorTerm(input)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` });
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') {
      throw new InvalidPublicationInput(`Publication validation ${result.status}`);
    }
  } catch (error) {
    if (error instanceof InvalidPublicationInput || error instanceof CommandRejected) throw error;
    /* resolve by terminal receipt */
  }
  const committed = await readTextPublicationReceipt(env, admission.id);
  if (committed) return checkedTextPublicationReceipt(committed, admission, input, digest);
  const stale = await sealStalePublication(env, admission, input, digest);
  if (stale) return checkedTextPublicationReceipt(stale, admission, input, digest);
  throw new PendingActivation('publication guard did not match');
}
