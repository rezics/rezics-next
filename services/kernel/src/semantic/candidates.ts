import { checkStatementInput } from '@rezics/definitions/validate';
import type { Source, BatchReference } from '@rezics/definitions/bulk';
import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { runCommand, type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccountActor } from '../request/access.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding, type CursorKey } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { redirectOf, SubjectRedirectError } from './merges.ts';
import { GLOBAL_CONTEXT, readRelease } from './definitions.ts';
import { LINKS_CHANGED } from './events.ts';
import { factDataTypes, itemFacts, resolveItem, SubjectInputError, type Violation } from './item.ts';
import { linkChanges } from './link-changes.ts';
import { PageCursorError } from './page.ts';
import { rejectContent } from './rules.ts';
import {
  candidateFact,
  currentAcceptance,
  expandSlot,
  insertAcceptance,
  insertAdoption,
  latestAdoption,
  resolveSlot,
  slotId,
  slotView,
  type Adoption,
  type Candidate,
} from './slots.ts';
import readTypes from './read-item-types.sql';
import { contextSnapshot } from './context.ts';
import { matchesTarget } from './targets.ts';

export class SubjectNotFoundError extends Error {}
export class EditorialConflictError extends Error {}
const CANDIDATE_NS = '3c62c392-7c55-4fda-bf16-13b4853e7598';
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function validatedStatement(
  subject: string,
  type: string,
  release: { digest: string; release: Release },
  raw: unknown,
) {
  const property = record(raw) && record(raw.property) && typeof raw.property.id === 'string' ? raw.property.id : '';
  const definition = Object.hasOwn(release.release.types, type) ? release.release.types[type] : undefined;
  const subjectErrors: Violation[] = !definition
    ? [{ pointer: '/type', code: 'unsupported' }]
    : !definition.properties.includes(property)
      ? [{ pointer: '/statement/property/id', code: 'unsupported' }]
      : [];
  const checked = checkStatementInput(raw, subjectErrors.length ? undefined : release.release, { rejectContent });
  const violations = [...subjectErrors, ...checked.violations];
  if (violations.length) throw new SubjectInputError(violations);
  const input = { type, labels: { en: 'Validation' }, statements: { [property]: [raw] } };
  const facts = itemFacts(subject, input, type);
  return { property, fact: facts.find((fact) => fact.kind === 'statement')!, items: checked.targets };
}

export async function proposeStatement(
  pool: Pool,
  options: {
    subject: string;
    statement: unknown;
    actor: AccountActor;
    idempotencyKey: string;
    digest: Uint8Array;
    release: { digest: string; release: Release };
    authorization: CommandAuthorization;
    deadline: number;
  },
) {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  const command = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: options.deadline,
      receipt: {
        actorAccountId: options.actor.accountId,
        kind: 'subject.propose',
        key: options.idempotencyKey,
        digest: options.digest,
      },
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorization: options.authorization,
    },
    async (tx, { transactionId }) => {
      return writeProposal(tx, transactionId, options);
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}

/** Allocate and validate a proposal inside its subject's command transaction. */
export async function writeProposal(
  tx: CommandTransaction,
  transactionId: string,
  options: Pick<Parameters<typeof proposeStatement>[1], 'subject' | 'statement' | 'release'> & { source?: Source },
) {
  const route = routeOf(options.subject)!;
  const subject = await tx.query<{ type: string; revision: number }>(
    `SELECT s.type, latest.revision FROM semantic.subject s
       JOIN LATERAL (SELECT revision FROM semantic.revision WHERE route = s.route AND subject_id = s.subject_id
         ORDER BY revision DESC LIMIT 1) latest ON true
       WHERE s.route = $1 AND s.subject_id = $2 AND s.visibility = 'visible'`,
    [route, options.subject],
  );
  if (!subject.rows[0]) throw new SubjectNotFoundError();
  const redirect = await redirectOf(tx, options.subject);
  if (redirect) throw new SubjectRedirectError(options.subject, redirect);
  const input = validatedStatement(options.subject, subject.rows[0].type, options.release, options.statement);
  const grouped = new Map<number, Set<string>>();
  for (const item of input.items) {
    const itemRoute = routeOf(item.id);
    if (itemRoute === null) continue;
    const partition = partitionOf(itemRoute);
    const ids = grouped.get(partition) ?? new Set<string>();
    ids.add(item.id);
    grouped.set(partition, ids);
  }
  const types = new Map<string, string>();
  for (const [partition_no, ids] of grouped) {
    const rows = await readTypes.run(tx, { partition_no, subject_ids: [...ids] });
    for (const row of rows) types.set(row.id, row.type);
  }
  const errors = input.items.flatMap((item) =>
    matchesTarget(options.release.release, types.get(item.id) ?? '', item.targets)
      ? []
      : [{ pointer: item.pointer, code: 'out_of_range' as const }],
  );
  if (errors.length) throw new SubjectInputError(errors);
  const revision = subject.rows[0].revision + 1;
  const candidate = derivedId(CANDIDATE_NS, `${options.subject}\n${revision}`, route);
  try {
    await expandSlot(tx, options.subject, input.property, transactionId);
    await tx.query(
      `INSERT INTO semantic.revision (route, subject_id, revision, kind, release, recorded_transaction_id, source)
         VALUES ($1, $2, $3, 'propose', $4, $5, $6)`,
      [route, options.subject, revision, options.release.digest, transactionId, options.source ?? null],
    );
    await tx.query(
      `INSERT INTO semantic.candidate
         (route, subject_id, candidate_id, slot_id, property, rank, statement, release, revision, origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'proposal')`,
      [
        route,
        options.subject,
        candidate,
        slotId(options.subject, input.property),
        input.property,
        (input.fact.body as { rank: string }).rank,
        JSON.stringify(input.fact.body),
        options.release.digest,
        revision,
      ],
    );
  } catch (error) {
    // PostgreSQL can report a concurrent insert as a uniqueness failure before SSI detects the race.
    if (
      record(error) &&
      error.code === '23505' &&
      ['revision_pkey', 'candidate_pkey', 'fact_pkey'].includes(String(error.constraint))
    ) {
      error.code = '40001';
    }
    throw error;
  }
  return {
    value: { candidate, revision },
    events: [{ type: 'com.rezics.statement.proposed.v1', subject: options.subject, data: { candidate, revision } }],
  };
}

type EditorialWriteOptions = {
  subject: string;
  actor: AccountActor;
  idempotencyKey: string;
  digest: Uint8Array;
  authorization: CommandAuthorization;
  deadline: number;
};

async function appendEditorialRevision(
  tx: Parameters<Parameters<typeof runCommand>[2]>[0],
  input: {
    subject: string;
    route: number;
    revision: number;
    release: string;
    kind: 'accept' | 'reject' | 'adopt';
    transactionId: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO semantic.revision (route, subject_id, revision, kind, release, recorded_transaction_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.route, input.subject, input.revision, input.kind, input.release, input.transactionId],
  );
}

function retryEditorialUniqueness(error: unknown): void {
  if (
    record(error) &&
    error.code === '23505' &&
    ['revision_pkey', 'acceptance_pkey', 'adoption_pkey'].includes(String(error.constraint))
  )
    error.code = '40001';
}

export async function decideCandidate(
  pool: Pool,
  options: EditorialWriteOptions & {
    candidate: string;
    context: string;
    decision: 'accept' | 'reject';
    expectedHead: number | null;
  },
) {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  const command = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: options.deadline,
      receipt: {
        actorAccountId: options.actor.accountId,
        kind: 'subject.decide',
        key: options.idempotencyKey,
        digest: options.digest,
      },
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorization: options.authorization,
    },
    async (tx, { transactionId }) => {
      type CandidateRow = {
        revision: number;
        release: string;
        candidate_id: string;
        property: string;
        slot_id: string;
      };
      const found = await tx.query<CandidateRow>(
        `SELECT latest.revision, latest.release, c.candidate_id::text, c.property, c.slot_id::text
         FROM semantic.subject s
         JOIN LATERAL (
           SELECT revision, release FROM semantic.revision
           WHERE route = s.route AND subject_id = s.subject_id ORDER BY revision DESC LIMIT 1
         ) latest ON true
         JOIN semantic.candidate c
           ON c.route = s.route AND c.subject_id = s.subject_id AND c.candidate_id = $3
         WHERE s.route = $1 AND s.subject_id = $2 AND s.visibility = 'visible'`,
        [route, options.subject, options.candidate],
      );
      let candidate = found.rows[0];
      if (!candidate) {
        const compact = await tx.query<CandidateRow>(
          `SELECT r.revision, r.release, f.statement_id::text AS candidate_id, f.property, f.slot_id::text AS slot_id
           FROM semantic.fact f
           JOIN semantic.subject s ON s.route = f.route AND s.subject_id = f.subject_id AND s.visibility = 'visible'
           JOIN LATERAL (
             SELECT revision, release FROM semantic.revision
             WHERE route = f.route AND subject_id = f.subject_id
               AND recorded_transaction_id = f.recorded_transaction_id
             LIMIT 1
           ) r ON true
           WHERE f.route = $1 AND f.subject_id = $2 AND f.statement_id = $3
             AND f.kind = 'statement' AND f.operation = 'assert'
             AND NOT EXISTS (
               SELECT 1 FROM semantic.fact newer
               WHERE newer.route = f.route AND newer.subject_id = f.subject_id
                 AND newer.slot_id = f.slot_id AND newer.statement_id = f.statement_id
                 AND newer.log_seq > f.log_seq
             )
           ORDER BY f.log_seq DESC LIMIT 1`,
          [route, options.subject, options.candidate],
        );
        candidate = compact.rows[0];
      }
      if (!candidate) throw new SubjectNotFoundError();
      const concealed = await tx.query(
        `SELECT 1 FROM semantic.hidden_candidate
         WHERE route = $1 AND subject_id = $2 AND candidate_id = $3`,
        [route, options.subject, options.candidate],
      );
      if ((concealed.rowCount ?? 0) > 0) throw new SubjectNotFoundError();
      if (await redirectOf(tx, options.subject)) throw new EditorialConflictError();

      await expandSlot(tx, options.subject, candidate.property, transactionId);
      if (options.decision === 'reject') {
        const adoption = await latestAdoption(tx, options.subject, candidate.property, options.context);
        if (adoption?.mode === 'replace' && adoption.selection.some((entry) => entry.candidate === options.candidate))
          throw new EditorialConflictError();
      }

      const revision = candidate.revision + 1;
      try {
        await appendEditorialRevision(tx, {
          subject: options.subject,
          route,
          revision,
          release: candidate.release,
          kind: options.decision,
          transactionId,
        });
        const head = await insertAcceptance(
          tx,
          options.subject,
          options.candidate,
          options.context,
          options.expectedHead,
          options.decision,
          revision,
          candidate.slot_id,
        );
        return {
          value: {
            acceptance: {
              context: options.context,
              candidate: options.candidate,
              decision: options.decision,
              head,
            },
            revision,
          },
          events: [
            {
              type:
                options.decision === 'accept' ? 'com.rezics.statement.accepted.v1' : 'com.rezics.statement.rejected.v1',
              subject: options.subject,
              data: { candidate: options.candidate, context: options.context, revision, head },
            },
          ],
        };
      } catch (error) {
        retryEditorialUniqueness(error);
        throw error;
      }
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}

export async function adoptCandidates(
  pool: Pool,
  options: EditorialWriteOptions & {
    context: string;
    property: string;
    mode: Adoption['mode'];
    selection: { candidate: string; rank: 'normal' | 'preferred' | 'deprecated' }[];
    expectedHead: number | null;
    release: { digest: string; release: Release };
  },
) {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  const command = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: options.deadline,
      receipt: {
        actorAccountId: options.actor.accountId,
        kind: 'subject.adopt',
        key: options.idempotencyKey,
        digest: options.digest,
      },
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorization: options.authorization,
    },
    async (tx, { transactionId }) => {
      const subject = await tx.query<{ type: string; revision: number; security_revision: string }>(
        `SELECT s.type, latest.revision, s.security_revision::text AS security_revision
         FROM semantic.subject s
         JOIN LATERAL (
           SELECT revision FROM semantic.revision
           WHERE route = s.route AND subject_id = s.subject_id ORDER BY revision DESC LIMIT 1
         ) latest ON true
         WHERE s.route = $1 AND s.subject_id = $2 AND s.visibility = 'visible'`,
        [route, options.subject],
      );
      if (!subject.rows[0]) throw new SubjectNotFoundError();
      if (await redirectOf(tx, options.subject)) throw new EditorialConflictError();
      const type = options.release.release.types[subject.rows[0].type];

      if (options.context === GLOBAL_CONTEXT && options.mode !== 'replace')
        throw new SubjectInputError([{ pointer: '/mode', code: 'unsupported' }]);
      if ((options.mode === 'inherit' || options.mode === 'suppress') && options.selection.length)
        throw new SubjectInputError([{ pointer: '/selection', code: 'out_of_range' }]);
      const definition = options.release.release.properties[options.property];
      if (!type || !type.properties.includes(options.property) || !definition)
        throw new SubjectInputError([{ pointer: '/property', code: 'unsupported' }]);

      if (options.selection.length > 32) throw new SubjectInputError([{ pointer: '/selection', code: 'out_of_range' }]);
      const hiddenCandidates = new Set<string>();
      const hiddenIds = [
        ...new Set(options.selection.map((entry) => entry.candidate).filter((id) => routeOf(id) === route)),
      ];
      if (hiddenIds.length) {
        const concealed = await tx.query<{ candidate_id: string }>(
          `SELECT candidate_id::text FROM semantic.hidden_candidate
           WHERE route = $1 AND subject_id = $2 AND candidate_id = ANY($3::uuid[])`,
          [route, options.subject, hiddenIds],
        );
        for (const row of concealed.rows) hiddenCandidates.add(row.candidate_id);
      }
      const state = await resolveSlot(tx, options.subject, options.property, options.context);
      const compact = new Set(state.compact.map((candidate) => candidate.candidate_id));
      for (const [index, entry] of options.selection.entries()) {
        let supported = compact.has(entry.candidate);
        if (!supported) {
          const result = await tx.query<{ candidate_id: string }>(
            `SELECT candidate_id::text FROM semantic.candidate
             WHERE route = $1 AND subject_id = $2 AND slot_id = $3 AND candidate_id = $4::uuid`,
            [route, options.subject, slotId(options.subject, options.property), entry.candidate],
          );
          supported = result.rows.length > 0;
        }
        if (routeOf(entry.candidate) !== route || !supported || hiddenCandidates.has(entry.candidate))
          throw new SubjectInputError([{ pointer: `/selection/${index}/candidate`, code: 'unsupported' }]);
      }
      const seen = new Set<string>();
      for (const [index, entry] of options.selection.entries()) {
        if (seen.has(entry.candidate))
          throw new SubjectInputError([{ pointer: `/selection/${index}/candidate`, code: 'invalid_format' }]);
        seen.add(entry.candidate);
      }
      const deprecated = options.selection.findIndex((entry) => entry.rank === 'deprecated');
      if (deprecated >= 0)
        throw new SubjectInputError([{ pointer: `/selection/${deprecated}/rank`, code: 'unsupported' }]);
      if (!definition.multivalued && options.selection.length > 1)
        throw new SubjectInputError([{ pointer: '/selection', code: 'out_of_range' }]);

      const beforeLinks =
        options.context === GLOBAL_CONTEXT ? (await slotView(tx, options.subject, options.property)).facts : null;
      await expandSlot(tx, options.subject, options.property, transactionId);
      const revision = subject.rows[0].revision + 1;
      const selection = options.selection as Adoption['selection'];
      try {
        await appendEditorialRevision(tx, {
          subject: options.subject,
          route,
          revision,
          release: options.release.digest,
          kind: 'adopt',
          transactionId,
        });
        const head = await insertAdoption(
          tx,
          options.subject,
          options.property,
          options.context,
          options.expectedHead,
          options.mode,
          selection,
          revision,
        );
        for (const entry of selection) {
          const local = await currentAcceptance(tx, options.subject, entry.candidate, options.context);
          const effective =
            local ??
            (options.context === GLOBAL_CONTEXT
              ? null
              : await currentAcceptance(tx, options.subject, entry.candidate, GLOBAL_CONTEXT));
          if (effective?.verdict !== 'accept') throw new EditorialConflictError();
        }
        const events: { type: string; subject: string; data: unknown }[] = [
          {
            type: 'com.rezics.subject.adopted.v1',
            subject: options.subject,
            data: { context: options.context, property: options.property, mode: options.mode, revision, head },
          },
        ];
        if (beforeLinks) {
          const afterFacts = (await slotView(tx, options.subject, options.property)).facts;
          const changes = linkChanges(
            beforeLinks,
            afterFacts,
            factDataTypes(options.release.release, [...beforeLinks, ...afterFacts]),
          );
          if (changes.length > 0) {
            events.push({
              type: LINKS_CHANGED,
              subject: options.subject,
              data: {
                subject: options.subject,
                revision,
                security_revision: Number(subject.rows[0].security_revision),
                changes,
              },
            });
          }
        }
        return {
          value: {
            adoption: {
              context: options.context,
              property: options.property,
              mode: options.mode,
              selection,
              head,
            },
            revision,
          },
          events,
        };
      } catch (error) {
        retryEditorialUniqueness(error);
        throw error;
      }
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}

type PageOptions = {
  subject: string;
  limit: number;
  cursor?: string;
  authorize: (client: PoolClient) => Promise<boolean>;
};
async function page<T>(
  pool: Pool,
  ring: KeyRing,
  options: PageOptions,
  binding: CursorBinding,
  validAfter: (after: CursorKey[]) => boolean,
  read: (client: PoolClient, after: CursorKey[] | null) => Promise<{ value: T; after: CursorKey[] | null }>,
) {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  let cursor: { epoch: number; after: CursorKey[] } | null = null;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(ring, binding, options.cursor);
    if (!decoded.ok) throw new PageCursorError(decoded.reason);
    if (!validAfter(decoded.after)) throw new PageCursorError('invalid');
    cursor = decoded;
  }
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query("SET LOCAL statement_timeout = '300ms'");
      const partition = await readPartition(client, partitionOf(route));
      const subject = await client.query<{ visibility: string }>(
        'SELECT visibility FROM semantic.subject WHERE route = $1 AND subject_id = $2',
        [route, options.subject],
      );
      if (!partition || subject.rows[0]?.visibility !== 'visible' || !(await options.authorize(client)))
        throw new SubjectNotFoundError();
      if (cursor && cursor.epoch !== partition.epoch) throw new PageCursorError('stale');
      const result = await read(client, cursor?.after ?? null);
      await client.query('COMMIT');
      return {
        ...result.value,
        next: result.after ? encodeCursor(ring, binding, { epoch: partition.epoch, after: result.after }) : null,
        component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}

export function listRevisions(pool: Pool, ring: KeyRing, options: PageOptions) {
  return page(
    pool,
    ring,
    options,
    { operation: 'subject.list_revisions', parameters: { subject: options.subject } },
    (after) => after.length === 1 && Number.isSafeInteger(after[0]) && Number(after[0]) >= 1,
    async (client, after) => {
      const result = await client.query<{ revision: number; kind: string; release: string; source: Source | null }>(
        `SELECT revision, kind, release, source FROM semantic.revision WHERE route = $1 AND subject_id = $2
         AND revision < $3 ORDER BY revision DESC LIMIT $4`,
        [routeOf(options.subject), options.subject, after?.[0] ?? 2147483647, options.limit + 1],
      );
      const revisions = result.rows.slice(0, options.limit);
      return { value: { revisions }, after: result.rows.length > options.limit ? [revisions.at(-1)!.revision] : null };
    },
  );
}

export async function listCandidates(
  pool: Pool,
  ring: KeyRing,
  options: PageOptions & { property: string; context: string },
) {
  const contextRecord = options.context === GLOBAL_CONTEXT ? null : await contextSnapshot(pool, options.context);
  if (options.context !== GLOBAL_CONTEXT && !contextRecord) throw new SubjectNotFoundError();
  const defaults = contextRecord?.defaults ?? {};
  return page(
    pool,
    ring,
    options,
    {
      operation: 'subject.list_candidates',
      parameters: {
        subject: options.subject,
        property: options.property,
        context: options.context,
      },
    },
    (after) =>
      after.length === 3 &&
      Number.isSafeInteger(after[0]) &&
      Number(after[0]) >= 1 &&
      Number.isInteger(after[1]) &&
      Number(after[1]) >= 0 &&
      Number(after[1]) <= 32 &&
      typeof after[2] === 'string' &&
      routeOf(after[2]) === routeOf(options.subject),
    async (client, after) => {
      const state = await resolveSlot(client, options.subject, options.property, options.context);
      type Decided = Candidate & { verdict: 'accept' | 'reject' | 'abstain' | null; head: number | null };
      let rows: Decided[];
      if (state.expanded) {
        const result = await client.query<Decided>(
          `SELECT c.*, a.verdict, a.head FROM (
           SELECT * FROM semantic.candidate WHERE route = $1 AND subject_id = $2 AND slot_id = $3
             AND (revision, view_order, candidate_id) > ($5, $6, $7::uuid)
           ORDER BY revision, view_order, candidate_id LIMIT $8
         ) c LEFT JOIN semantic.acceptance_current a
           ON a.route = c.route AND a.subject_id = c.subject_id AND a.context_id = $4
             AND a.candidate_id = c.candidate_id
         ORDER BY c.revision, c.view_order, c.candidate_id`,
          [
            routeOf(options.subject),
            options.subject,
            slotId(options.subject, options.property),
            options.context,
            after?.[0] ?? 0,
            after?.[1] ?? 0,
            after?.[2] ?? '00000000-0000-0000-0000-000000000000',
            options.limit + 1,
          ],
        );
        rows = result.rows;
      } else {
        rows = state.compact
          .filter(
            (row) =>
              !after ||
              row.revision > Number(after[0]) ||
              (row.revision === after[0] && row.view_order > Number(after[1])),
          )
          .sort((a, b) => a.revision - b.revision || a.view_order - b.view_order)
          .slice(0, options.limit + 1)
          .map((row) => ({
            ...row,
            verdict: options.context === GLOBAL_CONTEXT ? 'accept' : null,
            head: options.context === GLOBAL_CONTEXT ? 1 : null,
          }));
      }
      const window = rows.slice(0, options.limit);
      const hidden = new Set<string>();
      if (window.length) {
        const concealed = await client.query<{ candidate_id: string }>(
          `SELECT candidate_id::text FROM semantic.hidden_candidate
           WHERE route = $1 AND subject_id = $2 AND candidate_id = ANY($3::uuid[])`,
          [routeOf(options.subject), options.subject, window.map((row) => row.candidate_id)],
        );
        for (const row of concealed.rows) hidden.add(row.candidate_id);
      }
      // Hidden rows leave this page short. next stays set until the candidate sequence ends.
      const shown = window.filter((row) => !hidden.has(row.candidate_id));
      const releases = new Map<string, Release>();
      for (const row of shown) {
        if (releases.has(row.release)) continue;
        const release = await readRelease(client, row.release);
        if (!release) throw new Error('Candidate release is missing');
        releases.set(row.release, release);
      }
      const view = await slotView(client, options.subject, options.property, options.context, defaults);
      const ranks = new Map(
        view.facts.map((fact) => [
          fact.statement_id!,
          (fact.body as { rank?: 'normal' | 'preferred' | 'deprecated' }).rank ?? null,
        ]),
      );
      const candidates = [];
      for (const row of shown) {
        const provenance = await client.query<{
          source: Source | null;
          retracted: number | null;
          retraction: { source: Source; references: BatchReference[] } | null;
        }>(
          `SELECT p.source, latest.revision AS retracted,
             CASE WHEN latest.revision IS NULL THEN NULL ELSE
               jsonb_build_object('source', latest.source, 'references', latest."references") END AS retraction
           FROM semantic.revision p LEFT JOIN LATERAL (
             SELECT t.revision, r.source, t."references" FROM semantic.retraction t JOIN semantic.revision r
               ON r.route = t.route AND r.subject_id = t.subject_id AND r.revision = t.revision
             WHERE t.route = p.route AND t.subject_id = p.subject_id AND t.candidate_id = $4
             ORDER BY t.revision DESC LIMIT 1
           ) latest ON true
           WHERE p.route = $1 AND p.subject_id = $2 AND p.revision = $3`,
          [routeOf(options.subject), options.subject, row.revision, row.candidate_id],
        );
        const fact = candidateFact(options.property, row);
        const dataTypes = factDataTypes(releases.get(row.release)!, [fact]);
        const statement = resolveItem(options.subject, [fact], '', dataTypes, {
          revision: row.revision,
          release: row.release,
          context: options.context,
        }).statements[options.property]![0]!;
        candidates.push({
          ...provenance.rows[0]!,
          id: row.candidate_id,
          statement,
          release: row.release,
          revision: row.revision,
          decision:
            row.verdict === 'accept' ? ('accepted' as const) : row.verdict === 'reject' ? ('rejected' as const) : null,
          head: row.head,
          rank: ranks.get(row.candidate_id) ?? null,
        });
      }
      const last = window.at(-1);
      return {
        value: {
          candidates,
          adoption: state.adoption ? { mode: state.adoption.mode, head: state.adoption.head } : null,
        },
        after: rows.length > options.limit && last ? [last.revision, last.view_order, last.candidate_id] : null,
      };
    },
  );
}
