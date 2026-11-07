import { requireLibraryDomain } from './domain-binding.ts';
import { admitFilter, FilterError, parseFilter, walkFilter, type FilterDocument } from '@rezics/filter';
import type { Pool, PoolClient } from 'pg';
import type { AuthoritativeTime, CommandAttempt, CommandTransaction } from '../command/command.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { Access, AccessCheck, AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { runLibraryBoundedStep } from './collection-command-work.ts';
import { collectionMutationApplication } from './collection-mutation.ts';
import type { CollectionDraft } from './collection-model.ts';
import type { PreparationDefinition } from './members-preparation.ts';
import { collectionRuleReadPlan, executeCollectionRuleRead } from './collection-rule-read-bounds.ts';
import {
  collectionRuleInsertPlan,
  collectionRuleUpdatePlan,
  executeCollectionRuleInsert,
  executeCollectionRuleUpdate,
} from './collection-rule-edit-bounds.ts';

function ruleAuthority() {
  const authority = requireLibraryDomain().collectionRuleAuthority;
  if (!authority) throw new TypeError('Collection rule authority is not composed');
  return authority;
}

/** Source selection is stored beside the shared predicate, never inside its grammar. */
export type CollectionRuleSource = Readonly<{ kind: 'owner' | 'catalogue' }>;
/** Uses the actual common preparation order declaration; no caller-local sort language. */
export type CollectionRule = Readonly<{
  filter: FilterDocument;
  sort: Extract<PreparationDefinition['sort'], 'id'>;
  source: CollectionRuleSource;
}>;
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
  if (Object.keys(input).some((key) => key !== 'filter' && key !== 'sort' && key !== 'source') || !('filter' in input))
    throw new ProblemError('invalid_request');
  const sort = 'sort' in input ? input.sort : 'id';
  if (typeof sort !== 'string') throw new ProblemError('invalid_request');
  if (sort !== 'id') throw new ProblemError('unsupported_query');
  const sourceValue = 'source' in input ? input.source : { kind: 'owner' };
  if (
    !sourceValue ||
    typeof sourceValue !== 'object' ||
    Array.isArray(sourceValue) ||
    Object.keys(sourceValue).length !== 1 ||
    !('kind' in sourceValue) ||
    (sourceValue.kind !== 'owner' && sourceValue.kind !== 'catalogue')
  )
    throw new ProblemError('invalid_request');
  try {
    return { filter: parseFilter(input.filter), sort, source: { kind: sourceValue.kind } };
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
  const current = await requireLibraryDomain().identityDisclosure.readActiveRelease(pool);
  if (!current) throw new ProblemError('semantic_not_ready');
  try {
    const filter = admitFilter(rule.filter, current.release as Parameters<typeof admitFilter>[1], { owner: true });
    // OWNER rules compile against Commerce's private population. Catalogue rules retain shared Search meaning;
    // their execution admission belongs to the installed Search Source and is not certified by this write.
    if (rule.source.kind === 'owner') ruleAuthority().compileOwnerFilter(filter);
    return {
      filter,
      sort: rule.sort,
      source: rule.source,
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
  if (route === null) throw ruleAuthority().denied();
  const checks: AccessCheck[] = [];
  for (const action of collectionRuleActions(filter)) {
    if (!actor.scopes.includes(action))
      throw new ProblemError('forbidden', {
        headers: { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${action}"` },
      });
    await ruleAuthority().admitGroup({
      pool: config.pool,
      access: config.access,
      actor,
      action,
      deadline,
      at: attempt.time,
    });
    // These are the actor's private families, using the same intrinsic ownership
    // boundary as native entry/session/copy reads, rather than resource grants.
    checks.push(async (client) => {
      const current = await ruleAuthority().readAccount(client, route, actor.accountId);
      return (
        !!current &&
        current.kind === 'actor' &&
        current.state === 'active' &&
        !current.fenced &&
        Number.isSafeInteger(actor.authnEpoch) &&
        actor.authnEpoch >= 1 &&
        current.minimumAuthnEpoch <= BigInt(actor.authnEpoch)
      );
    });
  }
  return checks;
}

/** Reevaluate at native current T BEFORE the executor may disclose an old receipt. */
export async function authorizeCollectionRule(
  tx: CommandTransaction,
  attempt: Pick<CommandAttempt, 'time'>,
  checks: readonly AccessCheck[],
): Promise<void> {
  for (const check of checks) if (!(await check(tx, attempt.time))) throw ruleAuthority().denied();
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
  const plan = collectionRuleReadPlan({ route, collection_id: collectionId });
  const row = await runLibraryBoundedStep(plan.operation, plan.total, () =>
    executeCollectionRuleRead({ query: client.query.bind(client) }, plan),
  );
  if (!row || row.releaseDigest === null || row.filter === null || row.sort === null || row.source === null)
    return null;
  const rule = parseCollectionRule({ filter: JSON.parse(row.filter), sort: row.sort, source: { kind: row.source } });
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
  const plan = collectionRuleInsertPlan({
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
    source: rule.source.kind,
    release_digest: rule.releaseDigest,
    transaction_id: command.transactionId,
    time: command.time,
  });
  await collectionMutationApplication().create(tx, { route, collection: draft, ...command }, () =>
    runLibraryBoundedStep(plan.operation, plan.total, () => executeCollectionRuleInsert(tx, plan)),
  );
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
  const plan = collectionRuleUpdatePlan({
    route,
    collection_id: collectionId,
    revision,
    filter: JSON.stringify(rule.filter),
    sort: rule.sort,
    source: rule.source.kind,
    release_digest: rule.releaseDigest,
    transaction_id: command.transactionId,
    time: command.time,
  });
  const row = await runLibraryBoundedStep(plan.operation, plan.total, () => executeCollectionRuleUpdate(tx, plan));
  if (!row) throw new ProblemError('conflict');
}
