import canonicalize from 'canonicalize';
import { readPublicIdentities, type PublicIdentity } from '../access/account-data.ts';
import { readNativeAccountStates } from '../access/account-authority.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { AccessUnavailableError, CommandUnavailableError } from '../access/unavailable.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type AccessClient, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import { RealmBanInputError, type BanDependencies } from './ban.ts';
import type {
  BanReviewIdentity,
  BanReviewPage,
  BanReviewPageItem,
  BanReviewPageQuery,
} from './ban-review-page-schemas.ts';
import { PublicationCursorError } from './publication.ts';
import { realmReadEligibility } from './realm.ts';
import { spaceReadEligibility } from './space.ts';
import sourceRead from './ban-review-page-source.sql';
import windowRead from './ban-review-page-window.sql';
import selectedRead from './ban-review-page-selected.sql';
import contextRead from './ban-review-page-context.sql';

// Admission bounds derive from the native reason (1024 scalars), Account profile
// (4096 scalars) and handle (64 ASCII) contracts, including JSON escaping.
export const BAN_REVIEW_LIMITS = Object.freeze({
  page: 100,
  identityBatch: 100,
  identityPayloadBytes: 26_624,
  reasonBytes: 6_146,
  contextBytes: 16_384,
  responseBytes: 12 * 1024 * 1024,
});
type RawBan = Awaited<ReturnType<typeof windowRead.run>>[number];
type Source = NonNullable<Awaited<ReturnType<typeof sourceRead.run>>>;
const start = '00000000-0000-0000-0000-000000000000';
const changed = () =>
  new ProblemError('dependency_unavailable', { detail: 'Current Realm bans changed; retry this exact read.' });
const equal = (left: unknown, right: unknown) => canonicalize(left) === canonicalize(right);
function bounded(value: unknown, bytes: number) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > bytes) throw changed();
}
function present(accountId: string, identities: ReadonlyMap<string, PublicIdentity>): BanReviewIdentity {
  const row = identities.get(accountId);
  if (!row || row.state !== 'active') return { state: 'concealed', accountId, label: 'Account', destination: null };
  return {
    state: 'available',
    accountId,
    displayName: row.displayName,
    handle: row.handle,
    label: row.displayName || row.handle || 'Account',
    destination: row.handle === null ? null : `/@${row.handle}`,
  };
}

/** Compose the existing native inventory. Accounts and Access preparation always
 * release their homes before Realm checkout. The two rounds are observations,
 * never a distributed snapshot, command receipt or transferable permission.
 */
export async function readBanReviewPage(
  deps: BanDependencies,
  actorInput: Actor,
  realmId: string,
  context: { deadline: number },
  query: BanReviewPageQuery = {},
): Promise<BanReviewPage> {
  const routed = routeOf(realmId);
  const limit = query.limit ?? 20;
  if (
    routed === null ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > BAN_REVIEW_LIMITS.page ||
    (query.selectedAccountId !== undefined && routeOf(query.selectedAccountId) === null)
  )
    throw new RealmBanInputError();
  if (actorInput.kind !== 'account') throw new GrantDeniedError();
  const actor = actorInput;
  const route = routed;
  const caller = canonicalize(actor);
  const resource = { route, id: realmId };
  const accessContext = { pool: deps.pool, deadline: context.deadline };
  const binding = {
    operation: 'community.realm.bans',
    parameters: {
      realmId,
      limit,
      viewer: actor.accountId,
      client: actor.clientId,
      scopes: JSON.stringify([...actor.scopes].sort()),
      requestedBy: actor.requestedBy,
      authnEpoch: actor.authnEpoch,
    },
  };
  const assertCaller = () => {
    if (canonicalize(actor) !== caller) throw changed();
  };
  const snapshot = <T>(read: (client: AccessClient) => Promise<T>) =>
    withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const result = await read(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    });
  async function home(client: AccessClient) {
    const value = await readPartition(client, partitionOf(route!));
    if (!value || value.writeState === 'moved') throw new ProblemError('partition_unavailable');
    return value;
  }
  async function admission() {
    assertCaller();
    const time = await withConnection(deps.pool, (client) =>
      mintReadTime(deadlineClient(client, context.deadline), deps.clock),
    );
    try {
      const check = await accessCheck(deps.access, actor, 'realm:ban', resource, { ...accessContext, time });
      return { time, check };
    } catch (error) {
      releaseOperationalTime(time);
      throw error;
    }
  }
  async function callerState() {
    assertCaller();
    const rows = await readNativeAccountStates(deadlineClient(deps.pool, context.deadline), [actor.accountId]);
    const row = rows[0];
    if (
      !row ||
      row.kind !== 'actor' ||
      row.state !== 'active' ||
      row.fenced ||
      !Number.isSafeInteger(actor.authnEpoch) ||
      actor.authnEpoch < 1 ||
      BigInt(actor.authnEpoch) < BigInt(row.minimumAuthnEpoch)
    )
      throw new GrantDeniedError();
    return row;
  }
  async function raw(prepared: Awaited<ReturnType<typeof admission>>, after: string) {
    return snapshot(async (client) => {
      // The original realm:ban gate precedes source, page and exact inspection.
      if (!(await prepared.check(client, prepared.time))) throw new GrantDeniedError();
      const partition = await home(client);
      const source = await sourceRead.run(client, {
        route,
        realm_id: realmId,
        at: authoritativeTimeValue(prepared.time),
      });
      if (!source) throw new GrantDeniedError();
      const rows = await windowRead.run(client, { route, realm_id: realmId, after, limit: limit + 1 });
      const selected =
        query.selectedAccountId === undefined
          ? null
          : await selectedRead.run(client, { route, realm_id: realmId, account_id: query.selectedAccountId });
      for (const row of [...rows, ...(selected ? [selected] : [])]) {
        if (row.at === null) throw changed();
        bounded(row.reason, BAN_REVIEW_LIMITS.reasonBytes);
      }
      return { source, rows, selected, epoch: partition.epoch };
    });
  }
  async function identities(ids: readonly string[]) {
    const result = new Map<string, PublicIdentity>();
    for (let offset = 0; offset < ids.length; offset += BAN_REVIEW_LIMITS.identityBatch) {
      const batch = ids.slice(offset, offset + BAN_REVIEW_LIMITS.identityBatch);
      // Installed Accounts disclosure, grouped by actual native homes, never a
      // handle lookup, account index, private profile read or per-row HTTP call.
      const rows = await readPublicIdentities(
        deadlineClient(deps.pool, context.deadline),
        batch.map((id) => routeOf(id)!),
        batch,
      );
      for (const row of rows) {
        if (!batch.includes(row.id) || result.has(row.id)) throw changed();
        bounded(row, BAN_REVIEW_LIMITS.identityPayloadBytes);
        result.set(row.id, row);
      }
    }
    return result;
  }
  async function optionalContext(source: Source): Promise<BanReviewPage['context']> {
    const time = await withConnection(deps.pool, (client) =>
      mintReadTime(deadlineClient(client, context.deadline), deps.clock),
    );
    try {
      const host = { route, id: source.spaceId };
      const realm = await accessCheck(
        deps.access,
        actor,
        'realm:read',
        { ...resource, eligibility: realmReadEligibility(resource) },
        { ...accessContext, time },
      );
      const space = await accessCheck(
        deps.access,
        actor,
        'space:read',
        { ...host, eligibility: spaceReadEligibility(host) },
        { ...accessContext, time },
      );
      return await snapshot(async (client) => {
        // The ordinary readers own these decisions, including protected ban
        // precedence. A moderator label never supplies either read permission.
        if (!(await realm(client, time)) || !(await space(client, time))) return { state: 'concealed' };
        const current = await sourceRead.run(client, { route, realm_id: realmId, at: authoritativeTimeValue(time) });
        if (!equal(source, current)) throw changed();
        const titles = await contextRead.run(client, {
          route,
          realm_id: realmId,
          realm_head: source.realmHead,
          space_id: source.spaceId,
          space_head: source.spaceHead,
        });
        if (!titles) throw changed();
        bounded(titles, BAN_REVIEW_LIMITS.contextBytes);
        return { state: 'available', ...titles, spaceId: source.spaceId };
      });
    } catch (error) {
      if (error instanceof ProblemError && error.code === 'not_found') return { state: 'concealed' };
      throw error;
    } finally {
      releaseOperationalTime(time);
    }
  }
  return within(context.deadline, async () => {
    let after = start;
    let continuation: ReturnType<typeof decodeCursor> | undefined;
    if (query.cursor !== undefined) {
      continuation = decodeCursor(deps.tokens, binding, query.cursor);
      if (!continuation.ok) throw new PublicationCursorError(continuation.reason);
      if (
        continuation.after.length !== 4 ||
        typeof continuation.after[0] !== 'string' ||
        routeOf(continuation.after[0]) === null
      )
        throw new PublicationCursorError('invalid');
      after = continuation.after[0];
    }
    const initialAccess = await admission();
    let initial;
    try {
      initial = await raw(initialAccess, after);
    } finally {
      releaseOperationalTime(initialAccess.time);
    }
    const epochs = (source: Source) => [source.realmVersion, source.spaceVersion, source.sourceEpoch];
    if (
      continuation?.ok &&
      (continuation.epoch !== initial.epoch || !equal(continuation.after.slice(1), epochs(initial.source)))
    )
      throw new PublicationCursorError('stale');
    const callerBefore = await callerState();
    const items = initial.rows.slice(0, limit);
    const represented = [...items, ...(initial.selected ? [initial.selected] : [])];
    const keys = [
      ...new Set([
        ...represented.flatMap((row) => (row.actor === null ? [row.accountId] : [row.accountId, row.actor])),
        ...(initial.selected || query.selectedAccountId === undefined ? [] : [query.selectedAccountId]),
      ]),
    ];
    if (keys.length > 2 * limit + 2) throw changed();
    const people = await identities(keys);
    const titles = await optionalContext(initial.source);
    // Refresh disclosed identity observations as well as hidden/absent ones.
    // Erasure cannot silently remove an operational row or expose its old name.
    if (!equal([...people], [...(await identities(keys))])) throw changed();
    const finalTitles = await optionalContext(initial.source);
    if (!equal(titles, finalTitles)) throw changed();
    const finalAccess = await admission();
    try {
      if (!equal(callerBefore, await callerState())) throw changed();
      const final = await raw(finalAccess, after);
      if (!equal(initial, final)) throw changed();
      assertCaller();
      const item = (row: RawBan): BanReviewPageItem => {
        if (row.at === null) throw changed();
        return {
          accountId: row.accountId,
          reason: row.reason,
          actor: row.actor,
          at: row.at,
          account: present(row.accountId, people),
          moderator: row.actor === null ? null : present(row.actor, people),
          unban: {
            state: 'permitted',
            realmId,
            accountId: row.accountId,
            observedAt: row.at,
            membershipRestored: false,
          },
          removal: { state: 'unavailable' },
        };
      };
      const last = items.at(-1);
      const page: BanReviewPage = {
        items: items.map(item),
        next:
          initial.rows.length > limit && last
            ? encodeCursor(deps.tokens, binding, {
                epoch: initial.epoch,
                after: [last.accountId, ...epochs(initial.source)],
              })
            : null,
        context: finalTitles,
        viewer: {
          accountId: actor.accountId,
          clientId: actor.clientId,
          requestedBy: actor.requestedBy,
          authnEpoch: actor.authnEpoch,
          unban: { state: 'permitted', operationId: 'realm.unban', action: 'realm:ban', resource, reauthorizes: true },
        },
        selected:
          query.selectedAccountId === undefined
            ? { state: 'not-requested' }
            : initial.selected
              ? { state: 'current', ban: item(initial.selected) }
              : {
                  state: 'absent',
                  accountId: query.selectedAccountId,
                  account: present(query.selectedAccountId, people),
                },
      };
      bounded(page, BAN_REVIEW_LIMITS.responseBytes);
      return page;
    } finally {
      releaseOperationalTime(finalAccess.time);
    }
  }).catch((error: unknown) => {
    if (
      error instanceof ProblemError ||
      error instanceof GrantDeniedError ||
      error instanceof RealmBanInputError ||
      error instanceof PublicationCursorError ||
      error instanceof AccessUnavailableError ||
      error instanceof CommandUnavailableError
    )
      throw error;
    throw new ProblemError('dependency_unavailable');
  });
}
