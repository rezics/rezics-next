import { t } from 'elysia';
import { pendingOperation, problemResult, sourcePosition } from './api-contract.ts';

const ref = t.String();
const nullableRef = t.Nullable(ref);
const replay = { sourcePosition, replayed: t.Boolean() };
const scale = t.Object({ min: t.Literal(1), max: t.Literal(10), step: t.Literal(1) });
const ratingPolicy = {
  targetGrain: t.Literal('mainVersion'), scale, cadence: t.Literal('standing'),
  population: t.Literal('account-principal'),
  aggregation: t.Literal('latest-per-rater-mean'),
  profile: t.Literal('realm-standing-rating-context-v1'),
};
const classificationDefinitions = {
  scheme: ref, concept: ref, path: ref, expression: ref, sense: ref,
};
const classificationProposition = {
  ...classificationDefinitions, definitionRevision: ref,
  profile: t.Literal('classification-proposition-v1'),
  interpretationScope: ref,
};
const classificationContext = {
  realm: ref, context: ref, contextRevision: ref,
  role: t.Literal('realm-classification'), fallbackContext: ref,
  inheritancePolicy: ref,
};
const selectedText = {
  work: ref, mainVersion: ref, selection: ref, contribution: ref,
  selectedDraft: ref, language: ref, body: t.String(),
};
const selectionWrite = {
  work: ref, mainVersion: ref, contribution: ref, publicationDecision: ref,
  selectedDraft: ref, selection: ref, matchUnit: ref,
  predecessor: nullableRef, ...replay,
};

export const writeProblems = {
  400: problemResult(400), 401: problemResult(401),
  403: problemResult(403), 409: problemResult(409),
  500: problemResult(500), 503: problemResult(503),
};
export const readProblems = {
  400: problemResult(400), 404: problemResult(404),
  500: problemResult(500), 503: problemResult(503),
};
export const authorizedReadProblems = {
  ...readProblems, 401: problemResult(401), 403: problemResult(403),
};
export { pendingOperation };

export const ratingAggregateResult = t.Object({
  profile: t.Literal('realm-standing-latest-mean-v1'), complete: t.Literal(true),
  context: ref, realm: ref, work: ref, mainVersion: ref,
  targetGrain: t.Literal('mainVersion'), scale,
  cadence: t.Literal('standing'), populationPolicy: t.Literal('account-principal'),
  aggregationPolicy: t.Literal('latest-per-rater-mean'),
  population: t.Integer(), count: t.Integer(), withdrawnCount: t.Integer(),
  histogram: t.Tuple([t.Integer(), t.Integer(), t.Integer(), t.Integer(), t.Integer(),
    t.Integer(), t.Integer(), t.Integer(), t.Integer(), t.Integer()]),
  sum: t.Integer(), mean: t.Nullable(t.Number()),
  precision: t.Union([t.Object({ kind: t.Literal('no-data') }),
    t.Object({ kind: t.Literal('exact-rational'), numerator: t.Integer(),
      denominator: t.Integer() })]),
  sourcePosition,
});

export const ratingObservationWriteResult = t.Object({
  observation: ref, observationRevision: ref, predecessor: nullableRef,
  context: ref, work: ref, mainVersion: ref,
  value: t.Nullable(t.Integer()),
  availability: t.Union([t.Literal('available'), t.Literal('withdrawn')]),
  profile: t.Literal('realm-standing-rating-observation-v1'), ...replay,
});
export const ratingObservationReadResult = t.Object({
  observation: ref, observationRevision: ref, context: ref, work: ref,
  mainVersion: ref, predecessor: nullableRef,
  availability: t.Union([t.Literal('available'), t.Literal('withdrawn')]),
  value: t.Nullable(t.Integer()), evaluatedAt: t.String(), submittedAt: t.String(),
  originalSubmissionAt: t.String(), revisedAt: t.String(),
  profile: t.Literal('realm-standing-rating-observation-v1'),
});
export const ratingContextWriteResult = t.Object({
  context: ref, realm: ref, question: t.String(), contextRevision: ref,
  ...ratingPolicy, ...replay,
});
export const ratingContextReadResult = t.Object({
  context: ref, realm: ref, question: t.String(), contextRevision: ref, ...ratingPolicy,
});

export const classificationResolutionResult = t.Object({
  work: ref, mainVersion: ref, sense: ref,
  requestedContext: t.Union([t.Object({ kind: t.Literal('global') }),
    t.Object({ kind: t.Literal('realm-classification'), id: ref })]),
  classificationContext: ref, contextRevision: nullableRef,
  state: t.Union([t.Literal('accepted'), t.Literal('rejected'), t.Literal('absent')]),
  source: t.Union([t.Literal('local'), t.Literal('inherited-global'),
    t.Literal('global'), t.Literal('none')]),
  sourceContext: nullableRef, application: nullableRef, decision: nullableRef,
  policy: ref, sourcePosition,
});
export const classificationDecisionWriteResult = t.Object({
  application: ref, decision: ref,
  decisionOutcome: t.Union([t.Literal('accepted'), t.Literal('rejected')]),
  context: ref, realm: nullableRef, contextRevision: nullableRef,
  work: ref, mainVersion: ref, sense: ref, expectedDecisionHead: nullableRef,
  profile: t.Literal('classification-direct-decision-v1'), ...replay,
});
export const classificationPropositionWriteResult = t.Object({
  ...classificationProposition, ...replay,
});
export const classificationPropositionReadResult = t.Object({
  ...classificationProposition, label: t.String(), language: t.Literal('en'),
});
export const classificationContextWriteResult = t.Object({
  ...classificationContext, ...replay,
});
export const classificationContextReadResult = t.Object(classificationContext);

export const spaceWriteResult = t.Object({
  space: ref, realm: ref, spaceRevision: ref, realmRevision: ref,
  owner: ref, capabilities: t.Tuple([t.Literal('realm')]), ...replay,
});
export const spaceReadResult = t.Object({
  space: ref, realm: ref, owner: ref, name: t.String(),
  capabilities: t.Tuple([t.Literal('realm')]), state: t.Literal('active'),
  spaceRevision: ref, realmRevision: ref, selectionPolicy: ref,
  membershipPolicy: ref, reviewPolicy: ref,
});

export const publicationSelectionWriteResult = t.Union([
  t.Object(selectionWrite, { additionalProperties: false }),
  t.Object({ ...selectionWrite, realm: ref, slot: ref },
    { additionalProperties: false }),
]);
export const publicationRejectionWriteResult = t.Object({
  work: ref, mainVersion: ref, realm: ref, slot: ref, rejection: ref,
  reasonCode: t.Literal('not-approved'), predecessor: nullableRef, ...replay,
});
export const realmSelectionReadResult = t.Union([
  t.Object({ status: t.Literal('suppressed'), reason: t.Literal('realm-rejection'),
    work: ref, mainVersion: ref, realm: ref, effectiveContext: ref,
    rejection: ref, reasonCode: t.Literal('not-approved') },
  { additionalProperties: false }),
  t.Object({ ...selectedText, realm: ref, effectiveContext: ref,
    reason: t.Union([t.Literal('realm-adoption'), t.Literal('main-fallback')]) },
  { additionalProperties: false }),
]);
export const mainSelectionReadResult = t.Object(selectedText);

export const contributionPublicationWriteResult = t.Object({
  contribution: ref, publicationDecision: ref, selectedDraft: ref,
  predecessor: nullableRef, ...replay,
});
export const contributionEditWriteResult = t.Object({
  contribution: ref, draftRevision: ref, predecessor: ref, ...replay,
});
export const contributionWriteResult = t.Object({
  contribution: ref, draftRevision: ref, work: ref, language: ref, author: ref,
  ...replay,
});
export const contributionDraftReadResult = t.Object({
  contribution: ref, revision: ref, work: ref, author: ref, language: ref,
  body: t.String(), predecessor: t.Optional(ref), sourcePosition,
});
export const contentEditWriteResult = t.Object({
  work: ref, revision: ref, predecessor: ref, ...replay,
});
