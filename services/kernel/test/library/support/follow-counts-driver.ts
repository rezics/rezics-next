import type { PoolClient } from "pg";
import type {
  CountFixture,
  CountInspection,
  CountTarget,
  FollowCountsDriver,
  Principal,
  ReadTrace,
} from "../../../../../specs/follow-counts-driver.ts";
import { readErasureStatus } from "../../../src/access/erasure.ts";
import { PLATFORM_RESOURCE } from "../../../src/access/bootstrap-governance.ts";
import { libraryErasureWorkflowId } from "../../../src/library/erasure-participant.ts";
import {
  bootstrapFollowCountOwner,
  reconcileFollowCountSource,
  type CountKey,
} from "../../../src/library/follow-count-source.ts";
import { deliverFollowCount } from "../../../src/library/follow-count-target.ts";
import { newId, partitionOf, routeOf } from "../../../src/route/route.ts";
import { drainEffects } from "../../support/account-deletion.ts";
import { costOf, withoutCatalogStatements } from "../../support/growth.ts";
import { createLibraryDriver } from "./outcome-driver.ts";
import {
  json,
  requestKey,
  setGate,
  unavailable,
  type NativeConformanceWorld,
} from "./native-conformance.ts";

export type NativeFollowCountsDriver = FollowCountsDriver & {
  readonly world: NativeConformanceWorld;
};
const keyOf = (follower: Principal, target: CountTarget): CountKey => ({
  accountId: follower.accountId,
  ...target,
});
const route = (id: string) => {
  const value = routeOf(id);
  if (value === null)
    throw new TypeError("Native Follow fixture requires a routed identity");
  return value;
};

/** TEST binding only. Work, authority, revisions, totals and acknowledgements stay native. */
export async function createFollowCountsDriver(): Promise<NativeFollowCountsDriver> {
  const world = await createLibraryDriver();
  try {
    await world.native.hold();
    const { pool, reader, workClient: client } = world.native;
    const deps = { pool, client };
    const captures = new Map<string, CountKey>();
    const fixtures: CountFixture[] = [];
    const revocations = new Map<
      CountFixture,
      { path: string; body: unknown }
    >();
    const populations = new Map<CountFixture, Map<string, number>>();
    let principalSequence = 0;
    let dependencyLock: PoolClient | undefined;
    const principal = async () => {
      for (let attempt = 0; attempt < 2048; attempt++) {
        const partition = 1024 + (principalSequence++ % 2048);
        if (
          fixtures.some(
            (fixture) =>
              partitionOf(route(fixture.follower.accountId)) === partition ||
              partitionOf(route(fixture.target.targetId)) === partition,
          )
        )
          continue;
        return world.native.principal(partition);
      }
      throw new Error(
        "Native Follow growth exhausted distinct fixture partition placements",
      );
    };
    const steward: Principal = {
      accountId: world.native.steward.id,
      credential: world.native.token("steward"),
    };
    const request: FollowCountsDriver["request"] = (credential, path, init) =>
      world.native.bearerRequest(credential, path, init);
    const write = (
      as: Principal,
      method: string,
      path: string,
      body?: unknown,
    ) =>
      request(as.credential, path, {
        method,
        headers: {
          "Idempotency-Key": requestKey(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    async function grant(
      resource: { route: number; id: string },
      subjectId: string,
      actions: string[],
    ) {
      await json(
        await write(steward, "POST", "/v1/grants", {
          resource,
          subject: { kind: "account", id: subjectId },
          actions,
          valid: "(,)",
        }),
        201,
      );
    }
    async function collection(as: Principal): Promise<CountTarget> {
      const value = await json<{ collection: { id: string } }>(
        await write(as, "POST", "/v1/collections", {
          title: "Native Follow count target",
          visibility: "public",
        }),
        201,
      );
      return { targetType: "collection", targetId: value.collection.id };
    }
    async function follow(as: Principal, target: CountTarget, live = true) {
      await json(
        await write(
          as,
          live ? "PUT" : "DELETE",
          `/v1/follows/${target.targetId}`,
        ),
      );
    }
    async function releaseDependency() {
      if (!dependencyLock) return;
      const lock = dependencyLock;
      dependencyLock = undefined;
      try {
        await lock.query("ROLLBACK");
      } finally {
        lock.release();
      }
    }
    async function inspectRows(relation: string, sql: string, args: unknown[]) {
      return (await reader.query(sql, args)).rows.map((row) => ({
        relation,
        row,
      }));
    }
    const driver: NativeFollowCountsDriver = {
      world,
      request,
      async fixture(kind) {
        const [manager, granted, follower, other, noScopeAccount] =
          await Promise.all([
            principal(),
            principal(),
            principal(),
            principal(),
            principal(),
          ]);
        const noScope = await world.native.reauthenticate(
          noScopeAccount.accountId,
          [],
        );
        const suspended = {
          accountId: world.accounts.suspended.id,
          credential: world.native.token("suspended"),
        };
        let target: CountTarget;
        let targetAccountId: string | null = null;
        let revoke: { path: string; body: unknown } | undefined;
        if (kind === "collection") {
          target = await collection(manager);
          const resource = {
            route: route(target.targetId),
            id: target.targetId,
          };
          const body = {
            resource,
            subject: { kind: "account", id: granted.accountId },
            actions: ["collection:update"],
            valid: "(,)",
          };
          await json(await write(steward, "POST", "/v1/grants", body), 201);
          revoke = { path: "/v1/grants:revoke", body };
        } else if (kind === "space") {
          await grant(PLATFORM_RESOURCE, manager.accountId, ["space:create"]);
          const created = await json<{ space: { spaceId: string } }>(
            await write(manager, "POST", "/v1/spaces", {
              title: "Native Follow count Space",
            }),
            201,
          );
          target = { targetType: "space", targetId: created.space.spaceId };
          const body = {
            resource: { route: route(target.targetId), id: target.targetId },
            subject: { kind: "account", id: granted.accountId },
            role: "community.space.owner",
            valid: "(,)",
          };
          await json(await write(steward, "POST", "/v1/roleGrants", body), 201);
          revoke = { path: "/v1/roleGrants:revoke", body };
        } else if (kind === "ordinary") {
          const subject = await world.native.subject("schema:Book");
          target = { targetType: "subject", targetId: subject.id };
        } else {
          targetAccountId =
            kind === "person"
              ? manager.accountId
              : (await world.native.accountHost.managed(kind, manager))
                  .accountId;
          // Consume the real account-agent effect and public identity, not a guessed id
          // or a fabricated catalogue verification (software agents cannot be verified).
          await world.native.resume();
          try {
            await drainEffects(pool, partitionOf(route(targetAccountId)));
          } finally {
            await world.native.hold();
          }
          const identity = await json<{
            accounts: { id: string; subject: { id: string } | null }[];
          }>(await request(null, `/v1/accounts?ids=${targetAccountId}`));
          const account = identity.accounts.find(
            (account) => account.id === targetAccountId,
          );
          if (!account?.subject)
            return unavailable("native account-agent effect/public subject");
          target = { targetType: "subject", targetId: account.subject.id };
          const body = {
            resource: { route: route(targetAccountId), id: targetAccountId },
            subject: { kind: "account", id: granted.accountId },
            actions: ["account:manage"],
            valid: "(,)",
          };
          await json(await write(steward, "POST", "/v1/grants", body), 201);
          revoke = { path: "/v1/grants:revoke", body };
        }
        const fixture: CountFixture = {
          target,
          targetAccountId,
          manager,
          granted,
          follower,
          other,
          staff: steward,
          noScope,
          suspended,
          unknown: {
            targetType: target.targetType,
            targetId: newId(route(target.targetId)),
          },
        };
        fixtures.push(fixture);
        if (revoke) revocations.set(fixture, revoke);
        return fixture;
      },
      async revokeManagement(fixture) {
        const revoke = revocations.get(fixture);
        if (!revoke)
          throw new Error(
            "No native management grant was installed for this fixture",
          );
        await json(await write(steward, "POST", revoke.path, revoke.body));
      },
      async accountState(accountId, state) {
        if (state === "deleted") {
          await world.native.accountHost.delete(accountId);
          return;
        }
        await json(
          await write(
            steward,
            "POST",
            `/v1/accounts/${accountId}:${state === "active" ? "reinstate" : "suspend"}`,
            {},
          ),
        );
      },
      reauthenticate: (as) => world.native.reauthenticate(as.accountId),
      gate: (open) => setGate(world, "personal_library", open),
      async additionalOutgoing(as) {
        const target = await collection(await principal());
        await follow(as, target);
        return target;
      },
      async libraryFollow(as, target) {
        await json(
          await write(as, "PUT", `/v1/libraryEntries/${target.targetId}`, {
            state: "in_progress",
          }),
          201,
        );
      },
      async capture(as, target) {
        await world.native.hold();
        const key = keyOf(as, target);
        await reconcileFollowCountSource(deps, key); // committed, released source
        const pending = await reader.query(
          `SELECT 1 FROM library.follow_count_source WHERE route=$1 AND account_id=$2
           AND target_type=$3 AND target_id=$4 AND pending_since IS NOT NULL`,
          [
            route(as.accountId),
            as.accountId,
            target.targetType,
            target.targetId,
          ],
        );
        if (!pending.rowCount)
          throw new Error(
            "Native Follow capture requires actual pending per-edge work",
          );
        const handle = crypto.randomUUID();
        captures.set(handle, key); // locator only; eligibility and revision are never saved
        return handle;
      },
      async deliver(handle) {
        const key = captures.get(handle);
        if (!key) throw new Error("Unknown native Follow work handle");
        await deliverFollowCount(deps, key);
      },
      async reconcile(as, target) {
        while (
          !(await bootstrapFollowCountOwner(deps, as.accountId)).complete
        ) {
          /* native bounded continuation */
        }
        await deliverFollowCount(deps, keyOf(as, target));
      },
      async accountSignal(accountId) {
        const event = await reader.query(
          `SELECT id FROM core.outbox WHERE partition_no=$1 AND subject=$2
           AND type='com.rezics.access.account-tombstoned.v1' ORDER BY position,event_seq LIMIT 1`,
          [partitionOf(route(accountId)), accountId],
        );
        if (!event.rowCount)
          throw new Error("Native account-tombstoned event is absent");
        await world.native.resume();
        try {
          await drainEffects(pool, partitionOf(route(accountId)));
          const admitted = (
            await reader.query<{ workflow_id: string }>(
              `SELECT c.workflow_id FROM core.outbox o JOIN core.history_event_consumer c
             USING(partition_no,position,event_seq) WHERE o.id=$1 AND c.consumer='library_account_erasure'`,
              [event.rows[0].id],
            )
          ).rows[0];
          if (!admitted)
            throw new Error(
              "Native Library terminal effect admission is absent",
            );
          await client.resumeWorkflow(admitted.workflow_id, {
            queueName: "effects",
          });
          await client.retrieveWorkflow(admitted.workflow_id).getResult();
        } finally {
          await world.native.hold();
        }
      },
      async purge(accountId) {
        await world.native.resume();
        try {
          await drainEffects(pool, partitionOf(route(accountId)));
          let id = libraryErasureWorkflowId(accountId);
          let pages = 0;
          for (let segment = 0; segment < 100; segment++) {
            const deadline = Date.now() + 30_000;
            while (!(await client.getWorkflow(id))) {
              if (Date.now() >= deadline)
                throw new Error(`Native event did not enqueue ${id}`);
              await Bun.sleep(10);
            }
            const result: unknown = await client
              .retrieveWorkflow(id)
              .getResult();
            if (typeof result !== "object" || result === null)
              throw new Error("Invalid Library participant result");
            if ("state" in result && result.state === "acknowledged") {
              const status = await readErasureStatus(pool, accountId);
              const outcome = status?.participants.library?.outcome;
              return {
                pages,
                maxRows: await observedMaxPage(accountId),
                complete: outcome === "erased" || outcome === "none",
              };
            }
            for (const field of ["counts", "facts", "owned"] as const) {
              const stats: unknown = Reflect.get(result, field);
              if (
                typeof stats !== "object" ||
                stats === null ||
                !("pages" in stats) ||
                typeof stats.pages !== "number"
              )
                throw new Error(`Invalid Library participant ${field} stats`);
              pages += stats.pages;
            }
            if (!("continuation" in result) || result.continuation === null)
              return {
                pages,
                maxRows: await observedMaxPage(accountId),
                complete: false,
              };
            const next = result.continuation;
            if (
              typeof next !== "object" ||
              !("segment" in next) ||
              typeof next.segment !== "number"
            )
              throw new Error("Invalid Library continuation");
            id = `${libraryErasureWorkflowId(accountId)}:${next.segment}`;
          }
          throw new Error(
            "Library erasure exceeded bounded observation segments",
          );
        } finally {
          await world.native.hold();
        }
      },
      async inspect(as, target): Promise<CountInspection> {
        const args = [route(as.accountId), as.accountId];
        const source =
          (
            await reader.query<NonNullable<CountInspection["source"]>>(
              `SELECT route,account_id AS "accountId",target_id AS "targetId",target_type AS "targetType",
           state,reason,created_at::text AS "createdAt",updated_at::text AS "updatedAt",transaction_id AS "transactionId"
           FROM library.follow WHERE route=$1 AND account_id=$2 AND target_id=$3`,
              [...args, target.targetId],
            )
          ).rows[0] ?? null;
        const targetRows = [];
        for (const relation of ["follow_count_pair", "follow_count_support"])
          targetRows.push(
            ...(await inspectRows(
              `library.${relation}`,
              `SELECT * FROM library.${relation} WHERE account_id=$1 ORDER BY route,target_type,target_id,to_jsonb(${relation})::text`,
              [as.accountId],
            )),
          );
        const privatePayloads = [...targetRows];
        for (const relation of [
          "follow_count_source",
          "follow_count_destination",
          "follow_count_owner",
          "follow_count_account_work",
          "follow_count_account_signal",
        ])
          privatePayloads.push(
            ...(await inspectRows(
              `library.${relation}`,
              `SELECT * FROM library.${relation} WHERE route=$1 AND account_id=$2 ORDER BY to_jsonb(${relation})::text`,
              args,
            )),
          );
        // Native source/receiving locators are included above. Shared command and
        // event copies are observed too, never assumed minimized.
        privatePayloads.push(
          ...(await inspectRows(
            "core.receipt",
            `SELECT * FROM core.receipt WHERE principal_id=$1 AND command_kind LIKE 'library.%' ORDER BY partition_no,command_kind,idempotency_key`,
            [as.accountId],
          )),
        );
        const effects = (
          await reader.query<CountInspection["effects"][number]>(
            `SELECT transaction_id AS "transactionId",type,subject,data FROM core.outbox
           WHERE subject=$1 AND type LIKE 'com.rezics.library.%' ORDER BY partition_no,position,event_seq`,
            [as.accountId],
          )
        ).rows;
        privatePayloads.push(
          ...effects.map((row) => ({ relation: "core.outbox", row })),
        );
        const terminalFences = (
          await reader.query<{ accountId: string }>(
            `SELECT account_id AS "accountId" FROM library.follow_count_terminal_follower WHERE account_id=$1
             UNION ALL
             SELECT account_id AS "accountId" FROM library.follow_count_terminal_source WHERE account_id=$1
             ORDER BY "accountId"`,
            [as.accountId],
          )
        ).rows;
        return { source, targetRows, privatePayloads, effects, terminalFences };
      },
      async fault(state) {
        await releaseDependency();
        if (state === "clear") return;
        // Hold the real dependency unavailable until clear. HTTP/Access/readiness
        // still execute their ordinary bounded database requests and error paths.
        dependencyLock = await reader.connect();
        await dependencyLock.query("BEGIN");
        await dependencyLock.query(
          state === "access_unavailable"
            ? "LOCK TABLE access.resource_grant,access.resource_role_grant IN ACCESS EXCLUSIVE MODE"
            : "LOCK TABLE library.follow_count_health IN ACCESS EXCLUSIVE MODE",
        );
      },
      async publicArtifacts() {
        const responses = [];
        for (const fixture of fixtures) {
          const path =
            fixture.target.targetType === "collection"
              ? `/v1/collections/${fixture.target.targetId}`
              : fixture.target.targetType === "space"
                ? `/v1/spaces/${fixture.target.targetId}`
                : `/v1/subjects/${fixture.target.targetId}`;
          const response = await request(null, path);
          responses.push({
            path,
            status: response.status,
            body: await response.json(),
          });
        }
        const artifacts: { surface: string; value: unknown }[] = [
          { surface: "responses", value: responses },
        ];
        for (const [surface, pattern] of [
          ["fts", "(search|fts|text)"],
          ["counts", "(listing|count)"],
          ["sitemaps", "sitemap"],
          ["notifications", "(notif|notice)"],
        ] as const) {
          const relations = (
            await reader.query<{ schema: string; name: string }>(
              `SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE c.relkind IN ('r','p') AND n.nspname=ANY($1::text[])
             AND ((c.relname ~ $2 AND c.relname NOT LIKE 'follow_count_%') OR ($3 AND n.nspname='search'))
             ORDER BY n.nspname,c.relname`,
              [
                ["semantic", "library", "community", "content", "search"],
                pattern,
                surface === "fts",
              ],
            )
          ).rows;
          const rows = [];
          for (const relation of relations) {
            const name = `"${relation.schema.replaceAll('"', '""')}"."${relation.name.replaceAll('"', '""')}"`;
            rows.push(
              ...(await inspectRows(
                `${relation.schema}.${relation.name}`,
                `SELECT * FROM ${name} ORDER BY to_jsonb(${name})::text`,
                [],
              )),
            );
          }
          // Include actual public fanout envelopes even when a derived table is absent.
          const events = (
            await reader.query(
              `SELECT type,subject,data FROM core.outbox WHERE type NOT LIKE 'com.rezics.library.follow%'
             AND (type ~ $1) ORDER BY partition_no,position,event_seq`,
              [pattern],
            )
          ).rows;
          let publicResponse: unknown;
          if (surface === "sitemaps") {
            const response = await request(null, "/v1/sitemap/collections");
            publicResponse = {
              status: response.status,
              body: await response.json(),
            };
          }
          artifacts.push({
            surface,
            value: {
              rows,
              events,
              ...(publicResponse === undefined
                ? {}
                : { response: publicResponse }),
            },
          });
        }
        return artifacts;
      },
      async seed(fixture, scale, axis) {
        if (![1, 4, 16].includes(scale))
          throw new RangeError("Follow growth uses scales 1, 4, 16");
        let axes = populations.get(fixture);
        if (!axes) {
          axes = new Map();
          populations.set(fixture, axes);
        }
        const previous = axes.get(axis) ?? 0;
        if (scale < previous) throw new Error("Native growth is cumulative");
        for (let i = 128 * previous; i < 128 * scale; i++) {
          if (axis === "target_followers") {
            const as = await principal();
            await follow(as, fixture.target);
            await driver.reconcile(as, fixture.target);
          } else if (axis === "unrelated_followers") {
            const as = await principal();
            const target = await collection(await principal());
            await follow(as, target);
            await driver.reconcile(as, target);
          } else {
            const target = await collection(await principal());
            if (axis === "history") {
              await follow(fixture.follower, target);
              await follow(fixture.follower, target, false);
              await driver.reconcile(fixture.follower, target);
            }
          }
        }
        axes.set(axis, scale);
      },
      async measure(read) {
        const managementChecks: ReadTrace["managementChecks"] = [];
        world.native.observeManagement((check) => managementChecks.push(check));
        try {
          const measured = await world.native.capture(read);
          const raw = withoutCatalogStatements(
            "Follow count native read",
            measured.capture,
          );
          const cost = costOf(raw);
          return {
            value: measured.value,
            trace: {
              managementChecks,
              statements: cost.statements,
              examinedRows: cost.rows,
              sharedBlocks: cost.sharedHit + cost.sharedRead,
              sequentialRelations: Object.entries(cost.relations)
                .filter(
                  ([relation, work]) =>
                    work.sequentialScans > 0 &&
                    !["core.partition", "core.consumer_lag"].includes(relation),
                )
                .map(([relation]) => relation)
                .sort(),
            },
          };
        } finally {
          world.native.observeManagement(undefined);
        }
      },
      async close() {
        try {
          await releaseDependency();
        } finally {
          await world.close();
        }
      },
    };
    async function observedMaxPage(accountId: string): Promise<number> {
      // Actual persisted native page results, including failed-attempt history,
      // must be available; a constant 100 is a bound, not an observation.
      return unavailable(
        `Library erasure per-page raw-row observation for ${accountId}`,
      );
    }
    return driver;
  } catch (error) {
    await world.close();
    throw error;
  }
}
