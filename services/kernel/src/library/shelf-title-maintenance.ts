import { cleanupShelfTitleKeys } from './shelf-title-maintenance-store.ts';
import type { Pool, PoolClient } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
import { ProblemError } from '../http/problem.ts';
import { withConnection } from '../database/pool.ts';
import { newId, routeOf } from '../route/route.ts';
import { createLibraryCommandRunner, requireRoute } from './command-support.ts';
import { shelfTitleKey } from './shelf-title-key.ts';
import {
  currentShelfTitleBasis,
  shelfTitlePolicy,
  titleLanguages,
  type ShelfTitleLabels,
  type ShelfTitleSource,
} from './shelf-title-source.ts';
import { ShelfReadUnavailableError } from './shelf-reader-unavailable.ts';
import type { ShelfOwner } from './shelf-maintenance-ops-contract.ts';

type Client = Pick<PoolClient, 'query'>;
type Head = {
  generation: string;
  population: string;
  policy: string;
  source_basis: string;
  phase: 'cleanup' | 'build' | 'ready';
  after_subject_id: string | null;
};
type Candidate = {
  subject_id: string;
  incarnation_id: string | null;
  transaction_id: string;
  state: string;
  type_id: string | null;
};
export type ShelfTitlePreparation = { installation: 'pending' | 'installed'; prepared: number };
const pending: ShelfTitlePreparation = { installation: 'pending', prepared: 0 };

async function readHead(client: Client, owner: ShelfOwner, lock = false) {
  const { rows } = await client.query<Head>(
    `SELECT generation,population::text,policy,source_basis,phase,after_subject_id
     FROM library.shelf_title_head WHERE route=$1 AND account_id=$2::uuid${lock ? ' FOR UPDATE' : ''}`,
    [owner.route, owner.accountId],
  );
  return rows[0] ?? null;
}

async function readCandidates(client: Client, owner: ShelfOwner, after: string | null) {
  return (
    await client.query<Candidate>(
      `SELECT subject_id,incarnation_id,transaction_id,state,type_id FROM library.entry
     WHERE route=$1 AND account_id=$2::uuid${after === null ? '' : ' AND subject_id>$3::uuid'}
     ORDER BY subject_id LIMIT 101`,
      [owner.route, owner.accountId, ...(after === null ? [] : [after])],
    )
  ).rows;
}

/** Exact batched coverage is required; absence of identity must never become an invented missing title. */
export function shelfTitleObservations(ids: readonly string[], entries: readonly ShelfTitleLabels[]) {
  const observations = new Map(entries.map((row) => [row.subjectId, row]));
  if (
    ids.length > 100 ||
    new Set(ids).size !== ids.length ||
    observations.size !== entries.length ||
    observations.size !== ids.length ||
    ids.some((id) => !observations.has(id))
  )
    throw new ShelfReadUnavailableError('complete disclosed title batch');
  for (const row of entries)
    if (
      typeof row.sourceBasis !== 'string' ||
      !row.sourceBasis ||
      row.sourceBasis.length > 256 ||
      routeOf(row.sourceId) === null
    )
      throw new ShelfReadUnavailableError('current title source reference');
  return observations;
}

/**
 * A bounded read-only derivative command using existing Entry-list authority and the retained owner runner.
 * Source observations finish in ownAccountPrepared before the owner gate/transaction is acquired. Retries
 * repeat preparation; receipt replay remains the original effect. No title data enters a command operand.
 */
export function createShelfTitlePreparation(deps: {
  pool: Pool;
  access: Access;
  clock?: KernelClock;
  titleSource?: ShelfTitleSource;
}) {
  const runner = createLibraryCommandRunner(deps);
  return async (actor: Actor, key: string, rawLanguages: readonly string[]): Promise<ShelfTitlePreparation> => {
    if (actor.kind !== 'account' || !actor.scopes.includes('library_entry:list')) throw new ProblemError('forbidden');
    const languages = titleLanguages(rawLanguages);
    const policy = shelfTitlePolicy(languages);
    const owner = { route: requireRoute(actor.accountId), accountId: actor.accountId };
    const result = await runner.ownAccountPrepared(
      actor,
      {
        action: 'library_entry:list',
        kind: 'library.shelf.title.prepare',
        requestKey: key,
        input: { policy },
        async prepare() {
          // Unavailable evidence is deferred until the fresh body, preserving exact receipt replay.
          try {
            const basis = await currentShelfTitleBasis(deps.titleSource, owner, languages, actor);
            // currentShelfTitleBasis reports the missing producer before any native candidate work.
            if (!deps.titleSource) throw new ShelfReadUnavailableError('Content shelfTitleInputs.observe installation');
            const head = await withConnection(deps.pool, (client) => readHead(client, owner));
            const candidates =
              head?.phase === 'build' && head.policy === policy && head.source_basis === basis
                ? await withConnection(deps.pool, (client) => readCandidates(client, owner, head.after_subject_id))
                : [];
            const selected = candidates.slice(0, 100);
            const labels = selected.length
              ? await deps.titleSource.labels(
                  owner,
                  languages,
                  basis,
                  selected.map((row) => row.subject_id),
                  actor,
                )
              : { status: 'current' as const, entries: [] };
            if (labels.status !== 'current')
              throw new ShelfReadUnavailableError(
                'Content exact disclosed title batch under the captured source basis',
              );
            const observations = shelfTitleObservations(
              selected.map((row) => row.subject_id),
              labels.entries,
            );
            const rows = selected.map((entry) => {
              const source = observations.get(entry.subject_id)!;
              const title = shelfTitleKey(source.labels, languages, source.originalLanguage);
              return {
                ...entry,
                source_id: source.sourceId,
                source_basis: source.sourceBasis,
                missing: title.coverage === 'missing',
                key: Buffer.from(title.bytes ?? []),
              };
            });
            // The whole source basis, including disclosure/ownership, is checked after the batched reads.
            if (basis !== (await currentShelfTitleBasis(deps.titleSource, owner, languages, actor)))
              throw new ShelfReadUnavailableError('Content unchanged whole-source basis after the exact title batch');
            return { basis, head, rows, more: candidates.length > 100 };
          } catch (error) {
            return { error };
          }
        },
      },
      async (tx, _command, input) => {
        if (!input) throw new ShelfReadUnavailableError('complete current Content title/disclosure source');
        if ('error' in input) throw input.error;
        await tx.query(
          `INSERT INTO library.shelf_title_owner(route,account_id) VALUES($1,$2::uuid) ON CONFLICT DO NOTHING`,
          [owner.route, owner.accountId],
        );
        const { rows: owners } = await tx.query<{ population: string }>(
          `SELECT population::text FROM library.shelf_title_owner WHERE route=$1 AND account_id=$2::uuid FOR UPDATE`,
          [owner.route, owner.accountId],
        );
        const population = owners[0]!.population;
        const head = await readHead(tx, owner, true);
        const same = head?.policy === policy && head.source_basis === input.basis && head.population === population;
        if (!head || !same) {
          await tx.query(
            `INSERT INTO library.shelf_title_head(route,account_id,generation,population,policy,source_basis,phase)
             VALUES($1,$2::uuid,$3::uuid,$4::bigint,$5,$6,'cleanup')
             ON CONFLICT(route,account_id) DO UPDATE SET generation=EXCLUDED.generation,
               population=EXCLUDED.population,policy=EXCLUDED.policy,source_basis=EXCLUDED.source_basis,
               phase='cleanup',after_subject_id=NULL`,
            [owner.route, owner.accountId, newId(owner.route), population, policy, input.basis],
          );
          return { value: pending, events: [] };
        }
        if (head.phase === 'ready') return { value: { installation: 'installed' as const, prepared: 0 }, events: [] };
        if (head.phase === 'cleanup') {
          const removed = await cleanupShelfTitleKeys(tx, owner);
          if (removed < 100)
            await tx.query(`UPDATE library.shelf_title_head SET phase='build' WHERE route=$1 AND account_id=$2::uuid`, [
              owner.route,
              owner.accountId,
            ]);
          return { value: pending, events: [] };
        }
        // A concurrent page, population edit or replacement build cannot advance this captured frontier.
        if (JSON.stringify(head) !== JSON.stringify(input.head)) return { value: pending, events: [] };
        if (input.rows.some((row) => row.incarnation_id === null || row.type_id === null))
          throw new ShelfReadUnavailableError('complete native Entry incarnation and type maintenance');
        // Exactly the bounded captured Entry versions must remain at this frontier; no per-Subject reads.
        const current = await readCandidates(tx, owner, head.after_subject_id);
        if (
          JSON.stringify(current.slice(0, 100)) !==
            JSON.stringify(
              input.rows.map(
                ({ source_id: _source, source_basis: _basis, missing: _missing, key: _key, ...entry }) => entry,
              ),
            ) ||
          current.length > 100 !== input.more
        )
          return { value: pending, events: [] };
        if (input.rows.length)
          await tx.query(
            `INSERT INTO library.shelf_title_key(route,account_id,subject_id,generation,incarnation_id,
             transaction_id,state,type_id,source_id,source_basis,missing,key)
           SELECT $1,$2::uuid,v.subject_id,$3::uuid,v.incarnation_id,v.transaction_id,v.state,v.type_id,
             v.source_id,v.source_basis,v.missing,decode(v.key,'hex')
           FROM jsonb_to_recordset($4::jsonb) AS v(subject_id uuid,incarnation_id uuid,transaction_id uuid,
             state text,type_id uuid,source_id uuid,source_basis text,missing boolean,key text)`,
            [
              owner.route,
              owner.accountId,
              head.generation,
              JSON.stringify(input.rows.map((row) => ({ ...row, key: row.key.toString('hex') }))),
            ],
          );
        await tx.query(
          `UPDATE library.shelf_title_head SET after_subject_id=$3::uuid,phase=$4
           WHERE route=$1 AND account_id=$2::uuid`,
          [
            owner.route,
            owner.accountId,
            input.rows.at(-1)?.subject_id ?? head.after_subject_id,
            input.more ? 'build' : 'ready',
          ],
        );
        return {
          value: {
            installation: input.more ? ('pending' as const) : ('installed' as const),
            prepared: input.rows.length,
          },
          events: [],
        };
      },
    );
    return result.value;
  };
}
