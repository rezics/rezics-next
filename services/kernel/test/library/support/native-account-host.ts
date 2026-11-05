import type { JWK } from 'jose';
import { Client, type Pool } from 'pg';
import type { Principal } from '../../../../../specs/follow-counts-driver.ts';
import type { Anchor } from '../../../../../specs/library-driver.ts';
import { cookies, nativeFixture, password } from '../../access/native-account-bindings-fixture.ts';
import { deletePersona } from '../../support/account-deletion.ts';
import { partitionOf, routeOf } from '../../../src/route/route.ts';

let stalledNativeStart: Error | undefined;

/** A native Auth start that does not settle within ninety seconds reports the database sessions it waits on. Later
 * starts in this process fail at once with that first evidence, because the stalled start still owns DBOS here. */
async function boundedNativeStart<T>(start: () => Promise<T>, databaseUrl: string): Promise<T> {
  if (stalledNativeStart) throw stalledNativeStart;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void waitingSessions(databaseUrl).then((detail) => {
        stalledNativeStart = new Error(`Library native Auth start did not settle; sessions: ${detail}`);
        reject(stalledNativeStart);
      });
    }, 90_000);
  });
  try {
    return await Promise.race([start(), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitingSessions(databaseUrl: string): Promise<string> {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
  try {
    await client.connect();
    const result = await client.query(
      `SELECT pid, datname, state, wait_event_type, wait_event, pg_blocking_pids(pid)::text AS blocked_by,
              left(query, 300) AS query
         FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname IS NOT NULL ORDER BY pid`,
    );
    return JSON.stringify(result.rows).slice(0, 6000);
  } catch (error) {
    return `session probe failed: ${String(error)}`;
  } finally {
    await client.end().catch(() => undefined);
  }
}

let stalledRegistration: Error | undefined;

/** A registration that does not settle within a minute fails with the durable workflow rows it left behind; later
 * registrations in this process fail at once with that first evidence instead of waiting again. */
async function boundedRegistration<T>(start: () => Promise<T>, pool: Pool): Promise<T> {
  if (stalledRegistration) throw stalledRegistration;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void pool
        .query('SELECT workflow_uuid, name, status, error FROM dbos.workflow_status ORDER BY created_at DESC LIMIT 8')
        .then(
          (result) => JSON.stringify(result.rows),
          (error: unknown) => `status query failed: ${String(error)}`,
        )
        .then((detail) => {
          stalledRegistration = new Error(`Library native registration did not settle; workflows: ${detail}`);
          reject(stalledRegistration);
        });
    }, 60_000);
  });
  try {
    return await Promise.race([start(), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

/** Library borrows Accounts' host, approvals and exact receipt verifiers. */
export async function createLibraryAccountHost(input: {
  pool: Pool;
  authPool: Pool;
  databaseUrl: string;
  privateKey: JWK & { kid: string };
  actions: ReadonlyMap<string, { anonymous: boolean }>;
  scopes: string[];
}) {
  const fixture = await boundedNativeStart(
    () =>
      nativeFixture(input.pool, () => input.authPool, {
        database: { url: input.databaseUrl, close() {} },
        privateKey: input.privateKey,
        actions: input.actions,
      }),
    input.databaseUrl,
  );
  try {
    await fixture.host.service.internal.registerClient({
      clientId: 'web',
      firstParty: true,
      scopes: input.scopes,
    });
  } catch (error) {
    await fixture.stop();
    throw error;
  }
  const actingHumans = new Map<string, string>();
  async function signIn(accountId: string, scopes: readonly string[] = input.scopes) {
    const signed = await fixture.request('/signin', {
      account_id: accountId,
      password,
      client_id: 'web',
      scope: scopes,
    });
    if (signed.status !== 200) throw new Error(`Library Auth sign-in failed: ${signed.status} ${await signed.text()}`);
    const headers = cookies(signed);
    const issued = await fixture.request('/token', {}, headers);
    if (issued.status !== 200) throw new Error(`Library Auth token failed: ${issued.status} ${await issued.text()}`);
    const { access_token: credential } = (await issued.json()) as {
      access_token: string;
    };
    return { accountId, credential, headers };
  }
  return {
    service: fixture.host.service,
    close: () => fixture.stop(),
    signIn,
    async person(partition: number): Promise<Anchor & Principal> {
      // Choose a registration key, never substitute the host's routed account identity.
      const prefix = Bun.randomUUIDv7();
      let key = '';
      for (let candidate = 0; candidate < 1_000_000; candidate++) {
        key = `${prefix}_${candidate}`;
        const id = fixture.bindings.workflowPorts.registrationTarget(key);
        if (partitionOf(routeOf(id)!) === partition) break;
        key = '';
      }
      if (!key) throw new Error('Library native registration could not place the requested partition');
      const registered = await boundedRegistration(
        () =>
          fixture.host.workflows.register({
            key,
            handle: `library_${key.replaceAll('-', '')}`,
            email: `${key}@example.test`,
            password,
          }),
        input.pool,
      );
      const route = routeOf(registered.accountId)!;
      if (partitionOf(route) !== partition) throw new Error('Auth changed the native registration placement');
      const signed = await signIn(registered.accountId);
      return {
        id: registered.accountId,
        route,
        partition,
        accountId: registered.accountId,
        credential: signed.credential,
      };
    },
    async managed(kind: 'automated' | 'organization', human: Principal) {
      const signed = await signIn(human.accountId);
      const key = `library_${Bun.randomUUIDv7().replaceAll('-', '')}`;
      const context = { pool: input.pool, deadline: Date.now() + 10000 };
      if (kind === 'organization') {
        const operation = { kind, handle: key, authorization: 'request' };
        const approval = await fixture.approval().approve(signed.credential, { operationKey: key, operation }, context);
        const created = await fixture.host.workflows.createOrganization({
          key,
          handle: key,
          authorization: approval.reference,
        });
        actingHumans.set(created.accountId, human.accountId);
        return { accountId: created.accountId };
      }
      const created = await fixture.automated(key, {
        accountId: human.accountId,
        bearer: signed.credential,
      });
      const operation = {
        kind: 'opening' as const,
        operatorAccountId: human.accountId,
        subjectAccountId: created.accountId,
        authorization: 'request',
      };
      const openingKey = `${key}_opening`;
      const approval = await fixture
        .approval()
        .approve(signed.credential, { operationKey: openingKey, operation }, context);
      const opened = await fixture.host.workflows.openOperatorSession({
        ...operation,
        key: openingKey,
        authorization: approval.reference,
        headers: signed.headers,
      });
      if (opened.status !== 200)
        throw new Error(`Library operator session failed: ${opened.status} ${await opened.text()}`);
      const issued = await fixture.request('/token', {}, cookies(opened));
      if (issued.status !== 200)
        throw new Error(`Library operator token failed: ${issued.status} ${await issued.text()}`);
      const { access_token: credential } = (await issued.json()) as {
        access_token: string;
      };
      actingHumans.set(created.accountId, human.accountId);
      return { accountId: created.accountId, credential };
    },
    async delete(accountId: string) {
      const humanId = actingHumans.get(accountId) ?? accountId;
      const human = await signIn(humanId);
      // This helper signs in again, approves/executes, and reads committed Access T.
      // T is a fence receipt, never proof that downstream erasure is complete.
      return deletePersona(
        { pool: input.pool, auth: fixture },
        { accountId, bearer: human.credential },
        { actingHuman: { accountId: humanId, bearer: human.credential } },
      );
    },
  };
}
export type LibraryAccountHost = Awaited<ReturnType<typeof createLibraryAccountHost>>;
