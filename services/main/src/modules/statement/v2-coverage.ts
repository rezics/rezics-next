import { ContextCommandUnavailable } from '../context/problems.ts';
import { readExactDefinition, readExactOccurrence, type ExactDefinition, type OccurrenceState } from '../relation/change.ts';
import { readAttributedOccurrence, validateAttributedOccurrence } from '../relation/v2-read.ts';
import { canonicalAttribution } from '../relation/v2-schema.ts';
import { relationAttributionVerifier, type RelationAttributionVerifier } from '../relation/attribution.ts';
import { systemDisclosure, type ReferenceDisclosure } from '../target/disclosed-references.ts';
import { PROFILES } from '../semantic/schema.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { OCCURRENCE_ASSERTION_NOTATION, statementCoverageRejected,
  type StatementMeaningV2 } from './v2-schema.ts';

export interface ResolvedStatementCoverage {
  guard: string; applicability: string[]; references: string[];
  native?: { receipt: string; manifest: string; modelGeneration: string; attribution: unknown };
}
/** Server-resolved compatibility identity, never a caller-supplied witness or
 * an activation receipt. It retains the original credit and sealed allocations. */
export interface RetainedStatementCoverage {
  occurrence: string; revision: string;
  state: Pick<OccurrenceState, 'definition' | 'participations' | 'applicability'>;
  definition: ExactDefinition; guard: string;
  native: NonNullable<ResolvedStatementCoverage['native']>;
}
export type RetainedStatementCoverageReader = (occurrence: string, revision: string) => Promise<RetainedStatementCoverage | null>;
export class StatementCoverageHidden extends ContextCommandUnavailable {}

/** Match the full Participant, never just its key, label, type or another co-participant. */
export function assertParticipationCoverage(meaning: StatementMeaningV2, state: Pick<OccurrenceState, 'participations'>,
  subjectRoles: readonly string[]): void {
  const coverage = meaning.coverage;
  if (coverage.kind !== 'participation') return;
  const matches = state.participations.filter(part => part.iri === coverage.participation);
  if (matches.length !== 1 || !subjectRoles.includes(matches[0]!.role)
    || canonicalAttribution(matches[0]!.participant) !== canonicalAttribution(meaning.subject)) {
    statementCoverageRejected('participation coverage must bind this exact subject in an authored subject role');
  }
}

/** The existing occurrence/definition owners resolve exact sealed bytes. No coverage is inferred for V1 meanings. */
export async function resolveStatementCoverage(env: WorkActivationEnvironment, meaning: StatementMeaningV2,
  canRead: (reference: string) => Promise<boolean>, canReadDefinition?: (definition: string) => Promise<boolean>,
  discloseOwned?: ReferenceDisclosure,
  readReferences?: ReferenceDisclosure,
  attribution?: RelationAttributionVerifier,
  readRetained?: RetainedStatementCoverageReader,
): Promise<ResolvedStatementCoverage> {
  if (meaning.coverage.kind === 'subject-global') return { guard: '', applicability: [], references: [] };
  const coverage = meaning.coverage;
  const exact = await readExactOccurrence(env, coverage.occurrence, coverage.occurrenceRevision);
  const retained = !exact && readRetained ? await readRetained(coverage.occurrence, coverage.occurrenceRevision) : null;
  if (exact ? exact.state.lifecycle !== 'active' : !retained) throw new ContextCommandUnavailable('exact covered occurrence revision is unavailable');
  if (retained && (retained.occurrence !== coverage.occurrence || retained.revision !== coverage.occurrenceRevision
    || retained.state.definition !== retained.definition.revision || !retained.guard.trim())) {
    throw new ContextCommandUnavailable('retained coverage differs from its exact owner identity');
  }
  const state = exact?.state ?? retained!.state;
  const definition = retained?.definition ?? await readExactDefinition(env, state.definition, systemDisclosure, canReadDefinition);
  if (!definition?.association || definition.modelRevision !== PROFILES.definitionV2 || definition.lifecycle !== 'active') {
    throw new ContextCommandUnavailable('covered occurrence has no exact authored association binding');
  }
  if (retained && canReadDefinition && !await canReadDefinition(definition.definition)) {
    throw new StatementCoverageHidden('covered association definition is unavailable');
  }
  const attributed = exact?.state.profile === 'relation-change-v2'
    ? await readAttributedOccurrence(env, coverage.occurrence, coverage.occurrenceRevision) : null;
  const currentAttribution = attributed ? await validateAttributedOccurrence(env, attributed, definition,
    attribution ?? relationAttributionVerifier(undefined, null, undefined)) : null;
  const works = state.participations.filter(part => part.role === `${definition.definition}/role/${definition.association!.workRole}`);
  if (works.length !== 1 || works[0]!.participant.kind !== 'resource') {
    return statementCoverageRejected('authored Work role must bind exactly one native Work');
  }
  const work = works[0]!.participant.ref;
  // Revision and participation identities are owned by this exact occurrence.
  // They have no independent semantic-read scope; the actual Work and every
  // co-participant still need their own owner read and disclosure.
  const authorityReferences = [...new Set([...state.applicability,
    ...state.participations.flatMap(part => part.participant.kind === 'resource' ? [part.participant.ref] : [])])];
  const readable = readReferences ? await readReferences(authorityReferences)
    : new Set((await Promise.all(authorityReferences.map(async ref => await canRead(ref) ? ref : null)))
      .filter((ref): ref is string => ref !== null));
  if (authorityReferences.some(ref => !readable.has(ref))) {
    throw new StatementCoverageHidden('covered Work, coordinate or co-participant is unavailable');
  }
  const owned = [coverage.occurrence, coverage.occurrenceRevision,
    ...(coverage.kind === 'participation' ? [coverage.participation] : [])];
  const disclosed = discloseOwned ? await discloseOwned(owned) : new Set(await canRead(coverage.occurrence) ? owned : []);
  if (owned.some(ref => !disclosed.has(ref))) throw new StatementCoverageHidden('covered occurrence is unavailable');
  const references = [...owned, definition.definition, definition.revision, ...authorityReferences];
  assertParticipationCoverage(meaning, state,
    definition.association.subjectRoles.map(key => `${definition.definition}/role/${key}`));
  let assertionGuard = '';
  if (coverage.kind === 'occurrence') {
    const property = await readExactDefinition(env, meaning.relationDefinition, systemDisclosure, canReadDefinition, ['property']);
    if (property?.modelRevision !== PROFILES.definitionV2 || property.notation !== OCCURRENCE_ASSERTION_NOTATION
      || property.definition !== meaning.predicate || property.roles.length) {
      return statementCoverageRejected('occurrence coverage requires its exact authored occurrence-assertion property');
    }
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?definition ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?definition a rv:SemanticDefinition ; rv:definitionHead ?head .
        ?key a rv:DefinitionKey ; rv:keyDefinition ?definition ;
          <http://www.w3.org/2004/02/skos/core#notation> "${OCCURRENCE_ASSERTION_NOTATION}" }
      GRAPH ${iri(GRAPHS.revisions)} { ?head rv:component ?definition ; rv:modelRevision ${iri(PROFILES.definitionV2)} ;
        rv:lifecycle rv:Active }
    } LIMIT 2`)).results?.bindings ?? [];
    if (rows.length !== 1 || rows[0]?.definition?.value !== property.definition
      || rows[0]?.head?.value !== meaning.relationDefinition) {
      throw new ContextCommandUnavailable('occurrence assertion binding is absent or ambiguous');
    }
    assertionGuard = `GRAPH ${iri(GRAPHS.current)} { ${iri(property.definition)} rv:definitionHead ${iri(property.revision)} }`;
  }
  const ownerGuard = retained?.guard ?? `GRAPH ${iri(GRAPHS.current)} { ${iri(coverage.occurrence)} a rv:RelationOccurrence ;
      rv:occurrenceHead ${iri(coverage.occurrenceRevision)} . ${iri(work)} a <https://schema.org/CreativeWork> }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(coverage.occurrenceRevision)} a rv:RelationOccurrenceRevision ;
      rv:component ${iri(coverage.occurrence)} ; rv:relationDefinition ${iri(state.definition)} ; rv:lifecycle rv:Active
      ${coverage.kind === 'participation' ? `; rv:participation ${iri(coverage.participation)}` : ''} . }`;
  const guard = `${ownerGuard} ${assertionGuard} ${currentAttribution?.guard ?? ''}`;
  if ((await env.fuseki.query(`PREFIX rv: <${RV}> ASK { ${guard} }`)).boolean !== true) {
    throw new ContextCommandUnavailable('covered occurrence changed or is retired');
  }
  return { guard, applicability: state.applicability, references: [...new Set(references)],
    ...(retained ? { native: retained.native } : {}),
    ...(attributed ? { native: { receipt: attributed.receipt, manifest: attributed.manifest,
      modelGeneration: attributed.modelGeneration, attribution: currentAttribution } } : {}) };
}
