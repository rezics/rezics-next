import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { runCommand, type CommandAuthorization } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccountActor } from '../request/access.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding, type CursorKey } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { GLOBAL_CONTEXT, readRelease } from './definitions.ts';
import { itemFacts, resolveItem, SubjectInputError, type Violation } from './item.ts';
import { PageCursorError } from './page.ts';
import { checkTyped } from './rules.ts';
import { candidateFact, expandSlot, resolveSlot, slotId, type Candidate } from './slots.ts';
import readTypes from './read-item-types.sql';

export class SubjectNotFoundError extends Error {}
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
  const escaped = property.replaceAll('~', '~0').replaceAll('/', '~1');
  const prefix = `/statements/${escaped}/0`;
  const remap = (violation: Violation): Violation => ({
    ...violation,
    pointer:
      violation.pointer === `/statements/${escaped}`
        ? '/statement/property/id'
        : violation.pointer.replace(prefix, '/statement'),
  });
  const input = { type, labels: { en: 'Validation' }, statements: { [property]: [raw] } };
  const typed = checkTyped(release.release, release.digest, input);
  const violations = typed.violations.map(remap);
  if (!record(raw) || !Array.isArray(raw.references) || !raw.references.length)
    violations.push({ pointer: '/statement/references', code: 'required' });
  let facts: ReturnType<typeof itemFacts> = [];
  try {
    facts = itemFacts(subject, input, type);
  } catch (error) {
    if (!(error instanceof SubjectInputError)) throw error;
    violations.push(...error.violations.map(remap));
  }
  if (violations.length) throw new SubjectInputError(violations);
  return {
    property,
    fact: facts.find((fact) => fact.kind === 'statement')!,
    items: typed.items.map((item) => ({
      ...item,
      pointer: item.pointer.replace(prefix, '/statement'),
    })),
  };
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
      const subject = await tx.query<{ type: string; revision: number }>(
        `SELECT s.type, latest.revision FROM semantic.subject s
       JOIN LATERAL (SELECT revision FROM semantic.revision WHERE route = s.route AND subject_id = s.subject_id
         ORDER BY revision DESC LIMIT 1) latest ON true
       WHERE s.route = $1 AND s.subject_id = $2`,
        [route, options.subject],
      );
      if (!subject.rows[0]) throw new SubjectNotFoundError();
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
        item.targets.includes(types.get(item.id) ?? '')
          ? []
          : [{ pointer: item.pointer, code: 'out_of_range' as const }],
      );
      if (errors.length) throw new SubjectInputError(errors);
      const revision = subject.rows[0].revision + 1;
      const candidate = derivedId(CANDIDATE_NS, `${options.subject}\n${revision}`, route);
      try {
        await expandSlot(tx, options.subject, input.property, transactionId);
        await tx.query(
          `INSERT INTO semantic.revision (route, subject_id, revision, kind, release, recorded_transaction_id)
         VALUES ($1, $2, $3, 'propose', $4, $5)`,
          [route, options.subject, revision, options.release.digest, transactionId],
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
      const subject = await client.query('SELECT 1 FROM semantic.subject WHERE route = $1 AND subject_id = $2', [
        route,
        options.subject,
      ]);
      if (!partition || !subject.rowCount || !(await options.authorize(client))) throw new SubjectNotFoundError();
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
      const result = await client.query<{ revision: number; kind: string; release: string }>(
        `SELECT revision, kind, release FROM semantic.revision WHERE route = $1 AND subject_id = $2
         AND revision < $3 ORDER BY revision DESC LIMIT $4`,
        [routeOf(options.subject), options.subject, after?.[0] ?? 2147483647, options.limit + 1],
      );
      const revisions = result.rows.slice(0, options.limit);
      return { value: { revisions }, after: result.rows.length > options.limit ? [revisions.at(-1)!.revision] : null };
    },
  );
}

export function listCandidates(
  pool: Pool,
  ring: KeyRing,
  options: PageOptions & { property: string; context: string },
) {
  if (options.context !== GLOBAL_CONTEXT) throw new SubjectNotFoundError();
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
      const state = await resolveSlot(client, options.subject, options.property);
      type Decided = Candidate & { verdict: 'accept' | 'reject' | 'abstain' | null; head: number | null };
      let rows: Decided[];
      if (state.expanded) {
        const result = await client.query<Decided>(
          `SELECT c.*, a.verdict, a.head FROM (
           SELECT * FROM semantic.candidate WHERE route = $1 AND subject_id = $2 AND slot_id = $3
             AND (revision, view_order, candidate_id) > ($5, $6, $7::uuid)
           ORDER BY revision, view_order, candidate_id LIMIT $8
         ) c LEFT JOIN LATERAL (
           SELECT verdict, head FROM semantic.acceptance
           WHERE route = c.route AND subject_id = c.subject_id AND context_id = $4 AND candidate_id = c.candidate_id
           ORDER BY head DESC LIMIT 1
         ) a ON true ORDER BY c.revision, c.view_order, c.candidate_id`,
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
          .map((row) => ({ ...row, verdict: 'accept', head: 1 }));
      }
      const shown = rows.slice(0, options.limit);
      const releases = new Map<string, Release>();
      for (const row of shown) {
        if (releases.has(row.release)) continue;
        const release = await readRelease(client, row.release);
        if (!release) throw new Error('Candidate release is missing');
        releases.set(row.release, release);
      }
      const ranks = new Map(
        state.adoption?.mode === 'replace'
          ? state.adoption.selection.map((entry) => [entry.candidate, entry.rank])
          : [],
      );
      const candidates = shown.map((row) => {
        const dataTypes = Object.fromEntries(
          Object.entries(releases.get(row.release)!.properties).map(([id, property]) => [id, property.datatype]),
        );
        const statement = resolveItem(options.subject, [candidateFact(options.property, row)], '', dataTypes, {
          revision: row.revision,
          release: row.release,
          context: options.context,
        }).statements[options.property]![0]!;
        return {
          id: row.candidate_id,
          statement,
          release: row.release,
          revision: row.revision,
          decision:
            row.verdict === 'accept' ? ('accepted' as const) : row.verdict === 'reject' ? ('rejected' as const) : null,
          head: row.head,
          rank: ranks.get(row.candidate_id) ?? null,
        };
      });
      const last = shown.at(-1);
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
