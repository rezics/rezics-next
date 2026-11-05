import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import { withReadTransaction } from '../semantic/read.ts';
import {
  readViewerActions,
  type ViewerActionBindings,
  type ViewerActionResource,
  type ViewerActionResources,
} from '../access/viewer-actions.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import { routeOf } from '../route/route.ts';
import {
  MAX_VIEWER_FACTS_INPUT_BYTES,
  MAX_VIEWER_FACTS_RESPONSE_BYTES,
  MAX_VIEWER_FACTS_ROWS,
  prepareViewerFacts,
  readViewerFacts,
  viewerFactsCurrent,
  type PreparedViewerFacts,
  type ViewerFact,
  type ViewerFactInput,
  type ViewerFactsPage,
  type ViewerQuestion,
} from './viewer-facts.ts';

const SUBJECT_TYPE = /^[A-Za-z][A-Za-z0-9_.-]*(?::[A-Za-z][A-Za-z0-9_.-]*)?$/;
const SEMANTIC_SUBJECT_RESOURCE_TYPE = 'semantic.subject';
const PERSONAL_ACTIONS = new Set([
  'library_entry:update',
  'library_entry:delete',
  'progress_session:create',
  'progress_session:update',
  'rating:vote',
]);
const MANUAL_SCORE_OPERATIONS = new Set(['rating.vote_put', 'rating.vote_delete']);

export type ViewerPersonalActionInput = ViewerFactInput & Readonly<{ resourceType: string }>;
export type ViewerPersonalActionRuntime = Readonly<{
  access: Access;
  resources: ViewerActionResources;
  bindings: ViewerActionBindings;
  clock: () => Date;
}>;
export type ViewerPersonalAction = Readonly<{
  action: string;
  operations: readonly string[];
}>;
export type ViewerPersonalActionState =
  | Readonly<{ state: 'current'; allowed: readonly ViewerPersonalAction[] }>
  | Readonly<{ state: 'unavailable'; reason: 'admission' | 'currentness' | 'dependency' }>;
export type ViewerPersonalFact = ViewerFact & Readonly<{ actions: ViewerPersonalActionState }>;
export type ViewerPersonalActionsPage =
  | Readonly<{ state: 'current'; question: ViewerQuestion | null; rows: readonly ViewerPersonalFact[] }>
  | Extract<ViewerFactsPage, { state: 'unavailable' }>;

export type ViewerPersonalActionsReader = (
  actor: Actor,
  rows: readonly ViewerPersonalActionInput[],
  questionId: string,
  deadline: number,
) => Promise<ViewerPersonalActionsPage>;

export type ViewerPersonalActionsDependencies = Readonly<{
  pool: Pool;
  viewerActionRuntime: () => ViewerPersonalActionRuntime;
}>;

type ActionReference = Readonly<{ type: string; id: string }>;
type ActionReferenceGroups = Readonly<{ subject: readonly ActionReference[]; typed: readonly ActionReference[] }>;
type ActionResult = Awaited<ReturnType<typeof readViewerActions>>['resources'][number];
type InternalActionState = ViewerPersonalActionState;
type ActionRuntimeSnapshot = Readonly<{
  runtime: ViewerPersonalActionRuntime;
  resourceTypes: readonly string[];
  resources: readonly (ViewerActionResource | undefined)[];
  bindings: string;
}>;

function refKey(reference: ActionReference): string {
  return `${reference.type}/${reference.id}`;
}

function validateRows(rows: readonly ViewerPersonalActionInput[], questionId: string): ViewerPersonalActionInput[] {
  if (!Array.isArray(rows) || rows.length > MAX_VIEWER_FACTS_ROWS || routeOf(questionId) === null)
    throw new RangeError('Viewer facts require an explicit routed question and at most 100 rows');
  const copied = Array.from(rows, (row) => {
    if (
      !row ||
      typeof row.rowKey !== 'string' ||
      row.rowKey.length === 0 ||
      typeof row.subjectId !== 'string' ||
      routeOf(row.subjectId) === null ||
      typeof row.resourceType !== 'string' ||
      !SUBJECT_TYPE.test(row.resourceType)
    )
      throw new TypeError('Viewer personal action rows require a key, routed Subject and resource type');
    return Object.freeze({ rowKey: row.rowKey, subjectId: row.subjectId, resourceType: row.resourceType });
  });
  const bytes = new TextEncoder().encode(JSON.stringify({ questionId, rows: copied })).byteLength;
  if (bytes > MAX_VIEWER_FACTS_INPUT_BYTES)
    throw new RangeError(`Viewer personal action input exceeds ${MAX_VIEWER_FACTS_INPUT_BYTES} encoded bytes`);
  return copied;
}

function unavailablePage(reason: 'identity' | 'currentness' | 'response_limit'): ViewerPersonalActionsPage {
  return { state: 'unavailable', reason, retryable: reason !== 'response_limit' };
}

function standardQuestionCurrent(questionId: string, question: ViewerQuestion | null): boolean {
  return (
    questionId === STANDARD_QUESTION_ID &&
    question?.id === STANDARD_QUESTION_ID &&
    question.revision === 1 &&
    question.scale.min === 0 &&
    question.scale.max === 20 &&
    question.scale.displayStep === 1 &&
    question.meaning.length > 0
  );
}

function personalActions(
  actions: readonly Readonly<{ action: string; operations: readonly string[] }>[],
  allowManualScore: boolean,
): readonly ViewerPersonalAction[] {
  const projected: ViewerPersonalAction[] = [];
  for (const entry of actions) {
    if (!PERSONAL_ACTIONS.has(entry.action)) continue;
    if (entry.action !== 'rating:vote') {
      projected.push({ action: entry.action, operations: [...entry.operations] });
      continue;
    }
    if (!allowManualScore) continue;
    const operations = entry.operations.filter((operation) => MANUAL_SCORE_OPERATIONS.has(operation));
    if (operations.length > 0)
      projected.push({
        action: entry.action,
        operations,
      });
  }
  return projected;
}

function sameActionRuntime(left: ActionRuntimeSnapshot, right: ActionRuntimeSnapshot): boolean {
  return (
    left.runtime.access === right.runtime.access &&
    left.runtime.clock === right.runtime.clock &&
    left.resourceTypes.length === right.resourceTypes.length &&
    left.resourceTypes.every((type, index) => type === right.resourceTypes[index]) &&
    left.resources.length === right.resources.length &&
    left.resources.every((resource, index) => resource === right.resources[index]) &&
    left.bindings === right.bindings
  );
}

function snapshotActionRuntime(
  runtime: ViewerPersonalActionRuntime,
  resourceTypes: readonly string[],
): ActionRuntimeSnapshot {
  const types = [...resourceTypes];
  return {
    runtime,
    resourceTypes: types,
    resources: types.map((type) => runtime.resources.get(type)),
    bindings: JSON.stringify(types.map((type) => [type, runtime.bindings.get(type) ?? []])),
  };
}

function actionReferenceGroups(rows: readonly ViewerPersonalActionInput[]): ActionReferenceGroups {
  const subjects = new Map<string, ActionReference>();
  const typed = new Map<string, ActionReference>();
  for (const row of rows) {
    const subject = { type: SEMANTIC_SUBJECT_RESOURCE_TYPE, id: row.subjectId };
    const subjectResource = { type: row.resourceType, id: row.subjectId };
    subjects.set(refKey(subject), subject);
    typed.set(refKey(subjectResource), subjectResource);
  }
  return { subject: [...subjects.values()], typed: [...typed.values()] };
}

function combineActionStates(
  rows: readonly ViewerPersonalActionInput[],
  subject: ReadonlyMap<string, InternalActionState>,
  typed: ReadonlyMap<string, InternalActionState>,
): Map<string, InternalActionState> {
  const unique = new Map<string, ActionReference>();
  for (const row of rows) {
    const reference = { type: row.resourceType, id: row.subjectId };
    unique.set(refKey(reference), reference);
  }
  const result = new Map<string, InternalActionState>();
  for (const reference of unique.values()) {
    const subjectState = subject.get(refKey({ type: SEMANTIC_SUBJECT_RESOURCE_TYPE, id: reference.id }));
    const typedState = typed.get(refKey(reference));
    if (!subjectState || !typedState) {
      result.set(refKey(reference), { state: 'unavailable', reason: 'dependency' });
      continue;
    }
    if (subjectState.state === 'unavailable' || typedState.state === 'unavailable') {
      result.set(refKey(reference), subjectState.state === 'unavailable' ? subjectState : typedState);
      continue;
    }
    const merged = new Map<string, Set<string>>();
    for (const action of [...subjectState.allowed, ...typedState.allowed]) {
      const operations = merged.get(action.action) ?? new Set<string>();
      for (const operation of action.operations) operations.add(operation);
      merged.set(action.action, operations);
    }
    result.set(refKey(reference), {
      state: 'current',
      allowed: [...merged]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([action, operations]) => ({ action, operations: [...operations].sort() })),
    });
  }
  return result;
}

async function readActionProjection(
  dependencies: ViewerPersonalActionsDependencies,
  runtime: ViewerPersonalActionRuntime,
  actor: Actor,
  groups: ActionReferenceGroups,
  rows: readonly ViewerPersonalActionInput[],
  deadline: number,
  questionId: string,
  question: ViewerQuestion | null,
): Promise<Map<string, InternalActionState>> {
  const subject = await readActionBatch(dependencies, runtime, actor, groups.subject, deadline, questionId, question);
  const typed = await readActionBatch(dependencies, runtime, actor, groups.typed, deadline, questionId, question);
  return combineActionStates(rows, subject, typed);
}

async function readActionBatch(
  dependencies: ViewerPersonalActionsDependencies,
  runtime: ViewerPersonalActionRuntime,
  actor: Actor,
  references: readonly ActionReference[],
  deadline: number,
  questionId: string,
  question: ViewerQuestion | null,
): Promise<Map<string, InternalActionState>> {
  const results = new Map<string, InternalActionState>();
  const admitted = references.filter(({ type }) => runtime.resources.has(type));
  for (const reference of references) {
    if (!runtime.resources.has(reference.type))
      results.set(refKey(reference), { state: 'unavailable', reason: 'admission' });
  }
  if (admitted.length === 0) return results;

  const page = await readViewerActions(
    {
      pool: dependencies.pool,
      access: runtime.access,
      resources: runtime.resources,
      bindings: runtime.bindings,
      clock: runtime.clock,
    },
    actor,
    admitted,
    deadline,
  );
  const allowManualScore = standardQuestionCurrent(questionId, question);
  for (const result of page.resources as readonly ActionResult[]) {
    const key = refKey({ type: result.type, id: result.id });
    if ('error' in result) {
      results.set(key, { state: 'unavailable', reason: 'admission' });
      continue;
    }
    results.set(key, {
      state: 'current',
      allowed: personalActions(result.viewerActions, allowManualScore),
    });
  }
  return results;
}

function unavailableStates(
  references: readonly ActionReference[],
  reason: Extract<ViewerPersonalActionState, { state: 'unavailable' }>['reason'],
): Map<string, InternalActionState> {
  return new Map(references.map((reference) => [refKey(reference), { state: 'unavailable', reason }]));
}

function matchingActionStates(
  first: ReadonlyMap<string, InternalActionState>,
  final: ReadonlyMap<string, InternalActionState>,
  references: readonly ActionReference[],
): Map<string, InternalActionState> {
  const result = new Map<string, InternalActionState>();
  for (const reference of references) {
    const key = refKey(reference);
    const before = first.get(key);
    const after = final.get(key);
    if (!before || !after) {
      result.set(key, { state: 'unavailable', reason: 'dependency' });
      continue;
    }
    result.set(
      key,
      JSON.stringify(before) === JSON.stringify(after) ? after : { state: 'unavailable', reason: 'currentness' },
    );
  }
  return result;
}

async function currentFacts(
  dependencies: ViewerPersonalActionsDependencies,
  actor: Actor,
  prepared: PreparedViewerFacts,
  runtime: ViewerPersonalActionRuntime,
  deadline: number,
): Promise<boolean> {
  try {
    return await viewerFactsCurrent({ pool: dependencies.pool, access: runtime.access }, actor, prepared, deadline);
  } catch {
    return false;
  }
}

/**
 * Compose exact Entry and standard-score facts with the current mounted Access actions.
 * Rows are already source-admitted by the caller; this helper preserves their original Subject IDs.
 */
export async function readViewerPersonalActionsPage(
  dependencies: ViewerPersonalActionsDependencies,
  actor: Actor,
  inputRows: readonly ViewerPersonalActionInput[],
  questionId: string,
  deadline: number,
): Promise<ViewerPersonalActionsPage> {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  const accountActor = actor;
  const rows = validateRows(inputRows, questionId);
  let initialRuntime: ViewerPersonalActionRuntime;
  try {
    initialRuntime = dependencies.viewerActionRuntime();
  } catch {
    return unavailablePage('currentness');
  }
  const prepared = await prepareViewerFacts(
    { pool: dependencies.pool, access: initialRuntime.access },
    accountActor,
    rows.map(({ rowKey, subjectId }) => ({ rowKey, subjectId })),
    questionId,
    deadline,
  );
  const facts = await withReadTransaction(
    dependencies.pool,
    (client) => readViewerFacts(client, accountActor, prepared),
    deadline,
  );
  if (facts.state !== 'current') return facts;

  const references = actionReferenceGroups(rows);
  if (references.subject.length === 0) {
    if (!(await currentFacts(dependencies, accountActor, prepared, initialRuntime, deadline)))
      return unavailablePage('currentness');
    const result: ViewerPersonalActionsPage = {
      state: 'current',
      question: facts.question,
      rows: [],
    };
    return new TextEncoder().encode(JSON.stringify(result)).byteLength <= MAX_VIEWER_FACTS_RESPONSE_BYTES
      ? result
      : unavailablePage('response_limit');
  }

  const actionReferences = [
    ...new Map(
      [...references.subject, ...references.typed].map((reference) => [refKey(reference), reference]),
    ).values(),
  ];
  const resourceTypes = [...new Set(actionReferences.map(({ type }) => type))];
  let firstRuntime: ViewerPersonalActionRuntime;
  let firstRuntimeSnapshot: ActionRuntimeSnapshot;
  let first: Map<string, InternalActionState>;
  try {
    firstRuntime = dependencies.viewerActionRuntime();
    firstRuntimeSnapshot = snapshotActionRuntime(firstRuntime, resourceTypes);
    first = await readActionProjection(
      dependencies,
      firstRuntime,
      accountActor,
      references,
      rows,
      deadline,
      questionId,
      facts.question,
    );
  } catch {
    if (!(await currentFacts(dependencies, accountActor, prepared, initialRuntime, deadline)))
      return unavailablePage('currentness');
    const unavailable = unavailableStates([...references.typed, ...references.subject], 'dependency');
    const actions = combineActionStates(rows, unavailable, unavailable);
    return pageWithActions(facts, rows, actions);
  }
  if (!(await currentFacts(dependencies, accountActor, prepared, firstRuntime, deadline)))
    return unavailablePage('currentness');

  let finalRuntime: ViewerPersonalActionRuntime;
  let finalRuntimeSnapshot: ActionRuntimeSnapshot;
  let final: Map<string, InternalActionState>;
  try {
    finalRuntime = dependencies.viewerActionRuntime();
    finalRuntimeSnapshot = snapshotActionRuntime(finalRuntime, resourceTypes);
    final = await readActionProjection(
      dependencies,
      finalRuntime,
      accountActor,
      references,
      rows,
      deadline,
      questionId,
      facts.question,
    );
  } catch {
    if (!(await currentFacts(dependencies, accountActor, prepared, firstRuntime, deadline)))
      return unavailablePage('currentness');
    const unavailable = unavailableStates([...references.typed, ...references.subject], 'dependency');
    return pageWithActions(facts, rows, combineActionStates(rows, unavailable, unavailable));
  }
  if (!(await currentFacts(dependencies, accountActor, prepared, finalRuntime, deadline)))
    return unavailablePage('currentness');

  let afterFinalization: ViewerPersonalActionRuntime;
  try {
    afterFinalization = dependencies.viewerActionRuntime();
  } catch {
    return pageWithActions(facts, rows, unavailableStates(actionReferences, 'dependency'));
  }
  const afterFinalizationSnapshot = snapshotActionRuntime(afterFinalization, resourceTypes);
  const actions =
    sameActionRuntime(firstRuntimeSnapshot, finalRuntimeSnapshot) &&
    sameActionRuntime(finalRuntimeSnapshot, afterFinalizationSnapshot)
      ? matchingActionStates(first, final, actionReferences)
      : unavailableStates(actionReferences, 'currentness');
  return pageWithActions(facts, rows, actions);
}

function pageWithActions(
  facts: Extract<ViewerFactsPage, { state: 'current' }>,
  inputs: readonly ViewerPersonalActionInput[],
  actions: ReadonlyMap<string, InternalActionState>,
): ViewerPersonalActionsPage {
  const rows = facts.rows.map((fact, index) => ({
    ...fact,
    actions: actions.get(refKey({ type: inputs[index]!.resourceType, id: fact.subjectId })) ?? {
      state: 'unavailable' as const,
      reason: 'dependency' as const,
    },
  }));
  const result: ViewerPersonalActionsPage = { state: 'current', question: facts.question, rows };
  return new TextEncoder().encode(JSON.stringify(result)).byteLength <= MAX_VIEWER_FACTS_RESPONSE_BYTES
    ? result
    : unavailablePage('response_limit');
}
