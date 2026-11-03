import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { readAccount } from '../access/account-data.ts';
import { admitGroup } from '../access/gates/admission.ts';
import { authoritativeTimeValue, commandTime, noEffect, principalCommandIdentity } from '../command/command.ts';
import { runOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCommandAuthorization, type Access, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import type { WorkClient } from '../work/client.ts';
import { createLibraryCommandRunner } from './command-support.ts';
import { COPY_ARCHIVE_LIMITS, parseCopyArchive, type ArchivedHolding,
  type ArchiveSectionCoverage, type CopyArchiveManifest } from './copy-archive-format.ts';

export type CopyArchiveDependencies = {
  pool: Pool;
  access: Access;
  workClient: WorkClient | (() => Promise<WorkClient>);
  clock?: KernelClock;
};
export const copyArchiveAuthorityTypes = Object.keys(bundledRelease.types);
type Header = {
  upload_id: string;
  manifest: CopyArchiveManifest;
  coverage: ArchiveSectionCoverage[];
  holding_count: number;
  expires_at: string;
  cancelled: boolean;
  removing: boolean;
};
const missing = () => new ProblemError('not_found');

/** Private evidence only. This service has no native copy, entry or catalogue writer. */
export function createCopyArchive(deps: CopyArchiveDependencies) {
  const clock = deps.clock ?? systemClock;
  const runner = createLibraryCommandRunner(deps);
  function owner(actor: Actor) {
    if (actor.kind !== 'account') throw new ProblemError('authentication_required');
    if (routeOf(actor.accountId) === null || !actor.scopes.includes('copy:list')) throw new ProblemError('forbidden');
    return actor;
  }
  async function operation<T>(actor: Actor, signal: AbortSignal | undefined,
    body: (tx: OperationalTransaction, route: number, accountId: string, now: number) => Promise<T>) {
    const a = owner(actor), route = routeOf(a.accountId)!;
    await admitGroup({ pool: deps.pool, access: () => deps.access, actor, group: 'personal_library',
      clientAction: 'copy:list', deadline: deadlineFor(5000), clock });
    const authorization = await accessCommandAuthorization(deps.access, a, 'copy:list',
      { route, id: a.accountId }, { pool: deps.pool, deadline: deadlineFor(5000) }, () => new ProblemError('forbidden'));
    return runOperationalTransaction(deps.pool, {
      mode: 'request', ...principalCommandIdentity(a), partition: partitionOf(route), kind: 'library.copy-archive',
      accounts: [a.accountId], authorization, clock, deadline: deadlineFor(5000),
      workClient: typeof deps.workClient === 'function' ? await deps.workClient() : deps.workClient,
    }, async (tx) => {
      signal?.throwIfAborted();
      const current = await readAccount(tx, route, a.accountId);
      if (!current || current.kind !== 'actor' || current.state !== 'active' || current.fenced ||
        !Number.isSafeInteger(a.authnEpoch) || a.authnEpoch < 1 || current.minimumAuthnEpoch > BigInt(a.authnEpoch))
        throw new ProblemError('forbidden');
      const at = commandTime(tx);
      if (!at) throw new ProblemError('dependency_unavailable');
      const result = await body(tx, route, a.accountId, Date.parse(authoritativeTimeValue(at)));
      signal?.throwIfAborted();
      return result;
    });
  }
  async function header(tx: OperationalTransaction, route: number, account: string, id: string,
    now: number, allowExpired = false): Promise<Header> {
    if (routeOf(id) !== route) throw missing();
    const h = (await tx.query<Header>(`SELECT upload_id,manifest,coverage,holding_count,
      expires_at::text,cancelled,removing FROM library.copy_archive_upload
      WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE`, [route, account, id])).rows[0];
    if (!h || (!allowExpired && (h.removing || Date.parse(h.expires_at) <= now))) throw missing();
    return h;
  }
  async function upload(actor: Actor, bytes: Uint8Array, requestKey: string, signal?: AbortSignal) {
    // Admission and the terminal account barrier precede decoding, parsing and persistence.
    await operation(actor, signal, async () => undefined);
    const parsed = parseCopyArchive(bytes), a = owner(actor), route = routeOf(a.accountId)!;
    signal?.throwIfAborted();
    const outcome = await runner.ownAccount(actor, { action: 'copy:list', kind: 'library.copy-archive.upload',
      requestKey, input: { digest: createHash('sha256').update(bytes).digest('hex') } }, async (tx, command) => {
      signal?.throwIfAborted();
      const id = newId(route);
      const expiresAt = new Date(Date.parse(authoritativeTimeValue(command.time)) +
        COPY_ARCHIVE_LIMITS.lifetimeDays * 86_400_000).toISOString();
      // One retained upload is a keyed capacity bound, including cancelled and expired evidence.
      const inserted = await tx.query(`INSERT INTO library.copy_archive_upload
        (route,account_id,upload_id,manifest,coverage,holding_count,expires_at)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::timestamptz)
        ON CONFLICT (route,account_id) DO NOTHING RETURNING upload_id`,
        [route,a.accountId,id,JSON.stringify(parsed.manifest),JSON.stringify(parsed.coverage),parsed.holdings.length,expiresAt]);
      if (!inserted.rowCount) throw new ProblemError('conflict');
      await tx.query(`INSERT INTO library.copy_archive_row(route,account_id,upload_id,ordinal,evidence)
        SELECT $1,$2,$3,r.ordinal,r.evidence FROM jsonb_to_recordset($4::jsonb) AS r(ordinal integer,evidence jsonb)`,
        [route,a.accountId,id,JSON.stringify(parsed.holdings)]);
      signal?.throwIfAborted();
      // Original receipts contain no uploaded text, pins or historical row identities.
      return noEffect({ uploadId: id, holdings: parsed.holdings.length, expiresAt });
    });
    // A receipt never recreates evidence removed since the original upload.
    await operation(actor, signal, async (tx, r, account, now) => { await header(tx,r,account,outcome.value.uploadId,now); });
    return outcome;
  }
  async function page(actor: Actor, id: string, after = -1, signal?: AbortSignal) {
    if (!Number.isInteger(after) || after < -1 || after >= COPY_ARCHIVE_LIMITS.records) throw new ProblemError('invalid_request');
    return operation(actor, signal, async (tx, route, account, now) => {
      const h = await header(tx,route,account,id,now);
      const rows = (await tx.query<{ ordinal: number; evidence: ArchivedHolding }>(
        `SELECT ordinal,evidence FROM library.copy_archive_row
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal>$4 ORDER BY ordinal LIMIT 11`,
        [route,account,id,after])).rows;
      return { uploadId: id, state: h.cancelled ? 'cancelled' as const : 'inspecting' as const,
        expiresAt: h.expires_at, fullRestoration: false as const, effectsSupported: false as const,
        manifest: h.manifest, coverage: h.coverage, holdings: h.holding_count,
        rows: rows.slice(0,COPY_ARCHIVE_LIMITS.page).map((r) => ({ ...r, resolution: 'unresolved' as const,
          reason: 'Historical evidence requires current identity, profile and explicit copy review' })),
        next: rows.length > COPY_ARCHIVE_LIMITS.page ? rows[COPY_ARCHIVE_LIMITS.page - 1]!.ordinal : null };
    });
  }
  async function cancel(actor: Actor, id: string, signal?: AbortSignal) {
    return operation(actor,signal,async (tx,route,account,now) => {
      await header(tx,route,account,id,now);
      await tx.query('UPDATE library.copy_archive_upload SET cancelled=true WHERE route=$1 AND account_id=$2 AND upload_id=$3',
        [route,account,id]);
      return { uploadId: id, cancelled: true as const };
    });
  }
  async function remove(actor: Actor, id: string, signal?: AbortSignal) {
    return operation(actor,signal,async (tx,route,account,now) => {
      await header(tx,route,account,id,now,true);
      await tx.query(`UPDATE library.copy_archive_upload SET removing=true,cancelled=true
        WHERE route=$1 AND account_id=$2 AND upload_id=$3`,[route,account,id]);
      const removed = await removeCopyArchivePage(tx,route,account,id);
      return { uploadId: id, ...removed };
    });
  }
  return { upload, page, cancel, remove };
}

/** Caller holds the root lock and owns account/terminal admission. Never cascade an unbounded child set. */
export async function removeCopyArchivePage(tx: Pick<OperationalTransaction,'query'>,
  route: number, accountId: string, id: string) {
  const removed = await tx.query(`WITH keys AS MATERIALIZED (SELECT ordinal FROM library.copy_archive_row
    WHERE route=$1 AND account_id=$2 AND upload_id=$3 ORDER BY ordinal LIMIT 100)
    DELETE FROM library.copy_archive_row r USING keys k WHERE r.route=$1 AND r.account_id=$2
      AND r.upload_id=$3 AND r.ordinal=k.ordinal`,[route,accountId,id]);
  const root = await tx.query(`DELETE FROM library.copy_archive_upload u
    WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND NOT EXISTS
    (SELECT 1 FROM library.copy_archive_row r WHERE r.route=u.route AND r.account_id=u.account_id
      AND r.upload_id=u.upload_id ORDER BY ordinal LIMIT 1)`,[route,accountId,id]);
  return { removed: removed.rowCount ?? 0, complete: (root.rowCount ?? 0) > 0 };
}
