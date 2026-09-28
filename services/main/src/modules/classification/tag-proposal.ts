import { t } from 'elysia';
import type { Static } from 'typebox';
import { profileValidations } from '../../infrastructure/profile.ts';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { ContextCommandUnavailable, commitCommand, checkedCommandReceipt, readCommandReceipt,
  term } from '../context/command.ts';
import { activeDirectDefinitionsGuard } from '../context/definition-state.ts';
import { conceptLabel, conceptScopePattern, SKOS } from '../semantic/concept-search.ts';
import { CLASSIFIED_AS, STATEMENT_PROFILE, statementMeaningKey, type StatementMeaning } from '../statement/schema.ts';
import { GRAPHS, ID, hash, iri, lit, prepareComponent, type WorkActivationEnvironment } from '../work/activate.ts';
import { readId, readPosition } from '../work/read-contract.ts';
import { unerased } from '../work/public-patterns.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from './proposition.ts';

export const TAG_PROPOSAL_COST = { graphCalls: 24, graphBytes: 524_288, deadlineMs: 30_000 } as const;
export const tagProposalInput = t.Object({ work: readId, mainVersion: readId, actingSubject: readId,
  tag: t.Union([
    t.Object({ concept: readId }, { additionalProperties: false }),
    t.Object({ label: t.String({ minLength: 1, maxLength: 240 }),
      language: t.String({ minLength: 2, maxLength: 40 }) }, { additionalProperties: false }),
  ]),
  acceptance: t.Union([t.Object({ kind: t.Literal('global') }, { additionalProperties: false }),
    t.Object({ kind: t.Literal('realm'), realm: readId }, { additionalProperties: false })]),
}, { additionalProperties: false });
export type TagProposalInput = Static<typeof tagProposalInput>;
export const tagProposalResult = t.Object({ statement: readId, revision: readId, concept: readId,
  meaningKey: t.String(), acceptance: tagProposalInput.properties.acceptance,
  state: t.Literal('proposed'), replayed: t.Boolean(), sourcePosition: readPosition });

export function tagProposalRequest(input: TagProposalInput) {
  const tag = 'label' in input.tag ? conceptLabel(input.tag.label, input.tag.language) : input.tag;
  return { family: 'statement-record-v1', action: 'statement.record', scope: `work:edit:${input.work}`,
    digest: hash(JSON.stringify(['author-tag-proposal-v1', input.work, input.mainVersion,
      tag, input.acceptance, input.actingSubject])) };
}

/** One author-owned Work, one concept and one attributed Statement in one graph
 * command. New labels create distinct identities; clients select existing IDs
 * through concept search. No acceptance decision or classifiedAs base triple
 * is written. Existing Statement decision/withdrawal APIs own the next steps. */
export async function recordTagProposal(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: TagProposalInput) {
  const plan = tagProposalRequest(input);
  const saved = await readCommandReceipt(env, admission.id, plan.family);
  if (saved) return checkedCommandReceipt(saved, admission, plan.digest);
  const statement = ID + Bun.randomUUIDv7(), revision = ID + Bun.randomUUIDv7(), operation = ID + Bun.randomUUIDv7();
  const concept = 'concept' in input.tag ? input.tag.concept : ID + Bun.randomUUIDv7();
  const label = 'label' in input.tag ? conceptLabel(input.tag.label, input.tag.language) : null;
  const realm = input.acceptance.kind === 'realm' ? input.acceptance.realm : undefined;
  const meaning: StatementMeaning = { subject: input.mainVersion, predicate: CLASSIFIED_AS,
    relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE, interpretationDefinitions: [],
    value: { kind: 'resource', iri: concept }, applicability: [] };
  const meaningKey = statementMeaningKey(meaning);
  const manifest = prepareComponent(env.objectDirectory, statement, { revision, meaning, meaningKey,
    speaker: input.actingSubject, semanticContextRevision: null, state: 'active', evidence: [],
    recordedBy: input.actingSubject, proposedAcceptance: input.acceptance,
    conceptDefinition: label ? { concept, ...label, realm: realm ?? null } : null }, STATEMENT_PROFILE);
  const validations = await profileValidations(env.fuseki, 'statement-v1', [
    { shape: `${STATEMENT_PROFILE}/statement-shape`, focus: [statement], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${STATEMENT_PROFILE}/revision-shape`, focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  if (label) validations.push(...await profileValidations(env.fuseki, 'tag-proposal-concept-v1', [
    { shape: 'https://rezics.com/definition/tag-proposal-concept-v1/concept-shape',
      focus: [concept], graphs: [GRAPHS.current] },
  ]));
  const result = await commitCommand(env, admission, { family: plan.family, digest: plan.digest,
    validations, operation, component: statement, revision, expectedHead: null,
    insert: `GRAPH ${iri(GRAPHS.current)} {
      ${label ? `${iri(concept)} a <https://schema.org/DefinedTerm>, rv:AuthorTagConcept ; <${SKOS}prefLabel> ${lit(label.label)}@${label.language} ;
        rv:conceptState rv:Active ${realm ? `; rv:conceptRealm ${iri(realm)}` : ''} .` : ''}
      ${iri(statement)} a rdf:Statement ; rdf:subject ${iri(input.mainVersion)} ;
        rdf:predicate ${term(CLASSIFIED_AS)} ; rdf:object ${iri(concept)} ;
        rv:relationDefinition ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
        rv:speaker ${iri(input.actingSubject)} ; rv:meaningKey ${iri(meaningKey)} ;
        rv:statementState rv:Active ; rv:head ${iri(revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:StatementRevision, rv:RevisionAnchor ; rv:component ${iri(statement)} ;
          rv:statementState rv:Active ; rv:recordedBy ${iri(input.actingSubject)} ; rv:operation ${iri(operation)} ;
          rv:modelRevision ${iri(STATEMENT_PROFILE)} ; rv:shapeRevision ${iri(STATEMENT_PROFILE)} ;
          rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }`,
    where: `GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.work)} a <https://schema.org/CreativeWork> ; rv:mainVersion ${iri(input.mainVersion)} .
      ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
      ${realm ? `${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?space ; rv:classificationContext ?context .
        ?space rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .` : ''}
      ${label ? `FILTER NOT EXISTS { ${iri(concept)} ?p ?o }` : `${iri(concept)} a ?conceptType .
        VALUES ?conceptType { <${SKOS}Concept> rv:AuthorTagConcept }
        ${conceptScopePattern(realm, iri(concept))}`}
      } ${unerased(iri(input.work))} ${activeDirectDefinitionsGuard([CLASSIFICATION_PROPOSITION_PROFILE])}` });
  if (!result) throw new ContextCommandUnavailable('Work, Realm or concept is unavailable');
  return checkedCommandReceipt(result, admission, plan.digest);
}

export function tagProposalBudget<T>(run: () => Promise<T>) {
  return fusekiReadBudget.run({ signal: AbortSignal.timeout(TAG_PROPOSAL_COST.deadlineMs),
    callsLeft: TAG_PROPOSAL_COST.graphCalls, bytesLeft: TAG_PROPOSAL_COST.graphBytes }, run);
}
