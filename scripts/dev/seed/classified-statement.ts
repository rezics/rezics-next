import { CLASSIFICATION_PROPOSITION_PROFILE } from '../../../services/main/src/modules/classification/proposition.ts';
import { CLASSIFIED_AS } from '../../../services/main/src/modules/statement/schema.ts';

// Topic seeds state a Concept about a Main version inside a shared Context, then
// accept or reject that Statement. Acceptance scope stays the Global or Realm
// classification context; the retired direct-decision route no longer writes one.

export const CLASSIFIED_AS_PREDICATE = CLASSIFIED_AS;

export interface ClassifiedTerm { concept: string; definitionRevision: string }
export interface SharedClassificationContext { context: string; semanticRevision: string }
export interface ClassifiedStatement { statement: string; meaningKey: string }
export interface ClassificationResolution { state: string; source: string; decision: string | null }
export type ClassificationScope = { kind: 'global' } | { kind: 'realm-classification'; id: string };
export type StatementAcceptance = { kind: 'global' } | { kind: 'realm'; realm: string };

export type ClassificationPost = <T>(path: string, body: unknown, token: string, key: string) => Promise<T>;

/** Skip a write when this scope already has its own acceptance. A Realm that only
 * inherits Global still needs a local decision. */
export function classificationAlreadyAccepted(current: Pick<ClassificationResolution, 'state' | 'source'>,
  scope: ClassificationScope): boolean {
  return current.state === 'accepted' && (scope.kind === 'global' || current.source === 'local');
}

/** Revise only a decision this scope already holds. An inherited Global head is not the local head. */
export function expectedLocalDecisionHead(current: Pick<ClassificationResolution, 'source' | 'decision'>): string | null {
  return current.source === 'local' ? current.decision : null;
}

/** A rejection revises the accepted head this read returned, including a Global one. */
export function rejectionRevises(current: ClassificationResolution, scope: ClassificationScope): boolean {
  return classificationAlreadyAccepted(current, scope) && current.decision !== null;
}

export function statementAcceptance(scope: ClassificationScope): StatementAcceptance {
  return scope.kind === 'global' ? { kind: 'global' } : { kind: 'realm', realm: scope.id };
}

/** One shared Context entry per Concept, in a stable order so a replay sends the same body. */
export function classificationContextBody(actor: string, terms: readonly ClassifiedTerm[]) {
  return { profile: 'context-v1' as const, role: 'shared' as const, disclosure: 'public' as const, base: null,
    entries: [...terms].sort((left, right) => left.concept.localeCompare(right.concept)).map(term => ({
      target: term.concept, relation: CLASSIFIED_AS, state: 'defined' as const,
      definition: term.definitionRevision, applicability: [] as string[],
    })), actingSubject: actor };
}

export function classifiedStatementBody(actor: string, mainVersion: string, concept: string,
  interpretation: SharedClassificationContext) {
  return { profile: 'statement-v1' as const, speaker: { kind: 'personal' as const }, subject: mainVersion,
    predicate: CLASSIFIED_AS, relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
    value: { kind: 'resource' as const, iri: concept }, applicability: [] as string[],
    interpretation: { kind: 'explicit' as const, context: interpretation.context,
      semanticRevision: interpretation.semanticRevision },
    evidence: [] as string[], actingSubject: actor };
}

export function statementDecisionBody(actor: string, statement: ClassifiedStatement, scope: ClassificationScope,
  outcome: 'accepted' | 'rejected', expectedDecisionHead: string | null) {
  return { profile: 'statement-decision-v1' as const,
    target: { kind: 'qualified-fact' as const, meaningKey: statement.meaningKey, support: [statement.statement] },
    acceptance: statementAcceptance(scope), expectedDecisionHead, outcome, actingSubject: actor };
}

export async function shareClassificationContext(post: ClassificationPost, token: string, actor: string,
  terms: readonly ClassifiedTerm[], key: string): Promise<SharedClassificationContext> {
  if (!terms.length) throw new Error('A classification Context needs at least one Concept');
  return post<SharedClassificationContext>('/v1/contexts', classificationContextBody(actor, terms), token, key);
}

export async function recordClassifiedStatement(post: ClassificationPost, token: string, actor: string,
  mainVersion: string, concept: string, interpretation: SharedClassificationContext,
  key: string): Promise<ClassifiedStatement> {
  return post<ClassifiedStatement>('/v1/statements',
    classifiedStatementBody(actor, mainVersion, concept, interpretation), token, key);
}

/** Home hides a Concept whose spoiler hint is still unknown. A seeded topic is not a spoiler. */
export async function discloseClassificationConcept(post: ClassificationPost, token: string, actor: string,
  concept: string, key: string, scope: StatementAcceptance = { kind: 'global' }): Promise<void> {
  await post(`/v1/concepts/${concept.slice(-36)}/spoiler-hints`, {
    profile: 'concept-spoiler-hint-v1', context: scope, hint: 'not-spoiler', expectedGeneration: '0',
    actingSubject: actor }, token, key);
}

/**
 * Accept a Concept on a Work when this scope does not already accept it.
 * `settled` is the current classification resolution for that Work, Sense and scope.
 */
export async function acceptClassifiedStatement(post: ClassificationPost, token: string, actor: string,
  work: { mainVersion: string }, concept: string, interpretation: SharedClassificationContext,
  scope: ClassificationScope, settled: ClassificationResolution, keys: { statement: string; decision: string }) {
  if (classificationAlreadyAccepted(settled, scope)) return;
  const statement = await recordClassifiedStatement(post, token, actor, work.mainVersion, concept, interpretation,
    keys.statement);
  await post('/v1/statement-decisions', statementDecisionBody(actor, statement, scope, 'accepted',
    expectedLocalDecisionHead(settled)), token, keys.decision);
}

/** Reject an acceptance this scope already holds, so an older Sense stops matching. */
export async function rejectClassifiedStatement(post: ClassificationPost, token: string, actor: string,
  work: { mainVersion: string }, concept: string, interpretation: SharedClassificationContext,
  scope: ClassificationScope, settled: ClassificationResolution, keys: { statement: string; decision: string }) {
  if (!rejectionRevises(settled, scope)) return;
  const statement = await recordClassifiedStatement(post, token, actor, work.mainVersion, concept, interpretation,
    keys.statement);
  await post('/v1/statement-decisions', statementDecisionBody(actor, statement, scope, 'rejected', settled.decision),
    token, keys.decision);
}
