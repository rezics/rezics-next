import { t } from 'elysia';
import type { Static } from 'typebox';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import {
  controlRead,
  controlTransaction,
  ControlConflict,
  ControlInvalid,
  ControlStale,
} from '../access/topology-control.ts';
import { followPrincipal } from '../follows/authority.ts';
import { commandKey } from '../follows/store.ts';
import { digest } from '../recommendation/derived-generation.ts';
import { readId } from '../work/read-contract.ts';

export const watchKind = t.Union(
  ['thread', 'proposal', 'release', 'collection'].map((kind) => t.Literal(kind)),
);
export const watchLevel = t.Union(
  ['participating', 'all', 'ignore'].map((level) => t.Literal(level)),
);
export const watchTarget = t.Union([
  readId,
  t.String({ pattern: '^urn:rezics:proposal:[0-9a-f-]{36}$' }),
]);
const revision = t.String({ pattern: '^[1-9][0-9]{0,18}$' });
export const watchCommand = t.Object(
  {
    target: watchTarget,
    kind: watchKind,
    level: watchLevel,
    actingSubject: readId,
    expectedRevision: t.Nullable(revision),
  },
  { additionalProperties: false },
);
export const watchState = t.Object({
  target: watchTarget,
  kind: watchKind,
  level: watchLevel,
  reason: t.String(),
  revision,
});
export const watchReceipt = t.Object({ ...watchState.properties, replayed: t.Boolean() });
type WatchInput = Static<typeof watchCommand>;
export type Watch = Static<typeof watchState>;
/** One inventory slot, one CAS and one immutable replay record. Target authority
 * is always proved by the owner adapter, including read and hidden targets. */
export class WatchStore {
  constructor(private readonly pool: Pool) {}
  async read(principal: VerifiedPrincipal, agent: string, target: string, disclose: () => Promise<void>) {
    await controlRead(this.pool,client => followPrincipal(client,principal,agent));
    await disclose();
    return controlRead(this.pool, async (client) => {
      const owner = await followPrincipal(client, principal, agent);
      return (
        (
          await client.query<Watch>(
            'SELECT target,kind,level,reason,revision::text FROM access.watch WHERE principal_id=$1 AND target=$2',
            [owner, target],
          )
        ).rows[0] ?? null
      );
    });
  }
  async set(
    principal: VerifiedPrincipal,
    input: WatchInput,
    key: string,
    disclose: () => Promise<void>,
  ): Promise<Static<typeof watchReceipt>> {
    commandKey(key);
    const old = await controlRead(this.pool,async client => {
      const owner = await followPrincipal(client,principal,input.actingSubject);
      return (await client.query<{ request_digest: string; result: Static<typeof watchReceipt> }>(
        'SELECT request_digest,result FROM access.watch_receipt WHERE principal_id=$1 AND idempotency_key=$2',[owner,key])).rows[0];
    });
    if (old) {
      if (old.request_digest!==digest(input)) throw new ControlConflict('Key binds another Watch intent');
      return { ...old.result,replayed: true };
    }
    await disclose();
    return controlTransaction(this.pool, async (client) => {
      const owner = await followPrincipal(client, principal, input.actingSubject);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `watch:${owner}:${input.target}`,
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `watch-receipt:${owner}:${key}`,
      ]);
      const intent = digest(input);
      const receipt = (
        await client.query<{ request_digest: string; result: Static<typeof watchReceipt> }>(
          'SELECT request_digest,result FROM access.watch_receipt WHERE principal_id=$1 AND idempotency_key=$2',
          [owner, key],
        )
      ).rows[0];
      if (receipt) {
        if (receipt.request_digest !== intent)
          throw new ControlConflict('Key binds another Watch intent');
        return { ...receipt.result, replayed: true };
      }
      const current = (
        await client.query<Watch>(
          'SELECT target,kind,level,reason,revision::text FROM access.watch WHERE principal_id=$1 AND target=$2 FOR UPDATE',
          [owner, input.target],
        )
      ).rows[0];
      if ((current?.revision ?? null) !== input.expectedRevision)
        throw new ControlStale('Watch changed');
      if (current && current.kind !== input.kind) throw new ControlInvalid('Watch kind differs');
      if (!current && Number((await client.query<{ count: string }>(
        'SELECT count(*) FROM access.watch WHERE principal_id=$1',[owner])).rows[0]!.count)>=10000)
        throw new ControlInvalid('Watch budget exceeded');
      const next = current ? (BigInt(current.revision) + 1n).toString() : '1';
      const reason = current?.reason ?? 'manual';
      const proposal =
        input.kind === 'proposal' ? input.target.slice('urn:rezics:proposal:'.length) : null;
      if (current)
        await client.query(
          'UPDATE access.watch SET level=$3,revision=$4,manual_choice=true WHERE principal_id=$1 AND target=$2',
          [owner, input.target, input.level, next],
        );
      else if (
        !(
          await client.query(
            `INSERT INTO access.watch(principal_id,target,kind,proposal,level,reason,revision)
        VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT DO NOTHING RETURNING principal_id`,
            [owner, input.target, input.kind, proposal, input.level, reason],
          )
        ).rowCount
      )
        throw new ControlStale('Automatic Watch appeared');
      const result = {
        target: input.target,
        kind: input.kind,
        level: input.level,
        reason,
        revision: next,
        replayed: false,
      };
      await client.query(
        'INSERT INTO access.watch_receipt(principal_id,idempotency_key,request_digest,result) VALUES($1,$2,$3,$4)',
        [owner, key, intent, result],
      );
      return result;
    });
  }
}
export const WATCH_COST = { targetSlots: 1, receiptSlots: 1, recipients: 256,maximumWatching: 10000 } as const;
