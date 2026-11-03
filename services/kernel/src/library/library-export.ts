import type { Pool } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { readAccount } from '../access/account-data.ts';
import { admitGroup } from '../access/gates/admission.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import { authoritativeTimeValue, commandTime, principalCommandIdentity } from '../command/command.ts';
import { runOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCommandAuthorization, AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import { createLibraryCommandRunner } from './command-support.ts';
import { exportSections, initialExportSeek, readExportSourcePage, type ExportSeek } from './library-export-source.ts';

export type LibraryExportDependencies = {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  workClient: WorkClient | (() => Promise<WorkClient>);
  clock?: KernelClock;
};
type State = 'collecting' | 'ready' | 'stale' | 'cancelled' | 'expired' | 'limit';
type Capture = {
  export_id: string;
  generation: string;
  created_at: string;
  expires_at: string;
  state: State;
};
const ACTIONS = [
  'library_entry:list',
  'library_entry:read',
  'copy:list',
  'progress_session:list',
  'progress_session:read',
  'collection:read',
] as const;
const groups = [
  ['personal_library', 'library_entry:list'],
  ['reading_progress', 'progress_session:list'],
  ['collections', 'collection:read'],
] as const;
export const exportAuthorityTypes = Object.keys(bundledRelease.types);

function owner(actor: Actor) {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (routeOf(actor.accountId) === null || ACTIONS.some((action) => !actor.scopes.includes(action)))
    throw new ProblemError('forbidden');
  return actor;
}
function binding(accountId: string, capture: Capture) {
  return {
    operation: 'library_export.page',
    parameters: {
      accountId,
      exportId: capture.export_id,
      generation: capture.generation,
    },
  };
}
function cursor(deps: LibraryExportDependencies, accountId: string, capture: Capture, seek: ExportSeek) {
  return encodeCursor(
    deps.tokens,
    binding(accountId, capture),
    {
      epoch: 1,
      after: [seek.section, seek.parent, seek.after, seek.rows, seek.bytes],
    },
    Date.parse(capture.created_at),
  );
}
function seekOf(
  deps: LibraryExportDependencies,
  accountId: string,
  capture: Capture,
  token: string,
  now: number,
): ExportSeek {
  const result = decodeCursor(deps.tokens, binding(accountId, capture), token, now);
  if (!result.ok) throw new ProblemError('invalid_cursor');
  const [section, parent, after, rows, bytes] = result.after;
  if (
    result.epoch !== 1 ||
    result.after.length !== 5 ||
    typeof section !== 'number' ||
    section < 0 ||
    section >= exportSections.length ||
    typeof parent !== 'string' ||
    typeof after !== 'string' ||
    typeof rows !== 'number' ||
    rows < 0 ||
    typeof bytes !== 'number' ||
    bytes < 0
  )
    throw new ProblemError('invalid_cursor');
  return { section, parent, after, rows, bytes };
}
function manifest(capture: Capture) {
  return {
    format: 'https://rezics.com/formats/library-export' as const,
    version: 1 as const,
    exportId: capture.export_id,
    capturedAt: capture.created_at,
    expiresAt: capture.expires_at,
    privacy: 'private' as const,
    completeness: 'supported-native-facts' as const,
    sections: [...exportSections],
    omissions: {
      trash: 'excluded; current live facts and retained session history only',
      providerIdentifiers: 'unavailable in the native owner Library store; no identifiers inferred',
      personalImportEvidence: 'unavailable; no installed native personal import evidence store',
      commerce: 'excluded; orders and financial evidence use Commerce retention/export policy',
      publication: 'excluded; stored rules only, no dynamic evaluation or working publication output',
      reimport: 'unavailable; this format does not promise an installed re-import endpoint',
    },
  };
}
function status(deps: LibraryExportDependencies, accountId: string, capture: Capture) {
  return {
    ...manifest(capture),
    state: capture.state,
    fullExport: false as const,
    first:
      capture.state === 'collecting' || capture.state === 'ready'
        ? cursor(deps, accountId, capture, initialExportSeek())
        : null,
  };
}

/** No private artifact is retained: signed keysets replay only against the original unchanged source. */
export function createLibraryExport(deps: LibraryExportDependencies) {
  const clock = deps.clock ?? systemClock;
  async function admit(actor: Actor) {
    const account = owner(actor);
    for (const [group, clientAction] of groups)
      await admitGroup({
        pool: deps.pool,
        access: () => deps.access,
        actor,
        group,
        clientAction,
        deadline: deadlineFor(5000),
        clock,
      });
    return account;
  }
  async function generation(tx: Pick<OperationalTransaction, 'query'>, route: number, accountId: string) {
    await tx.query(
      `INSERT INTO library.native_source_fence(route,kind,owner_id,generation,account_id)
      VALUES($1,'account',$2,0,$2) ON CONFLICT DO NOTHING`,
      [route, accountId],
    );
    // All current native personal producers fence this key; the added Collection hooks close that family too.
    return (
      await tx.query<{ generation: string }>(
        `SELECT generation::text FROM library.native_source_fence
      WHERE route=$1 AND kind='account' AND owner_id=$2 FOR SHARE`,
        [route, accountId],
      )
    ).rows[0]!.generation;
  }
  async function operation<T>(
    actor: Actor,
    signal: AbortSignal | undefined,
    body: (tx: OperationalTransaction, route: number, accountId: string, now: number) => Promise<T>,
  ): Promise<T> {
    const account = await admit(actor);
    const route = routeOf(account.accountId)!;
    const authorization = await accessCommandAuthorization(
      deps.access,
      account,
      'library_entry:list',
      { route, id: account.accountId },
      { pool: deps.pool, deadline: deadlineFor(5000) },
      () => new ProblemError('forbidden'),
    );
    try {
      return await runOperationalTransaction(
        deps.pool,
        {
          mode: 'request',
          ...principalCommandIdentity(account),
          partition: partitionOf(route),
          kind: 'library.export',
          accounts: [account.accountId],
          workClient: typeof deps.workClient === 'function' ? await deps.workClient() : deps.workClient,
          authorization,
          clock,
          deadline: deadlineFor(5000),
        },
        async (tx) => {
          signal?.throwIfAborted();
          const current = await readAccount(tx, route, account.accountId);
          if (
            !current ||
            current.kind !== 'actor' ||
            current.state !== 'active' ||
            current.fenced ||
            !Number.isSafeInteger(account.authnEpoch) ||
            account.authnEpoch < 1 ||
            current.minimumAuthnEpoch > BigInt(account.authnEpoch)
          )
            throw new ProblemError('forbidden');
          const time = commandTime(tx);
          if (!time) throw new ProblemError('dependency_unavailable');
          const result = await body(tx, route, account.accountId, Date.parse(authoritativeTimeValue(time)));
          signal?.throwIfAborted();
          return result;
        },
      );
    } catch (error) {
      if (error instanceof LifecycleDeniedError) throw new ProblemError('forbidden');
      throw error;
    }
  }
  async function current(tx: OperationalTransaction, route: number, accountId: string, id: string, now: number) {
    const capture = (
      await tx.query<Capture>(
        `SELECT export_id,generation::text,created_at::text,expires_at::text,state
      FROM library.library_export WHERE route=$1 AND account_id=$2 AND export_id=$3 FOR UPDATE`,
        [route, accountId, id],
      )
    ).rows[0];
    if (!capture) throw new ProblemError('not_found');
    const source = await generation(tx, route, accountId);
    const state =
      now >= Date.parse(capture.expires_at)
        ? 'expired'
        : (capture.state === 'collecting' || capture.state === 'ready') && source !== capture.generation
          ? 'stale'
          : capture.state;
    if (state !== capture.state) {
      await tx.query(`UPDATE library.library_export SET state=$3 WHERE route=$1 AND account_id=$2`, [
        route,
        accountId,
        state,
      ]);
      capture.state = state;
    }
    return capture;
  }
  return {
    async create(actor: Actor, requestKey: string, signal?: AbortSignal) {
      const account = await admit(actor);
      const route = routeOf(account.accountId)!;
      // The native command receipt preserves original request identity across expiry, cancellation and replacement.
      const result = await createLibraryCommandRunner(deps).ownAccount(
        account,
        {
          action: 'library_entry:list',
          kind: 'library.export.capture',
          requestKey,
          input: {},
        },
        async (tx, command) => {
          signal?.throwIfAborted();
          const old = (
            await tx.query<{ state: State; expired: boolean }>(
              `SELECT state,expires_at<=$3::timestamptz AS expired
          FROM library.library_export WHERE route=$1 AND account_id=$2 FOR UPDATE`,
              [route, account.accountId, new Date(authoritativeTimeValue(command.time)).toISOString()],
            )
          ).rows[0];
          if (old && !old.expired && (old.state === 'collecting' || old.state === 'ready'))
            throw new ProblemError('conflict');
          const id = derivedId(account.accountId, `library-export:${requestKey}`, route);
          const source = await generation(tx, route, account.accountId);
          const at = new Date(authoritativeTimeValue(command.time)).toISOString();
          await tx.query(
            `INSERT INTO library.library_export(route,account_id,export_id,generation,created_at,expires_at,state)
          VALUES($1,$2,$3,$4,$5,$5::timestamptz+interval '15 minutes','collecting')
          ON CONFLICT(route,account_id) DO UPDATE SET export_id=EXCLUDED.export_id,generation=EXCLUDED.generation,
            created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at,state='collecting'`,
            [route, account.accountId, id, source, at],
          );
          signal?.throwIfAborted();
          return {
            value: { id },
            events: [
              {
                type: 'com.rezics.library.export.requested.v1',
                subject: account.accountId,
                data: { exportId: id },
              },
            ],
          };
        },
      );
      return this.get(actor, result.value.id, signal);
    },
    async get(actor: Actor, id: string, signal?: AbortSignal) {
      return operation(actor, signal, async (tx, route, accountId, now) =>
        status(deps, accountId, await current(tx, route, accountId, id, now)),
      );
    },
    async page(actor: Actor, id: string, token: string, signal?: AbortSignal) {
      return operation(actor, signal, async (tx, route, accountId, now) => {
        const capture = await current(tx, route, accountId, id, now);
        if (capture.state !== 'collecting' && capture.state !== 'ready')
          return {
            exportId: id,
            state: capture.state,
            records: [],
            next: null,
            manifest: null,
          };
        const seek = seekOf(deps, accountId, capture, token, now);
        const page = await readExportSourcePage(tx, route, accountId, seek);
        if (page.oversized || page.seek.rows > 100_000 || page.seek.bytes > 32 * 1024 * 1024) {
          await tx.query(`UPDATE library.library_export SET state='limit' WHERE route=$1 AND account_id=$2`, [
            route,
            accountId,
          ]);
          return {
            exportId: id,
            state: 'limit' as const,
            records: [],
            next: null,
            manifest: null,
          };
        }
        if (page.done && capture.state !== 'ready')
          await tx.query(`UPDATE library.library_export SET state='ready' WHERE route=$1 AND account_id=$2`, [
            route,
            accountId,
          ]);
        return {
          exportId: id,
          state: page.done ? ('ready' as const) : ('collecting' as const),
          records: page.records,
          next: page.done ? null : cursor(deps, accountId, capture, page.seek),
          manifest: page.done
            ? {
                ...manifest(capture),
                fullExport: false as const,
                rows: page.seek.rows,
                recordBytes: page.seek.bytes,
              }
            : null,
        };
      });
    },
    async cancel(actor: Actor, id: string, signal?: AbortSignal) {
      return operation(actor, signal, async (tx, route, accountId, now) => {
        const capture = await current(tx, route, accountId, id, now);
        if (capture.state !== 'expired') {
          await tx.query(`UPDATE library.library_export SET state='cancelled' WHERE route=$1 AND account_id=$2`, [
            route,
            accountId,
          ]);
          capture.state = 'cancelled';
        }
        return status(deps, accountId, capture);
      });
    },
  };
}
