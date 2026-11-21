import type { Pool, PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { nativeSourceQuery } from '../database/native-source-query.ts';
import moveFrontier from './public-filter-held-subject-advance.sql';
import { withBoundedCommandConnection } from '../database/pool.ts';
import { CommandUnavailableError } from '../access/unavailable.ts';
import type { PublicFilterConsumer } from './public-filter-source-contract.ts';
import { reserveHeldSubjectBootstrap } from './public-filter-source-binding.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { HeldSubjectOriginal } from './public-filter-held-subject-originals.ts';
import {
  publicFilterCreationAction,
  readPublicFilterCreationEvents,
  type PublicFilterCreationWindow,
} from './public-filter-creation-window.ts';

type Context = Readonly<{ deadline: number }>;
type Member = Readonly<{ job: string; bootstrap: string; birth: string }>;
type Page = Member & Readonly<{ firstHome: number; endHome: number; ordinal: number }>;
type Inventory = {
  partition: number;
  epoch: number;
  receipt: string;
  commandHead: string;
  originals: HeldSubjectOriginal[];
  complete: boolean;
};
type Envelope = Awaited<ReturnType<typeof readPublicFilterCreationEvents>>['envelopes'][number];
type Window = Omit<PublicFilterCreationWindow, 'base' | 'through' | 'position'> &
  Readonly<{ base: string; through: string; position: string }>;
type Cursor =
  | { phase: 'inventory'; partition: number; after: HeldSubjectOriginal | null }
  | { phase: 'window' }
  | { phase: 'events'; windows: readonly Window[] };
type Obligation = { partition: number; epoch: number; position: string; ids: readonly string[] };
type Step = {
  ordinal: number;
  phase: Cursor['phase'];
  complete: boolean;
  obligations: Obligation[];
  evidence: { inventory?: Inventory[]; windows?: Window[]; envelopes?: readonly Envelope[]; window?: Window };
  next: Cursor | null;
};
type Cut = {
  home: number;
  epoch: number;
  generation: string;
  command: string;
  privacy: string;
  account: string;
  claim: string;
  enqueue: string;
  receipt: string;
};

function pending(home: number): never {
  throw new CommandUnavailableError('contention', home);
}

async function transaction<T>(pool: Pool, context: Context, body: (db: PoolClient) => Promise<T>) {
  return withBoundedCommandConnection(pool, context.deadline, async (db) => {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const result = await body(db);
    await db.query('COMMIT');
    return result;
  });
}

/** Explicit producer admission on the original native job. The Search scheduler
 * keeps its ordinary protocol until the remaining owners qualify admission.
 */
export async function openHeldSubjectPreparation(pool: Pool, input: Omit<Member, 'birth'>, context: Context) {
  return transaction(pool, context, (db) => reserveHeldSubjectPreparation(db, input));
}

export async function reserveHeldSubjectPreparation(db: PoolClient, input: Omit<Member, 'birth'>) {
  const { job, bootstrap } = input;
  const { rows } = await db.query<{ birth: string; consumer: PublicFilterConsumer }>(
    `WITH locked AS MATERIALIZED (
         SELECT j.job,j.consumer FROM search.generation_publication j WHERE (j.partition_no,j.job)=(0,$1)
           AND pg_try_advisory_xact_lock(hashtextextended(j.prefix||'subjects',2))
       )
       SELECT core.open_subject_subscription_v1(job,$2)::text AS birth,consumer FROM locked`,
    [job, bootstrap],
  );
  const birth = rows[0]?.birth;
  if (!birth) return pending(0);
  await reserveHeldSubjectBootstrap(db, { birth, bootstrap, consumer: rows[0]!.consumer });
  return birth;
}

function saveWindow(w: PublicFilterCreationWindow): Window {
  return { ...w, base: String(w.base), through: String(w.through), position: String(w.position) };
}
function loadWindow(w: Window): PublicFilterCreationWindow {
  return { ...w, base: BigInt(w.base), through: BigInt(w.through), position: BigInt(w.position) };
}

async function produce(
  db: PoolClient,
  page: Page,
  cursor: Cursor,
  cuts: readonly Cut[],
  context: Context,
  received: boolean,
): Promise<Step> {
  const { ordinal, bootstrap, birth, firstHome, endHome } = page;
  const evidence: Step['evidence'] = {};
  const obligations: Obligation[] = [];
  let next: Cursor | null = null;
  // Capture already validated every owner in this repeatable-read transaction.
  // Read only its finite command heads and the page's one ordered original-key range.
  const heads =
    cursor.phase === 'events'
      ? []
      : (
          await db.query<{ home: number; head: string }>(
            `SELECT p.home,p.head FROM generate_series($1::integer,$2::integer-1) i
     CROSS JOIN LATERAL (SELECT partition_no AS home,position::text AS head FROM core.partition
       WHERE partition_no=i LIMIT 1) p ORDER BY p.home`,
            [firstHome, endHome],
          )
        ).rows;
  if (cursor.phase !== 'events' && (heads.length !== cuts.length || heads.some((h, i) => h.home !== cuts[i]?.home)))
    return pending(firstHome);
  if (cursor.phase === 'inventory') {
    const { rows } = await db.query<HeldSubjectOriginal>(
      `SELECT s.route,s.subject_id::text AS id FROM semantic.subject s
       WHERE s.route >= $1 AND s.route < $2 AND (s.route,s.subject_id) ${cursor.after ? '>' : '>='} ($3::integer,$4::uuid)
       ORDER BY s.route,s.subject_id LIMIT 33`,
      [
        cursor.partition * 16,
        endHome * 16,
        cursor.after?.route ?? cursor.partition * 16,
        cursor.after?.id ?? '00000000-0000-0000-0000-000000000000',
      ],
    );
    const more = rows.length > 32;
    const originals = rows.slice(0, 32);
    const last = originals.at(-1);
    const lastHome = more && last ? partitionOf(last.route) : endHome - 1;
    const inventory: Inventory[] = [];
    for (const cut of cuts.slice(cursor.partition - firstHome, lastHome - firstHome + 1)) {
      const keys = originals.filter((k) => partitionOf(k.route) === cut.home);
      if (keys.some((k) => routeOf(k.id) !== k.route)) return pending(cut.home);
      const commandHead = heads[cut.home - firstHome]!.head;
      inventory.push({
        partition: cut.home,
        epoch: cut.epoch,
        receipt: cut.receipt,
        commandHead,
        originals: keys,
        complete: !more || cut.home < lastHome,
      });
      if (keys.length)
        obligations.push({ partition: cut.home, epoch: cut.epoch, position: commandHead, ids: keys.map((k) => k.id) });
    }
    evidence.inventory = inventory;
    next = more && last ? { phase: 'inventory', partition: lastHome, after: last } : { phase: 'window' };
  }
  // A fresh empty inventory has no outstanding writer. If every head is
  // still its retained base, this snapshot closes every command window too.
  const emptyAtCut =
    received &&
    cursor.phase === 'inventory' &&
    ordinal === 0 &&
    evidence.inventory?.length === cuts.length &&
    obligations.length === 0 &&
    cuts.every((cut, i) => cut.command === heads[i]!.head);
  if (cursor.phase === 'window' || emptyAtCut) {
    evidence.windows = cuts.map(({ home, epoch, receipt, command }, i) => ({
      partition: home,
      epoch,
      heldBirth: birth,
      receipt,
      base: command,
      through: heads[i]!.head,
      position: String(BigInt(command) + 1n),
      sequence: 0,
      eventCount: null,
    }));
    const windows = evidence.windows.filter((w) => w.base !== w.through);
    next = windows.length ? { phase: 'events', windows } : null;
  } else if (cursor.phase === 'events') {
    const [original, ...rest] = cursor.windows;
    if (!original) return pending(firstHome);
    const window = loadWindow(original);
    const meter = { rows: 0, inputKeys: 0, dependencyPoints: 0 };
    const range = await readPublicFilterCreationEvents(
      db,
      { bootstrap, window, accounts: false, inputLimit: 32, subjectRange: true },
      context,
      meter,
    );
    evidence.window = original;
    evidence.envelopes = range.envelopes;
    for (const row of range.envelopes) {
      if (!publicFilterCreationAction(row.type, false)) continue;
      const route = row.subject === null ? null : routeOf(row.subject);
      if (row.subject === null || route === null || partitionOf(route) !== window.partition)
        return pending(window.partition);
      const prior = obligations.at(-1);
      if (prior?.ids[0] === row.subject) prior.position = row.position;
      else
        obligations.push({
          partition: window.partition,
          epoch: window.epoch,
          position: row.position,
          ids: [row.subject],
        });
    }
    if (range.next.position <= window.through) rest.unshift(saveWindow(range.next));
    if (rest.length) next = { phase: 'events', windows: rest };
  }
  return { ordinal, phase: cursor.phase, complete: next === null, obligations, evidence, next };
}

async function reopenStep(db: PoolClient, page: Page, step: Step, context: Context) {
  if (step.evidence.window) {
    const window = loadWindow(step.evidence.window);
    const result = await readPublicFilterCreationEvents(
      db,
      {
        bootstrap: page.bootstrap,
        window,
        accounts: false,
        inputLimit: 32,
        subjectRange: true,
      },
      context,
      { rows: 0, inputKeys: 0, dependencyPoints: 0 },
    );
    if (!isDeepStrictEqual(result.envelopes, step.evidence.envelopes)) return pending(window.partition);
  } else {
    // A later create behind the saved key cursor belongs to the bridge.
    // Reopen only the original keys and finite ends; a newer inventory is a different observation.
    const originals = step.evidence.inventory?.flatMap((home) => home.originals) ?? [];
    const heads =
      step.evidence.inventory?.map((home) => ({ partition: home.partition, position: home.commandHead })) ??
      step.evidence.windows?.map((w) => ({ partition: w.partition, position: w.through }));
    if (!heads) return pending(page.firstHome);
    const result = await db.query<{ keys: number; homes: number }>(
      `SELECT (SELECT count(*)::integer FROM jsonb_to_recordset($1) k(route integer,id uuid)
        CROSS JOIN LATERAL (SELECT FROM semantic.subject WHERE (route,subject_id)=(k.route,k.id) LIMIT 1) original) AS keys,
        (SELECT count(*)::integer FROM jsonb_to_recordset($2) h(partition integer,position bigint)
        CROSS JOIN LATERAL (SELECT FROM core.partition WHERE partition_no=h.partition AND position>=h.position LIMIT 1) p) AS homes`,
      [JSON.stringify(originals), JSON.stringify(heads)],
    );
    if (result.rows[0]?.keys !== originals.length || result.rows[0]?.homes !== heads.length)
      return pending(page.firstHome);
  }
  return step;
}

/** Each result is addressed by the original membership, interval and ordinal.
 * No caller-provided key cursor, end position or event count can advance it.
 */
export async function advanceHeldSubjectPage(pool: Pool, input: Page, context: Context): Promise<Step> {
  const page = validatedPage(input);
  return transaction(pool, context, (db) => readOrSaveStep(db, page, context));
}

function validatedPage(input: Page) {
  const page = { ...input };
  const { firstHome, endHome, ordinal } = page;
  if (
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal > 2147483647 ||
    !Number.isInteger(firstHome) ||
    !Number.isInteger(endHome) ||
    firstHome < 0 ||
    endHome > 4096 ||
    endHome <= firstHome ||
    endHome - firstHome > 32
  )
    throw new TypeError('Invalid held Subject page');
  return page;
}

async function readOrSaveStep(db: PoolClient, page: Page, context: Context): Promise<Step> {
  const { job, bootstrap, birth, firstHome, endHome, ordinal } = page;
  const { rows } = await db.query<{ cuts: Cut[] }>(
    acceptReceiver
      ? // The acceptance trigger reopens these exact committed Core and Access
        // cuts under the membership and owner locks in our inventory snapshot.
        `WITH accepted AS MATERIALIZED (
           SELECT semantic.accept_subject_receiver_page_v1(m.job) AS homes FROM core.subject_subscription_v1 m
           JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap,b.coverage_after)=(0,m.bootstrap,$4)
           WHERE (m.job,m.bootstrap,m.birth)=($1,$2,$3)
         ) SELECT p.cuts FROM accepted JOIN semantic.subject_access_page_v1 p
           ON (p.birth,p.first_home,p.end_home)=($3,$4,$5) AND accepted.homes=p.end_home-p.first_home`
      : `SELECT semantic.capture_subject_access_page_v1(m.birth,$4,$5) AS cuts FROM core.subject_subscription_v1 m
     JOIN semantic.subject_source_preparation_v1 s USING(birth)
     JOIN semantic.subject_access_page_v1 p ON (p.birth,p.first_home,p.end_home)=(m.birth,$4,$5)
     WHERE (m.job,m.bootstrap,m.birth)=($1,$2,$3) AND p.captured_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()`,
    [job, bootstrap, birth, firstHome, endHome],
  );
  const cuts = rows[0]?.cuts;
  if (!cuts || cuts.length !== endHome - firstHome) return pending(firstHome);
  const steps = await db.query<{ ordinal: number; evidence: Step }>(
    `SELECT ordinal,evidence FROM semantic.subject_source_step_v1
     WHERE birth=$1 AND first_home=$2 AND ordinal BETWEEN $3::integer-1 AND $3 ORDER BY ordinal DESC`,
    [birth, firstHome, ordinal],
  );
  const prior = steps.rows[0];
  if (prior?.ordinal === ordinal) return reopenStep(db, page, prior.evidence, context);
  const cursor: Cursor | null =
    ordinal === 0 ? { phase: 'inventory', partition: firstHome, after: null } : (prior?.evidence.next ?? null);
  if (!cursor) return pending(firstHome);
  const step = await produce(db, page, cursor, cuts, context, acceptReceiver);
  await db.query('INSERT INTO semantic.subject_source_step_v1 VALUES($1,$2,$3,$4)', [birth, firstHome, ordinal, step]);
  return step;
}

export type HeldSubjectFrontier = Member & { firstHome: number; endHome: number; ordinal: number };

/** Search retains its own lock throughout this call. The writer comparison
 * happens outside Source transactions. If the process dies before the CAS,
 * its successor gets the same immutable obligations.
 */
export async function reconcileHeldSubjectPage(
  pool: Pool,
  input: HeldSubjectFrontier,
  context: Context,
  settle: (obligation: Obligation) => Promise<void>,
  receiveCommittedCut?: () => Promise<number>,
) {
  const page = validatedPage(input);
  const captured =
    page.ordinal === 0 &&
    (await withBoundedCommandConnection(pool, context.deadline, (db) =>
      db.query(
        `SELECT semantic.capture_subject_access_page_v1(m.birth,$4,$5)
        FROM core.subject_subscription_v1 m JOIN semantic.subject_source_preparation_v1 s USING(birth)
        WHERE (m.job,m.bootstrap,m.birth)=($1,$2,$3) AND (s.next_home,s.next_ordinal)=($4,$6)
          AND NOT EXISTS (SELECT FROM semantic.subject_access_page_v1 p WHERE (p.birth,p.first_home)=(m.birth,$4))`,
        [page.job, page.bootstrap, page.birth, page.firstHome, page.endHome, page.ordinal],
      ),
    ));
  // The original cut must commit before the first key seek. A fresh turn can
  // save that inventory with its second page check. If it found writer work,
  // leave the original ordinal for the next funded comparison and recheck.
  const receive = captured && captured.rowCount === 1 && receiveCommittedCut;
  if (receive && (await receive()) !== page.endHome - page.firstHome) return pending(page.firstHome);
  const step = await transaction(pool, context, async (db) => {
    const original = await readOrSaveStep(db, page, context, !!receive);
    if (original.obligations.length === 0) await advanceFrontier(db, page, original, false);
    return original;
  });
  if (step.obligations.length === 0) return step;
  if (captured && captured.rowCount) return;
  for (const obligation of step.obligations) await settle(obligation);
  await withBoundedCommandConnection(pool, context.deadline, (db) => advanceFrontier(db, page, step, true));
  return step;
}

async function advanceFrontier(db: PoolClient, page: Page, step: Step, recheckAfterWriter: boolean) {
  const changed = await nativeSourceQuery(db, moveFrontier, {
    birth: page.birth,
    bootstrap: page.bootstrap,
    job: page.job,
    first_home: page.firstHome,
    end_home: page.endHome,
    ordinal: page.ordinal,
    next_home: step.complete ? page.endHome : page.firstHome,
    next_ordinal: step.complete ? 0 : page.ordinal + 1,
    after_writer: recheckAfterWriter,
  });
  if (changed.length !== 1) return pending(page.firstHome);
}
