import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import type { Account, Command } from '../../../../../specs/community-driver.ts';
import { GLOBAL_CONTEXT } from '../../../src/access/gates/catalogue.ts';
import type { PublicFigureView } from '../../../src/rating/public-figure-http.ts';
import { STANDARD_QUESTION_ID } from '../../../src/rating/votes.ts';
import { partitionOf, newId, routeOf } from '../../../src/route/route.ts';
import { subjectTarget } from '../../../src/semantic/subject.ts';
import {
  closeCommunityDrivers,
  communityFixtureRuntime,
  communityWorkerOutput,
  createCommunityDriver,
} from '../../community/community-driver.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';

export type FigureFixture = Awaited<ReturnType<typeof createFigureFixture>>;

/** Real Auth, Access, community membership and rating workers; SQL only provisions accounts or observes state. */
export async function createFigureFixture(
  options: { subjects?: number; partitions?: number; databaseUrl?: string; deferMembership?: boolean } = {},
) {
  const count = options.subjects ?? 4;
  const partitions = options.partitions ?? Math.min(3, count);
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(partitions) ||
    partitions < 1 ||
    partitions > count ||
    partitions > 4096
  )
    throw new TypeError('Invalid figure fixture subject or partition count');
  const driver = await createCommunityDriver({
    ...(options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl }),
    settleTimeoutMs: 180_000,
  });
  let cleanupDatabase: GrowthDatabase | undefined;
  try {
    const setup = await driver.provision();
    const { system, kernel } = communityFixtureRuntime();
    const settle = async () => {
      try {
        await driver.settle();
      } catch (error) {
        throw new Error(`Native figure fixture did not settle:\n${communityWorkerOutput().slice(-12_000)}`, {
          cause: error,
        });
      }
    };
    const database = (cleanupDatabase = await openGrowthDatabase(system.database.pool.options.connectionString));
    let closed = false;
    const voterIds = new Set<string>();
    const scopes = (
      system.auth.ordinaryClient as typeof system.auth.ordinaryClient & { readonly scopes: readonly string[] }
    ).scopes;
    const freshen = async (account: Account | null) => {
      if (account && voterIds.has(account.id) && (decodeJwt(account.bearer).exp ?? 0) * 1000 <= Date.now() + 30_000) {
        // Large native publication fixtures outlive access tokens. Sign in again through real Auth.
        account.bearer = (
          await system.auth.issue({ accountId: account.id, clientId: system.auth.ordinaryClient.id, scopes })
        ).bearer;
      }
    };
    const checked = async (command: Command) => {
      await freshen(command.actor);
      const response = await driver.request({
        ...command,
        ...(['GET', 'HEAD'].includes(command.method) ? {} : { key: JSON.stringify(randomUUID()) }),
      });
      if (!response.ok)
        throw new Error(`${command.method} ${command.path}: ${response.status} ${await response.text()}`);
      return response;
    };
    const request = async (path: string, actor: Account | null = null) => {
      await freshen(actor);
      return driver.request({ method: 'GET', path, actor });
    };
    const voters: Account[] = [];
    // Accounts and their credentials are permitted setup. Each password is the native fixture's password;
    // sign-in, consent, token issuance and verification still run in the real Auth service.
    for (let index = 0; index < 10; index++) {
      const id = newId(0x1000 + index * 16);
      await system.database.pool.query(
        `INSERT INTO access.account(route, account_id, kind, state, transaction_id, membership_inverse_complete)
         VALUES ($1, $2, 'actor', 'active', $2, true)`,
        [routeOf(id), id],
      );
      await system.database.authPool.query(`INSERT INTO "user" (id, name, "emailVerified") VALUES ($1, '', false)`, [
        id,
      ]);
      await system.database.authPool.query(
        `INSERT INTO account (id, "accountId", "providerId", "userId", password, "updatedAt")
         SELECT $1, $1, 'credential', $1, password, now() FROM account
         WHERE "userId" = $2 AND "providerId" = 'credential'`,
        [id, setup.owner.id],
      );
      const credential = await system.auth.issue({
        accountId: id,
        clientId: system.auth.ordinaryClient.id,
        scopes,
      });
      voterIds.add(id);
      voters.push({ id, bearer: credential.bearer });
    }
    const globalVoters = voters.slice(5);
    const realmMembers = voters.slice(0, 5);
    const space = (
      await (
        await checked({
          actor: setup.owner,
          method: 'POST',
          path: '/v1/spaces',
          body: { title: 'Figure fixture Space' },
        })
      ).json()
    ).space;
    const realm = (
      await (
        await checked({
          actor: setup.owner,
          method: 'POST',
          path: '/v1/realms',
          body: {
            spaceId: space.spaceId,
            title: 'Private figure Realm',
            visibility: 'protected',
            contextId: setup.contextId,
          },
        })
      ).json()
    ).realm;
    const realmId: string = realm.realmId;
    let membersJoined = false;
    const joinMembers = async () => {
      if (membersJoined) return;
      // Finish each durable membership before admitting the next operation on the same Realm.
      for (const member of realmMembers) {
        await checked({
          actor: setup.owner,
          method: 'POST',
          path: `/v1/realms/${realmId}/members`,
          body: { accountId: member.id },
        });
        await settle();
        const response = await checked({ actor: member, method: 'GET', path: `/v1/realms/${realmId}/members/me` });
        if ((await response.json()).state !== 'member') throw new Error('Native Realm membership did not publish');
      }
      membersJoined = true;
    };
    if (!options.deferMembership) await joinMembers();
    const subjectIds: string[] = [];
    const anchors: number[] = [];
    for (let index = 0; index < count; index++) {
      let key: string;
      let partition: number;
      do {
        key = randomUUID();
        partition = partitionOf(subjectTarget(system.routeKey, setup.subjectOwner.id, key).route);
      } while (anchors.length < partitions ? anchors.includes(partition) : partition !== anchors[index % partitions]);
      if (anchors.length < partitions) anchors.push(partition);
      const response = await kernel.handle(
        new Request('https://content.test/v1/subjects', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${setup.subjectOwner.bearer}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(key),
          },
          body: JSON.stringify({ type: 'schema:Book', labels: { en: `Figure subject ${index}` } }),
        }),
      );
      if (response.status !== 201) throw new Error(`Subject fixture: ${response.status} ${await response.text()}`);
      const id: string = (await response.json()).subject.id;
      if (partitionOf(routeOf(id)!) !== partition) throw new Error('Subject route did not match its command anchor');
      subjectIds.push(id);
    }
    const vote = async (subjectId: string, voter: Account, units: number) => {
      await checked({
        actor: voter,
        method: 'PUT',
        path: `/v1/subjects/${subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`,
        body: { units },
      });
    };
    const drain = async () => {
      await settle();
    };
    const figure = async (subjectId: string) => {
      const response = await checked({ actor: null, method: 'GET', path: `/v1/subjects/${subjectId}/figure` });
      const body = (await response.json()) as { figure: PublicFigureView };
      const etag = response.headers.get('etag');
      if (etag === null) throw new Error('Public figure response is missing its revision ETag');
      return { ...body, etag };
    };
    const published = async (subjectId: string, count: number, populationId = GLOBAL_CONTEXT.id) => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        await drain();
        const row = (
          await database.admin.query<{
            count: number;
            mean: number | null;
            priorEpoch: number | null;
            revision: string;
          }>(
            `SELECT count::integer, mean::float8, prior_epoch AS "priorEpoch", revision::text FROM rating.public_figure WHERE route = $1 AND subject_id = $2 AND question_id = $3 AND population_id = $4 AND pending_position IS NULL AND revision > 0`,
            [routeOf(subjectId), subjectId, STANDARD_QUESTION_ID, populationId],
          )
        ).rows[0];
        if (row?.count === count) return row;
        if (Date.now() > deadline) throw new Error(`Figure did not publish ${count} votes: ${JSON.stringify(row)}`);
        await Bun.sleep(20);
      }
    };
    return {
      database,
      subjectIds,
      realmId,
      globalVoters,
      realmMembers,
      vote,
      request,
      figure,
      published,
      joinMembers,
      drain,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await database.close();
        } finally {
          try {
            await driver.close();
          } finally {
            await closeCommunityDrivers();
          }
        }
      },
    };
  } catch (error) {
    await cleanupDatabase?.close();
    await driver.close();
    await closeCommunityDrivers();
    throw error;
  }
}
