import type { Pool } from 'pg';
import { readAccount, deadlineClient, within } from './access-port.ts';
import type { KernelClock } from '../clock.ts';
import type { CommandResult } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import { AuthenticationError } from '../request/authentication-error.ts';
import type { Access, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { createLibraryCommandRunner } from './command-support.ts';
import {
  HOSTED_READING_CHANGED_EVENT,
  type HostedReadingAddress,
  type HostedReadingClearInput,
  type HostedReadingClearResult,
  type HostedReadingPort,
  type HostedReadingSaveInput,
  type HostedReadingSaveResult,
  type HostedReadingView,
} from './contract/hosted-reading.ts';
import {
  addressFromRow,
  hostedReadingUuid,
  type HostedReadingRow,
  validateHostedReadingClear,
  validateHostedReadingSave,
} from './hosted-reading-validate.ts';
export {
  addressFromRow,
  hostedReadingPositionFromRow,
  parseHostedReadingPosition,
  validateHostedReadingClear,
  validateHostedReadingSave,
  type HostedReadingRow,
} from './hosted-reading-validate.ts';
import readCheckpoint from './hosted-reading-read.sql';
import insertCheckpoint from './hosted-reading-insert.sql';
import updateCheckpoint from './hosted-reading-update.sql';
import deleteCheckpoint from './hosted-reading-delete.sql';
import exportPage from './hosted-reading-export.sql';

export type HostedReadingDependencies = {
  pool: Pool;
  access?: Access;
  clock?: KernelClock;
  content: HostedReadingPort;
};

function requireOwner(actor: Actor, action: string): asserts actor is Actor & { kind: 'account' } {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  const route = routeOf(actor.accountId);
  if (route === null || !actor.scopes.includes(action)) throw new ProblemError('forbidden');
}

async function authorizeOwner(
  client: { query: Pool['query'] },
  route: number,
  actor: Actor & { kind: 'account' },
): Promise<void> {
  const owner = await readAccount(client, route, actor.accountId);
  if (
    !owner ||
    owner.kind !== 'actor' ||
    owner.state !== 'active' ||
    owner.fenced ||
    !Number.isSafeInteger(actor.authnEpoch) ||
    actor.authnEpoch < 1 ||
    owner.minimumAuthnEpoch > BigInt(actor.authnEpoch)
  )
    throw new ProblemError('forbidden');
}

function storedAddress(row: HostedReadingRow): HostedReadingAddress {
  return addressFromRow(row);
}

export function createHostedReadingReads(dependencies: HostedReadingDependencies) {
  return {
    async get(actor: Actor, subjectId: string, deadline: number, signal?: AbortSignal): Promise<HostedReadingView> {
      if (!hostedReadingUuid(subjectId)) throw new ProblemError('invalid_request');
      requireOwner(actor, 'progress_session:list');
      const route = routeOf(actor.accountId)!;
      const alive = () => {
        if (signal?.aborted || Date.now() >= deadline) throw new ProblemError('deadline_exceeded');
      };
      alive();
      const stored = await within(deadline, () =>
        withConnection(dependencies.pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          let committed = false;
          try {
            await client.query('BEGIN');
            await client.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE', [
              route,
              actor.accountId,
            ]);
            await authorizeOwner(client, route, actor);
            alive();
            const row = await readCheckpoint.run(client, {
              route,
              account_id: actor.accountId,
              subject_id: subjectId,
            });
            await authorizeOwner(client, route, actor);
            await client.query('COMMIT');
            committed = true;
            const found = Array.isArray(row) ? row[0] : row;
            return found ? (found as HostedReadingRow) : null;
          } catch (error) {
            if (!committed) await connection.query('ROLLBACK');
            throw error;
          }
        }),
      );
      if (!stored) return { state: 'none' as const, subjectId };
      const address = storedAddress(stored);
      const resume = await dependencies.content.resolveExact(actor, address, deadline);
      alive();
      await within(deadline, () =>
        withConnection(dependencies.pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          let committed = false;
          try {
            await client.query('BEGIN');
            await authorizeOwner(client, route, actor);
            await client.query('COMMIT');
            committed = true;
          } catch (error) {
            if (!committed) await connection.query('ROLLBACK');
            throw error;
          }
        }),
      );
      return {
        state: 'saved' as const,
        subjectId,
        revision: stored.revision,
        address,
        resume,
      };
    },
  };
}

type StoredWrite = HostedReadingRow;

function writeParams(route: number, accountId: string, input: HostedReadingSaveInput, address: HostedReadingAddress) {
  return {
    route,
    account_id: accountId,
    subject_id: input.subjectId,
    catalogue_id: address.catalogueId,
    publication_revision_id: address.publicationRevisionId,
    occurrence_id: address.occurrenceId,
    target_revision_id: address.targetRevisionId,
    target_sha256: address.targetSha256,
    document_block_id: address.documentPosition?.blockId ?? null,
    document_offset: address.documentPosition?.offset ?? null,
  };
}

export function createHostedReadingCommands(dependencies: HostedReadingDependencies) {
  const runner = createLibraryCommandRunner(dependencies);
  return {
    async save(actor: Actor, input: HostedReadingSaveInput, requestKey: string, deadline: number) {
      const value = validateHostedReadingSave(input);
      requireOwner(actor, 'progress_session:update');
      const route = routeOf(actor.accountId)!;
      return runner.ownAccountPrepared(
        actor,
        {
          action: 'progress_session:update',
          kind: 'library.hosted_reading.save',
          requestKey,
          input: value,
          deadline,
          async prepare() {
            const validated = await dependencies.content.validateSelection(actor, value, deadline);
            if (!validated.ok) {
              if (validated.reason === 'not_found') throw new ProblemError('not_found');
              if (validated.reason === 'unavailable') throw new ProblemError('not_found');
              throw new ProblemError('invalid_request');
            }
            if (
              validated.address.catalogueId !== value.catalogueId ||
              validated.address.publicationRevisionId !== value.publicationRevisionId ||
              validated.address.occurrenceId !== value.occurrenceId ||
              validated.address.targetRevisionId !== value.targetRevisionId ||
              validated.address.targetSha256 !== value.targetSha256
            )
              throw new ProblemError('invalid_request');
            return validated.address;
          },
        },
        async (tx, _context, address): Promise<CommandResult<HostedReadingSaveResult>> => {
          const params = writeParams(route, actor.accountId, value, address);
          const written =
            value.expectedRevision === null
              ? await insertCheckpoint.run(tx, params)
              : await updateCheckpoint.run(tx, { ...params, expected_revision: value.expectedRevision });
          const row = (Array.isArray(written) ? written[0] : written) as StoredWrite | undefined;
          if (!row) throw new ProblemError('conflict');
          return {
            value: { subjectId: value.subjectId, revision: row.revision, address: storedAddress(row) },
            events: [
              {
                type: HOSTED_READING_CHANGED_EVENT,
                subject: actor.accountId,
                data: { subjectId: value.subjectId, revision: row.revision },
              },
            ],
          };
        },
      );
    },
    async clear(actor: Actor, input: HostedReadingClearInput, requestKey: string) {
      const value = validateHostedReadingClear(input);
      requireOwner(actor, 'progress_session:update');
      const route = routeOf(actor.accountId)!;
      return runner.ownAccount(
        actor,
        {
          action: 'progress_session:update',
          kind: 'library.hosted_reading.clear',
          requestKey,
          input: value,
        },
        async (tx): Promise<CommandResult<HostedReadingClearResult>> => {
          const removed = await deleteCheckpoint.run(tx, {
            route,
            account_id: actor.accountId,
            subject_id: value.subjectId,
            expected_revision: value.expectedRevision,
          });
          const row = Array.isArray(removed) ? removed[0] : removed;
          if (!row) throw new ProblemError('conflict');
          return {
            value: { subjectId: value.subjectId, cleared: true },
            events: [
              {
                type: HOSTED_READING_CHANGED_EVENT,
                subject: actor.accountId,
                data: { subjectId: value.subjectId, revision: value.expectedRevision },
              },
            ],
          };
        },
      );
    },
  };
}

export async function readHostedReadingExportPage(
  client: { query: Pool['query'] },
  route: number,
  accountId: string,
  afterId: string,
  limit: number,
) {
  return exportPage.run(client, {
    route,
    account_id: accountId,
    after_id: afterId,
    limit,
  });
}
