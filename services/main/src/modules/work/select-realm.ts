import { CommandRejected, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { readExactContributionDraft } from '../contribution/history.ts';
import { PUBLICATION_PROFILE } from '../contribution/publish.ts';
import type { ContentCore } from '../../../../content/src/core.ts';
import { currentRealmMediaSet, type RealmMediaIntent }
  from '../content-publication/realm-media.ts';
import { reviewPolicy } from '../space/policy.ts';
import { REVIEW_POLICY, SELECTION_POLICY } from '../space/create.ts';
import { readComponentState } from './history.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from './activate.ts';

export const REALM_SELECTION_PROFILE = 'https://rezics.com/definition/realm-local-selection-v1';
const NONE = 'urn:rezics:none';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export class InvalidRealmSelectionInput extends Error {}
export class StaleRealmSelection extends Error {}
export class RealmSelectionUnavailable extends Error {}

export interface SelectRealmLocalInput {
  context: { kind: 'realm-local'; id: string };
  work: string;
  mainVersion: string;
  contribution: string;
  publicationDecision: string;
  media?: RealmMediaIntent;
  expectedSelectionHead: string | null;
  selectionBasis: 'realm-manager-review' | 'realm-policy';
  policy?: { revision: string; mode: 'trusted-members' | 'open' };
  actingSubject: string;
}

export interface RealmSelectionReceipt {
  outcome: 'succeeded' | 'cancelled';
  reason?: 'stale-head';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  work?: string;
  mainVersion?: string;
  realm?: string;
  slot?: string;
  contribution?: string;
  publicationDecision?: string;
  selectedDraft?: string;
  selection?: string;
  matchUnit?: string;
  expectedHead?: string | null;
  language?: string;
}

export function realmSelectionSlotIri(realm: string, mainVersion: string): string {
  if (!nativeId.test(realm) || !nativeId.test(mainVersion)) {
    throw new InvalidRealmSelectionInput('invalid Realm selection slot');
  }
  return `urn:rezics:realm-selection:${hash(`${realm}\0${mainVersion}`)}`;
}

export function realmSelectionDigest(input: SelectRealmLocalInput): string {
  if (input.context?.kind !== 'realm-local' || !nativeId.test(input.context.id)
    || !nativeId.test(input.work) || !nativeId.test(input.mainVersion)
    || !nativeId.test(input.contribution) || !nativeId.test(input.publicationDecision)
    || (input.media !== undefined && (!/^urn:rezics:variant:[0-9a-f-]{36}$/.test(input.media.variantId)
      || !/^urn:rezics:content-publication:[0-9a-f]{64}$/.test(input.media.publicationDecision)))
    || !nativeId.test(input.actingSubject)
    || (input.expectedSelectionHead !== null && !nativeId.test(input.expectedSelectionHead))
    || (input.selectionBasis !== 'realm-manager-review' && (input.selectionBasis !== 'realm-policy'
      || !input.policy || !/^urn:rezics:realm-policy:[0-9a-f-]{36}$/.test(input.policy.revision)
      || !['trusted-members','open'].includes(input.policy.mode)))) {
    throw new InvalidRealmSelectionInput('invalid Realm selection');
  }
  return hash(JSON.stringify({ family: 'select-realm-local-v1', context: input.context,
    work: input.work, mainVersion: input.mainVersion,
    contribution: input.contribution, publicationDecision: input.publicationDecision,
    ...(input.media ? { media: input.media } : {}),
    expectedSelectionHead: input.expectedSelectionHead,
    selectionBasis: input.selectionBasis, ...(input.policy ? { policy: input.policy } : {}), actor: input.actingSubject,
    selectionPolicy: SELECTION_POLICY, reviewPolicy: REVIEW_POLICY }));
}

export function realmSelectionReceiptIri(admissionId: string, submission = false): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0${submission ? 'realm-submission-submit-v1' : 'select-realm-local'}`)}`;
}

export async function readRealmSelectionReceipt(env: WorkActivationEnvironment,
  admissionId: string, submission = false): Promise<RealmSelectionReceipt | null> {
  const receipt = realmSelectionReceiptIri(admissionId, submission);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?reason ?digest ?id ?epoch ?scope ?dataEpoch ?sequence
    ?work ?main ?realm ?slot ?contribution ?decision ?draft ?selection ?unit ?prior ?language WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:work ?work ; rv:mainVersion ?main ;
        rv:realm ?realm ; rv:slot ?slot ; rv:contribution ?contribution ;
        rv:publicationDecision ?decision ; rv:selectedDraft ?draft ;
        rv:selection ?selection ; rv:matchUnit ?unit ; rv:language ?language .
        OPTIONAL { ${iri(receipt)} rv:expectedHead ?prior } }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('Realm selection receipt cardinality violation');
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const reason = value('reason') === `${RV}StaleHead` ? 'stale-head' : undefined;
  if (!outcome || !value('digest') || !value('id') || !value('epoch') || !value('scope')
    || !value('dataEpoch') || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (value('reason') && !reason)
    || (outcome === 'succeeded' && (!value('work') || !value('main') || !value('realm')
      || !value('slot') || !value('contribution') || !value('decision') || !value('draft')
      || !value('selection') || !value('unit') || !value('language') || reason))
    || (outcome === 'cancelled' && (value('work') || value('main') || value('realm')
      || value('slot') || value('contribution') || value('decision') || value('draft')
      || value('selection') || value('unit') || value('prior') || value('language')))) {
    throw new Error('Realm selection receipt is incomplete');
  }
  return { outcome, ...(reason ? { reason } : {}), receipt,
    admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('epoch')!, scope: value('scope')!,
    dataEpoch: value('dataEpoch')!, sequence: value('sequence')!,
    ...(outcome === 'succeeded' ? { work: value('work'), mainVersion: value('main'),
      realm: value('realm'), slot: value('slot'), contribution: value('contribution'),
      publicationDecision: value('decision'), selectedDraft: value('draft'),
      selection: value('selection'), matchUnit: value('unit'),
      expectedHead: value('prior') ?? null, language: value('language') } : {}) };
}

function matches(receipt: RealmSelectionReceipt, admission: RegisteredAdmission,
  digest: string): boolean {
  return receipt.admissionId === admission.id && receipt.requestDigest === digest
    && receipt.authorityEpoch === admission.authorityEpoch && receipt.scope === admission.scope;
}

export function checkedRealmSelectionReceipt(receipt: RealmSelectionReceipt,
  admission: RegisteredAdmission, input: SelectRealmLocalInput,
  digest: string): RealmSelectionReceipt {
  if (!matches(receipt, admission, digest)) throw new IdempotencyConflict('Realm selection receipt differs');
  if (receipt.outcome === 'cancelled') {
    if (receipt.reason === 'stale-head') throw new StaleRealmSelection('Realm selection is stale');
    throw new RealmSelectionUnavailable('Realm selection was cancelled');
  }
  if (receipt.work !== input.work || receipt.mainVersion !== input.mainVersion
    || receipt.realm !== input.context.id
    || receipt.slot !== realmSelectionSlotIri(input.context.id, input.mainVersion)
    || receipt.contribution !== input.contribution
    || receipt.publicationDecision !== input.publicationDecision
    || receipt.expectedHead !== input.expectedSelectionHead) {
    throw new IdempotencyConflict('Realm selection receipt targets another intent');
  }
  return receipt;
}

async function sealTerminal(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  reason?: 'stale-head', input?: SelectRealmLocalInput): Promise<RealmSelectionReceipt | null> {
  const receipt = realmSelectionReceiptIri(admission.id, admission.action === 'submission.submit');
  const suffix = hash(`${receipt}\0${reason ? 'stale' : 'cancel'}`);
  const batch = `urn:rezics:outbox:${suffix}`;
  const event = `urn:rezics:event:${suffix}`;
  const slot = input && realmSelectionSlotIri(input.context.id, input.mainVersion);
  const staleGuard = reason && input && slot ? `GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.context.id)} a rv:Realm ; rv:realmState rv:Active .
      ${iri(input.work)} rv:mainVersion ${iri(input.mainVersion)} .
      OPTIONAL { ${iri(slot)} rv:selectionHead ?prior }
      OPTIONAL { ${iri(input.contribution)} a rv:TextContribution ;
        rv:work ${iri(input.work)} ; rv:publicationHead ?published }
      ${input.policy ? `OPTIONAL { ${iri(input.context.id)} rv:realmPolicyHead ?policyHead }` : ''}
      ${input.media ? `OPTIONAL { ${iri(input.media.variantId)} a rv:ContentVariant ;
        rv:resource ${iri(input.work)} ; rv:contentPublicationHead ?mediaPublished }` : ''}
    }
    FILTER(COALESCE(?prior, ${iri(NONE)}) != ${iri(input.expectedSelectionHead ?? NONE)}
      || !BOUND(?published) || ?published != ${iri(input.publicationDecision)}
      ${input.policy ? `|| !BOUND(?policyHead) || ?policyHead != ${iri(input.policy.revision)}` : ''}
      ${input.media ? `|| !BOUND(?mediaPublished)
        || ?mediaPublished != ${iri(input.media.publicationDecision)}` : ''})` : '';
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ;
          ${reason ? 'rv:reason rv:StaleHead ;' : ''}
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount ${admission.action === 'submission.submit' ? 0 : 1} .
        ${admission.action === 'submission.submit' ? '' : `${iri(batch)} rv:event ${iri(event)} .
        ${iri(event)} a rv:${reason ? 'RealmSelectionRejectedEvent' : 'RealmSelectionCancelledEvent'} ;
          rv:ordinal 0 ; rv:action "publication.adopt" ; rv:receipt ${iri(receipt)} .`}
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      ${staleGuard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }); } catch { /* resolve ambiguous update through the receipt */ }
  return readRealmSelectionReceipt(env, admission.id, admission.action === 'submission.submit');
}

export async function sealRealmSelectionAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<RealmSelectionReceipt> {
  if (!['publication.adopt', 'submission.submit'].includes(admission.action)) throw new Error('unsupported Realm selection admission');
  const existing = await readRealmSelectionReceipt(env, admission.id, admission.action === 'submission.submit');
  if (existing) {
    if (!matches(existing, admission, admission.requestDigest)) {
      throw new IdempotencyConflict('Realm selection receipt differs from admission');
    }
    return existing;
  }
  const terminal = await sealTerminal(env, admission);
  if (!terminal || !matches(terminal, admission, admission.requestDigest)) {
    throw new PendingActivation('Realm selection cancellation is unknown');
  }
  return terminal;
}

async function validateCandidate(env: WorkActivationEnvironment, selection: string,
  slot: string, input: SelectRealmLocalInput, draft: string): Promise<CommandValidation[]> {
  for (const value of [selection, slot, input.context.id, input.work, input.mainVersion,
    input.contribution, input.publicationDecision, draft]) iri(value);
  const profile = input.policy ? 'realm-policy-selection-v1' : 'realm-local-selection-v1';
  return profileValidations(env.fuseki, profile, [{
    shape: `https://rezics.com/definition/${profile}/selection-shape`, focus: [selection],
    graphs: [GRAPHS.current, GRAPHS.revisions],
  }]);
}

/** Adopt one exact eligible public draft in a Realm/Main Version slot. */
export async function selectRealmLocal(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: SelectRealmLocalInput,
  content?: Pick<ContentCore, 'readExactBatch'>): Promise<RealmSelectionReceipt> {
  const selectionDigest = realmSelectionDigest(input);
  // Only the durable submission owner dispatches a policy adoption with its
  // original submit admission. One terminal receipt atomically records both
  // submission and selection, so recovery cannot acknowledge half an outcome.
  const automatic = admission.action === 'submission.submit' && !!input.policy;
  const digest = automatic ? admission.requestDigest : selectionDigest;
  if (automatic ? admission.scope !== `submission:submit:${input.context.id}`
    || input.selectionBasis !== 'realm-policy' || admission.actingSubject !== input.actingSubject
    : admission.action !== 'publication.adopt'
    || admission.scope !== `publication:adopt:${input.context.id}`
    || admission.actingSubject !== input.actingSubject
    || admission.requestDigest !== digest || !!input.policy) {
    throw new IdempotencyConflict('Realm adoption admission differs from intent');
  }
  await assertNotInvalidProfileReceipt(env.fuseki, realmSelectionReceiptIri(admission.id, admission.action === 'submission.submit'));
  const existing = await readRealmSelectionReceipt(env, admission.id, admission.action === 'submission.submit');
  if (existing) return checkedRealmSelectionReceipt(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Realm adoption expired');
  const profile = input.policy ? 'https://rezics.com/definition/realm-policy-selection-v1' : REALM_SELECTION_PROFILE;
  const policy = input.policy ? reviewPolicy(input.policy.mode) : REVIEW_POLICY;
  const policyGuard = input.policy ? `${iri(input.context.id)} rv:realmPolicyHead ${iri(input.policy.revision)} ;
    rv:reviewPolicy ${iri(policy)} .` : '';
  const slot = realmSelectionSlotIri(input.context.id, input.mainVersion);
  const current = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?draft ?language ?manifest ?prior WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ${iri(input.context.id)} .
        ${iri(input.context.id)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
          rv:selectionPolicy ${iri(SELECTION_POLICY)} . ${policyGuard}
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .
        ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
        ${iri(input.contribution)} a rv:TextContribution ; rv:work ${iri(input.work)} ;
          rv:publicationHead ${iri(input.publicationDecision)} .
        OPTIONAL { ${iri(slot)} rv:selectionHead ?prior }
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(input.publicationDecision)} a rv:PublicationDecision ;
          rv:component ${iri(input.contribution)} ; rv:work ${iri(input.work)} ;
          rv:contribution ${iri(input.contribution)} ; rv:selectedDraft ?draft ;
          rv:language ?language ; rv:rightsBasis rv:OriginalContribution ;
          rv:disclosure rv:Public ; rv:manifest ?manifest ;
          rv:modelRevision ${iri(PUBLICATION_PROFILE)} ;
          rv:shapeRevision ${iri(PUBLICATION_PROFILE)} .
      }
    }`);
  const rows = current.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.draft || !rows[0]?.language || !rows[0]?.manifest) {
    throw new RealmSelectionUnavailable('eligible Realm adoption candidate is unavailable');
  }
  const row = rows[0]!;
  if ((row.prior?.value ?? null) !== input.expectedSelectionHead) {
    const stale = await sealTerminal(env, admission, 'stale-head', input);
    if (stale) return checkedRealmSelectionReceipt(stale, admission, input, digest);
    throw new PendingActivation('stale Realm adoption was not sealed');
  }
  const publication = readComponentState(env.objectDirectory, row.manifest!.value,
    input.contribution, PUBLICATION_PROFILE);
  if (publication.contribution !== input.contribution || publication.work !== input.work
    || publication.selectedDraft !== row.draft!.value || publication.language !== row.language!.value
    || publication.rightsBasis !== 'original-contribution' || publication.disclosure !== 'public') {
    throw new RealmSelectionUnavailable('publication manifest differs from eligible decision');
  }
  const exact = await readExactContributionDraft(env, input.contribution, row.draft!.value,
    async () => true);
  if (exact.work !== input.work || exact.language !== row.language!.value
    || exact.author !== publication.author
    || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(exact.language)) {
    throw new RealmSelectionUnavailable('selected draft differs from eligible decision');
  }
  if (input.media && !content) throw new RealmSelectionUnavailable('Content owner is unavailable');
  const media = input.media && content
    ? await currentRealmMediaSet(env, content, input.work, input.media) : null;
  const selection = ID + Bun.randomUUIDv7();
  const unit = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const validations = await validateCandidate(env, selection, slot, input, exact.revision);
  const manifest = prepareComponent(env.objectDirectory, slot,
    { context: input.context, slot, work: input.work, mainVersion: input.mainVersion,
      contribution: input.contribution, publicationDecision: input.publicationDecision,
      selectedDraft: exact.revision, language: exact.language,
      ...(media ? { media: media.reference } : {}),
      selectionBasis: input.selectionBasis, selectionMode: 'fixed',
      reviewPolicy: policy, ...(input.policy ? { policyRevision: input.policy.revision } : {}), selectionPolicy: SELECTION_POLICY,
      ...(automatic ? { submittingAgent: input.actingSubject } : { reviewer: input.actingSubject }),
      predecessor: input.expectedSelectionHead,
      matchUnit: unit }, profile);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Realm adoption expired');
  const receipt = realmSelectionReceiptIri(admission.id, admission.action === 'submission.submit');
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  const predecessorTriple = input.expectedSelectionHead
    ? `rv:predecessor ${iri(input.expectedSelectionHead)} ;` : '';
  const receiptPredecessor = input.expectedSelectionHead
    ? `rv:expectedHead ${iri(input.expectedSelectionHead)} ;` : '';
  const mediaTriples = media
    ? `rv:mediaVariant ${iri(media.reference.variantId)} ;
          rv:mediaPublicationDecision ${iri(media.reference.publicationDecision)} ;
          rv:mediaRevision ${iri(`urn:rezics:content:revision:${media.reference.revisionId}`)} ;
          rv:mediaDigest ${lit(media.reference.byteDigest)} ;` : '';
  const mediaGuard = media ? `GRAPH ${iri(GRAPHS.current)} {
        ${iri(media.reference.variantId)} a rv:ContentVariant ; rv:resource ${iri(input.work)} ;
          rv:contentPublicationHead ${iri(media.reference.publicationDecision)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(media.reference.publicationDecision)} a rv:ContentPublicationDecision ;
          rv:component ${iri(media.reference.variantId)} ; rv:resource ${iri(input.work)} ;
          rv:contentModel "media-set-v1" ;
          rv:contentRevision ${iri(`urn:rezics:content:revision:${media.reference.revisionId}`)} ;
          rv:byteDigest ${lit(media.reference.byteDigest)} . }` : '';
  try {
    const result = await validatedCommand(env, { receipt, digest, validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:selectionHead ?prior }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?oldUnit ?oldPredicate ?oldValue }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(slot)} a rv:RealmPublicationSlot ; rv:realm ${iri(input.context.id)} ;
          rv:mainVersion ${iri(input.mainVersion)} ; rv:work ${iri(input.work)} ;
          rv:selectionHead ${iri(selection)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(selection)} a rv:PublicationSelection, rv:RevisionAnchor ;
          rv:component ${iri(slot)} ; ${predecessorTriple}
          rv:operation ${iri(operation)} ; rv:context ${iri(input.context.id)} ;
          rv:slot ${iri(slot)} ; rv:work ${iri(input.work)} ;
          rv:mainVersion ${iri(input.mainVersion)} ;
          rv:contribution ${iri(input.contribution)} ;
          rv:publicationDecision ${iri(input.publicationDecision)} ;
          ${mediaTriples}
          rv:selectedDraft ${iri(exact.revision)} ; rv:language ${lit(exact.language)} ;
          rv:selectionBasis rv:${input.policy ? 'RealmPolicy' : 'RealmManagerReview'} ; rv:selectionMode rv:Fixed ;
          ${input.policy ? `rv:realmPolicyHead ${iri(input.policy.revision)} ;` : ''}
          rv:reviewPolicy ${iri(policy)} ; rv:${automatic ? 'submittingAgent' : 'reviewer'} ${iri(input.actingSubject)} ;
          rv:matchUnit ${iri(unit)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(profile)} ;
          rv:shapeRevision ${iri(profile)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(unit)} a rv:MatchUnit ; rv:work ${iri(input.work)} ;
          rv:mainVersion ${iri(input.mainVersion)} ; rv:context ${iri(input.context.id)} ;
          rv:realm ${iri(input.context.id)} ; rv:slot ${iri(slot)} ;
          rv:contribution ${iri(input.contribution)} ; rv:revision ${iri(exact.revision)} ;
          rv:selection ${iri(selection)} ; rv:language ${lit(exact.language)} ;
          rv:field rv:Body ; rv:disclosure rv:Public ;
          rv:searchBody ${lit(exact.body)}@${exact.language} .
        ${iri(unit)} rv:searchResultWork ?parentWork ; rv:searchResultMain ?parentMain ;
          rv:searchChapterTitle ?chapterTitle .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:work ${iri(input.work)} ; rv:mainVersion ${iri(input.mainVersion)} ;
          rv:realm ${iri(input.context.id)} ; rv:slot ${iri(slot)} ;
          rv:contribution ${iri(input.contribution)} ;
          rv:publicationDecision ${iri(input.publicationDecision)} ;
          rv:selectedDraft ${iri(exact.revision)} ; rv:selection ${iri(selection)} ;
          rv:matchUnit ${iri(unit)} ; ${receiptPredecessor}
          rv:language ${lit(exact.language)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:${automatic ? 'RealmSubmissionSelectedEvent' : 'RealmSelectionChangedEvent'} ; rv:ordinal 0 ;
          rv:action ${lit(admission.action)} ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} ; rv:work ${iri(input.work)} ;
          rv:realm ${iri(input.context.id)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ${iri(input.context.id)} .
        ${iri(input.context.id)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
          rv:selectionPolicy ${iri(SELECTION_POLICY)} . ${policyGuard}
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .
        ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
        ${iri(input.contribution)} a rv:TextContribution ; rv:work ${iri(input.work)} ;
          rv:publicationHead ${iri(input.publicationDecision)} .
        OPTIONAL { ${iri(slot)} rv:selectionHead ?prior }
      }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.work)} schema:isPartOf ?parentWork ;
          <http://www.w3.org/2000/01/rdf-schema#label> ?chapterTitle .
        ?parentWork a schema:Book ; rv:mainVersion ?parentMain .
      } }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(input.publicationDecision)} a rv:PublicationDecision ;
          rv:component ${iri(input.contribution)} ; rv:selectedDraft ${iri(exact.revision)} ;
          rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public .
        ${iri(exact.revision)} a rv:RevisionAnchor ; rv:component ${iri(input.contribution)} .
      }
      ${mediaGuard}
      OPTIONAL {
        FILTER(BOUND(?prior))
        GRAPH ${iri(GRAPHS.revisions)} { ?prior rv:matchUnit ?oldUnit ; rv:slot ${iri(slot)} }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ?oldUnit a rv:MatchUnit ; rv:slot ${iri(slot)} ; rv:selection ?prior .
          ?oldUnit ?oldPredicate ?oldValue .
        }
      }
      OPTIONAL {
        FILTER(BOUND(?prior))
        GRAPH ${iri(GRAPHS.revisions)} {
          ?prior a rv:RealmPublicationRejection ; rv:slot ${iri(slot)} .
        }
        BIND(true AS ?priorRejected)
      }
      FILTER(COALESCE(?prior, ${iri(NONE)}) = ${iri(input.expectedSelectionHead ?? NONE)})
      FILTER(!BOUND(?prior) || (BOUND(?oldUnit) != BOUND(?priorRejected)))
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(selection)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }, admission);
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') {
      throw new InvalidRealmSelectionInput(`Realm selection validation ${result.status}`);
    }
  } catch (error) {
    if (error instanceof InvalidRealmSelectionInput || error instanceof CommandRejected) throw error;
    /* resolve by terminal receipt */
  }
  const committed = await readRealmSelectionReceipt(env, admission.id, admission.action === 'submission.submit');
  if (committed) return checkedRealmSelectionReceipt(committed, admission, input, digest);
  const stale = await sealTerminal(env, admission, 'stale-head', input);
  if (stale) return checkedRealmSelectionReceipt(stale, admission, input, digest);
  throw new PendingActivation('Realm adoption guard did not match');
}
