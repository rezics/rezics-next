import type { PoolClient } from "pg";
import { deadlineClient, within } from "../access/authenticate.ts";
import { CommandUnavailableError } from "../access/unavailable.ts";
import { authoritativeTimeValue, mintReadTime } from "../command/command.ts";
import { withConnection } from "../database/pool.ts";
import { readPartition, type Partition } from "../partition/partition.ts";
import { prepareReadDecisions, type ReadDecisions } from "../request/access.ts";
import realmRows from "../content/community-presentation-realms.sql";
import { discoveryDescription } from "./discovery.ts";
import { readRealmDiscoveryGate } from "./discovery-source.ts";
import { realmPresentation } from "./presentation.ts";
import { realmViewerActionResource } from "./realm.ts";
import { readSpace, spaceViewerActionResource } from "./space.ts";
import slotRead from "./realm-space.sql";
import type {
  IndexedSpace,
  SpaceDiscoveryDependencies,
  SpaceDiscoveryKey,
} from "./space-discovery.ts";

type Client = Pick<PoolClient, "query">;
type Card = {
  indexed: IndexedSpace;
  avatarMediaId: string | null;
  binding: string;
};

/** One native partition/position and owner snapshot, released before foreign reads. */
export async function spaceDiscoverySnapshot<T>(
  deps: SpaceDiscoveryDependencies,
  partition: number,
  deadline: number,
  read: (client: Client, anchor: Partition) => Promise<T>,
): Promise<T> {
  return within(deadline, () =>
    withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        const anchor = await readPartition(client, partition);
        if (!anchor) throw new CommandUnavailableError("contention", partition);
        if (anchor.writeState !== "active")
          throw new CommandUnavailableError(
            anchor.writeState,
            partition,
            anchor.movedTo,
          );
        const result = await read(client, anchor);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      }
    }),
  );
}

export function prepareSpaceDiscovery(
  deps: SpaceDiscoveryDependencies,
  deadline: number,
) {
  return prepareReadDecisions(deps.access, {
    actor: { kind: "anonymous" },
    actions: new Set(["space:read", "realm:read"]),
    context: { pool: deps.pool, deadline },
  });
}

/** Current native readers own text, lifecycle and anonymous eligibility. An
 * occupied protected/removed Realm slot never becomes a standalone Space.
 */
export async function spaceDiscoveryRound(
  deps: SpaceDiscoveryDependencies,
  decisions: ReadDecisions,
  partition: number,
  input:
    | readonly SpaceDiscoveryKey[]
    | { after: SpaceDiscoveryKey | null; limit: number },
  deadline: number,
) {
  return spaceDiscoverySnapshot(
    deps,
    partition,
    deadline,
    async (client, anchor) => {
      let requested: readonly SpaceDiscoveryKey[];
      let next: SpaceDiscoveryKey | null = null;
      if ("limit" in input) {
        const rows = (
          await client.query<SpaceDiscoveryKey>(
            `SELECT route,space_id AS id FROM community.space
         WHERE route >= $1 AND route < $2 AND (route,space_id)>($3::integer,$4::uuid)
         ORDER BY route,space_id LIMIT $5`,
            [
              partition * 16,
              (partition + 1) * 16,
              input.after?.route ?? -1,
              input.after?.id ?? "00000000-0000-0000-0000-000000000000",
              input.limit + 1,
            ],
          )
        ).rows;
        requested = rows.slice(0, input.limit);
        next = rows.length > input.limit ? requested.at(-1)! : null;
      } else requested = input;
      const cards = new Map<string, Card>();
      if (!requested.length) return { position: anchor.position, cards, next };
      const time = await mintReadTime(client, deps.clock);
      const at = authoritativeTimeValue(time);
      const spaces = new Map<
        string,
        NonNullable<Awaited<ReturnType<typeof readSpace>>>
      >();
      const slots = new Map<string, string>();
      for (const key of requested) {
        const space = await readSpace(client, key.id, at);
        if (!space) continue;
        spaces.set(key.id, space);
        const slot = await slotRead.run(client, {
          route: key.route,
          space: key.id,
          at,
        });
        if (slot?.realm_id) slots.set(key.id, slot.realm_id);
      }
      const realms = slots.size
        ? await realmRows.run(client, {
            keys: JSON.stringify(
              [...slots].map(([id, realmId]) => ({
                route: requested.find((key) => key.id === id)!.route,
                id: realmId,
              })),
            ),
          })
        : [];
      const allowedSpaces = await decisions.decide(
        client,
        {
          action: "space:read",
          resourceType: "community.space",
          ids: requested.map((key) => key.id),
          eligibility: async (connection, ids, instant) => ({
            ...Object.fromEntries(ids.map((id) => [id, false])),
            ...(await spaceViewerActionResource.read(connection, ids, instant)),
          }),
        },
        time,
      );
      const allowedRealms = realms.length
        ? await decisions.decide(
            client,
            {
              action: "realm:read",
              resourceType: "community.realm",
              ids: realms.map((r) => r.realm_id),
              eligibility: async (connection, ids, instant) => ({
                ...Object.fromEntries(ids.map((id) => [id, false])),
                ...(await realmViewerActionResource.read(
                  connection,
                  ids,
                  instant,
                )),
              }),
            },
            time,
          )
        : {};
      for (const key of requested) {
        const space = spaces.get(key.id);
        if (!space || !allowedSpaces[key.id]?.allowed) continue;
        const realmId = slots.get(key.id) ?? null;
        const realm = realms.find(
          (r) => r.realm_id === realmId && r.space_id === key.id,
        );
        const gate = realmId
          ? await readRealmDiscoveryGate(client, realmId)
          : null;
        if (
          realmId &&
          (!realm ||
            realm.visibility !== "public" ||
            !allowedRealms[realmId]?.allowed ||
            Date.parse(realm.created_at) > Date.parse(at) ||
            Date.parse(realm.revision_created_at) > Date.parse(at) ||
            !gate?.settled)
        )
          continue;
        const presentation = realm
          ? realmPresentation(realm.presentation)
          : null;
        const binding = JSON.stringify([
          anchor.epoch,
          space.headRevisionId,
          space.lifecycleVersion,
          realmId,
          realm?.head_revision_id,
          realm?.lifecycle_version,
          realm?.context_id,
          gate,
          presentation,
        ]);
        cards.set(key.id, {
          indexed: {
            id: key.id,
            realmId,
            name: realm?.title ?? space.title,
            description: discoveryDescription(realm?.summary ?? space.summary),
            revision: realm?.head_revision_id ?? space.headRevisionId,
          },
          avatarMediaId: presentation?.avatarMediaId ?? null,
          binding,
        });
      }
      return { position: anchor.position, cards, next };
    },
  );
}
