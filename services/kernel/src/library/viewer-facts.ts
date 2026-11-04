import type { Pool, PoolClient } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { withConnection } from '../database/pool.ts';
import { partitionReadClient } from '../database/read-snapshot.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readVisibleRatingQuestion, ratingQuestionIdentity, ratingQuestionView } from '../rating/question-directory.ts';
import {
  createOwnCountedVoteReader,
  type OwnCountedVotePreparation,
  type OwnCountedVoteReadResult,
  type OwnCountedVoteRequest,
} from '../rating/register.ts';
import { STANDARD_QUESTION_ID, VOTE_SCOPE } from '../rating/votes.ts';
import type { IdentityMapping } from '../semantic/identity-epoch-contract.ts';
import { readIdentityMappings } from '../semantic/identity-adapters/identity-epoch-read.ts';
import { withReadTransaction } from '../semantic/read.ts';
import viewerEntries from './viewer-facts-entries.sql';

import {
  MAX_VIEWER_FACTS_ROWS,
  MAX_VIEWER_FACTS_INPUT_BYTES,
  MAX_VIEWER_FACTS_RESPONSE_BYTES,
} from './viewer-facts-schema.ts';
export {
  MAX_VIEWER_FACTS_ROWS,
  MAX_VIEWER_FACTS_INPUT_BYTES,
  MAX_VIEWER_FACTS_RESPONSE_BYTES,
  viewerFactsResponseSchema,
} from './viewer-facts-schema.ts';
export const VIEWER_FACTS_SCOPE = 'library_entry:read';

type Dependencies = { pool: Pool; access: Access };
export type ViewerFactInput = Readonly<{ rowKey: string; subjectId: string }>;
export type ViewerQuestion = Readonly<{
  id: string;
  revision: number;
  grain: string;
  scale: Readonly<{ min: number; max: number; displayStep: number }>;
  meaning: string;
}>;
export type ViewerEntryFact =
  | Readonly<{ state: 'present'; incarnationId: string | null; entryState: string | null; revision: number }>
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'unavailable'; reason: 'scope' }>;
export type ViewerVoteFact =
  | Readonly<{
      state: 'present';
      questionId: string;
      questionRevision: number;
      units: number;
      revision: number;
    }>
  | Readonly<{ state: 'absent'; questionId: string; questionRevision: number }>
  | Readonly<{ state: 'unavailable'; reason: 'scope' | 'question' }>;
export type ViewerFact = Readonly<{
  rowKey: string;
  subjectId: string;
  entry: ViewerEntryFact;
  vote: ViewerVoteFact;
}>;
export type ViewerFactsPage =
  | Readonly<{ state: 'current'; question: ViewerQuestion | null; rows: readonly ViewerFact[] }>
  | Readonly<{
      state: 'unavailable';
      reason: 'identity' | 'currentness' | 'response_limit';
      retryable: boolean;
    }>;

type MappingRecord = Readonly<{ subjectId: string; mapping: IdentityMapping }>;
export type PreparedViewerFacts = Readonly<{
  accountId: string;
  actorIdentity: string;
  questionId: string;
  question: ViewerQuestion | null;
  mappings: readonly MappingRecord[];
  rows: readonly ViewerFactInput[];
  canReadEntries: boolean;
  canReadVotes: boolean;
}>;

type EntryRow = Awaited<ReturnType<typeof viewerEntries.run>>[number];
type EntryReadStage = Readonly<{ ids: readonly string[]; fingerprint: string }>;
// Native preparations belong to this reader instance and never cross the staged API as DTOs.
type NativeStage = {
  reader: ReturnType<typeof createOwnCountedVoteReader>;
  request: OwnCountedVoteRequest;
  preparation?: OwnCountedVotePreparation;
  read?: OwnCountedVoteReadResult;
  readStarted?: boolean;
};
const nativeStages = new WeakMap<PreparedViewerFacts, NativeStage>();
const entryReadStages = new WeakMap<PreparedViewerFacts, EntryReadStage>();

function unavailable(reason: Extract<ViewerFactsPage, { state: 'unavailable' }>['reason']): ViewerFactsPage {
  return { state: 'unavailable', reason, retryable: reason !== 'response_limit' };
}

function actorIdentity(actor: AccountActor): string {
  return JSON.stringify([
    actor.accountId,
    actor.clientId,
    actor.authnEpoch,
    actor.requestedBy,
    [...actor.scopes].sort(),
  ]);
}

function validAccount(actor: Actor): actor is AccountActor {
  return (
    actor.kind === 'account' &&
    routeOf(actor.accountId) !== null &&
    Number.isSafeInteger(actor.authnEpoch) &&
    actor.authnEpoch > 0
  );
}

function questionView(question: NonNullable<Awaited<ReturnType<typeof readVisibleRatingQuestion>>>) {
  const view = ratingQuestionView(question);
  return {
    id: view.id,
    revision: view.revision,
    grain: view.grain,
    scale: view.scale,
    meaning: question.meaning ?? view.label,
  } satisfies ViewerQuestion;
}

function validateInput(rows: readonly ViewerFactInput[], questionId: string): ViewerFactInput[] {
  if (!Array.isArray(rows) || rows.length > MAX_VIEWER_FACTS_ROWS || routeOf(questionId) === null)
    throw new RangeError('Viewer facts require an explicit routed question and at most 100 rows');
  const copied = rows.map((row) => {
    if (
      !row ||
      typeof row.rowKey !== 'string' ||
      row.rowKey.length === 0 ||
      typeof row.subjectId !== 'string' ||
      routeOf(row.subjectId) === null
    )
      throw new TypeError('Viewer facts rows require a row key and routed subject identity');
    return Object.freeze({ rowKey: row.rowKey, subjectId: row.subjectId });
  });
  const bytes = new TextEncoder().encode(JSON.stringify({ questionId, rows: copied })).byteLength;
  if (bytes > MAX_VIEWER_FACTS_INPUT_BYTES) throw new RangeError('Viewer facts input exceeds 16384 encoded bytes');
  return copied;
}

function mappingMarker(mapping: IdentityMapping): string {
  if (mapping.state === 'mapped') return JSON.stringify(['mapped', mapping.terminal, mapping.epoch.toString()]);
  if (mapping.state === 'absent') return '["absent"]';
  return JSON.stringify([mapping.state, mapping.state === 'pending' ? mapping.job.jobId : mapping.reason]);
}

function canonicalTarget(mapping: IdentityMapping, original: string): string | null {
  if (mapping.state === 'mapped') return mapping.terminal;
  if (mapping.state === 'absent') return original;
  return null;
}

function entryFingerprint(prepared: PreparedViewerFacts, rows: readonly EntryRow[]): string {
  const bySubject = new Map(rows.map((row) => [row.subjectId, row]));
  const mappings = new Map(prepared.mappings.map(({ subjectId, mapping }) => [subjectId, mapping]));
  return JSON.stringify(
    prepared.rows.map(({ rowKey, subjectId }) => {
      const target = canonicalTarget(mappings.get(subjectId)!, subjectId)!;
      const selected = bySubject.get(subjectId) ?? bySubject.get(target);
      return [
        rowKey,
        subjectId,
        selected?.subjectId ?? null,
        selected?.incarnationId ?? null,
        selected?.state ?? null,
        selected ? Number(selected.revision) : null,
      ];
    }),
  );
}

async function currentAccount(client: Pick<PoolClient, 'query'>, actor: AccountActor) {
  const route = routeOf(actor.accountId)!;
  await partitionReadClient(client, partitionOf(route));
  const account = await readAccount(client, route, actor.accountId);
  return Boolean(
    account &&
    account.kind === 'actor' &&
    account.state === 'active' &&
    !account.fenced &&
    account.minimumAuthnEpoch <= BigInt(actor.authnEpoch),
  );
}

/** Capture bounded Content identity and question meaning before the consumer checks out its read client. */
export async function prepareViewerFacts(
  dependencies: Dependencies,
  actor: Actor,
  inputRows: readonly ViewerFactInput[],
  questionId: string,
  deadline: number,
): Promise<PreparedViewerFacts> {
  if (!validAccount(actor)) throw new GrantDeniedError();
  const rows = validateInput(inputRows, questionId);
  const canReadEntries = actor.scopes.includes(VIEWER_FACTS_SCOPE) || actor.scopes.includes('library_entry:list');
  const canReadVotes = actor.scopes.includes(VOTE_SCOPE);
  const originals = [...new Set(rows.map((row) => row.subjectId))];
  const [mappings, question] = await Promise.all([
    readIdentityMappings(dependencies.pool, originals),
    canReadVotes ? readVisibleRatingQuestion(dependencies, actor, questionId, deadline, false) : Promise.resolve(null),
  ]);
  const records = originals.map((subjectId, index) => ({ subjectId, mapping: mappings[index]! }));
  const prepared = Object.freeze({
    accountId: actor.accountId,
    actorIdentity: actorIdentity(actor),
    questionId,
    question: question ? questionView(question) : null,
    mappings: Object.freeze(records),
    rows: Object.freeze(rows),
    canReadEntries,
    canReadVotes,
  });
  if (canReadVotes && questionId === STANDARD_QUESTION_ID && question) {
    const reader = createOwnCountedVoteReader(dependencies);
    const request = Object.freeze({ actor, targetIds: Object.freeze(originals) });
    const result = await reader.prepare(request, deadline);
    nativeStages.set(prepared, {
      reader,
      request,
      ...(result.status === 'prepared' ? { preparation: result.preparation } : {}),
    });
  }
  return prepared;
}

/** Read all private facts on the consumer's already-owned repeatable-read client. */
export async function readViewerFacts(
  client: Pick<PoolClient, 'query'>,
  actor: AccountActor,
  prepared: PreparedViewerFacts,
): Promise<ViewerFactsPage> {
  if (
    actor.accountId !== prepared.accountId ||
    actorIdentity(actor) !== prepared.actorIdentity ||
    routeOf(actor.accountId) === null
  )
    return unavailable('currentness');
  if (prepared.mappings.some(({ mapping }) => mapping.state === 'pending' || mapping.state === 'unavailable'))
    return unavailable('identity');
  if (!(await currentAccount(client, actor))) throw new GrantDeniedError();

  const mappingByOriginal = new Map(prepared.mappings.map(({ subjectId, mapping }) => [subjectId, mapping]));
  const targets = [
    ...new Set(prepared.rows.map((row) => canonicalTarget(mappingByOriginal.get(row.subjectId)!, row.subjectId))),
  ];
  if (targets.some((target) => target === null)) return unavailable('identity');
  const canonicalIds = targets as string[];
  const entryIds = [...new Set([...prepared.rows.map((row) => row.subjectId), ...canonicalIds])];
  const route = routeOf(actor.accountId)!;

  let entryRows: EntryRow[] = [];
  if (prepared.canReadEntries && entryIds.length) {
    entryRows = await viewerEntries.run(client, {
      route,
      account_id: actor.accountId,
      subject_ids: entryIds,
    });
  }
  if (prepared.canReadEntries)
    entryReadStages.set(prepared, { ids: entryIds, fingerprint: entryFingerprint(prepared, entryRows) });
  const entries = new Map(entryRows.map((row) => [row.subjectId, row]));

  const native = nativeStages.get(prepared);
  if (prepared.canReadVotes && prepared.questionId === STANDARD_QUESTION_ID && prepared.question && !native)
    return unavailable('currentness');
  if (native && (!native.preparation || actor !== native.request.actor)) return unavailable('currentness');
  if (native?.preparation) {
    if (native.preparation.targets.some((target) => 'state' in target)) return unavailable('identity');
    if (native.readStarted) return unavailable('currentness');
    native.readStarted = true;
    native.read = await native.reader.read(client, native.request, native.preparation);
    if (native.read.status !== 'read') return unavailable('currentness');
  }
  const nativeTargets = new Map(native?.preparation?.targets.map((target) => [target.requestedTargetId, target]));
  const nativeRows = new Map(
    native?.read?.status === 'read' ? native.read.rows.map((row) => [row.countingTargetId, row]) : [],
  );

  const rows = prepared.rows.map((input): ViewerFact => {
    const mapping = mappingByOriginal.get(input.subjectId)!;
    const target = canonicalTarget(mapping, input.subjectId)!;
    const rowEntry = entries.get(input.subjectId) ?? entries.get(target);
    const entry = !prepared.canReadEntries
      ? ({ state: 'unavailable', reason: 'scope' } as const)
      : rowEntry
        ? (() => {
            const row = rowEntry;
            return {
              state: 'present',
              incarnationId: row.incarnationId,
              entryState: row.state,
              revision: Number(row.revision),
            } as const;
          })()
        : ({ state: 'absent' } as const);
    const vote: ViewerVoteFact = !prepared.canReadVotes
      ? { state: 'unavailable', reason: 'scope' }
      : !native?.preparation || !prepared.question
        ? { state: 'unavailable', reason: 'question' }
        : (() => {
            const target = nativeTargets.get(input.subjectId);
            if (!target || 'state' in target) return { state: 'unavailable', reason: 'question' } as const;
            const question = prepared.question!;
            const own = nativeRows.get(target.countingTargetId);
            // Clear remains an absent score on the established wire. The native read retains
            // its tombstone, original/counted revisions and fingerprint for finish's comparison.
            return !own || own.units === null
              ? ({ state: 'absent', questionId: question.id, questionRevision: question.revision } as const)
              : ({
                  state: 'present',
                  questionId: question.id,
                  questionRevision: question.revision,
                  units: own.units,
                  revision: own.revision,
                } as const);
          })();
    return { rowKey: input.rowKey, subjectId: input.subjectId, entry, vote };
  });
  const page: ViewerFactsPage = { state: 'current', question: prepared.question, rows };
  if (new TextEncoder().encode(JSON.stringify(page)).byteLength > MAX_VIEWER_FACTS_RESPONSE_BYTES)
    return unavailable('response_limit');
  return page;
}

/** Recheck every authority term after the caller releases its account-home snapshot. */
export async function viewerFactsCurrent(
  dependencies: Dependencies,
  actor: Actor,
  prepared: PreparedViewerFacts,
  deadline: number,
): Promise<boolean> {
  if (!validAccount(actor) || actor.accountId !== prepared.accountId || actorIdentity(actor) !== prepared.actorIdentity)
    return false;
  const accountCurrent = await withReadTransaction(dependencies.pool, async (client) =>
    currentAccount(deadlineClient(client, deadline), actor),
  );
  if (!accountCurrent) return false;
  if (prepared.canReadEntries) {
    const stage = entryReadStages.get(prepared);
    if (!stage) return false;
    const currentRows = stage.ids.length
      ? await withReadTransaction(dependencies.pool, (client) =>
          viewerEntries.run(deadlineClient(client, deadline), {
            route: routeOf(actor.accountId)!,
            account_id: actor.accountId,
            subject_ids: [...stage.ids],
          }),
        )
      : [];
    if (entryFingerprint(prepared, currentRows) !== stage.fingerprint) return false;
  }
  const native = nativeStages.get(prepared);
  if (prepared.canReadVotes && prepared.questionId === STANDARD_QUESTION_ID && prepared.question && !native)
    return false;
  if (native) {
    if (actor !== native.request.actor || !native.preparation || !native.read) return false;
    const result = await native.reader.finish(native.request, native.preparation, native.read, deadline);
    if (result.status !== 'current') return false;
  }

  const originals = prepared.mappings.map(({ subjectId }) => subjectId);
  const mappings = await readIdentityMappings(dependencies.pool, originals);
  if (
    mappings.length !== prepared.mappings.length ||
    mappings.some(
      (mapping, index) =>
        mapping.state === 'pending' ||
        mapping.state === 'unavailable' ||
        mappingMarker(mapping) !== mappingMarker(prepared.mappings[index]!.mapping),
    )
  )
    return false;

  if (prepared.question) {
    const latest = await readVisibleRatingQuestion(dependencies, actor, prepared.questionId, deadline, false);
    if (!latest) return false;
    const current = questionView(latest);
    if (
      ratingQuestionIdentity({
        revision: current.revision,
        grain: current.grain,
        minimumUnits: current.scale.min,
        maximumUnits: current.scale.max,
        stepUnits: current.scale.displayStep,
      }) !==
        ratingQuestionIdentity({
          revision: prepared.question.revision,
          grain: prepared.question.grain,
          minimumUnits: prepared.question.scale.min,
          maximumUnits: prepared.question.scale.max,
          stepUnits: prepared.question.scale.displayStep,
        }) ||
      current.id !== prepared.question.id ||
      current.meaning !== prepared.question.meaning
    )
      return false;
  }
  return true;
}

/** Convenience for Library and Collection consumers; Search can use the staged API above. */
export async function readViewerFactsPage(
  dependencies: Dependencies,
  actor: Actor,
  rows: readonly ViewerFactInput[],
  questionId: string,
  deadline: number,
): Promise<ViewerFactsPage> {
  if (!validAccount(actor)) throw new GrantDeniedError();
  const prepared = await prepareViewerFacts(dependencies, actor, rows, questionId, deadline);
  const page = await withConnection(dependencies.pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await readViewerFacts(client, actor, prepared);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  if (page.state !== 'current') return page;
  return (await viewerFactsCurrent(dependencies, actor, prepared, deadline)) ? page : unavailable('currentness');
}
