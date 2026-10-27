import type { CommandEvent, CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import type { ModerationEventData } from './moderation-events.ts';
import type { ModerationValue } from './moderation.ts';
import lift from './lift-takedown.sql';

export type LiftTakedownInput = Readonly<{
  target: Readonly<{ kind: 'thread' | 'post'; id: string }>;
}>;
export type LiftTakedownContext = Readonly<{ events: CommandEvent[] }>;

/** Trusted composition inside the caller's authorized target-partition transaction.
 * The caller commits these events with its own command result; this port neither
 * opens a transaction nor supplies appeal authority. Retained index candidates
 * reappear through their existing current-visibility disclosure checks.
 */
export async function liftTakedown(
  client: CommandTransaction,
  input: LiftTakedownInput,
  context: LiftTakedownContext,
): Promise<ModerationValue | null> {
  const { kind, id } = input.target;
  const route = routeOf(id);
  if (route === null || (kind !== 'thread' && kind !== 'post')) throw new RangeError('Invalid lift takedown target');
  const parameters = { kind, route, id };
  const result = await client.query<(typeof lift)['~reylo']['element']>(
    lift.sql,
    lift.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  const row = result.rows[0];
  if (!row) return null;
  const securityRevision = row.security_revision;
  if (securityRevision === null) throw new Error('Restored target is missing its security revision');
  const data: ModerationEventData<'com.rezics.content.moderation.restored.v1'> = {
    targetKind: kind,
    targetId: id,
    securityRevision,
  };
  context.events.push({ type: 'com.rezics.content.moderation.restored.v1', subject: id, data });
  return { targetId: id, securityRevision };
}
