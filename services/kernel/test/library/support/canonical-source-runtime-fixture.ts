import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { resourceAuthorization } from '../../../src/access/resource-authorization.ts';
import { principalCommandIdentity, runCommand, type CommandTransaction } from '../../../src/command/command.ts';
import { withConnection } from '../../../src/database/pool.ts';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import type { WorkAllowance } from '../../../src/library/contract/work-dimensions.ts';
import {
  bindLibraryDomain,
  composeLibraryDomain,
  peekLibraryDomain,
  unbindLibraryDomain,
} from '../../../src/composition/library.ts';
import { createProfileEntryFixture } from './profile-entry-fixture.ts';

export const sourceAllowance = (keys = 100): WorkAllowance => ({
  reservationId: randomUUID(),
  remaining: {
    candidateKeys: keys,
    identityMetadataRows: 0,
    nativeRows: 1000000,
    nativePoints: 10000,
    witnessKeys: 1000,
    statements: 1000,
    bytes: 16 * 1024 * 1024,
    emptySeeks: 100,
  },
});

/** Product setup uses actual Auth, Access, subject and Collection APIs. Observations are exact read-only points. */
export async function sourceRuntimeFixture() {
  const previousDomain = peekLibraryDomain();
  const native = await createProfileEntryFixture();
  const restoreDomain = () => {
    if (previousDomain) bindLibraryDomain(previousDomain);
    else unbindLibraryDomain();
  };
  try {
    // Dynamic owner rules require the same installed Library domain as production.
    composeLibraryDomain({ pool: native.pool, access: native.access });
    expect((await native.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
    expect((await native.send('steward', 'POST', '/v1/platform/exposure/personal_library:open')).status).toBe(200);
    expect((await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
    const owner = await native.identity([
      'subject:read',
      'collection:create',
      'collection:read',
      'collection:update',
      'collection:delete',
      'library_entry:read',
      'gate:personal_library',
      'library_entry:list',
      'progress_session:read',
      'progress_session:list',
      'copy:read',
      'copy:list',
    ]);
    await native.grantLibraryGate(owner.actor.accountId);
    async function collection(
      visibility: 'private' | 'public' | 'unlisted' = 'public',
      membershipKind: 'dynamic' | 'curated' = 'dynamic',
    ) {
      // Public dynamic creation starts its whole-query publication immediately. These tests exercise
      // explicit output allocation against an empty public source, so promote a private dynamic source
      // through the normal metadata command after creation instead of racing that initial worker.
      const createdVisibility = membershipKind === 'dynamic' && visibility !== 'private' ? 'private' : visibility;
      const response = await native.send(owner.bearer, 'POST', '/v1/collections', {
        title: 'Explicit source runtime',
        visibility: createdVisibility,
        ...(membershipKind === 'dynamic' ? { membershipKind, rule: { filter: { owner: { presence: true } } } } : {}),
      });
      if (response.status !== 201)
        throw new Error(`Collection creation returned ${response.status}: ${await response.text()}`);
      expect(response.status).toBe(201);
      const id = (await response.json()).collection.id as string;
      if (createdVisibility !== visibility) {
        const promoted = await native.send(owner.bearer, 'PATCH', `/v1/collections/${id}`, {
          revision: 1,
          visibility,
        });
        if (promoted.status !== 200)
          throw new Error(`Collection visibility promotion returned ${promoted.status}: ${await promoted.text()}`);
      }
      return { route: routeOf(id)!, collectionId: id };
    }
    async function command<T>(
      collectionId: string,
      input: unknown,
      body: (tx: CommandTransaction) => Promise<T>,
      key = randomUUID(),
    ) {
      const route = routeOf(collectionId)!,
        deadline = Date.now() + 30000;
      const authorization = resourceAuthorization({
        access: native.access,
        actor: owner.actor,
        action: 'collection:update',
        anchor: {
          resource: { route, id: collectionId },
          async validate(client) {
            return (
              (
                await client.query(
                  "SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2 AND state='active'",
                  [route, collectionId],
                )
              ).rows.length === 1
            );
          },
        },
        context: { pool: native.pool, partition: partitionOf(route), deadline },
      });
      return runCommand(
        native.pool,
        {
          ...principalCommandIdentity(owner.actor),
          partition: partitionOf(route),
          deadline,
          authorization,
          receipt: {
            kind: 'library.collection.explicit-output',
            key,
            digest: createHash('sha256').update(JSON.stringify(input)).digest(),
          },
        },
        async (tx) => ({
          value: (await body(tx)) ?? null,
          events: [
            {
              type: 'com.rezics.library.collection.updated.v1',
              subject: collectionId,
              data: { collectionId },
            },
          ],
        }),
      );
    }
    async function inspect(collectionId: string) {
      return withConnection(native.pool, async (client) => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const keys = [routeOf(collectionId), collectionId];
          const generations = (
            await client.query(
              `SELECT generation::text,state,expected_members::text,written_members::text,after_subject_id::text
             FROM library.collection_source_output WHERE route=$1 AND collection_id=$2 ORDER BY generation`,
              keys,
            )
          ).rows;
          const selected =
            (
              await client.query<{ generation: string }>(
                'SELECT generation::text FROM library.collection_source_output_head WHERE route=$1 AND collection_id=$2',
                keys,
              )
            ).rows[0]?.generation ?? null;
          const members = (
            await client.query<{ generation: string; subject_id: string }>(
              `SELECT generation::text,subject_id::text FROM library.collection_source_output_member
             WHERE route=$1 AND collection_id=$2 ORDER BY generation,subject_id`,
              keys,
            )
          ).rows;
          await client.query('COMMIT');
          return { generations, selected, members };
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    }
    return {
      ...native,
      owner,
      collection,
      command,
      inspect,
      async close() {
        restoreDomain();
        await native.close();
      },
    };
  } catch (error) {
    restoreDomain();
    await native.close();
    throw error;
  }
}
export type SourceRuntimeFixture = Awaited<ReturnType<typeof sourceRuntimeFixture>>;
