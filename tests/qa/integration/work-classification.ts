import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../../../services/main/src/modules/access/admission.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../../../services/main/src/modules/classification/proposition.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { RV, hash } from '../../../services/main/src/modules/work/activate.ts';

export interface ClassifiedConcept {
  concept: string;
  sense: string;
  definitionRevision: string;
}

export interface ConceptContext {
  context: string;
  semanticRevision: string;
}

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;
type ReadJson = <T>(response: Response, expected?: number) => Promise<T>;

/** The speaker needs `context:create:root` / `context.create`,
 * `statement:speak:<actor>` / `statement.record`, and
 * `classification:decide:global` / `statement.decide`. Search still hides the
 * Concept until `discloseConcept`. */
export async function shareClassifiedConcepts(send: Send, read: ReadJson, actor: string,
  terms: readonly ClassifiedConcept[]): Promise<ConceptContext> {
  return read<ConceptContext>(await send('POST', '/v1/contexts', {
    profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
    entries: terms.map(term => ({ target: term.concept, relation: `${RV}classifiedAs`, state: 'defined' as const,
      definition: term.definitionRevision, applicability: [] })),
    actingSubject: actor,
  }), 201);
}

export async function acceptClassifiedWork(send: Send, read: ReadJson, actor: string,
  work: { mainVersion: string }, term: ClassifiedConcept, interpretation: ConceptContext): Promise<void> {
  const statement = await read<{ statement: string; meaningKey: string }>(await send('POST', '/v1/statements', {
    profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.mainVersion,
    predicate: `${RV}classifiedAs`, relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
    value: { kind: 'resource', iri: term.concept }, applicability: [],
    interpretation: { kind: 'explicit', context: interpretation.context,
      semanticRevision: interpretation.semanticRevision },
    evidence: [], actingSubject: actor,
  }), 201);
  await read(await send('POST', '/v1/statement-decisions', {
    profile: 'statement-decision-v1',
    target: { kind: 'qualified-fact', meaningKey: statement.meaningKey, support: [statement.statement] },
    acceptance: { kind: 'global' }, outcome: 'accepted', expectedDecisionHead: null, actingSubject: actor,
  }), 201);
}

/** An accepted Concept stays out of search until its hint is not a spoiler. */
export async function discloseConcept(pool: Pool, principal: VerifiedPrincipal, actor: string,
  concept: string): Promise<void> {
  await new AccessJudgments(pool).declareHint(principal, {
    concept, context: { kind: 'global' }, hint: 'not-spoiler', expectedGeneration: '0',
    actingSubject: actor, idempotencyKey: randomUUID(),
    requestDigest: hash(JSON.stringify([concept, { kind: 'global' }, 'not-spoiler'])),
  });
}
