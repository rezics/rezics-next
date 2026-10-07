import { canonicalLanguage } from '../display-language/select.ts';
import { DATASET, GRAPHS, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState, RevisionCorrupt, RevisionNotFound,
  type RevisionReadBudget } from '../work/history.ts';
import { CONTRIBUTION_CREATE_READ_COST, CONTRIBUTION_PROFILE,
  assertContributionReadOpen, queryContributionGraph, textContributionDigest,
  textContributionReceiptIri, withContributionGraphRead } from './draft.ts';
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

export interface ContributionHistoryRead {
  signal?: AbortSignal;
  /** Manifest and payload share this budget; a later read does not refill it. */
  budget?: RevisionReadBudget;
}

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const admissionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Binding = { value: string };
type Row = Record<string, Binding | undefined>;

function objectBudget(signal: AbortSignal, budget?: RevisionReadBudget): RevisionReadBudget {
  return budget ?? { bytesLeft: CONTRIBUTION_CREATE_READ_COST.objectBytes, signal };
}

function field(row: Row, key: string): string | undefined {
  const value = row[key]?.value;
  return value && value.length > 0 ? value : undefined;
}

/** Exact immutable draft read, gated by current private Contribution authority. */
export async function readExactContributionDraft(
  env: WorkActivationEnvironment, contribution: string, revision: string,
  canRead: (contribution: string) => Promise<boolean>, options?: ContributionHistoryRead,
): Promise<ExactContributionDraft> {
  return withContributionGraphRead(2, options?.signal, async signal => {
    assertContributionReadOpen(signal);
    if (!await canRead(contribution)) throw new RevisionNotFound('draft revision is unavailable');
    assertContributionReadOpen(signal);
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
    return { contribution, revision, work: state.work, author: state.author,
      language: state.language, ...content,
      ...(row.predecessor ? { predecessor: row.predecessor.value } : {}),
      sourcePosition: { datasetId: 'product', dataEpoch: row.epoch.value,
        sequence: row.sequence.value } };
  });
}

function createReceiptQuery(contribution: string): string {
  return `PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?receipt ?digest ?admission ?authority ?scope ?work ?author ?language
      ?contribution ?revision ?epoch ?sequence ?dataset WHERE {
      GRAPH ${iri(GRAPHS.receipts)} {
        ?receipt a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
          rv:contribution ?contribution ; rv:requestDigest ?digest ;
          rv:admissionId ?admission ; rv:authorityEpoch ?authority ;
          rv:admittedScope ?scope ; rv:work ?work ; rv:author ?author ;
          rv:language ?language ; rv:draftRevision ?revision ;
          rv:datasetId ?dataset ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        FILTER(?contribution = ${iri(contribution)})
        FILTER NOT EXISTS { ?receipt rv:expectedHead ?editHead }
        FILTER NOT EXISTS { ?receipt rv:reason ?editReason }
        FILTER(?scope = CONCAT("contribution:create:", STR(?work)))
      }
    } LIMIT 2`;
}

function createRevisionQuery(revision: string): string {
  return `PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?component ?manifest ?model ?shape ?dataset ?epoch ?sequence ?predecessor WHERE {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:RevisionAnchor ; rv:component ?component ;
          rv:manifest ?manifest ; rv:modelRevision ?model ; rv:shapeRevision ?shape ;
          rv:datasetId ?dataset ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(revision)} rv:predecessor ?predecessor }
      }
    } LIMIT 2`;
}

function requireCreateReceipt(contribution: string, rows: readonly Row[]): {
  receipt: string; requestDigest: string; admissionId: string; authorityEpoch: string;
  scope: string; work: string; author: string; language: string; revision: string;
  dataEpoch: string; sequence: string;
} {
  if (rows.length === 0) throw new RevisionNotFound('draft revision is unavailable');
  if (rows.length !== 1) throw new RevisionCorrupt('original contribution create source is ambiguous');
  const row = rows[0]!;
  if (row.expectedHead || row.reason) {
    throw new RevisionCorrupt('original contribution create source is an edit receipt');
  }
  const receipt = field(row, 'receipt');
  const requestDigest = field(row, 'digest');
  const admissionId = field(row, 'admission');
  const authorityEpoch = field(row, 'authority');
  const scope = field(row, 'scope');
  const work = field(row, 'work');
  const author = field(row, 'author');
  const language = field(row, 'language');
  const revision = field(row, 'revision');
  const dataEpoch = field(row, 'epoch');
  const sequence = field(row, 'sequence');
  const dataset = field(row, 'dataset');
  if (scope?.startsWith('contribution:edit:')) {
    throw new RevisionCorrupt('original contribution create source is an edit admission');
  }
  if (!receipt || !requestDigest || !/^[0-9a-f]{64}$/.test(requestDigest) || !admissionId
    || !admissionIdPattern.test(admissionId) || receipt !== textContributionReceiptIri(admissionId)
    || !authorityEpoch || !/^(0|[1-9][0-9]*)$/.test(authorityEpoch) || !scope || !work
    || !nativeId.test(work) || scope !== `contribution:create:${work}` || !author
    || !nativeId.test(author) || !language || canonicalLanguage(language) !== language || !revision
    || !nativeId.test(revision) || !dataEpoch || dataEpoch.length > 128 || !sequence
    || !/^[0-9]+$/.test(sequence) || dataset !== DATASET) {
    throw new RevisionCorrupt('original contribution create receipt is incomplete');
  }
  if (field(row, 'contribution') !== contribution) {
    throw new RevisionCorrupt('original contribution create receipt names another contribution');
  }
  return { receipt, requestDigest, admissionId, authorityEpoch, scope, work, author,
    language, revision, dataEpoch, sequence };
}

function requireCreateAnchor(contribution: string, revision: string, receiptEpoch: string,
  receiptSequence: string, rows: readonly Row[]): string {
  if (rows.length === 0) throw new RevisionNotFound('draft revision is unavailable');
  if (rows.length !== 1) throw new RevisionCorrupt('original contribution create revision is ambiguous');
  const row = rows[0]!;
  if (row.predecessor) throw new RevisionCorrupt('original contribution create revision has a predecessor');
  const manifest = field(row, 'manifest');
  if (!nativeId.test(revision) || field(row, 'component') !== contribution) {
    throw new RevisionCorrupt('original contribution create revision does not match its receipt');
  }
  if (field(row, 'model') !== CONTRIBUTION_PROFILE || field(row, 'shape') !== CONTRIBUTION_PROFILE) {
    throw new RevisionCorrupt('original contribution create model does not match its receipt');
  }
  if (field(row, 'epoch') !== receiptEpoch || field(row, 'sequence') !== receiptSequence
    || field(row, 'dataset') !== DATASET) {
    throw new RevisionCorrupt('original contribution create source position does not match its receipt');
  }
  if (!manifest || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifest)) {
    throw new RevisionCorrupt('original contribution create revision does not match its receipt');
  }
  return manifest;
}

/**
 * The private body source is the original create receipt reconciled with that
 * revision's immutable bytes. An edit actor is the edit's Access admission,
 * not this payload author, and the current draft head is not sufficient.
 */
export async function readOriginalContributionCreateSource(
  env: WorkActivationEnvironment, contribution: string,
  canRead: (contribution: string) => Promise<boolean>, options?: ContributionHistoryRead,
): Promise<OriginalContributionCreateSource> {
  return withContributionGraphRead(2, options?.signal, async signal => {
    assertContributionReadOpen(signal);
    if (!await canRead(contribution)) throw new RevisionNotFound('draft revision is unavailable');
    assertContributionReadOpen(signal);
    if (!nativeId.test(contribution)) throw new RevisionCorrupt('original contribution create receipt is incomplete');
    const receiptRows = (await queryContributionGraph(env, createReceiptQuery(contribution), signal))
      .results?.bindings ?? [];
    assertContributionReadOpen(signal);
    const created = requireCreateReceipt(contribution, receiptRows);
    const anchorRows = (await queryContributionGraph(env, createRevisionQuery(created.revision), signal))
      .results?.bindings ?? [];
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
      language: created.language, ...content, receipt: created.receipt,
      requestDigest: created.requestDigest, admissionId: created.admissionId,
      authorityEpoch: created.authorityEpoch, scope: created.scope,
      sourcePosition: { datasetId: 'product', dataEpoch: created.dataEpoch,
        sequence: created.sequence } };
  });
}
