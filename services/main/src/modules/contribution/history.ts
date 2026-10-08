import type { Pool } from 'pg';
import { AccessAdmissionRegistry, AdmissionDenied } from '../access/admission.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState, RevisionCorrupt, RevisionNotFound, RevisionUnavailable,
  type RevisionReadBudget } from '../work/history.ts';
import { CONTRIBUTION_CREATE_READ_COST, CONTRIBUTION_PROFILE, ContributionReadExpired,
  admittedContributionLanguage, assertContributionReadOpen, queryContributionGraph,
  textContributionDigest, textContributionReceiptIri, withContributionGraphRead } from './draft.ts';
import { textContributionEditDigest, textContributionEditReceiptIri } from './edit.ts';
import type { DocumentSnapshot } from '@rezics/document';
import { retainedDocumentBody } from '../../../../content/src/document-body.ts';

export interface ExactContributionDraft {
  contribution: string;
  revision: string;
  work: string;
  author: string;
  language: string;
  body: string;
  document?: DocumentSnapshot;
  predecessor?: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

/** Original create bytes. The receipt author is the Access-admitted create actor. */
export interface OriginalContributionCreateSource extends ExactContributionDraft {
  receipt: string;
  requestDigest: string;
  admissionId: string;
  authorityEpoch: string;
  scope: string;
}

/** One edit head. `author` stays the original creator; `actor` is the editor the digest used. */
export interface OriginalContributionEditSource extends ExactContributionDraft {
  receipt: string;
  requestDigest: string;
  admissionId: string;
  authorityEpoch: string;
  scope: string;
  expectedHead: string;
  actor: string;
}

export interface ContributionHistoryRead {
  signal?: AbortSignal;
  /** Manifest and payload share this budget; a later read does not refill it. */
  budget?: RevisionReadBudget;
}

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const admissionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
/** Public draft GET: one current-Work ASK, then the anchor, identity, receipt discovery, and receipt triples. */
const EXACT_DRAFT_READ_CALLS = 1 + 4;
/** Admission ASK, receipt discovery, unfiltered receipt triples, unfiltered revision triples. */
const ORIGINAL_CREATE_READ_CALLS = 1 + 3;
const ORIGINAL_EDIT_READ_CALLS = 1 + 3;
const CREATE_RECEIPT_TRIPLES = 15;
const EDIT_RECEIPT_TRIPLES = 16;
const HEAD_RECEIPT_TRIPLES = EDIT_RECEIPT_TRIPLES + 1;
const CREATE_ANCHOR_TRIPLES = 9;
const EDIT_ANCHOR_TRIPLES = 10;

type RdfTerm = { type: string; value: string; datatype?: string; 'xml:lang'?: string };
type Row = Record<string, RdfTerm | undefined>;

const CREATE_RECEIPT_PREDICATES = [
  RDF_TYPE, `${RV}operation`, `${RV}requestDigest`, `${RV}admissionId`, `${RV}authorityEpoch`,
  `${RV}admittedScope`, `${RV}outcome`, `${RV}work`, `${RV}contribution`, `${RV}draftRevision`,
  `${RV}language`, `${RV}author`, `${RV}datasetId`, `${RV}dataEpoch`, `${RV}sequence`,
] as const;

const CREATE_ANCHOR_PREDICATES = [
  RDF_TYPE, `${RV}component`, `${RV}operation`, `${RV}manifest`, `${RV}modelRevision`,
  `${RV}shapeRevision`, `${RV}datasetId`, `${RV}dataEpoch`, `${RV}sequence`,
] as const;

const EDIT_RECEIPT_PREDICATES = [
  RDF_TYPE, `${RV}operation`, `${RV}requestDigest`, `${RV}admissionId`, `${RV}authorityEpoch`,
  `${RV}admittedScope`, `${RV}outcome`, `${RV}work`, `${RV}contribution`, `${RV}draftRevision`,
  `${RV}expectedHead`, `${RV}language`, `${RV}author`, `${RV}datasetId`, `${RV}dataEpoch`,
  `${RV}sequence`,
] as const;

const EDIT_ANCHOR_PREDICATES = [...CREATE_ANCHOR_PREDICATES, `${RV}predecessor`] as const;

function objectBudget(signal: AbortSignal, budget?: RevisionReadBudget): RevisionReadBudget {
  return budget ?? { bytesLeft: CONTRIBUTION_CREATE_READ_COST.objectBytes, signal };
}

function isUri(term: RdfTerm | undefined): term is RdfTerm {
  return !!term && term.type === 'uri' && term.datatype === undefined && term['xml:lang'] === undefined
    && term.value.length > 0;
}

function isPlainString(term: RdfTerm | undefined): term is RdfTerm {
  return !!term && term.type === 'literal' && term['xml:lang'] === undefined
    && (term.datatype === undefined || term.datatype === XSD_STRING) && term.value.length > 0;
}

function isInteger(term: RdfTerm | undefined): term is RdfTerm {
  return !!term && term.type === 'literal' && term.datatype === XSD_INTEGER
    && term['xml:lang'] === undefined && /^[0-9]+$/.test(term.value);
}

async function admitContributionRead(contribution: string, signal: AbortSignal,
  canRead: (contribution: string) => Promise<boolean>): Promise<void> {
  assertContributionReadOpen(signal);
  let allowed: boolean;
  try { allowed = await canRead(contribution); }
  catch (error) {
    if (signal.aborted) throw new ContributionReadExpired('contribution read expired');
    throw error;
  }
  assertContributionReadOpen(signal);
  if (!allowed) throw new RevisionNotFound('draft revision is unavailable');
}

/** Exact immutable draft read, gated by current private Contribution authority. */
export async function readExactContributionDraft(
  env: WorkActivationEnvironment, contribution: string, revision: string,
  canRead: (contribution: string) => Promise<boolean>, options?: ContributionHistoryRead,
): Promise<ExactContributionDraft> {
  return withContributionGraphRead(EXACT_DRAFT_READ_CALLS, options?.signal, async signal => {
    await admitContributionRead(contribution, signal, canRead);
    const result = await queryContributionGraph(env, `PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?component ?manifest ?model ?shape ?dataset ?epoch ?sequence ?predecessor WHERE {
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(revision)} a rv:RevisionAnchor ; rv:component ?component ;
            rv:manifest ?manifest ; rv:modelRevision ?model ; rv:shapeRevision ?shape ;
            rv:datasetId ?dataset ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
          OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor }
        }
      } LIMIT 2`, signal);
    assertContributionReadOpen(signal);
    const rows = result.results?.bindings ?? [];
    if (rows.length === 0) throw new RevisionNotFound('draft revision is unavailable');
    if (rows.length !== 1) throw new RevisionCorrupt('draft revision anchor is ambiguous');
    const row = rows[0]!;
    if (row.component?.value !== contribution) throw new RevisionNotFound('draft revision is unavailable');
    if (row.model?.value !== CONTRIBUTION_PROFILE || row.shape?.value !== CONTRIBUTION_PROFILE
      || row.dataset?.value !== DATASET || !row.epoch?.value
      || !/^[0-9]+$/.test(row.sequence?.value ?? '')) {
      throw new RevisionCorrupt('draft revision anchor is incomplete');
    }
    const state = readComponentState(env.objectDirectory, row.manifest?.value ?? '',
      contribution, CONTRIBUTION_PROFILE, objectBudget(signal, options?.budget));
    assertContributionReadOpen(signal);
    if (typeof state.work !== 'string' || typeof state.author !== 'string'
      || typeof state.language !== 'string' || typeof state.body !== 'string'
      || state.publication !== 'draft') {
      throw new RevisionCorrupt('draft payload does not match Contribution profile');
    }
    const identity = await queryContributionGraph(env, `PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(state.work)} ;
          rv:author ${iri(state.author)} ; rv:language ${lit(state.language)} .
      }
    }`, signal);
    assertContributionReadOpen(signal);
    if (identity.boolean !== true) throw new RevisionCorrupt('draft payload differs from Contribution identity');
    let content;
    try { content = retainedDocumentBody(state); }
    catch { throw new RevisionCorrupt('draft document or text projection is corrupt'); }
    assertContributionReadOpen(signal);
    const predecessor = row.predecessor?.value;
    await reconcileExactHeadReceipt(env, signal, { contribution, revision,
      ...(predecessor ? { predecessor } : {}), work: state.work, author: state.author,
      language: state.language, dataEpoch: row.epoch.value, sequence: row.sequence.value, content });
    assertContributionReadOpen(signal);
    return { contribution, revision, work: state.work, author: state.author,
      language: state.language, ...content,
      ...(predecessor ? { predecessor } : {}),
      sourcePosition: { datasetId: 'product', dataEpoch: row.epoch.value,
        sequence: row.sequence.value } };
  });
}

function discoverCreateReceipt(contribution: string): string {
  return `PREFIX rv: <${RV}>
    SELECT ?receipt WHERE {
      GRAPH ${iri(GRAPHS.receipts)} {
        ?receipt a rv:OperationReceipt ;
          rv:contribution ?contribution ;
          rv:admittedScope ?scope .
        FILTER(?contribution = ${iri(contribution)})
        FILTER(STRSTARTS(STR(?scope), "contribution:create:"))
      }
    } LIMIT 2`;
}

function subjectTriples(graph: string, subject: string, limit: number): string {
  return `SELECT ?p ?o WHERE { GRAPH ${iri(graph)} { ${iri(subject)} ?p ?o } } LIMIT ${limit}`;
}

function groupSubject(rows: readonly Row[], expected: number, conflict: string,
  invalid = 'original contribution create term type is invalid'): Map<string, RdfTerm[]> {
  if (rows.length > expected) throw new RevisionCorrupt(conflict);
  const fields = new Map<string, RdfTerm[]>();
  for (const row of rows) {
    const predicate = row.p;
    const object = row.o;
    if (!isUri(predicate) || !object || object['xml:lang'] !== undefined
      || (object.type !== 'uri' && object.type !== 'literal')
      || (object.type === 'uri' && object.datatype !== undefined)) {
      throw new RevisionCorrupt(invalid);
    }
    const values = fields.get(predicate.value) ?? [];
    values.push(object);
    fields.set(predicate.value, values);
  }
  return fields;
}

function one(fields: Map<string, RdfTerm[]>, predicate: string, conflict: string): RdfTerm {
  const values = fields.get(predicate) ?? [];
  if (values.length !== 1) throw new RevisionCorrupt(conflict);
  return values[0]!;
}

function requireCreateReceipt(contribution: string, rows: readonly Row[]): {
  requestDigest: string; admissionId: string; authorityEpoch: string;
  scope: string; work: string; author: string; language: string; revision: string;
  dataEpoch: string; sequence: string;
} {
  const conflict = 'original contribution create source conflicts';
  if (rows.some(row => row.p?.value === `${RV}expectedHead` || row.p?.value === `${RV}reason`)) {
    throw new RevisionCorrupt('original contribution create source is an edit receipt');
  }
  if (rows.some(row => row.p?.value === `${RV}admittedScope` && row.o?.value.startsWith('contribution:edit:'))) {
    throw new RevisionCorrupt('original contribution create source is an edit admission');
  }
  const fields = groupSubject(rows, CREATE_RECEIPT_TRIPLES, conflict);
  if (fields.size !== CREATE_RECEIPT_PREDICATES.length
    || CREATE_RECEIPT_PREDICATES.some(predicate => !fields.has(predicate))) {
    throw new RevisionCorrupt(conflict);
  }
  const type = one(fields, RDF_TYPE, conflict);
  const operation = one(fields, `${RV}operation`, conflict);
  const requestDigest = one(fields, `${RV}requestDigest`, conflict);
  const admissionId = one(fields, `${RV}admissionId`, conflict);
  const authorityEpoch = one(fields, `${RV}authorityEpoch`, conflict);
  const scope = one(fields, `${RV}admittedScope`, conflict);
  const outcome = one(fields, `${RV}outcome`, conflict);
  const work = one(fields, `${RV}work`, conflict);
  const recordedContribution = one(fields, `${RV}contribution`, conflict);
  const revision = one(fields, `${RV}draftRevision`, conflict);
  const language = one(fields, `${RV}language`, conflict);
  const author = one(fields, `${RV}author`, conflict);
  const dataset = one(fields, `${RV}datasetId`, conflict);
  const dataEpoch = one(fields, `${RV}dataEpoch`, conflict);
  const sequence = one(fields, `${RV}sequence`, conflict);
  if (!isUri(type) || type.value !== `${RV}OperationReceipt` || !isUri(outcome)
    || outcome.value !== `${RV}Succeeded` || !isUri(operation) || !nativeId.test(operation.value)) {
    throw new RevisionCorrupt(conflict);
  }
  if (!isUri(work) || !isUri(author) || !isUri(recordedContribution) || !isUri(revision)
    || !isUri(dataset) || !isPlainString(requestDigest) || !isPlainString(admissionId)
    || !isPlainString(authorityEpoch) || !isPlainString(scope) || !isPlainString(language)
    || !isPlainString(dataEpoch) || !isInteger(sequence)) {
    throw new RevisionCorrupt('original contribution create term type is invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(requestDigest.value) || !admissionIdPattern.test(admissionId.value)
    || !/^(0|[1-9][0-9]*)$/.test(authorityEpoch.value) || !nativeId.test(work.value)
    || !nativeId.test(author.value) || !nativeId.test(revision.value)
    || !admittedContributionLanguage(language.value) || dataEpoch.value.length > 128
    || dataset.value !== DATASET) {
    throw new RevisionCorrupt('original contribution create receipt is incomplete');
  }
  if (scope.value !== `contribution:create:${work.value}`) {
    throw new RevisionCorrupt('original contribution create source is an edit admission');
  }
  if (recordedContribution.value !== contribution) {
    throw new RevisionCorrupt('original contribution create receipt names another contribution');
  }
  return { requestDigest: requestDigest.value, admissionId: admissionId.value,
    authorityEpoch: authorityEpoch.value, scope: scope.value, work: work.value, author: author.value,
    language: language.value, revision: revision.value, dataEpoch: dataEpoch.value,
    sequence: sequence.value };
}

function requireCreateAnchor(contribution: string, revision: string, receiptEpoch: string,
  receiptSequence: string, rows: readonly Row[]): string {
  const ambiguous = 'original contribution create revision is ambiguous';
  if (rows.some(row => row.p?.value === `${RV}predecessor`)) {
    throw new RevisionCorrupt('original contribution create revision has a predecessor');
  }
  const fields = groupSubject(rows, CREATE_ANCHOR_TRIPLES, ambiguous);
  if (fields.size === 0) throw new RevisionNotFound('draft revision is unavailable');
  if (fields.size !== CREATE_ANCHOR_PREDICATES.length
    || CREATE_ANCHOR_PREDICATES.some(predicate => !fields.has(predicate))) {
    throw new RevisionCorrupt(ambiguous);
  }
  const type = one(fields, RDF_TYPE, ambiguous);
  const component = one(fields, `${RV}component`, ambiguous);
  const manifest = one(fields, `${RV}manifest`, ambiguous);
  const model = one(fields, `${RV}modelRevision`, ambiguous);
  const shape = one(fields, `${RV}shapeRevision`, ambiguous);
  const dataset = one(fields, `${RV}datasetId`, ambiguous);
  const epoch = one(fields, `${RV}dataEpoch`, ambiguous);
  const sequence = one(fields, `${RV}sequence`, ambiguous);
  const operation = one(fields, `${RV}operation`, ambiguous);
  if (!isUri(type) || type.value !== `${RV}RevisionAnchor` || !isUri(component)
    || !isUri(manifest) || !isUri(model) || !isUri(shape) || !isUri(dataset) || !isUri(operation)
    || !isPlainString(epoch) || !isInteger(sequence)) {
    throw new RevisionCorrupt('original contribution create term type is invalid');
  }
  if (component.value !== contribution || !nativeId.test(revision)) {
    throw new RevisionCorrupt('original contribution create revision does not match its receipt');
  }
  if (model.value !== CONTRIBUTION_PROFILE || shape.value !== CONTRIBUTION_PROFILE) {
    throw new RevisionCorrupt('original contribution create model does not match its receipt');
  }
  if (epoch.value !== receiptEpoch || sequence.value !== receiptSequence || dataset.value !== DATASET) {
    throw new RevisionCorrupt('original contribution create source position does not match its receipt');
  }
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifest.value)) {
    throw new RevisionCorrupt('original contribution create revision does not match its receipt');
  }
  return manifest.value;
}

/**
 * The private body source is the original create receipt reconciled with that
 * revision's immutable bytes. An edit actor is the edit's Access admission,
 * not this payload author, and the current draft head is not sufficient.
 * Discovery only names the receipt. Acceptance reads that subject's triples,
 * so a filtered projection cannot hide a conflicting term.
 */
export async function readOriginalContributionCreateSource(
  env: WorkActivationEnvironment, contribution: string,
  canRead: (contribution: string) => Promise<boolean>, options?: ContributionHistoryRead,
): Promise<OriginalContributionCreateSource> {
  return withContributionGraphRead(ORIGINAL_CREATE_READ_CALLS, options?.signal, async signal => {
    await admitContributionRead(contribution, signal, canRead);
    if (!nativeId.test(contribution)) throw new RevisionCorrupt('original contribution create receipt is incomplete');
    const discovered = (await queryContributionGraph(env, discoverCreateReceipt(contribution), signal))
      .results?.bindings ?? [];
    assertContributionReadOpen(signal);
    if (discovered.length === 0) throw new RevisionNotFound('draft revision is unavailable');
    if (discovered.length !== 1 || !isUri(discovered[0]?.receipt)) {
      throw new RevisionCorrupt('original contribution create source is ambiguous');
    }
    const receipt = discovered[0].receipt.value;
    let receiptQuery: string;
    try { receiptQuery = subjectTriples(GRAPHS.receipts, receipt, CREATE_RECEIPT_TRIPLES + 1); }
    catch { throw new RevisionCorrupt('original contribution create receipt is incomplete'); }
    const receiptRows = (await queryContributionGraph(env, receiptQuery, signal)).results?.bindings ?? [];
    assertContributionReadOpen(signal);
    if (receiptRows.length === 0) throw new RevisionNotFound('draft revision is unavailable');
    const created = requireCreateReceipt(contribution, receiptRows);
    if (receipt !== textContributionReceiptIri(created.admissionId)) {
      throw new RevisionCorrupt('original contribution create receipt is incomplete');
    }
    const anchorRows = (await queryContributionGraph(env, subjectTriples(
      GRAPHS.revisions, created.revision, CREATE_ANCHOR_TRIPLES + 1), signal)).results?.bindings ?? [];
    assertContributionReadOpen(signal);
    const manifest = requireCreateAnchor(contribution, created.revision, created.dataEpoch,
      created.sequence, anchorRows);
    const state = readComponentState(env.objectDirectory, manifest, contribution,
      CONTRIBUTION_PROFILE, objectBudget(signal, options?.budget));
    assertContributionReadOpen(signal);
    if (state.publication !== 'draft') {
      throw new RevisionCorrupt('original contribution payload is not the draft recipe');
    }
    if (typeof state.body !== 'string' || typeof state.work !== 'string'
      || typeof state.author !== 'string' || typeof state.language !== 'string') {
      throw new RevisionCorrupt('original contribution bytes do not match the create receipt');
    }
    if (state.work !== created.work) {
      throw new RevisionCorrupt('original contribution work does not match the create receipt');
    }
    if (state.author !== created.author) {
      throw new RevisionCorrupt('original contribution author does not match the create receipt');
    }
    if (state.language !== created.language) {
      throw new RevisionCorrupt('original contribution language does not match the create receipt');
    }
    let content;
    try { content = retainedDocumentBody(state); }
    catch { throw new RevisionCorrupt('original contribution body is corrupt'); }
    let digest: string;
    try {
      digest = textContributionDigest({ work: created.work, language: created.language,
        actingSubject: created.author,
        ...(content.document ? { document: content.document } : { body: content.body }) });
    } catch { throw new RevisionCorrupt('original contribution bytes do not match the create receipt'); }
    if (digest !== created.requestDigest) {
      throw new RevisionCorrupt('original contribution create digest differs from immutable bytes');
    }
    assertContributionReadOpen(signal);
    return { contribution, revision: created.revision, work: created.work, author: created.author,
      language: created.language, ...content, receipt, requestDigest: created.requestDigest,
      admissionId: created.admissionId, authorityEpoch: created.authorityEpoch, scope: created.scope,
      sourcePosition: { datasetId: 'product', dataEpoch: created.dataEpoch,
        sequence: created.sequence } };
  });
}

interface RetainedDraft {
  body: string;
  document?: DocumentSnapshot;
}

interface ExactHeadFacts {
  contribution: string;
  revision: string;
  predecessor?: string;
  work: string;
  author: string;
  language: string;
  dataEpoch: string;
  sequence: string;
  content: RetainedDraft;
}

function digestBody(content: RetainedDraft): { body: string } | { document: DocumentSnapshot } {
  return content.document ? { document: content.document } : { body: content.body };
}

function discoverHeadReceipt(contribution: string, revision: string): string {
  return `PREFIX rv: <${RV}>
    SELECT ?receipt WHERE {
      GRAPH ${iri(GRAPHS.receipts)} {
        ?receipt a rv:OperationReceipt ;
          rv:contribution ${iri(contribution)} ;
          rv:draftRevision ${iri(revision)} ;
          rv:outcome rv:Succeeded .
      }
    } LIMIT 2`;
}

function requireEditReceipt(contribution: string, revision: string, rows: readonly Row[]): {
  requestDigest: string; admissionId: string; authorityEpoch: string; scope: string;
  work: string; author: string; language: string; revision: string; expectedHead: string;
  dataEpoch: string; sequence: string;
} {
  const conflict = 'original contribution edit source conflicts';
  const invalid = 'original contribution edit term type is invalid';
  const fields = groupSubject(rows, EDIT_RECEIPT_TRIPLES, conflict, invalid);
  if (fields.size !== EDIT_RECEIPT_PREDICATES.length
    || EDIT_RECEIPT_PREDICATES.some(predicate => !fields.has(predicate))) {
    throw new RevisionCorrupt(conflict);
  }
  const type = one(fields, RDF_TYPE, conflict);
  const operation = one(fields, `${RV}operation`, conflict);
  const requestDigest = one(fields, `${RV}requestDigest`, conflict);
  const admissionId = one(fields, `${RV}admissionId`, conflict);
  const authorityEpoch = one(fields, `${RV}authorityEpoch`, conflict);
  const scope = one(fields, `${RV}admittedScope`, conflict);
  const outcome = one(fields, `${RV}outcome`, conflict);
  const work = one(fields, `${RV}work`, conflict);
  const recordedContribution = one(fields, `${RV}contribution`, conflict);
  const draftRevision = one(fields, `${RV}draftRevision`, conflict);
  const expectedHead = one(fields, `${RV}expectedHead`, conflict);
  const language = one(fields, `${RV}language`, conflict);
  const author = one(fields, `${RV}author`, conflict);
  const dataset = one(fields, `${RV}datasetId`, conflict);
  const dataEpoch = one(fields, `${RV}dataEpoch`, conflict);
  const sequence = one(fields, `${RV}sequence`, conflict);
  if (!isUri(type) || type.value !== `${RV}OperationReceipt` || !isUri(outcome)
    || outcome.value !== `${RV}Succeeded` || !isUri(operation) || !nativeId.test(operation.value)) {
    throw new RevisionCorrupt(conflict);
  }
  if (!isUri(work) || !isUri(author) || !isUri(recordedContribution) || !isUri(draftRevision)
    || !isUri(expectedHead) || !isUri(dataset) || !isPlainString(requestDigest)
    || !isPlainString(admissionId) || !isPlainString(authorityEpoch) || !isPlainString(scope)
    || !isPlainString(language) || !isPlainString(dataEpoch) || !isInteger(sequence)) {
    throw new RevisionCorrupt(invalid);
  }
  if (!/^[0-9a-f]{64}$/.test(requestDigest.value) || !admissionIdPattern.test(admissionId.value)
    || !/^(0|[1-9][0-9]*)$/.test(authorityEpoch.value) || !nativeId.test(work.value)
    || !nativeId.test(author.value) || !nativeId.test(draftRevision.value)
    || !nativeId.test(expectedHead.value) || !admittedContributionLanguage(language.value)
    || dataEpoch.value.length > 128 || dataset.value !== DATASET) {
    throw new RevisionCorrupt('original contribution edit receipt is incomplete');
  }
  if (scope.value !== `contribution:edit:${contribution}`) {
    throw new RevisionCorrupt('original contribution edit admission does not match');
  }
  if (recordedContribution.value !== contribution || draftRevision.value !== revision) {
    throw new RevisionCorrupt('original contribution edit receipt names another head');
  }
  return { requestDigest: requestDigest.value, admissionId: admissionId.value,
    authorityEpoch: authorityEpoch.value, scope: scope.value, work: work.value, author: author.value,
    language: language.value, revision: draftRevision.value, expectedHead: expectedHead.value,
    dataEpoch: dataEpoch.value, sequence: sequence.value };
}

function requireEditAnchor(contribution: string, revision: string, expectedHead: string,
  receiptEpoch: string, receiptSequence: string, rows: readonly Row[]): string {
  const ambiguous = 'original contribution edit revision is ambiguous';
  const invalid = 'original contribution edit term type is invalid';
  const fields = groupSubject(rows, EDIT_ANCHOR_TRIPLES, ambiguous, invalid);
  if (fields.size === 0) throw new RevisionNotFound('draft revision is unavailable');
  if (fields.size !== EDIT_ANCHOR_PREDICATES.length
    || EDIT_ANCHOR_PREDICATES.some(predicate => !fields.has(predicate))) {
    throw new RevisionCorrupt(ambiguous);
  }
  const type = one(fields, RDF_TYPE, ambiguous);
  const component = one(fields, `${RV}component`, ambiguous);
  const manifest = one(fields, `${RV}manifest`, ambiguous);
  const model = one(fields, `${RV}modelRevision`, ambiguous);
  const shape = one(fields, `${RV}shapeRevision`, ambiguous);
  const dataset = one(fields, `${RV}datasetId`, ambiguous);
  const epoch = one(fields, `${RV}dataEpoch`, ambiguous);
  const sequence = one(fields, `${RV}sequence`, ambiguous);
  const operation = one(fields, `${RV}operation`, ambiguous);
  const predecessor = one(fields, `${RV}predecessor`, ambiguous);
  if (!isUri(type) || type.value !== `${RV}RevisionAnchor` || !isUri(component)
    || !isUri(manifest) || !isUri(model) || !isUri(shape) || !isUri(dataset) || !isUri(operation)
    || !isUri(predecessor) || !isPlainString(epoch) || !isInteger(sequence)) {
    throw new RevisionCorrupt(invalid);
  }
  if (component.value !== contribution || predecessor.value !== expectedHead || !nativeId.test(revision)) {
    throw new RevisionCorrupt('original contribution edit revision does not match its receipt');
  }
  if (model.value !== CONTRIBUTION_PROFILE || shape.value !== CONTRIBUTION_PROFILE) {
    throw new RevisionCorrupt('original contribution edit model does not match its receipt');
  }
  if (epoch.value !== receiptEpoch || sequence.value !== receiptSequence || dataset.value !== DATASET) {
    throw new RevisionCorrupt('original contribution edit source position does not match its receipt');
  }
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifest.value)) {
    throw new RevisionCorrupt('original contribution edit revision does not match its receipt');
  }
  return manifest.value;
}

function acceptCreateHead(head: ExactHeadFacts, receipt: string, rows: readonly Row[]): void {
  const created = requireCreateReceipt(head.contribution, rows);
  if (receipt !== textContributionReceiptIri(created.admissionId)) {
    throw new RevisionCorrupt('original contribution create receipt is incomplete');
  }
  if (created.revision !== head.revision || created.work !== head.work || created.author !== head.author
    || created.language !== head.language || created.dataEpoch !== head.dataEpoch
    || created.sequence !== head.sequence) {
    throw new RevisionCorrupt('draft revision receipt does not match the exact head');
  }
  let digest: string;
  try {
    digest = textContributionDigest({ work: created.work, language: created.language,
      actingSubject: created.author, ...digestBody(head.content) });
  } catch { throw new RevisionCorrupt('original contribution create digest differs from immutable bytes'); }
  if (digest !== created.requestDigest) {
    throw new RevisionCorrupt('original contribution create digest differs from immutable bytes');
  }
}

/** Main's Access registry, or the Access pool already attached to this process.
 * Contribution does not open a pool and does not write Access tables. */
function editAccess(env: WorkActivationEnvironment): Pick<AccessAdmissionRegistry, 'admittedActingSubject'> {
  const attached = (env as { accessAdmission?: Pick<AccessAdmissionRegistry, 'admittedActingSubject'> })
    .accessAdmission;
  if (attached) return attached;
  const pool = (env as { eventTemporalAccess?: Pool }).eventTemporalAccess;
  if (pool) return new AccessAdmissionRegistry(pool);
  throw new RevisionUnavailable('Access admission store could not be reached');
}

/** The receipt records the original creator. The editor is only the Access admission's acting subject. */
async function proveEditDigest(env: WorkActivationEnvironment, signal: AbortSignal, contribution: string,
  expectedHead: string, admissionId: string, requestDigest: string, content: RetainedDraft): Promise<string> {
  assertContributionReadOpen(signal);
  let actor: string;
  try { actor = await editAccess(env).admittedActingSubject(admissionId); }
  catch (error) {
    if (error instanceof RevisionUnavailable) throw error;
    if (error instanceof AdmissionDenied) throw new RevisionCorrupt('original contribution edit actor is unavailable');
    throw new RevisionUnavailable('Access admission store could not be reached');
  }
  assertContributionReadOpen(signal);
  if (!nativeId.test(actor)) throw new RevisionCorrupt('original contribution edit actor is invalid');
  let digest: string;
  try {
    digest = textContributionEditDigest({ contribution, expectedHead, actingSubject: actor,
      ...digestBody(content) });
  } catch { throw new RevisionCorrupt('original contribution edit digest differs from immutable bytes'); }
  if (digest !== requestDigest) {
    throw new RevisionCorrupt('original contribution edit digest differs from immutable bytes');
  }
  return actor;
}

async function loadHeadReceipt(env: WorkActivationEnvironment, signal: AbortSignal,
  contribution: string, revision: string, missing: 'corrupt' | 'absent'): Promise<{ receipt: string; rows: Row[] }> {
  const discovered = (await queryContributionGraph(env, discoverHeadReceipt(contribution, revision), signal))
    .results?.bindings ?? [];
  assertContributionReadOpen(signal);
  const absent = () => missing === 'absent'
    ? new RevisionNotFound('draft revision is unavailable')
    : new RevisionCorrupt('draft revision receipt is missing or ambiguous');
  const found = discovered[0]?.receipt;
  if (discovered.length === 0) throw absent();
  if (discovered.length !== 1 || !isUri(found)) {
    throw new RevisionCorrupt('draft revision receipt is missing or ambiguous');
  }
  const receipt = found.value;
  let receiptQuery: string;
  try { receiptQuery = subjectTriples(GRAPHS.receipts, receipt, HEAD_RECEIPT_TRIPLES); }
  catch { throw new RevisionCorrupt('draft revision receipt is incomplete'); }
  const rows = (await queryContributionGraph(env, receiptQuery, signal)).results?.bindings ?? [];
  assertContributionReadOpen(signal);
  if (rows.length === 0) throw absent();
  return { receipt, rows };
}

async function reconcileExactHeadReceipt(env: WorkActivationEnvironment, signal: AbortSignal,
  head: ExactHeadFacts): Promise<void> {
  const loaded = await loadHeadReceipt(env, signal, head.contribution, head.revision, 'corrupt');
  if (!head.predecessor) {
    acceptCreateHead(head, loaded.receipt, loaded.rows);
    return;
  }
  const edited = requireEditReceipt(head.contribution, head.revision, loaded.rows);
  if (loaded.receipt !== textContributionEditReceiptIri(edited.admissionId)
    || edited.expectedHead !== head.predecessor || edited.work !== head.work
    || edited.author !== head.author || edited.language !== head.language
    || edited.dataEpoch !== head.dataEpoch || edited.sequence !== head.sequence) {
    throw new RevisionCorrupt('draft revision receipt does not match the exact head');
  }
  await proveEditDigest(env, signal, head.contribution, edited.expectedHead,
    edited.admissionId, edited.requestDigest, head.content);
}

/**
 * One edit head reconciled with its original receipt, immutable bytes, and edit actor.
 * Discovery only names the receipt. Acceptance reads that subject's triples unfiltered.
 */
export async function readOriginalContributionEditSource(
  env: WorkActivationEnvironment, contribution: string, revision: string,
  canRead: (contribution: string) => Promise<boolean>, options?: ContributionHistoryRead,
): Promise<OriginalContributionEditSource> {
  return withContributionGraphRead(ORIGINAL_EDIT_READ_CALLS, options?.signal, async signal => {
    await admitContributionRead(contribution, signal, canRead);
    if (!nativeId.test(contribution) || !nativeId.test(revision)) {
      throw new RevisionCorrupt('original contribution edit receipt is incomplete');
    }
    const loaded = await loadHeadReceipt(env, signal, contribution, revision, 'absent');
    const edited = requireEditReceipt(contribution, revision, loaded.rows);
    if (loaded.receipt !== textContributionEditReceiptIri(edited.admissionId)) {
      throw new RevisionCorrupt('original contribution edit receipt is incomplete');
    }
    const anchorRows = (await queryContributionGraph(env, subjectTriples(
      GRAPHS.revisions, edited.revision, EDIT_ANCHOR_TRIPLES + 1), signal)).results?.bindings ?? [];
    assertContributionReadOpen(signal);
    const manifest = requireEditAnchor(contribution, edited.revision, edited.expectedHead,
      edited.dataEpoch, edited.sequence, anchorRows);
    const state = readComponentState(env.objectDirectory, manifest, contribution,
      CONTRIBUTION_PROFILE, objectBudget(signal, options?.budget));
    assertContributionReadOpen(signal);
    if (state.publication !== 'draft' || typeof state.body !== 'string' || typeof state.work !== 'string'
      || typeof state.author !== 'string' || typeof state.language !== 'string') {
      throw new RevisionCorrupt('original contribution bytes do not match the edit receipt');
    }
    if (state.work !== edited.work || state.author !== edited.author || state.language !== edited.language) {
      throw new RevisionCorrupt('original contribution bytes do not match the edit receipt');
    }
    let content: RetainedDraft;
    try { content = retainedDocumentBody(state); }
    catch { throw new RevisionCorrupt('original contribution body is corrupt'); }
    const actor = await proveEditDigest(env, signal, contribution, edited.expectedHead,
      edited.admissionId, edited.requestDigest, content);
    assertContributionReadOpen(signal);
    return { contribution, revision: edited.revision, work: edited.work, author: edited.author,
      language: edited.language, ...content, predecessor: edited.expectedHead, receipt: loaded.receipt,
      requestDigest: edited.requestDigest, admissionId: edited.admissionId,
      authorityEpoch: edited.authorityEpoch, scope: edited.scope, expectedHead: edited.expectedHead, actor,
      sourcePosition: { datasetId: 'product', dataEpoch: edited.dataEpoch, sequence: edited.sequence } };
  });
}
