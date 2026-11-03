import type { PoolClient } from 'pg';
import { stepOwnerChronology } from './owner-index-continue.ts';
import { hasLiveOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { routeOf } from '../route/route.ts';
import { decodeLibraryProfilePin } from './profile-pin.ts';
import type { LibraryProfilePin } from './profile.ts';
import type { CanonicalRawKey } from './canonical-source-store.ts';
import nativeFacts from './collection-source-native-facts.sql';
import labelOriginals from './owner-index-native-label-originals.sql';

type Client = Pick<PoolClient, 'query'>;
export type OwnerNativeFactDriver = 'entry' | 'label' | 'session' | 'copy';

/** Independent native ranges for retained canonical preparation, including state Sources.
 * These are actual fact keys, never positive Source witnesses. The maintenance caller reserves work before
 * dispatch and checks its actual owner/source fence and captured scoped observation before publication.
 * Unlike a state Source's entry range, exhausting ALL four drivers closes independent original support.
 */
export async function readOwnerNativeFactPage(
  client: Client,
  accountId: string,
  driver: OwnerNativeFactDriver,
  after: CanonicalRawKey | null,
  limit: number,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Owner fact limit must be 1..100');
  if (!['entry', 'label', 'session', 'copy'].includes(driver)) throw new TypeError('Invalid owner fact driver');
  if (after && (after.driver !== driver || routeOf(after.storedSubjectId) === null || routeOf(after.factId) === null))
    throw new TypeError('Invalid owner fact continuation');
  const input = {
    route: key(accountId)[0],
    account_id: accountId,
    driver,
    after_subject: after?.storedSubjectId ?? null,
    after_fact: after?.factId ?? null,
    limit,
  };
  // The native assignment PK includes legacy/unreserved and retained excluded originals too. Its label
  // key is structural coverage only; the filter later reads current full-key label truth independently.
  const rows = driver === 'label' ? await labelOriginals.run(client, input) : await nativeFacts.run(client, input);
  const keys = rows.map(({ storedSubjectId, factId }): CanonicalRawKey => {
    if (storedSubjectId === null || factId === null || routeOf(storedSubjectId) === null || routeOf(factId) === null)
      throw new TypeError('Invalid native owner fact key');
    return { driver, storedSubjectId, factId };
  });
  return { rows: keys.map((key) => ({ key })), after: keys.at(-1) ?? after, exhausted: keys.length < limit };
}
export type OwnerIndexPhase = 'entry' | 'session' | 'copy' | 'label' | 'ready';
export type OwnerIndexFrontier = Readonly<{ phase: OwnerIndexPhase; subject: string | null; fact: string | null }>;
type Control = { phase: OwnerIndexPhase; subject: string | null; fact: string | null };
type Scope = { subject: string; fact: string; pin: unknown };
const phases = ['entry', 'session', 'copy', 'label', 'ready'] as const;
const sources = {
  entry: ['library.entry', 'subject_id', "COALESCE(library_profile_pin, '{}'::jsonb)"],
  session: ['library.progress_session', 'session_id', "COALESCE(library_profile_pin, '{}'::jsonb)"],
  copy: ['library.copy', 'copy_id', "COALESCE(library_profile_pin, '{}'::jsonb)"],
  label: ['library.label_assignment', 'label_id', "'{}'::jsonb"],
} as const;
function key(accountId: string): [number, string] {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid owner index account');
  return [route, accountId];
}

/** Pure native reads: absent control is unbuilt, never an empty/ready owner. */
export async function readOwnerIndexFrontier(client: Client, accountId: string): Promise<OwnerIndexFrontier | null> {
  const { rows } = await client.query<Control>(
    `SELECT phase, after_subject AS subject, after_fact AS fact
    FROM library.owner_index_control WHERE route=$1 AND account_id=$2`,
    key(accountId),
  );
  return rows[0] ?? null;
}

/** At most 100 examined native facts. The caller supplies the real fenced Core operational transaction. */
export async function stepOwnerIndex(tx: OperationalTransaction, accountId: string): Promise<OwnerIndexFrontier> {
  if (!hasLiveOperationalTransaction(tx)) throw new TypeError('Owner index needs a live operational transaction');
  const args = key(accountId);
  await tx.query(
    `INSERT INTO library.fact_source_head(route,account_id,generation) VALUES($1,$2,1)
    ON CONFLICT DO NOTHING`,
    args,
  );
  await tx.query('SELECT 1 FROM library.fact_source_head WHERE route=$1 AND account_id=$2 FOR UPDATE', args);
  await tx.query(
    'INSERT INTO library.owner_index_control(route,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
    args,
  );
  const current = (await readOwnerIndexFrontier(tx, accountId))!;
  // Parent transitions invalidate the source head immediately. Indexed child repair catches up in raw100 steps.
  const repair = (
    await tx.query<{ label: string; after: string | null }>(
      `SELECT label_id AS label,
    after_subject AS after FROM library.owner_index_label_repair WHERE route=$1 AND account_id=$2
    ORDER BY label_id LIMIT 1 FOR UPDATE`,
      args,
    )
  ).rows[0];
  if (repair) {
    const children = (
      await tx.query<{ subject: string }>(
        `SELECT subject_id AS subject
      FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND label_id=$3
      AND ($4::uuid IS NULL OR subject_id>$4) ORDER BY subject_id LIMIT 100`,
        [...args, repair.label, repair.after],
      )
    ).rows;
    for (const child of children)
      await tx.query("SELECT library.refresh_owner_member_scope($1,$2,$3,'label','{}'::jsonb)", [
        ...args,
        child.subject,
      ]);
    if (children.length === 100)
      await tx.query(
        `UPDATE library.owner_index_label_repair SET after_subject=$4
      WHERE route=$1 AND account_id=$2 AND label_id=$3`,
        [...args, repair.label, children.at(-1)!.subject],
      );
    else
      await tx.query(
        `DELETE FROM library.owner_index_label_repair
      WHERE route=$1 AND account_id=$2 AND label_id=$3`,
        [...args, repair.label],
      );
    return current;
  }
  if (current.phase === 'ready') {
    await stepOwnerChronology(tx, accountId);
    return current;
  }
  const [table, id, pin] = sources[current.phase];
  // Only fixed native table/column literals above are interpolated; inputs remain parameters.
  const { rows } = await tx.query<Scope>(
    `SELECT subject_id AS subject, ${id} AS fact, ${pin} AS pin FROM ${table}
    WHERE route=$1 AND account_id=$2${current.phase === 'session' ? " AND state <> 'retired'" : ''} AND ($3::uuid IS NULL OR (subject_id,${id})>($3,$4::uuid))
    ORDER BY subject_id,${id} LIMIT 100`,
    [...args, current.subject, current.fact],
  );
  for (const row of rows)
    await tx.query('SELECT library.refresh_owner_member_scope($1,$2,$3,$4,$5::jsonb)', [
      ...args,
      row.subject,
      current.phase,
      JSON.stringify(row.pin),
    ]);
  const last = rows.at(-1);
  const next =
    rows.length === 100 && last
      ? { phase: current.phase, subject: last.subject, fact: last.fact }
      : { phase: phases[phases.indexOf(current.phase) + 1]!, subject: null, fact: null };
  await tx.query(
    `UPDATE library.owner_index_control SET phase=$3,after_subject=$4,after_fact=$5
    WHERE route=$1 AND account_id=$2`,
    [...args, next.phase, next.subject, next.fact],
  );
  return next;
}

/** One structural ORIGINAL seek; this is not canonical membership, disclosure or a useful public page. */
export async function readOwnerOriginalPrefix(client: Client, accountId: string, after: string | null, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Owner prefix limit must be 1..100');
  const { rows } = await client.query<{ subjectId: string }>(
    `SELECT subject_id AS "subjectId"
    FROM library.owner_member_index WHERE route=$1 AND account_id=$2
    AND ($3::uuid IS NULL OR subject_id>$3) ORDER BY subject_id LIMIT $4`,
    [...key(accountId), after, limit],
  );
  return rows.map((row) => row.subjectId);
}

/** Native independent supports. Label parent liveness is checked even if directory cleanup is delayed. */
export async function readOwnerOriginalTruth(client: Client, accountId: string, original: string) {
  const { rows } = await client.query<{
    entry: boolean;
    label: boolean;
    labelUnready: boolean;
    session: boolean;
    copy: boolean;
    state: string | null;
    sequence: string | null;
    pin: unknown;
  }>(
    `SELECT EXISTS(SELECT 1 FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3) AS entry,
    EXISTS(SELECT 1 FROM library.label_assignment x WHERE x.route=$1 AND x.account_id=$2 AND x.subject_id=$3
      AND x.deleted_at IS NULL AND x.slot_no IS NOT NULL AND x.assignment_id IS NOT NULL AND EXISTS(SELECT 1 FROM library.personal_label l
        WHERE l.route=$1 AND l.account_id=$2 AND l.label_id=x.label_id AND l.deleted_at IS NULL)) AS label,
    EXISTS(SELECT 1 FROM library.label_assignment x WHERE x.route=$1 AND x.account_id=$2 AND x.subject_id=$3
      AND x.deleted_at IS NULL AND (x.slot_no IS NULL OR x.assignment_id IS NULL)) AS "labelUnready",
    EXISTS(SELECT 1 FROM library.progress_session WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND state <> 'retired') AS session,
    EXISTS(SELECT 1 FROM library.copy WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND deletion_id IS NULL) AS copy,
    e.state, e.owner_write_seq::text AS sequence, e.library_profile_pin AS pin
    FROM (VALUES(1)) anchor(n) LEFT JOIN library.entry e ON e.route=$1 AND e.account_id=$2 AND e.subject_id=$3`,
    [...key(accountId), original],
  );
  const row = rows[0]!;
  return {
    original,
    presence: row.entry || row.label || row.session || row.copy || (row.labelUnready ? null : false),
    families: {
      entry: row.entry,
      label: row.label || (row.labelUnready ? null : false),
      session: row.session,
      copy: row.copy,
    },
    state:
      row.state === null
        ? null
        : {
            id: row.state,
            sequence: row.sequence === null ? null : BigInt(row.sequence),
            pin: decodeLibraryProfilePin(row.pin),
          },
  };
}
export type OwnerOriginalTruth = Awaited<ReturnType<typeof readOwnerOriginalTruth>>;

/** Chronology is independent of source, type, UUID, time and presentation digest. Preserve all live conflicts. */
export function currentOwnerState(
  originals: readonly OwnerOriginalTruth[],
):
  | { status: 'unready'; reason: 'unsequenced' | 'unpinned' }
  | { status: 'complete'; state: { original: string; id: string; sequence: bigint; pin: LibraryProfilePin } | null } {
  type Result = ReturnType<typeof currentOwnerState>;
  return originals.reduce<Result>(
    (result, original) => {
      if (result.status === 'unready') return result;
      const state = original.state;
      if (!state) return result;
      if (state.sequence === null) return { status: 'unready', reason: 'unsequenced' };
      if (state.pin === null) return { status: 'unready', reason: 'unpinned' };
      const winner = result.state;
      if (winner && winner.sequence === state.sequence) throw new Error('Duplicate live owner state-write sequence');
      if (winner && winner.sequence > state.sequence) return result;
      return {
        status: 'complete',
        state: { original: original.original, id: state.id, sequence: state.sequence, pin: state.pin },
      };
    },
    { status: 'complete', state: null },
  );
}
