import { jsonParameter } from '../database/json.ts';
import { admitIdentityTerminalCapture, runIdentityTerminalCommand } from './identity-terminal-closure-command.ts';
import {
  beginSemanticRecordSourceSet,
  collectSemanticRecordFacts,
  sealSemanticRecordSourceSet,
} from './record-source-set.ts';
import { initializeSubjectPagePublication, retainSubjectPageSource } from './subject-page-publication-store.ts';
import { subjectPageFacts, recordSubjectPageDiff, invalidateSubjectPage } from './subject-page-publication-native.ts';
import { disclosureAccount, keepStatementPrivate } from './statement-disclosure.ts';
import type { Source } from '@rezics/definitions/bulk';
import { SubjectRedirectError } from './contract/subject-errors.ts';
import { checkSubjectInput } from '@rezics/definitions/validate';
import type { DataType, Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import {
  currentCommand,
  currentCommandResources,
  DEFAULT_REQUEST_DEADLINE_MS,
  runCommand,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import type { AccessCheck, AccountActor, Resource } from '../request/access.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../route/route.ts';
import { type AgentSelfSource as CandidateAgentSelfSource } from './fences.ts';
import { resolvedSemanticDomain } from './adapters/registry.ts';
import { factDataTypes, isRelationProperty, itemFacts, resolveItem, type FactRow, type Item } from './item.ts';
import { SubjectInputError } from './item.ts';
import { rejectBulkContent, rejectContent } from './rules.ts';
import { authoredAuthorization, installAuthoredStatement } from './authored.ts';
import { GLOBAL_SUBJECT_CONTEXT } from './contract/subject-values.ts';
import { LINK_KEYS_CHANGED, LINKS_CHANGED } from './events.ts';
import { holderFacts } from './link-keys.ts';
import updateIdentity from './update-subject-identity.sql';
import readIdentitySubject from './candidates-read-adoption-subject.sql';
import { linkChanges } from './link-changes.ts';
import { expandSlot, slotId } from './slots.ts';
import { matchesTarget } from './targets.ts';
import createRevision from './create-revision.sql';
import insertSubject from './create-subject.sql';
import changePartitionSubjectCount from './change-partition-subject-count.sql';
import readLabelChoicesStatement from './read-label-choices.sql';
import readSubjectStatement from './read-subject.sql';
import readIdentityVisibility from './read-visibility.sql';
import { readItemDetails, type ItemTypeDetails } from './public-subject-facts.ts';
export { readItemDetails, readItemTypes, readLabels, type ItemTypeDetails } from './public-subject-facts.ts';
import { writeFacts } from './write-facts.ts';
import {
  AccountAgentLabelEditError,
  AccountAgentWriteDeniedError,
  accountAgentId,
  accountAgentsForSubjects,
} from './agents.ts';
import { initializeIdentitySubject } from './identity-adapters/subject-creation.ts';
import { initializeRevisionAuthorship, revisionResource } from './authorship.ts';
import { creationDeclares } from '../access/parent-creation.ts';
import { declareCommandHistory } from '../history/application/index.ts';
import { nativeSubjectReadingApplication } from './adapters/subject-reading.ts';

function composedDomain(pool?: Pool) {
  return resolvedSemanticDomain(pool);
}

export { writeFacts } from './write-facts.ts';

const BATCH_LIMIT = 256;

export const CREATE_SUBJECT = 'subject.create';
// Permanent Semantic owner-assigned receipt codec ID.
// Literal identity so this module can finish while definitions.ts is still evaluating.
const CONTEXT = '00000000-0000-8000-8000-000000000000';

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
  const type = typeof input?.type === 'string' ? input.type : String(input.type);
  const domain = composedDomain(currentCommandResources(tx).pool);
  const plan = domain?.subjects.plan({
    subjectId,
    item: options.item,
    type,
    release: options.release.release,
    releaseDigest: options.release.digest,
  });
  const facts = [...(plan?.facts ?? itemFacts(subjectId, options.item, type, options.release.release))];
  const dataTypes =
    (plan?.dataTypes as Record<string, DataType> | undefined) ?? factDataTypes(options.release.release, facts);
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
    type,
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
  if (domain) await domain.subjects.initializeIdentity(tx, subjectId);
  else await initializeIdentitySubject(tx, subjectId);
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
  if (domain && plan) {
    await domain.subjects.writePlannedFacts(
      {
        tx,
        route,
        subjectId,
        item: options.item,
        type,
        release: options.release.release,
        releaseDigest: options.release.digest,
        transactionId,
      },
      plan,
    );
  } else {
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
  }
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
      type,
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
  const relationCounts = Object.fromEntries(
    (options.release.release.types[type]?.properties ?? [])
      .filter((property) => isRelationProperty(options.release.release, property))
      .map((property) => [
        property,
        facts.filter((fact) => fact.kind === 'statement' && fact.property === property && fact.operation === 'assert')
          .length,
      ]),
  );
  const metadata = { revision: 1, release: options.release.digest, context: CONTEXT, relationCounts };
  return {
    value:
      domain && plan
        ? domain.subjects.project(plan, facts, metadata)
        : resolveItem(subjectId, facts, type, dataTypes, metadata),
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

export type RelatedState = import('./subject-reading-application.ts').RelatedState;
export type { SubjectReadOptions, SubjectReadResult } from './subject-reading-application.ts';

export function readSubject(
  pool: Pool,
  id: string,
  authorize: (client: PoolClient) => Promise<boolean>,
  context = GLOBAL_SUBJECT_CONTEXT,
  routeKey: Uint8Array,
  options: import('./subject-reading-application.ts').SubjectReadOptions = {},
) {
  return nativeSubjectReadingApplication().readSubject(pool, id, authorize, context, routeKey, options);
}

export { readRelated, loadRelated } from './related-subject-read.ts';

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
        context_id: GLOBAL_SUBJECT_CONTEXT,
        subjects: subjectIds.map((id) => ({ route: routeOf(id)!, id, original: slotId(id, 'schema:inLanguage') })),
      })) as { id: string; labels: Record<string, string>; original: string | null }[];
      for (const row of rows) labels.set(row.id, { labels: row.labels ?? {}, original: row.original });
    }),
  );
  return labels;
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
        labels: jsonParameter(
          facts.map((fact) => ({ slot_id: fact.slot_id, language: fact.language, body: fact.body })),
        ),
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
