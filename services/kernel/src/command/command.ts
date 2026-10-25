import type { Pool, PoolClient } from 'pg';
import fenceStatement from './fence.sql';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';

export type CommandEvent = { type: string; subject?: string; data: unknown };
export type CommandTransaction = Pick<PoolClient, 'query'>;
type CommandResult<T> = { value: T; events: CommandEvent[] };

export class CommandUnavailableError extends Error {
  readonly reason: 'fenced' | 'moved' | 'contention' | 'deadline' | 'overloaded';
  readonly partition: number;
  readonly movedTo: string | null;
  constructor(reason: CommandUnavailableError['reason'], partition: number, movedTo: string | null = null) {
    super(`Command unavailable for partition ${partition}: ${reason}${movedTo ? ` (${movedTo})` : ''}`);
    this.name = 'CommandUnavailableError';
    this.reason = reason;
    this.partition = partition;
    this.movedTo = movedTo;
  }
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}
function remaining(deadline: number): number {
  return Math.max(1, Math.floor(deadline - Date.now()));
}
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function jitter(): Promise<void> {
  return pause(5 + Math.floor(Math.random() * 16));
}

export async function runCommand<T>(
  pool: Pool,
  options: { partition: number; deadline?: number },
  body: (tx: CommandTransaction) => Promise<CommandResult<T>>,
): Promise<{ value: T; partition: number; epoch: number; position: bigint }> {
  const { partition } = options;
  if (!Number.isInteger(partition) || partition < 0 || partition > 4095) throw new RangeError('Invalid partition');
  const deadline = options.deadline ?? Date.now() + 2000;
  let contentionAttempts = 0;
  while (Date.now() < deadline) {
    try {
      const result = await withConnection(pool, async (client) => {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        try {
          await client.query("SET LOCAL lock_timeout = '200ms'");
          await client.query(`SET LOCAL statement_timeout = '${remaining(deadline)}ms'`);
          const response = await body(client);
          if (response.events.length === 0) throw new TypeError('A command must emit at least one event');
          const events = response.events.map((event) => ({ ...event, id: Bun.randomUUIDv7() }));
          await client.query(`SET LOCAL statement_timeout = '${remaining(deadline)}ms'`);
          const row = await fenceStatement.run(client, { partition_no: partition, events });
          if (row.length === 0) {
            try {
              await client.query('ROLLBACK');
            } catch (rollbackError) {
              discardConnection(client, rollbackError as Error);
              throw rollbackError;
            }
            const state = await readPartition(client, partition);
            if (state?.writeState === 'moved') throw new CommandUnavailableError('moved', partition, state.movedTo);
            if (state?.writeState === 'fenced') {
              return null;
            }
            throw new CommandUnavailableError('deadline', partition);
          }
          await client.query('COMMIT');
          return { value: response.value, partition, epoch: row[0]!.epoch, position: BigInt(row[0]!.position) };
        } catch (error) {
          if (codeOf(error) === '57014') {
            try {
              await client.query('ROLLBACK');
            } catch (rollbackError) {
              discardConnection(client, rollbackError as Error);
            }
            throw new CommandUnavailableError('deadline', partition);
          }
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(client, rollbackError as Error);
            throw rollbackError;
          }
          throw error;
        }
      });
      if (result) return result;
      if (Date.now() + 25 >= deadline) throw new CommandUnavailableError('fenced', partition);
      await pause(25);
    } catch (error) {
      if (error instanceof CommandUnavailableError) throw error;
      if (codeOf(error) === '57014' || Date.now() >= deadline) throw new CommandUnavailableError('deadline', partition);
      if (
        codeOf(error) === '53300' ||
        (error instanceof Error && /timeout exceeded when trying to connect/i.test(error.message))
      )
        throw new CommandUnavailableError('overloaded', partition);
      if (['40001', '40P01', '55P03'].includes(codeOf(error) ?? '')) {
        contentionAttempts++;
        if (contentionAttempts >= 3) throw new CommandUnavailableError('contention', partition);
        await jitter();
        continue;
      }
      throw error;
    }
  }
  throw new CommandUnavailableError('deadline', partition);
}
