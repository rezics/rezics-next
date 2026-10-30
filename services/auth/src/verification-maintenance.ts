import { nativeProtocolClient, verificationAttribution } from './erasure-attribution.ts';
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import type { DBAdapter } from 'better-auth/adapters';
import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

type NativeDatabase = Extract<BetterAuthOptions['database'], { db: unknown }>['db'];
// Resolve the public adapter package owned by the installed Better Auth version.
// Better Auth 1.7.12 does not re-export its Kysely adapter from a subpath.
const { createKyselyAdapter, kyselyAdapter } = createRequire(import.meta.resolve('better-auth'))(
  '@better-auth/kysely-adapter',
) as {
  createKyselyAdapter(
    options: BetterAuthOptions,
  ): Promise<{ kysely: NativeDatabase | null; databaseType: string | null }>;
  kyselyAdapter(
    db: NativeDatabase,
    config: { type: 'postgres'; transaction: boolean },
  ): (options: BetterAuthOptions) => DBAdapter;
};

const expiryStatement = readFileSync(new URL('./verification-maintenance.sql', import.meta.url), 'utf8');

/** One invocation, one batch. The shared worker decides when to invoke again. */
export async function pruneExpiredVerifications(database: Pool): Promise<number> {
  const result = await database.query(expiryStatement);
  return result.rowCount ?? 0;
}

/**
 * Better Auth 1.7.12 exposes a single-field sortBy. Its supported plugin init
 * and Kysely adapter factories let us implement the native top-one request
 * with a secondary key, including inside the native consume transaction.
 * All token processing, hooks, deletion and replay gates stay in Better Auth.
 */
function verificationPlugin(alreadyInTransaction = false) {
  return {
    id: 'native-verification-seek',
    async init(context) {
      const { kysely, databaseType } = await createKyselyAdapter(context.options);
      if (!kysely || databaseType !== 'postgres') throw new Error('Native verification requires PostgreSQL');

      function adapterFor(db: NativeDatabase, inTransaction = false): DBAdapter {
        const adapter = kyselyAdapter(db, { type: 'postgres', transaction: !inTransaction })(context.options);
        const create = adapter.create;
        adapter.create = async <T extends Record<string, unknown>, R = T>(query: {
          model: string;
          data: Omit<T, 'id'>;
          select?: string[];
          forceAllowId?: boolean;
        }): Promise<R> => {
          const model = query.model;
          if (!['verification', 'oauthClientAssertion', 'oauthRefreshFamily'].includes(model))
            return create<T, R>(query);
          // The artifact and its typed ownership fields commit together even when
          // Better Auth calls create outside an explicit adapter transaction.
          if (!inTransaction)
            return db.transaction().execute((transaction) => adapterFor(transaction, true).create<T, R>(query));
          const result = await create<T, R>(query);
          const id = (result as unknown as { id: string }).id;
          if (model === 'verification') {
            const attribution = verificationAttribution(query.data);
            if (attribution) await db.updateTable('verification').set(attribution).where('id', '=', id).execute();
          } else if (model === 'oauthClientAssertion') {
            const client = nativeProtocolClient.getStore();
            if (!client) throw new Error('Auth assertion producer attribution missing');
            await db
              .updateTable('oauthClientAssertion')
              .set({ erasure_client_id: client })
              .where('id', '=', id)
              .execute();
          } else {
            const verification = await db
              .selectFrom('verification')
              .select(['erasure_account_id', 'erasure_human_id', 'erasure_operator_id'])
              .where('identifier', '=', id)
              .orderBy('createdAt', 'desc')
              .orderBy('id', 'desc')
              .limit(1)
              .executeTakeFirst();
            if (verification)
              await db.updateTable('oauthRefreshFamily').set(verification).where('id', '=', id).execute();
          }
          return result;
        };
        const findMany = adapter.findMany;
        adapter.findMany = async <T>(query: Parameters<DBAdapter['findMany']>[0]): Promise<T[]> => {
          const condition = query.where?.[0];
          if (
            query.model === 'verification' &&
            query.limit === 1 &&
            query.sortBy?.field === 'createdAt' &&
            query.sortBy.direction === 'desc' &&
            query.where?.length === 1 &&
            condition?.field === 'identifier' &&
            (!condition.operator || condition.operator === 'eq') &&
            typeof condition.value === 'string' &&
            !query.offset &&
            !query.select &&
            !query.join
          ) {
            return (await db
              .selectFrom('verification')
              .selectAll()
              .where('identifier', '=', condition.value)
              .orderBy('createdAt', 'desc')
              .orderBy('id', 'desc')
              .limit(1)
              .execute()) as T[];
          }
          return findMany<T>(query);
        };
        if (!inTransaction) {
          adapter.transaction = (callback) =>
            db.transaction().execute((transaction) => callback(adapterFor(transaction, true)));
        }
        return adapter;
      }

      return { context: { adapter: adapterFor(kysely, alreadyInTransaction) } };
    },
  } satisfies BetterAuthPlugin;
}

export const nativeVerificationPlugin = verificationPlugin();
export const nativeVerificationTransactionPlugin = verificationPlugin(true);
