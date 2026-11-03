import { admitFilter, FilterError, parseFilter, walkFilter, type FilterDocument } from '@rezics/filter';
import type { Pool, PoolClient } from 'pg';
import { commandAccessContext } from '../access/command-admission.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { admitGroup } from '../access/gates/admission.ts';
import {
  authoritativeTimeValue,
  type AuthoritativeTime,
  type CommandAttempt,
  type CommandTransaction,
} from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type AccessCheck, type AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { activeRelease } from '../semantic/definitions.ts';
import { compileCurrentOwnerFilter } from '../search/current-filter-plan.ts';
import type { CollectionDraft } from './collection-model.ts';
import type { PreparationDefinition } from './members-preparation.ts';
import read from './collection-rules-read.sql';
import insert from './collection-rules-insert.sql';
import update from './collection-rules-update.sql';

/** Uses the actual common preparation order declaration; no caller-local sort language. */
export type CollectionRule = Readonly<{ filter: FilterDocument; sort: Extract<PreparationDefinition['sort'], 'id'> }>;
export type AdmittedCollectionRule = CollectionRule & Readonly<{ releaseDigest: string }>;
export type SavedCollectionRule = AdmittedCollectionRule &
  Readonly<{
    revision: number;
    collectionRevision: number;
    sourceGeneration: string;
  }>;
type Client = Pick<PoolClient, 'query'>;

/** Shared parser owns every predicate node, including nested and saved-filter operands. */
export function parseCollectionRule(input: unknown): CollectionRule {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProblemError('invalid_request');
  if (Object.keys(input).some((key) => key !== 'filter' && key !== 'sort') || !('filter' in input))
    throw new ProblemError('invalid_request');
  const sort = 'sort' in input ? input.sort : 'id';
  if (typeof sort !== 'string') throw new ProblemError('invalid_request');
  if (sort !== 'id') throw new ProblemError('unsupported_query');
  try {
    return { filter: parseFilter(input.filter), sort };
  } catch (error) {
    if (error instanceof FilterError) throw new ProblemError(error.problem, { errors: error.errors });
    throw error;
  }
}

/** All expanded leaves count, including negative and nonmatching branches. No fact IO or grant inference. */
export function collectionRuleActions(filter: FilterDocument): readonly string[] {
  const actions = new Set<string>();
  for (const node of walkFilter(filter)) {
    if (!('owner' in node)) continue;
    if ('presence' in node.owner) {
      actions.add('library_entry:read');
      actions.add('progress_session:read');
      actions.add('copy:read');
    } else if ('session' in node.owner) actions.add('progress_session:read');
    else if ('holding' in node.owner) actions.add('copy:read');
    else actions.add('library_entry:read');
  }
  return [...actions].sort();
}

/** Meaning admission is independent of native execution admission and never certifies completeness. */
export async function admitCollectionRule(pool: Pool, rule: CollectionRule): Promise<AdmittedCollectionRule> {
  const current = await activeRelease(pool);
  if (!current) throw new ProblemError('semantic_not_ready');
  try {
    const filter = admitFilter(rule.filter, current.release, { owner: true });
    // Compile the actual expanded native plan before accepting a definition. Saving needs no result Source.
    compileCurrentOwnerFilter(filter);
    return {
      filter,
      sort: rule.sort,
      releaseDigest: current.digest,
    };
  } catch (error) {
    if (error instanceof FilterError) throw new ProblemError(error.problem, { errors: error.errors });
    throw error;
  }
}

export type PreparedCollectionRuleWrite = Readonly<{
  rule: AdmittedCollectionRule | null;
  failure: ProblemError | null;
  checks: readonly AccessCheck[];
}>;

/** An exact retry needs current authority, but need not admit a new meaning or perform another CAS. */
export async function prepareCollectionRuleWrite(
  config: { pool: Pool; access: Access },
  actor: AccountActor,
  rule: CollectionRule,
  attempt: CommandAttempt,
  deadline: number,
): Promise<PreparedCollectionRuleWrite> {
  let admitted: AdmittedCollectionRule | null = null;
  let failure: ProblemError | null = null;
  try {
    admitted = await admitCollectionRule(config.pool, rule);
  } catch (error) {
    if (!(error instanceof ProblemError)) throw error;
    // The editor reads an expanded AST. If a caller supplies an unresolved saved operand, its complete
    // private dependency set is unknown: it cannot disclose a receipt by authorizing only visible leaves.
    if ([...walkFilter(rule.filter)].some((node) => 'saved' in node)) throw error;
    failure = error;
  }
  return {
    rule: admitted,
    failure,
    checks: await prepareCollectionRuleAuthority(config, actor, admitted?.filter ?? rule.filter, attempt, deadline),
  };
}

/** Prepare the actual private-family checks before the owning transaction takes its connection. */
export async function prepareCollectionRuleAuthority(
  config: { pool: Pool; access: Access },
  actor: AccountActor,
  filter: FilterDocument,
  attempt: CommandAttempt | { time: AuthoritativeTime; read: true },
  deadline: number,
): Promise<readonly AccessCheck[]> {
  const route = routeOf(actor.accountId);
  if (route === null) throw new GrantDeniedError();
  const checks: AccessCheck[] = [];
  for (const action of collectionRuleActions(filter)) {
    if (!actor.scopes.includes(action))
      throw new ProblemError('forbidden', {
        headers: { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${action}"` },
      });
    await admitGroup({
      pool: config.pool,
      access: () => config.access,
      actor,
      group: action === 'progress_session:read' ? 'reading_progress' : 'personal_library',
      clientAction: action,
      deadline,
      clock: () => new Date(authoritativeTimeValue(attempt.time)),
    });
    checks.push(
      await accessCheck(
        config.access,
        actor,
        action,
        { route, id: actor.accountId },
        'read' in attempt
          ? { pool: config.pool, deadline }
          : commandAccessContext({ pool: config.pool, deadline }, attempt),
      ),
    );
  }
  return checks;
}

/** Reevaluate at native current T BEFORE the executor may disclose an old receipt. */
export async function authorizeCollectionRule(
  tx: CommandTransaction,
  attempt: Pick<CommandAttempt, 'time'>,
  checks: readonly AccessCheck[],
): Promise<void> {
  for (const check of checks) if (!(await check(tx, attempt.time))) throw new GrantDeniedError();
}

/**
 * Private point read for the common Source/editor owner. The caller supplies current native Collection/editor
 * AND private-family authority; this DAO grants none. No public Collection projection selects these columns.
 */
export async function readSavedCollectionRule(
  client: Client,
  route: number,
  collectionId: string,
): Promise<SavedCollectionRule | null> {
  const row = await read.run({ query: client.query.bind(client) }, { route, collection_id: collectionId });
  if (!row || row.releaseDigest === null || row.filter === null || row.sort === null) return null;
  const rule = parseCollectionRule({ filter: JSON.parse(row.filter), sort: row.sort });
  return {
    ...rule,
    revision: Number(row.ruleRevision),
    collectionRevision: row.collectionRevision,
    sourceGeneration: row.sourceGeneration,
    releaseDigest: row.releaseDigest,
  };
}

/** Single-partition insert used by the existing Collection creator, before its ordinary grants/finalization. */
export async function insertSavedCollection(
  tx: CommandTransaction,
  route: number,
  draft: CollectionDraft,
  rule: AdmittedCollectionRule,
  command: { transactionId: string; time: string },
): Promise<void> {
  await insert.run(tx, {
    route,
    collection_id: draft.id,
    curator_account_id: draft.curatorAccountId,
    title: draft.title,
    description: draft.description,
    visibility: draft.visibility,
    presentation_kind: draft.presentationKind ?? null,
    cover_media_id: draft.coverMediaId ?? null,
    filter: JSON.stringify(rule.filter),
    sort: rule.sort,
    release_digest: rule.releaseDigest,
    transaction_id: command.transactionId,
    time: command.time,
  });
}

/** One header CAS advances the rule's own revision and Source generation exactly once. */
export async function updateSavedCollectionRule(
  tx: CommandTransaction,
  route: number,
  collectionId: string,
  revision: number,
  rule: AdmittedCollectionRule,
  command: { transactionId: string; time: string },
): Promise<void> {
  const row = await update.run(tx, {
    route,
    collection_id: collectionId,
    revision,
    filter: JSON.stringify(rule.filter),
    sort: rule.sort,
    release_digest: rule.releaseDigest,
    transaction_id: command.transactionId,
    time: command.time,
  });
  if (!row) throw new ProblemError('conflict');
}
