import type { JWK } from "jose";
import type { Pool } from "pg";
import type { Principal } from "../../../../../specs/follow-counts-driver.ts";
import type { Anchor } from "../../../../../specs/library-driver.ts";
import {
  cookies,
  nativeFixture,
  password,
} from "../../access/native-account-bindings-fixture.ts";
import { deletePersona } from "../../support/account-deletion.ts";
import { partitionOf, routeOf } from "../../../src/route/route.ts";

/** Library borrows Accounts' host, approvals and exact receipt verifiers. */
export async function createLibraryAccountHost(input: {
  pool: Pool;
  authPool: Pool;
  databaseUrl: string;
  privateKey: JWK & { kid: string };
  actions: ReadonlyMap<string, { anonymous: boolean }>;
  scopes: string[];
}) {
  const fixture = await nativeFixture(input.pool, () => input.authPool, {
    database: { url: input.databaseUrl, close() {} },
    privateKey: input.privateKey,
    actions: input.actions,
  });
  try {
    await fixture.host.service.internal.registerClient({
      clientId: "web",
      firstParty: true,
      scopes: input.scopes,
    });
  } catch (error) {
    await fixture.stop();
    throw error;
  }
  const actingHumans = new Map<string, string>();
  async function signIn(
    accountId: string,
    scopes: readonly string[] = input.scopes,
  ) {
    const signed = await fixture.request("/signin", {
      account_id: accountId,
      password,
      client_id: "web",
      scope: scopes,
    });
    if (signed.status !== 200)
      throw new Error(
        `Library Auth sign-in failed: ${signed.status} ${await signed.text()}`,
      );
    const headers = cookies(signed);
    const issued = await fixture.request("/token", {}, headers);
    if (issued.status !== 200)
      throw new Error(
        `Library Auth token failed: ${issued.status} ${await issued.text()}`,
      );
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
      let key = "";
      for (let candidate = 0; candidate < 1_000_000; candidate++) {
        key = `${prefix}_${candidate}`;
        const id = fixture.bindings.workflowPorts.registrationTarget(key);
        if (partitionOf(routeOf(id)!) === partition) break;
        key = "";
      }
      if (!key)
        throw new Error(
          "Library native registration could not place the requested partition",
        );
      const registered = await fixture.host.workflows.register({
        key,
        handle: `library_${key.replaceAll("-", "")}`,
        email: `${key}@example.test`,
        password,
      });
      const route = routeOf(registered.accountId)!;
      if (partitionOf(route) !== partition)
        throw new Error("Auth changed the native registration placement");
      const signed = await signIn(registered.accountId);
      return {
        id: registered.accountId,
        route,
        partition,
        accountId: registered.accountId,
        credential: signed.credential,
      };
    },
    async managed(kind: "automated" | "organization", human: Principal) {
      const signed = await signIn(human.accountId);
      const key = `library_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const context = { pool: input.pool, deadline: Date.now() + 10000 };
      if (kind === "organization") {
        const operation = { kind, handle: key, authorization: "request" };
        const approval = await fixture
          .approval()
          .approve(
            signed.credential,
            { operationKey: key, operation },
            context,
          );
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
        kind: "opening" as const,
        operatorAccountId: human.accountId,
        subjectAccountId: created.accountId,
        authorization: "request",
      };
      const openingKey = `${key}_opening`;
      const approval = await fixture
        .approval()
        .approve(
          signed.credential,
          { operationKey: openingKey, operation },
          context,
        );
      const opened = await fixture.host.workflows.openOperatorSession({
        ...operation,
        key: openingKey,
        authorization: approval.reference,
        headers: signed.headers,
      });
      if (opened.status !== 200)
        throw new Error(
          `Library operator session failed: ${opened.status} ${await opened.text()}`,
        );
      const issued = await fixture.request("/token", {}, cookies(opened));
      if (issued.status !== 200)
        throw new Error(
          `Library operator token failed: ${issued.status} ${await issued.text()}`,
        );
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
export type LibraryAccountHost = Awaited<
  ReturnType<typeof createLibraryAccountHost>
>;
