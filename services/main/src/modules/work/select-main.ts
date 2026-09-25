import { CommandRejected, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { readExactContributionDraft } from '../contribution/history.ts';
import { PUBLICATION_PROFILE } from '../contribution/publish.ts';
import { readComponentState } from './history.ts';
import { DATASET, GRAPHS, ID, PROFILE, RV, hash, iri, lit, prepareComponent,
  prepareWorkComponent, workMetadataValidations, IdempotencyConflict, PendingActivation,
  type WorkActivationEnvironment } from './activate.ts';

export const MAIN_SELECTION_PROFILE = 'https://rezics.com/definition/main-default-selection-v1';
export const PUBLIC_SEARCH_GRAPH = 'urn:rezics:search:public';
const NONE = 'urn:rezics:none';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export class InvalidMainSelectionInput extends Error {}
export class StaleMainSelection extends Error {}
export class MainSelectionUnavailable extends Error {}

export interface SelectMainDefaultInput {
  context: { kind: 'main-version-default'; id: string };
  work: string;
  contribution: string;
  publicationDecision: string;
  expectedSelectionHead: string | null;
  selectionBasis: 'main-maintainer';
  actingSubject: string;
}

export interface MainSelectionReceipt {
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
  contribution?: string;
  publicationDecision?: string;
  selectedDraft?: string;
  selection?: string;
  mainRevision?: string;
  matchUnit?: string;
  expectedHead?: string | null;
  language?: string;
}

export function mainSelectionDigest(input: SelectMainDefaultInput): string {
  if (input.context?.kind !== 'main-version-default' || !nativeId.test(input.context.id)
    || !nativeId.test(input.work) || !nativeId.test(input.contribution)
    || !nativeId.test(input.publicationDecision) || !nativeId.test(input.actingSubject)
    || (input.expectedSelectionHead !== null && !nativeId.test(input.expectedSelectionHead))
    || input.selectionBasis !== 'main-maintainer') {
    throw new InvalidMainSelectionInput('invalid Main Version selection');
  }
  return hash(JSON.stringify({ family: 'select-main-default-v1', context: input.context,
    work: input.work, contribution: input.contribution,
    publicationDecision: input.publicationDecision,
    expectedSelectionHead: input.expectedSelectionHead,
    selectionBasis: input.selectionBasis, actor: input.actingSubject }));
}

export function mainSelectionReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0select-main-default`)}`;
}

export async function readMainSelectionReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<MainSelectionReceipt | null> {
  const receipt = mainSelectionReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?reason ?digest ?id ?epoch ?scope ?dataEpoch ?sequence
    ?work ?main ?mainRevision ?contribution ?decision ?draft ?selection ?unit ?prior ?language WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:work ?work ; rv:mainVersion ?main ;
        rv:mainRevision ?mainRevision ;
        rv:contribution ?contribution ; rv:publicationDecision ?decision ;
        rv:selectedDraft ?draft ; rv:selection ?selection ; rv:matchUnit ?unit ;
        rv:language ?language .
        OPTIONAL { ${iri(receipt)} rv:expectedHead ?prior } }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('Main selection receipt cardinality violation');
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const reason = value('reason') === `${RV}StaleHead` ? 'stale-head' : undefined;
  if (!outcome || !value('digest') || !value('id') || !value('epoch') || !value('scope')
    || !value('dataEpoch') || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (value('reason') && !reason)
    || (outcome === 'succeeded' && (!value('work') || !value('main') || !value('mainRevision')
      || !value('contribution') || !value('decision') || !value('draft')
      || !value('selection') || !value('unit') || !value('language') || reason))
    || (outcome === 'cancelled' && (value('work') || value('main') || value('mainRevision')
      || value('contribution') || value('decision') || value('draft')
      || value('selection') || value('unit') || value('prior') || value('language')))) {
    throw new Error('Main selection receipt is incomplete');
  }
  return { outcome, ...(reason ? { reason } : {}), receipt,
    admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('epoch')!, scope: value('scope')!,
    dataEpoch: value('dataEpoch')!, sequence: value('sequence')!,
    ...(outcome === 'succeeded' ? { work: value('work'), mainVersion: value('main'),
      mainRevision: value('mainRevision'),
      contribution: value('contribution'), publicationDecision: value('decision'),
      selectedDraft: value('draft'), selection: value('selection'), matchUnit: value('unit'),
      expectedHead: value('prior') ?? null, language: value('language') } : {}) };
}

function matches(receipt: MainSelectionReceipt, admission: RegisteredAdmission,
  digest: string): boolean {
  return receipt.admissionId === admission.id && receipt.requestDigest === digest
    && receipt.authorityEpoch === admission.authorityEpoch && receipt.scope === admission.scope;
}

export function checkedMainSelectionReceipt(receipt: MainSelectionReceipt,
  admission: RegisteredAdmission, input: SelectMainDefaultInput,
  digest: string): MainSelectionReceipt {
  if (!matches(receipt, admission, digest)) throw new IdempotencyConflict('selection receipt differs');
  if (receipt.outcome === 'cancelled') {
    if (receipt.reason === 'stale-head') throw new StaleMainSelection('Main selection is stale');
    throw new MainSelectionUnavailable('Main selection was cancelled');
  }
  if (receipt.work !== input.work || receipt.mainVersion !== input.context.id
    || receipt.contribution !== input.contribution
    || receipt.publicationDecision !== input.publicationDecision
    || receipt.expectedHead !== input.expectedSelectionHead || !receipt.mainRevision) {
    throw new IdempotencyConflict('selection receipt targets another intent');
  }
  return receipt;
}

async function sealTerminal(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  reason?: 'stale-head', input?: SelectMainDefaultInput): Promise<MainSelectionReceipt | null> {
  const receipt = mainSelectionReceiptIri(admission.id);
  const suffix = hash(`${receipt}\0${reason ? 'stale' : 'cancel'}`);
  const batch = `urn:rezics:outbox:${suffix}`;
  const event = `urn:rezics:event:${suffix}`;
  const staleGuard = reason && input ? `GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.context.id)} a rv:MainVersion ; rv:work ${iri(input.work)} .
      OPTIONAL { ${iri(input.context.id)} rv:selectionHead ?prior }
      OPTIONAL { ${iri(input.contribution)} a rv:TextContribution ;
        rv:work ${iri(input.work)} ; rv:publicationHead ?published }
    }
    FILTER(COALESCE(?prior, ${iri(NONE)}) != ${iri(input.expectedSelectionHead ?? NONE)}
      || !BOUND(?published) || ?published != ${iri(input.publicationDecision)})` : '';
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
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:${reason ? 'PublicationSelectionRejectedEvent' : 'PublicationSelectionCancelledEvent'} ;
          rv:ordinal 0 ; rv:action "publication.select" ; rv:receipt ${iri(receipt)} .
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
  return readMainSelectionReceipt(env, admission.id);
}

export async function sealMainSelectionAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<MainSelectionReceipt> {
  if (admission.action !== 'publication.select') throw new Error('unsupported selection admission');
  const existing = await readMainSelectionReceipt(env, admission.id);
  if (existing) {
    if (!matches(existing, admission, admission.requestDigest)) {
      throw new IdempotencyConflict('selection receipt differs from admission');
    }
    return existing;
  }
  const terminal = await sealTerminal(env, admission);
  if (!terminal || !matches(terminal, admission, admission.requestDigest)) {
    throw new PendingActivation('selection cancellation is unknown');
  }
  return terminal;
}

async function validateCandidate(env: WorkActivationEnvironment, selection: string,
  work: string, main: string, contribution: string, decision: string, draft: string): Promise<CommandValidation[]> {
  for (const value of [selection, work, main, contribution, decision, draft]) iri(value);
  return [...await profileValidations(env.fuseki, 'main-default-selection-v1', [{
    shape: `${MAIN_SELECTION_PROFILE}/selection-shape`, focus: [selection],
    graphs: [GRAPHS.current, GRAPHS.revisions],
  }]), ...await workMetadataValidations(env, work, main)];
}

/** Select one eligible exact text state for the common Main Version entry. */
export async function selectMainDefault(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: SelectMainDefaultInput): Promise<MainSelectionReceipt> {
  const digest = mainSelectionDigest(input);
  if (admission.action !== 'publication.select'
    || admission.scope !== `publication:select:${input.context.id}`
    || admission.actingSubject !== input.actingSubject
    || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('selection admission differs from intent');
  }
  await assertNotInvalidProfileReceipt(env.fuseki, mainSelectionReceiptIri(admission.id));
  const existing = await readMainSelectionReceipt(env, admission.id);
  if (existing) return checkedMainSelectionReceipt(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('selection admission expired');
  const current = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?draft ?language ?manifest ?prior ?mainHead WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.context.id)} .
        ${iri(input.context.id)} a rv:MainVersion ; rv:work ${iri(input.work)} ;
          rv:head ?mainHead ; rv:hostingPolicy rv:MetadataOnly .
        ${iri(input.contribution)} a rv:TextContribution ; rv:work ${iri(input.work)} ;
          rv:publicationHead ${iri(input.publicationDecision)} .
        OPTIONAL { ${iri(input.context.id)} rv:selectionHead ?prior }
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
  if (rows.length !== 1 || !rows[0]?.draft || !rows[0]?.language || !rows[0]?.manifest
    || !rows[0]?.mainHead) {
    throw new MainSelectionUnavailable('eligible Contribution publication is unavailable');
  }
  const row = rows[0]!;
  if ((row.prior?.value ?? null) !== input.expectedSelectionHead) {
    const stale = await sealTerminal(env, admission, 'stale-head', input);
    if (stale) return checkedMainSelectionReceipt(stale, admission, input, digest);
    throw new PendingActivation('stale Main selection was not sealed');
  }
  const publication = readComponentState(env.objectDirectory, row.manifest!.value,
    input.contribution, PUBLICATION_PROFILE);
  if (publication.contribution !== input.contribution || publication.work !== input.work
    || publication.selectedDraft !== row.draft!.value || publication.language !== row.language!.value
    || publication.rightsBasis !== 'original-contribution' || publication.disclosure !== 'public') {
    throw new MainSelectionUnavailable('publication manifest differs from eligible decision');
  }
  const exact = await readExactContributionDraft(env, input.contribution, row.draft!.value,
    async () => true);
  if (exact.work !== input.work || exact.language !== row.language!.value
    || exact.author !== publication.author
    || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(exact.language)) {
    throw new MainSelectionUnavailable('selected draft differs from eligible decision');
  }
  const selection = ID + Bun.randomUUIDv7();
  const mainRevision = ID + Bun.randomUUIDv7();
  const unit = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const validations = await validateCandidate(env, selection, input.work, input.context.id,
    input.contribution, input.publicationDecision, exact.revision);
  const manifest = prepareComponent(env.objectDirectory, input.context.id,
    { context: { kind: 'main-version-default', id: input.context.id },
      work: input.work, contribution: input.contribution,
      publicationDecision: input.publicationDecision, selectedDraft: exact.revision,
      language: exact.language, selectionBasis: input.selectionBasis,
      selectionMode: 'fixed', predecessor: input.expectedSelectionHead,
      matchUnit: unit }, MAIN_SELECTION_PROFILE);
  const mainState = { work: input.work, hostingPolicy: 'metadata-only',
    defaultSelection: selection, predecessor: row.mainHead!.value };
  const mainManifest = env.workObjects
    ? await prepareWorkComponent(env.workObjects, input.context.id, mainState)
    : prepareComponent(env.objectDirectory, input.context.id, mainState);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('selection admission expired');
  const receipt = mainSelectionReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  const predecessorTriple = input.expectedSelectionHead
    ? `rv:predecessor ${iri(input.expectedSelectionHead)} ;` : '';
  const receiptPredecessor = input.expectedSelectionHead
    ? `rv:expectedHead ${iri(input.expectedSelectionHead)} ;` : '';
  try {
    const result = await validatedCommand(env, { receipt, digest, validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.context.id)} rv:selectionHead ?prior ;
        rv:head ${iri(row.mainHead!.value)} }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?oldUnit ?oldPredicate ?oldValue }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.context.id)} rv:selectionHead ${iri(selection)} ;
        rv:head ${iri(mainRevision)} }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(mainRevision)} a rv:RevisionAnchor ; rv:component ${iri(input.context.id)} ;
          rv:predecessor ${iri(row.mainHead!.value)} ; rv:operation ${iri(operation)} ;
          rv:manifest ${iri(`urn:rezics:sha256:${mainManifest}`)} ;
          rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
        ${iri(selection)} a rv:PublicationSelection, rv:RevisionAnchor ;
          rv:component ${iri(input.context.id)} ; ${predecessorTriple}
          rv:operation ${iri(operation)} ; rv:context ${iri(input.context.id)} ;
          rv:work ${iri(input.work)} ; rv:mainVersion ${iri(input.context.id)} ;
          rv:mainRevision ${iri(mainRevision)} ;
          rv:contribution ${iri(input.contribution)} ;
          rv:publicationDecision ${iri(input.publicationDecision)} ;
          rv:selectedDraft ${iri(exact.revision)} ; rv:language ${lit(exact.language)} ;
          rv:selectionBasis rv:MainMaintainer ; rv:selectionMode rv:Fixed ;
          rv:matchUnit ${iri(unit)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(MAIN_SELECTION_PROFILE)} ;
          rv:shapeRevision ${iri(MAIN_SELECTION_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(unit)} a rv:MatchUnit ; rv:work ${iri(input.work)} ;
          rv:mainVersion ${iri(input.context.id)} ; rv:context ${iri(input.context.id)} ;
          rv:contribution ${iri(input.contribution)} ; rv:revision ${iri(exact.revision)} ;
          rv:selection ${iri(selection)} ; rv:language ${lit(exact.language)} ;
          rv:field rv:Body ; rv:disclosure rv:Public ;
          rv:searchBody ${lit(exact.body)}@${exact.language} .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:work ${iri(input.work)} ; rv:mainVersion ${iri(input.context.id)} ;
          rv:mainRevision ${iri(mainRevision)} ;
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
        ${iri(event)} a rv:PublicationSelectionChangedEvent ; rv:ordinal 0 ;
          rv:action "publication.select" ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} ; rv:work ${iri(input.work)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.context.id)} .
        ${iri(input.context.id)} a rv:MainVersion ; rv:work ${iri(input.work)} ;
          rv:head ${iri(row.mainHead!.value)} ; rv:hostingPolicy rv:MetadataOnly .
        ${iri(input.contribution)} a rv:TextContribution ; rv:work ${iri(input.work)} ;
          rv:publicationHead ${iri(input.publicationDecision)} .
        OPTIONAL { ${iri(input.context.id)} rv:selectionHead ?prior }
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(row.mainHead!.value)} a rv:RevisionAnchor ;
          rv:component ${iri(input.context.id)} .
        ${iri(input.publicationDecision)} a rv:PublicationDecision ;
          rv:component ${iri(input.contribution)} ; rv:selectedDraft ${iri(exact.revision)} ;
          rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public .
        ${iri(exact.revision)} a rv:RevisionAnchor ; rv:component ${iri(input.contribution)} .
      }
      OPTIONAL {
        FILTER(BOUND(?prior))
        GRAPH ${iri(GRAPHS.revisions)} { ?prior rv:matchUnit ?oldUnit }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ?oldUnit a rv:MatchUnit ; rv:mainVersion ${iri(input.context.id)} ;
            rv:selection ?prior .
          ?oldUnit ?oldPredicate ?oldValue .
        }
      }
      FILTER(COALESCE(?prior, ${iri(NONE)}) = ${iri(input.expectedSelectionHead ?? NONE)})
      FILTER(!BOUND(?prior) || BOUND(?oldUnit))
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(selection)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(mainRevision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }, admission);
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') {
      throw new InvalidMainSelectionInput(`Main selection validation ${result.status}`);
    }
  } catch (error) {
    if (error instanceof InvalidMainSelectionInput || error instanceof CommandRejected) throw error;
    /* resolve by terminal receipt */
  }
  const committed = await readMainSelectionReceipt(env, admission.id);
  if (committed) return checkedMainSelectionReceipt(committed, admission, input, digest);
  const stale = await sealTerminal(env, admission, 'stale-head', input);
  if (stale) return checkedMainSelectionReceipt(stale, admission, input, digest);
  throw new PendingActivation('Main selection guard did not match');
}
