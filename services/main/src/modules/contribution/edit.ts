import type { RegisteredAdmission } from '../access/admission.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { CONTRIBUTION_PROFILE, InvalidContributionInput,
  validateTextContributionCandidate } from './draft.ts';
import { PRIVATE_SEARCH_GRAPH, privateDraftTriples, privateDraftUnit } from './private-projection.ts';

export class StaleContributionDraftHead extends Error {}
export class ContributionEditUnavailable extends Error {}

export interface EditTextContributionInput {
  contribution: string;
  expectedHead: string;
  body: string;
  actingSubject: string;
}

export interface TextContributionEditReceipt {
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
  draftRevision?: string;
  expectedHead?: string;
  work?: string;
  author?: string;
  language?: string;
}

export function textContributionEditDigest(input: EditTextContributionInput): string {
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(input.contribution)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(input.expectedHead)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(input.actingSubject)
    || !input.body || Buffer.byteLength(input.body, 'utf8') > 65536
    || input.body.includes('\0')) {
    throw new InvalidContributionInput('invalid text Contribution edit');
  }
  return hash(JSON.stringify({ family: 'edit-text-contribution-v1',
    contribution: input.contribution, expectedHead: input.expectedHead,
    actor: input.actingSubject, bodyDigest: hash(JSON.stringify(input.body)) }));
}

export function textContributionEditReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0edit-text-contribution`)}`;
}

export async function readTextContributionEditReceipt(
  env: WorkActivationEnvironment, admissionId: string,
): Promise<TextContributionEditReceipt | null> {
  const receipt = textContributionEditReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?reason ?digest ?id ?epoch ?scope ?dataEpoch ?sequence
    ?contribution ?draftRevision ?expectedHead ?work ?author ?language WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:contribution ?contribution ;
        rv:draftRevision ?draftRevision ; rv:expectedHead ?expectedHead ;
        rv:work ?work ; rv:author ?author ; rv:language ?language }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('Contribution edit receipt cardinality violation');
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const reason = value('reason') === `${RV}StaleHead` ? 'stale-head' : undefined;
  if (!outcome || !value('digest') || !value('id') || !value('epoch') || !value('scope')
    || !value('dataEpoch') || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (value('reason') && !reason)
    || (outcome === 'succeeded' && (!value('contribution') || !value('draftRevision')
      || !value('expectedHead') || !value('work') || !value('author')
      || !value('language') || reason))
    || (outcome === 'cancelled' && (value('contribution') || value('draftRevision')
      || value('expectedHead') || value('work') || value('author') || value('language')))) {
    throw new Error('Contribution edit receipt is incomplete');
  }
  return { outcome, ...(reason ? { reason } : {}), receipt,
    admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('epoch')!, scope: value('scope')!,
    dataEpoch: value('dataEpoch')!, sequence: value('sequence')!,
    ...(outcome === 'succeeded' ? { contribution: value('contribution'),
      draftRevision: value('draftRevision'), expectedHead: value('expectedHead'),
      work: value('work'), author: value('author'), language: value('language') } : {}) };
}

function matches(receipt: TextContributionEditReceipt, admission: RegisteredAdmission,
  digest: string): boolean {
  return receipt.admissionId === admission.id && receipt.requestDigest === digest
    && receipt.authorityEpoch === admission.authorityEpoch && receipt.scope === admission.scope;
}

export function checkedTextContributionEditReceipt(
  receipt: TextContributionEditReceipt, admission: RegisteredAdmission,
  input: EditTextContributionInput, digest: string,
): TextContributionEditReceipt {
  if (!matches(receipt, admission, digest)) {
    throw new IdempotencyConflict('Contribution edit receipt differs from admission');
  }
  if (receipt.outcome === 'cancelled') {
    if (receipt.reason === 'stale-head') throw new StaleContributionDraftHead('expected draft head is stale');
    throw new ContributionEditUnavailable('Contribution edit was cancelled');
  }
  if (receipt.contribution !== input.contribution || receipt.expectedHead !== input.expectedHead) {
    throw new IdempotencyConflict('Contribution edit receipt targets another intent');
  }
  return receipt;
}

async function sealStaleHead(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: EditTextContributionInput, digest: string): Promise<TextContributionEditReceipt | null> {
  const receipt = textContributionEditReceiptIri(admission.id);
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
        ${iri(event)} a rv:ContributionDraftEditRejectedEvent ; rv:ordinal 0 ;
          rv:action "contribution.edit" ; rv:receipt ${iri(receipt)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.contribution)} rv:draftHead ?currentHead . }
      FILTER(?currentHead != ${iri(input.expectedHead)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }); } catch { /* resolve the same receipt after an ambiguous result */ }
  return readTextContributionEditReceipt(env, admission.id);
}

/** Strong closure settles an uncommitted draft edit without changing its head. */
export async function sealTextContributionEditAdmission(
  env: WorkActivationEnvironment, admission: RegisteredAdmission,
): Promise<TextContributionEditReceipt> {
  if (admission.action !== 'contribution.edit') throw new Error('unsupported Contribution edit admission');
  const existing = await readTextContributionEditReceipt(env, admission.id);
  if (existing) {
    if (!matches(existing, admission, admission.requestDigest)) {
      throw new IdempotencyConflict('Contribution edit receipt differs from Access admission');
    }
    return existing;
  }
  const receipt = textContributionEditReceiptIri(admission.id);
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
        ${iri(event)} a rv:ContributionAdmissionCancelledEvent ; rv:ordinal 0 ;
          rv:action "contribution.edit" ; rv:receipt ${iri(receipt)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }); } catch { /* resolve the same receipt after an ambiguous result */ }
  const terminal = await readTextContributionEditReceipt(env, admission.id);
  if (!terminal || !matches(terminal, admission, admission.requestDigest)) {
    throw new PendingActivation('Contribution edit cancellation is unknown');
  }
  return terminal;
}

/** Exact-head private draft edit. Work, original author and language remain fixed. */
export async function editTextContributionDraft(
  env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: EditTextContributionInput,
): Promise<TextContributionEditReceipt> {
  const digest = textContributionEditDigest(input);
  if (admission.action !== 'contribution.edit'
    || admission.scope !== `contribution:edit:${input.contribution}`
    || admission.actingSubject !== input.actingSubject
    || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('Contribution edit admission differs from intent');
  }
  await assertNotInvalidProfileReceipt(env.fuseki, textContributionEditReceiptIri(admission.id));
  const existing = await readTextContributionEditReceipt(env, admission.id);
  if (existing) return checkedTextContributionEditReceipt(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Contribution edit admission expired');
  const current = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?work ?author ?language ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.contribution)} a rv:TextContribution ; rv:work ?work ;
          rv:author ?author ; rv:language ?language ; rv:draftHead ?head .
        ?work a schema:CreativeWork .
      }
    }`);
  const rows = current.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.work || !rows[0]?.author
    || !rows[0]?.language || !rows[0]?.head) {
    throw new ContributionEditUnavailable('Contribution is unavailable');
  }
  if (rows[0].head.value !== input.expectedHead) {
    const stale = await sealStaleHead(env, admission, input, digest);
    if (stale) return checkedTextContributionEditReceipt(stale, admission, input, digest);
    throw new PendingActivation('stale Contribution edit was not sealed');
  }
  const work = rows[0].work.value;
  const author = rows[0].author.value;
  const language = rows[0].language.value;
  const draftRevision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const validations = await validateTextContributionCandidate(env, input.contribution, draftRevision,
    { work, actingSubject: author, language, body: input.body });
  const manifest = prepareComponent(env.objectDirectory, input.contribution,
    { work, author, language, body: input.body, publication: 'draft' }, CONTRIBUTION_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Contribution edit admission expired');
  const receipt = textContributionEditReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  try {
    const result = await validatedCommand(env, { receipt, digest, validations, deadlineMs: 10_000,
    update: `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.contribution)} rv:draftHead ${iri(input.expectedHead)} }
      GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} { ${iri(privateDraftUnit(input.expectedHead))} ?oldProperty ?oldValue }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.contribution)} rv:draftHead ${iri(draftRevision)} }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(draftRevision)} a rv:RevisionAnchor ; rv:component ${iri(input.contribution)} ;
          rv:predecessor ${iri(input.expectedHead)} ; rv:operation ${iri(operation)} ;
          rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(CONTRIBUTION_PROFILE)} ;
          rv:shapeRevision ${iri(CONTRIBUTION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} {
        ${privateDraftTriples(input.contribution, draftRevision, work, language, input.body)}
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:work ${iri(work)} ; rv:contribution ${iri(input.contribution)} ;
          rv:draftRevision ${iri(draftRevision)} ; rv:expectedHead ${iri(input.expectedHead)} ;
          rv:author ${iri(author)} ; rv:language ${lit(language)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ContributionDraftEditedEvent ; rv:ordinal 0 ;
          rv:action "contribution.edit" ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} ; rv:work ${iri(work)} ;
          rv:contribution ${iri(input.contribution)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.contribution)} a rv:TextContribution ; rv:work ${iri(work)} ;
          rv:author ${iri(author)} ; rv:language ${lit(language)} ;
          rv:draftHead ${iri(input.expectedHead)} .
        ${iri(work)} a schema:CreativeWork .
      }
      OPTIONAL { GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} {
        ${iri(privateDraftUnit(input.expectedHead))} ?oldProperty ?oldValue } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }, admission);
    if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
  } catch (error) {
    if (error instanceof CommandRejected) throw error;
    /* resolve by the terminal receipt */
  }
  const committed = await readTextContributionEditReceipt(env, admission.id);
  if (committed) return checkedTextContributionEditReceipt(committed, admission, input, digest);
  const stale = await sealStaleHead(env, admission, input, digest);
  if (stale) return checkedTextContributionEditReceipt(stale, admission, input, digest);
  throw new PendingActivation('Contribution edit guard did not match');
}
