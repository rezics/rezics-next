import { ContextNotFound, readContextRevision } from '../context/read.ts';
import { contextSkos } from '../context/preferences.ts';
import type { AccessJudgments } from '../judgment/access.ts';
import { readResourceSummaries, type AvatarDescriptor, type ResourceSummary, type SummaryReader }
  from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT, type MediaStore } from '../media/store.ts';
import { readStatement, resolveStatementAcceptance, StatementNotFound }
  from '../statement/read.ts';
import type { Acceptance } from '../statement/graph.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment }
  from '../work/activate.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const contextId = (value: string) => native.test(value) || value === 'urn:rezics:semantic-context:global';
const decimal = /^(0|[1-9][0-9]*)$/;
const publicOnly = async () => false;

/** These caps cover the complete admission relation. An overflow is unavailable;
 * it must never be truncated into a precise count. */
export const PUBLIC_DISCLOSURE_COST = { contexts: 8, statements: 16, resources: 32,
  summaryTargets: 64, graphQueries: 192, badgeChecks: 32, mediaBatches: 2,
  outputBytes: 1_048_576 } as const;

export class InvalidPublicDisclosure extends Error {}
export class PublicDisclosureUnavailable extends Error {}

export interface PublicDisclosureInput {
  contexts: readonly string[];
  statements: readonly { statement: string; acceptance: Acceptance }[];
  resources: readonly string[];
  mediaContext: string;
  language: string | null;
}

export type PublicSearchField =
  | { kind: 'context-label'; owner: string; target: string; text: string; language: string }
  | { kind: 'statement-value'; owner: string; subject: string; text: string; language: string | null }
  | { kind: 'resource-name'; owner: string; text: string; language: string; avatar: AvatarDescriptor };

export interface PublicFieldDecision {
  fields: PublicSearchField[];
  sourcePosition: { dataEpoch: string; sequence: string };
  /** The current graph read and the owner batch are part of the cost contract. */
  cost: { contexts: number; statements: number; summaryTargets: number;
    badgeChecks: number; mediaBatches: number };
}

function validInput(input: PublicDisclosureInput): void {
  if (input.contexts.length > PUBLIC_DISCLOSURE_COST.contexts
    || input.statements.length > PUBLIC_DISCLOSURE_COST.statements
    || new Set(input.statements.map(item => item.statement)).size !== input.statements.length
    || input.resources.length > PUBLIC_DISCLOSURE_COST.resources
    || input.contexts.some(value => !contextId(value))
    || input.statements.some(value => !native.test(value.statement)
      || (value.acceptance.kind === 'realm' && !native.test(value.acceptance.realm)))
    || input.resources.some(value => !native.test(value))
    || (input.mediaContext !== DEFAULT_MEDIA_CONTEXT && !native.test(input.mediaContext))
    || (input.language !== null && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(input.language))) {
    throw new InvalidPublicDisclosure('public search disclosure request exceeds its profile');
  }
}

async function graphPosition(env: WorkActivationEnvironment) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:sequence ?sequence . BIND(${lit(env.lineage.dataEpoch)} AS ?epoch)
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
    }
  }`)).results?.bindings ?? [];
  if (rows.length !== 1 || !decimal.test(rows[0]?.sequence?.value ?? '')) {
    throw new PublicDisclosureUnavailable('search disclosure graph position is unavailable');
  }
  return { dataEpoch: env.lineage.dataEpoch, sequence: rows[0]!.sequence!.value };
}

/** A pinned Context can have inherited definitions. Every parent in that exact
 * chain must still be public before a label or Statement meaning is searchable. */
async function publicChain(env: WorkActivationEnvironment, revision: string,
  expectedContext: string, expectedDepth?: number): Promise<boolean> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?revision ?context ?disclosure ?depth WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} rv:baseRevision* ?revision .
      ?revision a rv:ContextSemanticRevision ; rv:component ?context ; rv:inheritanceDepth ?depth . }
    GRAPH ${iri(GRAPHS.current)} { ?context a rv:SemanticContext ; rv:disclosure ?disclosure . }
  } LIMIT 10`)).results?.bindings ?? [];
  const head = rows.find(row => row.revision?.value === revision && row.context?.value === expectedContext);
  const depths = rows.map(row => Number(row.depth?.value));
  if (!rows.length || rows.length > 9 || !head || !decimal.test(head.depth?.value ?? '')
    || (expectedDepth !== undefined && Number(head.depth!.value) !== expectedDepth)
    || rows.length !== Number(head.depth!.value) + 1
    || new Set(rows.map(row => row.revision?.value)).size !== rows.length
    || new Set(depths).size !== rows.length
    || depths.some(depth => !Number.isSafeInteger(depth) || depth < 0 || depth >= rows.length)) {
    throw new PublicDisclosureUnavailable('Context dependency chain is incomplete');
  }
  return rows.every(row => row.disclosure?.value === `${RV}Public`);
}

function publicSummary(summary: ResourceSummary, restrictedTitles: boolean): summary is
  Extract<ResourceSummary, { status: 'available' }> {
  return summary.status === 'available' && summary.disclosure === 'public'
    && (restrictedTitles || summary.work === null);
}

/** Read owner values before phrase matching. A candidate's indexed literal,
 * score, snippet, facet or private selection is never accepted as disclosure
 * evidence. Unknown/hidden IDs produce the same absence in the returned set. */
async function disclosePublicSearchFieldsUnchecked(env: WorkActivationEnvironment,
  media: MediaStore | undefined, judgments: Pick<AccessJudgments, 'protectionCheck'> | undefined,
  input: PublicDisclosureInput,
  restrictedTitles?: (heads: readonly { work: string; revision: string }[], context: string) =>
    Promise<ReadonlySet<string>>, reader: SummaryReader = {}): Promise<PublicFieldDecision> {
  validInput(input);
  const start = await graphPosition(env);
  const fields: PublicSearchField[] = [];
  const contexts = [...new Set(input.contexts)];
  for (const context of contexts) {
    let read;
    try { read = await readContextRevision(env, context, null, publicOnly); }
    catch (error) { if (error instanceof ContextNotFound) continue; throw error; }
    if (read.sourcePosition.sequence !== start.sequence || read.state !== 'active'
      || read.revision !== read.semanticHead) continue;
    if (!await publicChain(env, read.revision, context, read.inheritanceDepth)) continue;
    try {
      const labels = await contextSkos(env, context, read.revision, null, publicOnly);
      for (const entry of labels['@graph']) {
        fields.push({ kind: 'context-label', owner: context,
          target: entry['rv:interprets']['@id'], text: entry['skos:prefLabel']['@value'],
          language: entry['skos:prefLabel']['@language'] });
      }
    } catch (error) {
      // A Context without a preference revision has no searchable label.
      if (!(error instanceof ContextNotFound)) throw error;
    }
  }

  const statementReads: Array<{ statement: string; subject: string; text: string;
    language: string | null; object: string | null; generation: string; hintGeneration: string;
    acceptance: Acceptance; concept: string | null }> = [];
  let badgeChecks = 0;
  for (const candidate of input.statements) {
    let read;
    try { read = await readStatement(env, candidate.statement, publicOnly); }
    catch (error) { if (error instanceof StatementNotFound) continue; throw error; }
    if (read.sourcePosition.sequence !== start.sequence || read.state !== 'active'
      || read.meaningBasis.state !== 'readable'
      || (read.value.kind !== 'literal' && read.value.kind !== 'resource')) continue;
    if (!await publicChain(env, read.meaningBasis.semanticRevision, read.meaningBasis.context)) continue;
    const acceptance = await resolveStatementAcceptance(env,
      { kind: 'statement', statement: candidate.statement }, candidate.acceptance);
    if (acceptance.sourcePosition.sequence !== start.sequence
      || acceptance.result.state === 'unavailable') {
      throw new PublicDisclosureUnavailable('Statement acceptance moved or is unavailable');
    }
    if (acceptance.result.state !== 'accepted' || !judgments) continue;
    const badge = await judgments.protectionCheck(candidate.statement, candidate.acceptance, null);
    badgeChecks++;
    if (badge.protection !== 'show-all') continue;
    statementReads.push({ statement: candidate.statement, subject: read.subject,
      text: read.value.kind === 'literal' ? read.value.lexical : '',
      language: read.value.kind === 'literal' ? read.value.language : null,
      object: read.value.kind === 'resource' ? read.value.iri : null,
      generation: badge.generation, hintGeneration: badge.conceptHintGeneration,
      acceptance: candidate.acceptance, concept: null });
  }

  const targets = [...new Set([...input.resources, ...statementReads.map(item => item.subject),
    ...statementReads.flatMap(item => item.object ? [item.object] : [])])];
  if (targets.length > PUBLIC_DISCLOSURE_COST.summaryTargets || targets.some(value => !native.test(value))) {
    throw new InvalidPublicDisclosure('public search summary batch exceeds its profile');
  }
  let summaries = new Map<string, ResourceSummary>();
  let mediaBatches = 0;
  let mediaGeneration: string | null = null;
  if (targets.length) {
    const batch = await readResourceSummaries(env, media,
      { ...reader, ...(restrictedTitles ? { restrictedTitles } : {}) },
      { resources: targets, context: input.mediaContext, language: input.language });
    if (batch.generation.graph !== `${start.dataEpoch}:${start.sequence}`
      || batch.cost.mediaQueries > 1 || batch.cost.accessQueries > 1) {
      throw new PublicDisclosureUnavailable('resource summary moved during disclosure');
    }
    mediaBatches = batch.cost.mediaQueries;
    mediaGeneration = batch.generation.media;
    summaries = new Map(batch.summaries.map(summary => [summary.reference, summary]));
  }
  for (const statement of statementReads) {
    const subject = summaries.get(statement.subject);
    if (!subject || !publicSummary(subject, Boolean(restrictedTitles))) continue;
    const object = statement.object ? summaries.get(statement.object) : null;
    if (statement.object && (!object || !publicSummary(object, Boolean(restrictedTitles)))) continue;
    const badge = await judgments!.protectionCheck(statement.statement, statement.acceptance,
      statement.concept);
    badgeChecks++;
    if (badge.protection !== 'show-all' || badge.generation !== statement.generation
      || badge.conceptHintGeneration !== statement.hintGeneration) {
      throw new PublicDisclosureUnavailable('Statement spoiler protection moved');
    }
    fields.push({ kind: 'statement-value', owner: statement.statement, subject: statement.subject,
      text: object && object.status === 'available' ? object.name.value : statement.text,
      language: object && object.status === 'available' ? object.name.language : statement.language });
  }
  for (const resource of new Set(input.resources)) {
    const summary = summaries.get(resource);
    if (summary && publicSummary(summary, Boolean(restrictedTitles))) {
      fields.push({ kind: 'resource-name', owner: resource, text: summary.name.value,
        language: summary.name.language, avatar: summary.avatar });
    }
  }
  if (media && mediaBatches === 1) {
    const current = await media.avatarRows(targets, input.mediaContext);
    mediaBatches++;
    if (`${current.generation.dataEpoch}:${current.generation.sequence}` !== mediaGeneration) {
      throw new PublicDisclosureUnavailable('avatar owner moved during disclosure');
    }
  }
  const end = await graphPosition(env);
  if (end.dataEpoch !== start.dataEpoch || end.sequence !== start.sequence) {
    throw new PublicDisclosureUnavailable('search disclosure graph moved');
  }
  if (Buffer.byteLength(JSON.stringify(fields), 'utf8') > PUBLIC_DISCLOSURE_COST.outputBytes) {
    throw new PublicDisclosureUnavailable('search disclosure response exceeds its byte budget');
  }
  return { fields, sourcePosition: start,
    cost: { contexts: contexts.length, statements: input.statements.length,
      summaryTargets: targets.length, badgeChecks, mediaBatches } };
}

export async function disclosePublicSearchFields(env: WorkActivationEnvironment,
  media: MediaStore | undefined, judgments: Pick<AccessJudgments, 'protectionCheck'> | undefined,
  input: PublicDisclosureInput,
  restrictedTitles?: (heads: readonly { work: string; revision: string }[], context: string) =>
    Promise<ReadonlySet<string>>, reader: SummaryReader = {}): Promise<PublicFieldDecision> {
  try {
    return await disclosePublicSearchFieldsUnchecked(env, media, judgments, input, restrictedTitles, reader);
  } catch (cause) {
    if (cause instanceof InvalidPublicDisclosure || cause instanceof PublicDisclosureUnavailable) throw cause;
    throw new PublicDisclosureUnavailable('public search disclosure dependency is unavailable', { cause });
  }
}

/** The optional bounded phrase projection only matches admitted owner values.
 * Its score and facets cannot incorporate an undisclosed field. */
export function matchPublicDisclosedPhrase(decision: PublicFieldDecision, phrase: string) {
  const normalized = phrase.normalize('NFC').trim().toLocaleLowerCase('und');
  if (normalized.length < 2 || normalized.length > 80 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new InvalidPublicDisclosure('invalid public disclosure phrase');
  }
  const matches = decision.fields.filter(field => field.text.normalize('NFC')
    .toLocaleLowerCase('und').includes(normalized)).map(field => ({ ...field, score: 1 }));
  return { complete: true as const, total: matches.length, matches,
    facets: { contexts: matches.filter(item => item.kind === 'context-label').length,
      statements: matches.filter(item => item.kind === 'statement-value').length,
      names: matches.filter(item => item.kind === 'resource-name').length },
    sourcePosition: decision.sourcePosition };
}
