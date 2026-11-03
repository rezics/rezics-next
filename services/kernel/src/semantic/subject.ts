import { admitIdentityTerminalCapture, runIdentityTerminalCommand } from './identity-terminal-closure-command.ts';
import {
  beginSemanticRecordSourceSet,
  collectSemanticRecordFacts,
  sealSemanticRecordSourceSet,
} from './record-source-set.ts';
import { initializeSubjectPagePublication, retainSubjectPageSource } from './subject-page-publication-store.ts';
import { subjectPageFacts, recordSubjectPageDiff, invalidateSubjectPage } from './subject-page-publication-native.ts';
import {
  disclosureAccount,
  keepStatementPrivate,
  privateLinks,
  refreshStatementReaderAuthorization,
} from './statement-disclosure.ts';
import { readSubjectSummaries, type SubjectSummary, type SummaryDependencies } from './summaries.ts';
import { activeRelease } from './definitions.ts';
import { withReadTransaction } from './read.ts';
import type { Source } from '@rezics/definitions/bulk';
import { SubjectRedirectError } from './merges.ts';
import { checkSubjectInput } from '@rezics/definitions/validate';
import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { currentRelationFacts, currentRelationKey } from './current-relations.ts';
import {
  currentCommand,
  DEFAULT_REQUEST_DEADLINE_MS,
  runCommand,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { deadlineFor } from '../request/deadline.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccessCheck, AccountActor, Resource } from '../request/access.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../route/route.ts';
import {
  fencedIds,
  readAnchoredFences,
  type AgentSelfSource as CandidateAgentSelfSource,
  type CandidateSource,
} from './fences.ts';
import { checkMediaObject } from '../content/cover-reference.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { factDataTypes, isRelationProperty, itemFacts, resolveItem, type FactRow, type Item } from './item.ts';
import { SubjectInputError } from './item.ts';
import { rejectBulkContent, rejectContent } from './rules.ts';
import { authoredAuthorization, installAuthoredStatement } from './authored.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { contextSnapshot } from './context.ts';
import { LINK_KEYS_CHANGED, LINKS_CHANGED } from './events.ts';
import { holderFacts } from './link-keys.ts';
import readIdentityVisibility from './read-visibility.sql';
import updateIdentity from './update-subject-identity.sql';
import readIdentitySubject from './candidates-read-adoption-subject.sql';
import { linkChanges } from './link-changes.ts';
import { expandSlot, slotId, slotView } from './slots.ts';
import { matchesTarget } from './targets.ts';
import createRevision from './create-revision.sql';
import insertSubject from './create-subject.sql';
import changePartitionSubjectCount from './change-partition-subject-count.sql';
import readLabelsStatement from './read-labels.sql';
import readLabelChoicesStatement from './read-label-choices.sql';
import readRelatedStatement from './read-related.sql';
import readSubjectStatement from './read-subject.sql';
import readSubjectIdentity from './read-subject-identity.sql';
import readTypesStatement from './read-item-types.sql';
import readHiddenStatement from './subject-read-hidden.sql';
import { readRelease as getRelease } from './definitions.ts';
import { layeredRelease } from './extensions.ts';
import { writeFacts } from './write-facts.ts';
import {
  AccountAgentLabelEditError,
  AccountAgentWriteDeniedError,
  accountAgentId,
  accountAgentsForSubjects,
} from './agents.ts';
import listOutboundLinks from './list-outbound-links-by-property.sql';
import { waitForSubjectLinks } from './link-freshness.ts';
import { identityEpochStore } from './identity-epoch-store.ts';
import { initializeRevisionAuthorship, revisionResource } from './authorship.ts';
import { creationDeclares } from '../access/index.ts';
import { readSourceRecords } from './source-records.ts';
import readSourceMembers from './source-records-members.sql';
import { declareCommandHistory, registerCommandHistoryKind } from '../history/record.ts';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export { writeFacts } from './write-facts.ts';

const BATCH_LIMIT = 256;

export const CREATE_SUBJECT = 'subject.create';
// Permanent Semantic owner-assigned receipt codec ID.
registerCommandHistoryKind(CREATE_SUBJECT, 3020);
const CONTEXT = GLOBAL_CONTEXT;

/** Retries reach the partition holding their receipt while each attempt gets a new subject id. */
export function subjectTarget(routeKey: Uint8Array, accountId: string, idempotencyKey: string): Resource {
  const route = anchorRoute(routeKey, `${accountId}\n${CREATE_SUBJECT}\n${idempotencyKey}`);
  return { route, id: newId(route) };
}

export class SubjectAccessDeniedError extends Error {
  constructor() {
    super('Subject creation is not authorized');
    this.name = 'SubjectAccessDeniedError';
  }
}

export type SubjectComponent = { partition: number; epoch: number; position: bigint };
export type CreateSubjectResult = { subject: Item; component: SubjectComponent; replayed: boolean };
export type AgentSelfSource = CandidateAgentSelfSource;

export async function createSubject(
  pool: Pool,
  options: {
    actor: AccountActor;
    target: Resource;
    idempotencyKey: string;
    digest: Uint8Array;
    item: unknown;
    release: { digest: string; release: Release };
    authorize?: AccessCheck;
    authorization?: CommandAuthorization;
    deadline?: number;
    clock?: () => Date;
  },
): Promise<CreateSubjectResult> {
  const checked = checkSubjectInput(options.item, options.release.release, rejectContent, true);
  if (checked.violations.length) throw new SubjectInputError(checked.violations);
  const item = structuredClone(options.item);
  const { route, id: subjectId } = options.target;
  if (routeOf(subjectId) !== route) throw new RangeError('Subject target id must carry its route');
  const partition = partitionOf(route);
  const command = await runIdentityTerminalCommand(
    pool,
    {
      partition,
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
      receipt: {
        actorAccountId: options.actor.accountId,
        kind: CREATE_SUBJECT,
        key: options.idempotencyKey,
        digest: options.digest,
      },
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorization: authoredAuthorization(
        options.authorization ?? {
          action: 'subject:create',
          resource: options.target,
          denied: () => new SubjectAccessDeniedError(),
          async authorize(tx, attempt) {
            if (!options.authorize || !(await options.authorize(tx, attempt.time)))
              throw new SubjectAccessDeniedError();
            return 'execute';
          },
        },
        options.target,
      ),
      clock: options.clock,
    },
    async (tx, { transactionId }) => {
      const result = await writeSubject(tx, transactionId, { ...options, item });
      // Access supplies the admitted identity; bind every actual event, including publication events.
      await declareCommandHistory(tx, CREATE_SUBJECT, {
        response: { artifactType: 'command-receipt/v1', accounts: [] },
        events: result.events.map(() => ({ artifactType: 'outbox-event/v1', accounts: [] })),
      });
      return result;
    },
  );
  return {
    subject: command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
    replayed: command.replayed,
  };
}

/** The same creation work for individual writes and imported records. */
export async function writeSubject(
  tx: CommandTransaction,
  transactionId: string,
  options: Pick<Parameters<typeof createSubject>[1], 'target' | 'item' | 'release'> & {
    source?: Source | AgentSelfSource;
    routeKey?: Uint8Array;
  },
) {
  await admitIdentityTerminalCapture(tx, [options.target.id]);
  const sourceSet = await beginSemanticRecordSourceSet(tx);
  const { route, id: subjectId } = options.target;
  const input = options.item as Record<string, unknown>;
  const authored = options.source === undefined;
  const checked = checkSubjectInput(
    options.item,
    options.release.release,
    authored ? rejectContent : rejectBulkContent,
    authored,
  );
  if (checked.violations.length) throw new SubjectInputError(checked.violations);
  const facts = itemFacts(
    subjectId,
    options.item,
    typeof input?.type === 'string' ? input.type : undefined,
    options.release.release,
  );
  const dataTypes = factDataTypes(options.release.release, facts);
  const statementSubjects = [subjectId, ...checked.targets.map((item) => item.id)];
  const itemDetails = await readItemDetails(tx, statementSubjects);
  const privateAccounts = new Map<string, string>();
  for (const fact of facts) {
    if (fact.kind !== 'statement') continue;
    const account = await disclosureAccount(tx, options.release.release, fact.property!, fact.body);
    if (account) privateAccounts.set(fact.statement_id!, account);
  }
  assertAgentStatementAccess(
    tx,
    [
      subjectId,
      ...checked.targets
        .filter((target) => {
          const parts = target.pointer.split('/');
          return !(
            options.release.release.properties[parts[2]!]?.disclosure === 'sourceOrConsent' &&
            parts.slice(4).join('/') === 'value/content'
          );
        })
        .map((target) => target.id),
    ],
    itemDetails,
  );
  const targetErrors = checked.targets.flatMap((item) => {
    const targetType = itemDetails.get(item.id)?.type;
    return targetType && matchesTarget(options.release.release, targetType, item.targets)
      ? []
      : [{ pointer: item.pointer, code: 'out_of_range' as const }];
  });
  if (targetErrors.length) throw new SubjectInputError(targetErrors);
  await insertSubject.run(tx, {
    route,
    subject_id: subjectId,
    type: String(input.type),
    transaction_id: transactionId,
    current_facts: facts.filter(
      (fact) => fact.kind !== 'statement' || !isRelationProperty(options.release.release, fact.property!),
    ).length,
    current_release: options.release.digest,
  });
  await createRevision.run(tx, {
    route,
    subject_id: subjectId,
    release: options.release.digest,
    transaction_id: transactionId,
    source: options.source ?? accountSource(tx, statementSubjects),
  });
  // Historic trusted callbacks carry no creation capability and acquire no author rights.
  if (authored && creationDeclares(tx, revisionResource(subjectId, 1)))
    await initializeRevisionAuthorship(tx, { subject: subjectId, revision: 1 });
  await identityEpochStore.initializeSubject(tx, subjectId);
  const events: { type: string; subject: string; data: unknown }[] = [
    { type: 'com.rezics.subject.created.v1', subject: subjectId, data: { id: subjectId } },
  ];
  for (const fact of facts) {
    if (!authored || fact.kind !== 'statement') continue;
    const installed = await installAuthoredStatement(
      tx,
      subjectId,
      options.release.release,
      {
        candidate: fact.statement_id!,
        revision: 1,
        body: fact.body,
      },
      fact.property!,
    );
    fact.body = installed.body;
    events.push(...installed.events);
  }
  await collectSemanticRecordFacts(tx, subjectId, facts, 1);
  await writeFacts(tx, {
    route,
    subject_id: subjectId,
    transaction_id: transactionId,
    facts: facts.map((fact) => ({
      ...fact,
      release: fact.kind === 'statement' ? options.release.digest : null,
      relation: fact.kind === 'statement' && isRelationProperty(options.release.release, fact.property!),
    })),
  });
  for (const fact of facts) {
    const account = privateAccounts.get(fact.statement_id!);
    if (!account) continue;
    await expandSlot(
      tx,
      subjectId,
      fact.property!,
      transactionId,
      fact.slot_id,
      isRelationProperty(options.release.release, fact.property!),
    );
    await keepStatementPrivate(tx, {
      subject: subjectId,
      candidate: fact.statement_id!,
      slot: fact.slot_id,
      property: fact.property!,
      body: fact.body,
      account,
      revision: 1,
      release: options.release.release,
    });
  }
  await changePartitionSubjectCount.run(tx, { partition_no: partitionOf(route), delta: 1 });
  const changes = linkChanges(
    [],
    facts.filter((fact) => !privateAccounts.has(fact.statement_id!)),
    dataTypes,
    {
      subject: subjectId,
      release: options.release.release,
      type: String(input.type),
    },
  );
  if (changes.length > 0) {
    events.push({
      type: LINKS_CHANGED,
      subject: subjectId,
      data: { subject: subjectId, revision: 1, security_revision: 0, changes },
    });
  }
  if (options.source && 'source' in options.source && options.routeKey)
    await retainSubjectPageSource(tx, {
      subject: { route, id: subjectId },
      candidates: facts.flatMap((f) => (f.statement_id ? [f.statement_id] : [])),
      source: options.source,
      routeKey: options.routeKey,
    });
  await initializeSubjectPagePublication(tx, { route, id: subjectId });
  await recordSubjectPageDiff(
    tx,
    subjectId,
    transactionId,
    new Map(),
    await subjectPageFacts(
      tx,
      subjectId,
      facts.filter((fact) => !privateAccounts.has(fact.statement_id!)),
      options.release.release,
      options.routeKey,
    ),
    events,
  );
  await sealSemanticRecordSourceSet(tx, sourceSet);
  return {
    value: resolveItem(subjectId, facts, String(input.type), dataTypes, {
      revision: 1,
      release: options.release.digest,
      context: CONTEXT,
      relationCounts: Object.fromEntries(
        (options.release.release.types[String(input.type)]?.properties ?? [])
          .filter((property) => isRelationProperty(options.release.release, property))
          .map((property) => [
            property,
            facts.filter(
              (fact) => fact.kind === 'statement' && fact.property === property && fact.operation === 'assert',
            ).length,
          ]),
      ),
    }),
    events,
  };
}

type SubjectReadRow = {
  id: string;
  account: string | null;
  redirect: string | null;
  type: string;
  revision: number;
  security_revision: string;
  release: string;
  fact_revision: number | null;
  fact_release: string | null;
  slot_id: string | null;
  log_seq: number | null;
  operation: FactRow['operation'] | null;
  kind: FactRow['kind'] | null;
  language: string | null;
  property: string | null;
  statement_id: string | null;
  body: unknown;
};

function listed<T>(result: T[] | T | null): T[] {
  if (result == null) return [];
  return Array.isArray(result) ? result : [result];
}

function asFacts(rows: readonly SubjectReadRow[]): FactRow[] {
  return rows.flatMap((row) =>
    row.slot_id === null || row.log_seq === null || row.operation === null || row.kind === null
      ? []
      : [
          {
            slot_id: row.slot_id,
            log_seq: row.log_seq,
            operation: row.operation,
            kind: row.kind,
            language: row.language,
            property: row.property,
            statement_id: row.statement_id,
            body: row.body,
            fact_revision: row.fact_revision,
            fact_release: row.fact_release,
          },
        ],
  );
}

/** Fold terms first: fencing a final put must never resurrect an older put. */
function currentTerms(facts: FactRow[]): FactRow[] {
  const live = new Map<string, FactRow>();
  for (const fact of facts) {
    const key = JSON.stringify([fact.kind, fact.language, fact.kind === 'alias' ? fact.body : null]);
    if (fact.operation === 'retract') live.delete(key);
    else if (fact.operation === 'assert' && (fact.kind !== 'alias' || !live.has(key))) live.set(key, fact);
  }
  return [...live.values()];
}

type SupportedFact = { fact: FactRow; source: CandidateSource | null };

/** Exact immutable revision locators for the final terms and selected statements only. */
async function supportedFacts(
  client: PoolClient,
  routeKey: Uint8Array | undefined,
  subject: string,
  facts: FactRow[],
): Promise<SupportedFact[]> {
  const revisions = [...new Set(facts.flatMap((fact) => (fact.fact_revision ? [fact.fact_revision] : [])))];
  const rows = listed(
    (await readHiddenStatement.run(client, {
      route: routeOf(subject)!,
      subject_id: subject,
      revisions,
    })) as
      | { revision: number; source: CandidateSource | null }[]
      | { revision: number; source: CandidateSource | null }
      | null,
  );
  const sources = new Map(rows.map((row) => [row.revision, row.source]));
  const supported = facts.flatMap((fact) => {
    const revision = fact.fact_revision;
    return revision === null || revision === undefined || !sources.has(revision)
      ? []
      : [{ fact, source: sources.get(revision) ?? null }];
  });
  const gone = routeKey
    ? await fencedIds(
        client,
        routeKey,
        supported.map((row, index) => ({ id: String(index), source: row.source })),
      )
    : new Set<string>();
  return supported.filter((_, index) => !gone.has(String(index)));
}

/** Foreign item snaks need current original and terminal disclosure as well as the holder's permission. */
async function disclosedTargets(
  pool: Pool,
  release: Release,
  supported: SupportedFact[],
  authorize: SummaryDependencies['authorize'] | undefined,
): Promise<SupportedFact[]> {
  const types = factDataTypes(
    release,
    supported.map((row) => row.fact),
  );
  const targets = (fact: FactRow): string[] => {
    if (fact.kind !== 'statement') return [];
    const body = fact.body as {
      value: { type: string; content?: unknown };
      qualifiers: { property: string; value: { type: string; content?: unknown } }[];
      references: { parts: { property: string; value: { type: string; content?: unknown } }[] }[];
    };
    return [
      { property: fact.property!, value: body.value },
      ...body.qualifiers,
      ...body.references.flatMap((ref) => ref.parts),
    ].flatMap((snak) =>
      types[snak.property] === 'wikibase-item' && snak.value.type === 'value' && typeof snak.value.content === 'string'
        ? [snak.value.content]
        : [],
    );
  };
  const pending = [...new Set(supported.flatMap((row) => targets(row.fact)))];
  if (!pending.length) return supported;
  // No owner is checked out while Access prepares evidence, including on a max-one pool.
  const client = { query: pool.query.bind(pool) };
  const allowed = new Map<string, boolean>();
  const visiting = new Set<string>();
  const check = async (id: string): Promise<boolean> => {
    if (allowed.has(id)) return allowed.get(id)!;
    if (visiting.has(id)) return false;
    visiting.add(id);
    const state = (await loadRelated(client, [id])).get(id);
    const visible =
      state?.visibility === 'visible' &&
      (!authorize || (await authorize(client, id, [id]))) &&
      (!state.redirect || (await check(state.redirect)));
    visiting.delete(id);
    allowed.set(id, !!visible);
    return !!visible;
  };
  for (const id of pending) await check(id);
  return supported.filter((row) => targets(row.fact).every((id) => allowed.get(id)));
}

export async function readSubject(
  pool: Pool,
  id: string,
  authorize: (client: PoolClient) => Promise<boolean>,
  context = GLOBAL_CONTEXT,
  routeKey: Uint8Array,
  summaries: {
    languages?: readonly string[];
    authorize?: SummaryDependencies['authorize'];
    seen?: readonly { partition: number; epoch: number; position: bigint }[];
    deadline?: number;
    prepareAuthorization?: () => Promise<AccessCheck>;
    prepareAuthorize?: (id: string) => Promise<AccessCheck>;
    readAs?: <T>(read: () => Promise<T>) => Promise<T>;
  } = {},
): Promise<{
  subject: Item;
  account: { id: string } | null;
  summary: SubjectSummary | null;
  component: SubjectComponent;
} | null> {
  const route = routeOf(id);
  if (route === null) return null;
  const contextRecord = context === GLOBAL_CONTEXT ? null : await contextSnapshot(pool, context);
  if (context !== GLOBAL_CONTEXT && !contextRecord) return null;
  const defaults = contextRecord?.defaults ?? {};
  const active = await activeRelease(pool);
  const deadline = summaries.deadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
  const readSnapshot = async (subjectId: string, terminal?: string) => {
    const route = routeOf(subjectId)!;
    const readOriginal = async () => {
      const prepare = () =>
        summaries.prepareAuthorize
          ? summaries.prepareAuthorize(subjectId)
          : summaries.prepareAuthorization
            ? summaries.prepareAuthorization()
            : Promise.resolve(authorize);
      const initialAuthorize = await prepare();
      const preflight = await withReadTransaction(pool, async (client) => {
        const identity = await readSubjectIdentity.run(client, {
          route,
          subject_id: subjectId,
          partition_no: partitionOf(route),
        });
        if (!identity || identity.visibility !== 'visible' || !(await initialAuthorize(client))) return null;
        if (identity.redirect && identity.redirect !== terminal)
          throw new SubjectRedirectError(subjectId, identity.redirect);
        return {
          component: { partition: identity.partitionNo, epoch: identity.epoch, position: BigInt(identity.position) },
          revision: identity.revision,
          securityRevision: BigInt(identity.securityRevision),
        };
      });
      if (!preflight) return null;
      await waitForSubjectLinks(pool, [...(summaries.seen ?? []), preflight.component], subjectId, deadline);
      await refreshStatementReaderAuthorization();
      let check = await prepare();
      let expectedRevision = preflight.revision;
      let expectedSecurityRevision = preflight.securityRevision;
      const readCurrent = () =>
        withReadTransaction(pool, async (client) => {
          const partition = await readPartition(client, partitionOf(route));
          if (!partition) return null;
          const rows = listed(
            (await readSubjectStatement.run(client, { route, subject_id: subjectId })) as
              | SubjectReadRow[]
              | SubjectReadRow
              | null,
          );
          if (!rows.length) {
            return null;
          }
          const allowed = await check(client);
          if (!allowed) return null;
          if (rows[0]!.redirect && rows[0]!.redirect !== terminal)
            throw new SubjectRedirectError(subjectId, rows[0]!.redirect);
          const securityRevision = BigInt(rows[0]!.security_revision);
          if (rows[0]!.revision !== expectedRevision || securityRevision !== expectedSecurityRevision)
            return {
              freshnessRetry: true as const,
              component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
              revision: rows[0]!.revision,
              securityRevision,
            };
          const stored = await getRelease(client, rows[0]!.release);
          if (!stored) throw new Error('Subject revision release is missing');
          // The Context's own relation types show with the subject's release; reads never register the digest.
          const layer = await layeredRelease(client, { digest: rows[0]!.release, release: stored }, context);
          const release = layer.release;
          let statementFacts: FactRow[] = [];
          const resolution: Record<string, 'unresolved' | 'suppressed'> = {};
          const relationCounts: Record<string, number> = {};
          if (allowed) {
            const properties = release.types[rows[0]!.type]!.properties;
            for (const property of properties) {
              if (!isRelationProperty(release, property)) {
                const view = await slotView(client, subjectId, property, context, defaults);
                statementFacts.push(...view.facts);
                if (view.resolution) resolution[property] = view.resolution;
                continue;
              }
              const preview = (await listOutboundLinks.run(client, {
                context_id: context,
                route,
                subject_id: subjectId,
                property,
                filter_value: NIL_UUID,
                after_order: '',
                after_target: NIL_UUID,
                after_statement: NIL_UUID,
                page_limit: 13,
              })) as {
                slot: string;
                statement: string;
                target: string | null;
                external: string | null;
                value: 'value' | 'somevalue' | 'novalue';
                order_key: string;
              }[];
              // Resolution describes omitted Global slots too. Keep that diagnostic at
              // the same bounded Global preview it used before Context projection rows.
              if (context !== GLOBAL_CONTEXT) {
                const inheritedPreview = (await listOutboundLinks.run(client, {
                  context_id: GLOBAL_CONTEXT,
                  route,
                  subject_id: subjectId,
                  property,
                  filter_value: NIL_UUID,
                  after_order: '',
                  after_target: NIL_UUID,
                  after_statement: NIL_UUID,
                  page_limit: 12,
                })) as { slot: string }[];
                for (const entry of inheritedPreview) {
                  const view = await slotView(client, subjectId, property, context, defaults, entry.slot);
                  if (view.resolution) resolution[property] = view.resolution;
                }
              }
              const privatePage = await privateLinks(client, { subject: subjectId, property, limit: 13 });
              const privatePreview = privatePage.entries.map((row) => ({
                slot: row.slot_id,
                statement: row.candidate_id,
                target: row.target_id,
                external: null,
                value: 'value' as const,
                order_key: row.order_key,
              }));
              const combined = [...preview, ...privatePreview].sort((a, b) =>
                a.order_key < b.order_key
                  ? -1
                  : a.order_key > b.order_key
                    ? 1
                    : (a.target ?? NIL_UUID) < (b.target ?? NIL_UUID)
                      ? -1
                      : (a.target ?? NIL_UUID) > (b.target ?? NIL_UUID)
                        ? 1
                        : a.statement.localeCompare(b.statement),
              );
              const selected = combined.slice(0, 12);
              const filterProperties = release.properties[property]?.relation?.filter;
              const current = await currentRelationFacts(
                client,
                routeKey,
                selected.map((entry) => ({
                  subject: subjectId,
                  property,
                  candidate: entry.statement,
                  target: entry.target,
                  external: entry.external,
                  value: entry.value,
                  context,
                  defaults,
                  slot: entry.slot,
                  ...(filterProperties === undefined
                    ? {}
                    : { filterProperties: Array.isArray(filterProperties) ? filterProperties : [filterProperties] }),
                  requireRelation: true,
                })),
              );
              for (const entry of selected) {
                const fact = current.get(
                  currentRelationKey({ subject: subjectId, property, candidate: entry.statement }),
                );
                if (fact) statementFacts.push(fact);
                else {
                  const view = await slotView(client, subjectId, property, context, defaults, entry.slot);
                  if (view.resolution) resolution[property] = view.resolution;
                }
              }
            }
          }
          if (!allowed) return null;
          return {
            freshnessRetry: false as const,
            rows,
            supported: await supportedFacts(client, routeKey, subjectId, [
              ...currentTerms(asFacts(rows)),
              ...statementFacts,
            ]),
            members: terminal
              ? []
              : (await readSourceMembers.run(client, { route, subject_id: subjectId })).map((row) => row.member_id),
            release,
            layerDigest: layer.digest,
            component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
            resolution,
            relationCounts,
          };
        });
      let snapshot = await readCurrent();
      while (snapshot?.freshnessRetry) {
        expectedRevision = snapshot.revision;
        expectedSecurityRevision = snapshot.securityRevision;
        requireAccessDeadline(deadline);
        await waitForSubjectLinks(pool, [...(summaries.seen ?? []), snapshot.component], subjectId, deadline);
        requireAccessDeadline(deadline);
        await refreshStatementReaderAuthorization();
        check = await prepare();
        snapshot = await readCurrent();
      }
      return snapshot;
    };
    return summaries.readAs ? summaries.readAs(readOriginal) : readOriginal();
  };
  const snapshot = await readSnapshot(id);
  if (!snapshot) return null;
  const { rows, component, release, layerDigest, resolution, relationCounts } = snapshot;
  const supported = await disclosedTargets(pool, release, snapshot.supported, summaries.authorize);
  // Membership is current identity state, never revision/candidate history. Each admitted original
  // contributes only live displayed terms and selected slots, with fresh original Access and fences.
  const termKeys = new Map<string, unknown>();
  const factKeys = new Map<string, number>();
  const displayed: FactRow[] = [];
  const proof: SupportedFact[] = [];
  const key = (fact: FactRow) => {
    if (fact.kind !== 'statement')
      return JSON.stringify([fact.kind, fact.language, fact.kind === 'alias' ? fact.body : null]);
    const body = fact.body as Record<string, unknown>;
    return JSON.stringify([fact.property, body.value, body.qualifiers, body.references]);
  };
  const add = (entries: SupportedFact[], original = false) => {
    for (const entry of entries) {
      const fact = entry.fact;
      const identity = key(fact);
      if (fact.kind !== 'statement') {
        if (termKeys.has(identity) && termKeys.get(identity) !== fact.body) continue;
        if (!termKeys.has(identity)) {
          termKeys.set(identity, fact.body);
          displayed.push(fact);
        }
      } else if (!original || !factKeys.has(identity)) {
        const count = displayed.filter((row) => row.kind === 'statement' && row.property === fact.property).length;
        if (original && count >= (isRelationProperty(release, fact.property!) ? 12 : 32)) continue;
        factKeys.set(identity, displayed.length);
        displayed.push(fact);
      }
      proof.push(entry);
    }
  };
  add(supported);
  for (const member of snapshot.members) {
    const original = await readSnapshot(member, id);
    if (!original) continue;
    add(await disclosedTargets(pool, original.release, original.supported, summaries.authorize), true);
  }
  const dataTypes = factDataTypes(release, displayed);
  const subject = resolveItem(id, displayed, rows[0]!.type, dataTypes, {
    revision: rows[0]!.revision,
    release: layerDigest,
    context,
    resolution,
    relationCounts,
  });
  if (routeKey)
    subject.sourceRecords = await readSourceRecords(
      pool,
      routeKey,
      proof.flatMap((row) =>
        row.source && 'source' in row.source && typeof row.source.source === 'string' ? [row.source] : [],
      ),
    );
  const summary = active
    ? ((
        await readSubjectSummaries(
          {
            client: { query: pool.query.bind(pool) },
            pool,
            routeKey,
            deadline,
            release: active.release,
            authorize:
              summaries.authorize ??
              (async (connection, subject) => subject === id && authorize(connection as PoolClient)),
          },
          [id],
          { languages: summaries.languages ?? [] },
        )
      ).get(id) ?? null)
    : null;
  // The display projection is independent of the fenced statement view. Recheck
  // its selected media's exact source home before disclosing the cover metadata.
  if (summary?.cover && routeKey) {
    const media = await checkMediaObject({ query: pool.query.bind(pool) }, summary.cover.media, 'cover');
    if (media) {
      const { source, external_id, field_group } = media.source;
      const tuple = { route: tupleRoute(routeKey, source, external_id), source, external_id, field_group };
      const [fence] = await readAnchoredFences(pool, partitionOf(tuple.route), [tuple]);
      if (!fence || fence.takenDown) summary.cover = null;
    }
    requireAccessDeadline(deadline);
  }
  return {
    account: rows[0]!.account === null ? null : { id: rows[0]!.account },
    summary,
    subject,
    component,
  };
}

type Queryable = Pick<PoolClient, 'query'>;

export type ItemTypeDetails = {
  type: string;
  agentAccountId: string | null;
  agentVerified: boolean;
};

export function accountSource(tx: CommandTransaction, statementSubjects: readonly string[]): AgentSelfSource | null {
  const basis = currentCommand(tx).basis;
  if (!basis || basis.actorAccountId === null) return null;
  const subject = accountAgentId(basis.actorAccountId);
  return statementSubjects.includes(subject) ? { kind: 'agent', subject } : null;
}

export function assertAgentStatementAccess(
  tx: CommandTransaction,
  ids: readonly string[],
  details: ReadonlyMap<string, ItemTypeDetails>,
): void {
  const basis = currentCommand(tx).basis;
  if (!basis) return;
  for (const id of new Set(ids)) {
    const agent = details.get(id);
    if (agent?.agentAccountId && !agent.agentVerified && agent.agentAccountId !== basis.actorAccountId)
      throw new AccountAgentWriteDeniedError(id);
  }
}

function assertBatch(ids: readonly string[], message: string): void {
  if (ids.length > BATCH_LIMIT) throw new TypeError(message);
}

function groupsOf(ids: readonly string[]): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const route = routeOf(id);
    if (route === null) continue;
    const partition = partitionOf(route);
    const group = groups.get(partition) ?? [];
    group.push(id);
    groups.set(partition, group);
  }
  return groups;
}

/** Item targets of one write, one primary-key probe per id and one statement per partition. */
export async function readItemDetails(
  client: Queryable,
  ids: readonly string[],
): Promise<Map<string, ItemTypeDetails>> {
  if (ids.length > BATCH_LIMIT + 1) throw new TypeError('An item type and account agent check accepts at most 257 ids');
  const details = new Map<string, ItemTypeDetails>();
  for (const [partition, subjectIds] of groupsOf(ids)) {
    const result = (await readTypesStatement.run(client, {
      partition_no: partition,
      routes: subjectIds.map((id) => routeOf(id)!),
      subject_ids: subjectIds,
    })) as
      | { id: string; type: string; agent_account_id: string | null; agent_verified: boolean }[]
      | { id: string; type: string; agent_account_id: string | null; agent_verified: boolean }
      | null;
    const rows = result == null ? [] : Array.isArray(result) ? result : [result];
    for (const row of rows)
      details.set(row.id, {
        type: row.type,
        agentAccountId: row.agent_account_id,
        agentVerified: row.agent_verified,
      });
  }
  return details;
}

export async function readItemTypes(client: Queryable, ids: readonly string[]): Promise<Map<string, string>> {
  assertBatch(ids, 'An item type check accepts at most 256 ids');
  const details = await readItemDetails(client, ids);
  return new Map([...details].map(([id, detail]) => [id, detail.type]));
}

export async function readLabels(
  pool: Pool | CommandTransaction,
  ids: readonly string[],
): Promise<Map<string, Item['labels']>> {
  assertBatch(ids, 'A label fill accepts at most 256 ids');
  const labels = new Map<string, Item['labels']>();
  await Promise.all(
    [...groupsOf(ids)].map(async ([partition, subjectIds]) => {
      const rows = listed(
        (await readLabelsStatement.run(pool, {
          partition_no: partition,
          routes: subjectIds.map((id) => routeOf(id)!),
          subject_ids: subjectIds,
        })) as { id: string; labels: Record<string, string> }[] | { id: string; labels: Record<string, string> } | null,
      );
      for (const row of rows) labels.set(row.id, row.labels ?? {});
    }),
  );
  return labels;
}

/** Chosen-label inputs use one statement per partition, including the original-language slot. */
export async function readLabelChoices(
  pool: Pool,
  ids: readonly string[],
): Promise<Map<string, { labels: Item['labels']; original: string | null }>> {
  assertBatch(ids, 'A label fill accepts at most 256 ids');
  const labels = new Map<string, { labels: Item['labels']; original: string | null }>();
  await Promise.all(
    [...groupsOf(ids)].map(async ([partition, subjectIds]) => {
      const rows = (await readLabelChoicesStatement.run(pool, {
        partition_no: partition,
        context_id: GLOBAL_CONTEXT,
        subjects: subjectIds.map((id) => ({ route: routeOf(id)!, id, original: slotId(id, 'schema:inLanguage') })),
      })) as { id: string; labels: Record<string, string>; original: string | null }[];
      for (const row of rows) labels.set(row.id, { labels: row.labels ?? {}, original: row.original });
    }),
  );
  return labels;
}

export type RelatedState = {
  id: string;
  visibility: string;
  security_revision: string;
  redirect: string | null;
  labels: Item['labels'];
};

type RelatedEpisode = { ids: string[]; pending?: Promise<Map<string, RelatedState>> };

async function queryRelated(client: Queryable, ids: readonly string[]): Promise<Map<string, RelatedState>> {
  const states = new Map<string, RelatedState>();
  for (const [partition, subjectIds] of groupsOf(ids)) {
    const rows = listed(
      (await readRelatedStatement.run(client, {
        partition_no: partition,
        routes: subjectIds.map((id) => routeOf(id)!),
        subject_ids: subjectIds,
      })) as RelatedState[] | RelatedState | null,
    );
    for (const row of rows) states.set(row.id, { ...row, labels: row.labels ?? {} });
  }
  return states;
}

/** One statement per partition for visibility, eligibility, labels and redirects. */
function loadRelatedInEpisode(
  client: object,
  ids: readonly string[],
  episode: RelatedEpisode,
): Promise<Map<string, RelatedState>> {
  assertBatch(ids, 'A related read accepts at most 256 ids');
  const known = episode.pending === undefined ? null : { ids: episode.ids, pending: episode.pending };
  if (known && ids.every((id) => known.ids.includes(id))) return known.pending;
  const pending = queryRelated(client as Queryable, ids).then(async (fetched) => {
    const prior = known ? await known.pending : new Map<string, RelatedState>();
    const merged = new Map(prior);
    for (const [id, state] of fetched) merged.set(id, state);
    return merged;
  });
  episode.ids = [...new Set([...(known?.ids ?? []), ...ids])];
  episode.pending = pending;
  return pending;
}

/** Loads current related state; callers may reuse it only within their bounded read episode. */
export function loadRelated(client: object, ids: readonly string[]): Promise<Map<string, RelatedState>> {
  assertBatch(ids, 'A related read accepts at most 256 ids');
  return queryRelated(client as Queryable, ids);
}

function isPool(value: Pool | PoolClient): value is Pool {
  return typeof (value as Pool).connect === 'function' && typeof (value as PoolClient).release !== 'function';
}

/** Labels of the requested ids, following one redirect, from this related-read episode. */
export async function readRelated(db: Pool | PoolClient, ids: readonly string[]) {
  assertBatch(ids, 'A related read accepts at most 256 ids');
  const assemble = async (client: PoolClient) => {
    const episode: RelatedEpisode = { ids: [] };
    const states = await loadRelatedInEpisode(client, ids, episode);
    const targets = [
      ...new Set(
        ids.flatMap((id) => {
          const state = states.get(id);
          return state?.visibility === 'visible' && state.redirect ? [state.redirect] : [];
        }),
      ),
    ];
    const targetStates = targets.length > 0 ? await loadRelatedInEpisode(client, targets, episode) : states;
    const related: Record<string, { labels: Item['labels']; redirect?: string }> = {};
    for (const id of ids) {
      const state = states.get(id);
      if (!state || state.visibility !== 'visible') continue;
      const target = state.redirect;
      if (target) {
        const redirected = targetStates.get(target);
        if (!redirected || redirected.visibility !== 'visible') continue;
        related[id] = { redirect: target, labels: redirected.labels };
        continue;
      }
      related[id] = { labels: state.labels };
    }
    return related;
  };
  if (isPool(db)) return withConnection(db, assemble);
  return assemble(db);
}

/** Identity writers share this command so every outbound projection follows label and type changes. */
export async function updateSubjectIdentity(
  pool: Pool,
  options: {
    subject: string;
    labels?: Record<string, string>;
    type?: string;
    release: { digest: string; release: Release };
    authorize: AccessCheck;
    deadline?: number;
    clock?: () => Date;
  },
) {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectInputError([{ pointer: '/subject', code: 'invalid_format' }]);
  return runIdentityTerminalCommand(
    pool,
    {
      partition: partitionOf(route),
      clock: options.clock,
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
      authorization: {
        action: 'subject:create',
        resource: { route, id: options.subject },
        denied: () => new SubjectAccessDeniedError(),
        async authorize(tx, attempt) {
          if (!(await options.authorize(tx, attempt.time))) throw new SubjectAccessDeniedError();
          return 'execute';
        },
      },
    },
    async (tx, { transactionId }) => {
      const sourceSet = await beginSemanticRecordSourceSet(tx);
      const visibility = await readIdentityVisibility.run(tx, { route, subject_id: options.subject });
      if (visibility?.visibility !== 'visible') throw new SubjectAccessDeniedError();
      if (options.labels !== undefined) {
        const agents = await accountAgentsForSubjects(tx, [options.subject]);
        const agent = agents.get(options.subject);
        if (agent && agent.agent_id === options.subject && !agent.verified) throw new AccountAgentLabelEditError();
      }
      const before = await holderFacts(tx, options.subject, options.release.release);
      const type = options.type ?? before.type;
      if (!options.release.release.types[type])
        throw new SubjectInputError([{ pointer: '/type', code: 'unsupported' }]);
      const facts = options.labels === undefined ? [] : itemFacts(options.subject, { labels: options.labels });
      const latest = listed(
        (await readSubjectStatement.run(tx, { route, subject_id: options.subject })) as
          | SubjectReadRow[]
          | SubjectReadRow
          | null,
      );
      if (latest[0]?.redirect) throw new SubjectRedirectError(options.subject, latest[0].redirect);
      const state = await readIdentitySubject.run(tx, { route, subject_id: options.subject });
      if (
        !state ||
        state.current_facts + facts.length > 512 ||
        facts.some((fact) => latest.some((row) => row.slot_id === fact.slot_id && (row.log_seq ?? 0) >= 32))
      )
        throw new SubjectInputError([{ pointer: '/labels', code: 'out_of_range' }]);
      const revision = (latest[0]!.revision ?? 0) + 1;
      await collectSemanticRecordFacts(tx, options.subject, before.facts);
      await updateIdentity.run(tx, {
        route,
        subject_id: options.subject,
        type,
        release: options.release.digest,
        revision,
        transaction_id: transactionId,
        source: null,
        labels: facts.map((fact) => ({ slot_id: fact.slot_id, language: fact.language, body: fact.body })),
      });
      await collectSemanticRecordFacts(tx, options.subject, facts, revision);
      const keysChanged = options.labels !== undefined || type !== before.type;
      const publicationEvents: { type: string; subject: string; data: unknown }[] = [];
      await recordSubjectPageDiff(
        tx,
        options.subject,
        transactionId,
        await subjectPageFacts(
          tx,
          options.subject,
          before.facts.filter((f) => f.kind === 'label'),
          options.release.release,
        ),
        await subjectPageFacts(
          tx,
          options.subject,
          (await holderFacts(tx, options.subject, options.release.release)).facts.filter((f) => f.kind === 'label'),
          options.release.release,
        ),
        publicationEvents,
      );
      if (type !== before.type) await invalidateSubjectPage(tx, options.subject, transactionId, publicationEvents);
      await sealSemanticRecordSourceSet(tx, sourceSet);
      return {
        value: { revision },
        events: [
          ...publicationEvents,
          {
            type: 'com.rezics.subject.revised.v1',
            subject: options.subject,
            data: { id: options.subject, revision, kind: 'identity' },
          },
          ...(keysChanged
            ? (['holder', 'target'] as const).map((direction) => ({
                type: LINK_KEYS_CHANGED,
                subject: options.subject,
                data: {
                  subject: options.subject,
                  direction,
                  revision,
                  security_revision: Number(visibility.securityRevision),
                  cursor: [],
                },
              }))
            : []),
        ],
      };
    },
  );
}
