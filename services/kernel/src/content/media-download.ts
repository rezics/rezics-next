import { createResourcePublicEligibility } from './access-port.ts';
import { GrantDeniedError } from '../access/contract/index.ts';
import { authoritativeTimeValue, mintReadTime, type AuthoritativeTime } from '../command/command.ts';
import { readRealm, realmReadEligibility, type RealmView } from '../community/realm.ts';
import realmHead from '../community/realm-read.sql';
import { ProblemError } from '../http/problem-error.ts';
import { accessCheck } from './access-port.ts';
import type { AccessCheck, Actor, AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import subjectExists from '../semantic/subject-exists.sql';
import { tupleRoute } from './imported-contract.ts';
import { readFences } from './source-fences.ts';
import { mediaParentBoard, mediaParentChain, mediaParentSnapshot, type MediaParent } from './media-parent.ts';
import readBoardParent from './read-media-parent-board.sql';
import parent from './read-media-parent.sql';
import readPostAuthor from './read-post-author.sql';
import readThreadAuthor from './read-thread-author.sql';
import type { DownloadDecision, DownloadVariant, MediaDependencies } from './media.ts';
import read from './read-download-media.sql';
import readWork from './read-download-media-work.sql';
import { authorizedRealmMedia, realmMediaVariants } from './realm-media-read.ts';
import { AccessWorkUnavailableError, type AccessWorkAccounting } from '../access/work.ts';
import { coverPreparedAccessWork } from './cover-prepared-access-work.ts';
import { COVER_MEDIA_WORK_DEPENDENCY, mediaEligibilityCallbacks } from './media-eligibility-access-work.ts';

type Row = NonNullable<Awaited<ReturnType<typeof read.run>>>;
type RealmHeadRow = NonNullable<Awaited<ReturnType<typeof realmHead.run>>>;
export type DownloadContext = Readonly<{
  deadline: number;
  routeKey?: Uint8Array;
  /** Trusted caller forwarding only; never reconstructed from an HTTP timestamp. */
  time?: AuthoritativeTime;
  work?: AccessWorkAccounting;
}>;
const denied: DownloadDecision = Object.freeze({ allowed: false });
const digest = /^[0-9a-f]{64}$/;
function route(id: string) {
  const value = routeOf(id);
  if (value === null) throw new GrantDeniedError();
  return value;
}
function selection(variant: string) {
  if (variant === 'original') return { format: '', width: 0 };
  const match = /^(webp|avif)-([1-9][0-9]{0,3})$/.exec(variant);
  if (!match) return null;
  const width = Number(match[2]);
  if (!(width < 320 || [320, 640, 960, 1280, 1920, 2560].includes(width))) return null;
  return { format: match[1]!, width };
}
async function point(
  client: AccessClient,
  id: string,
  slot: { format: string; width: number },
  bounded = false,
  credit = true,
  provenance = true,
): Promise<Row | null> {
  const input = {
    route: route(id),
    media_id: id,
    ...slot,
    credit_bytes: credit ? 8192 : 0,
    provenance_bytes: provenance ? 65536 : 0,
  };
  const statement = bounded ? readWork : read;
  const result = await client.query<Row>(
    statement.sql,
    statement.params.map((name) => input[name as keyof typeof input]),
  );
  return result.rows.length === 1 ? result.rows[0]! : null;
}
const signature = (value: unknown) => JSON.stringify(value);
const usable = (row: Row) => !row.erased && !row.collection_pending && !row.taken_down;

/** A permanent post claim inherits that post's current disclosure chain, rather
 * than only the thread or reply parent used to reserve the image. Historical
 * reservations without an item binding retain their container prerequisite.
 * A moved claim cannot silently switch the reservation's native relationship.
 */
async function disclosureChain(
  client: AccessClient,
  row: Row,
  readParent?: Parameters<typeof mediaParentChain>[2],
): Promise<MediaParent[]> {
  const owner = row.claimed_item_id ?? row.container_id;
  if (routeOf(owner) !== routeOf(row.container_id)) throw new GrantDeniedError();
  const chain = await mediaParentChain(client, owner, readParent);
  if (
    (row.claimed_item_id !== null && chain[0]?.kind !== 'post') ||
    !chain.some((parent) => parent.id === row.container_id)
  )
    throw new GrantDeniedError();
  return chain;
}

function realmSignature(value: RealmView | RealmHeadRow): string {
  const realm =
    'realm_id' in value
      ? {
          realmId: value.realm_id,
          spaceId: value.space_id,
          state: value.state,
          visibility: value.visibility,
          contextId: value.context_id,
          boardSchemeId: value.board_scheme_id,
          headRevisionId: value.head_revision_id,
          createdAt: value.created_at,
          creator: value.creator,
          predecessor: value.predecessor,
          title: value.title,
          summary: value.summary,
          revisionCreatedAt: value.revision_created_at,
          author: value.author,
          votes: value.votes as Record<string, unknown>,
        }
      : value;
  return JSON.stringify([
    realm.realmId,
    realm.spaceId,
    realm.state,
    realm.visibility,
    realm.contextId,
    realm.boardSchemeId,
    realm.headRevisionId,
    new Date(realm.createdAt).toISOString(),
    realm.creator,
    realm.predecessor,
    realm.title,
    realm.summary,
    new Date(realm.revisionCreatedAt).toISOString(),
    realm.author,
    Object.entries(realm.votes).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

/** No image bytes or object-store operations cross this boundary. Prepared
 * facts are independently anchored and released, then revalidated at each home.
 * H is bounded by mediaParentChain; the final media query probes one exact slot.
 */
type AuthorizedDownload = Readonly<{ row: Row; decision: Extract<DownloadDecision, { allowed: true }> }>;

export async function downloadMedia(
  dependencies: MediaDependencies,
  mediaId: string,
  actor: Actor,
  variant: DownloadVariant,
  context: DownloadContext,
): Promise<DownloadDecision> {
  return (await authorizeDownload(dependencies, mediaId, actor, variant, context))?.decision ?? denied;
}

/** Internal authenticated transport facts. The supplied row is an expectation,
 * never permission: the ordinary download verifier checks it before and at final
 * disclosure. No retry selects a replacement when that expectation changes. */
export async function authorizeMediaDerivative(
  dependencies: MediaDependencies,
  mediaId: string,
  actor: Actor,
  variant: Exclude<DownloadVariant, 'original'>,
  context: DownloadContext,
  expected: Row,
): Promise<Row | null> {
  return (await authorizeDownload(dependencies, mediaId, actor, variant, context, expected))?.row ?? null;
}

async function authorizeDownload(
  dependencies: MediaDependencies,
  mediaId: string,
  actor: Actor,
  variant: DownloadVariant,
  context: DownloadContext,
  expected?: Row,
): Promise<AuthorizedDownload | null> {
  const slot = selection(variant);
  if (!slot || routeOf(mediaId) === null || !Number.isFinite(context.deadline) || Date.now() >= context.deadline)
    return null;
  const r = route(mediaId);
  const snapshot = <T>(home: number, work: (client: AccessClient) => Promise<T>) =>
    mediaParentSnapshot(dependencies.pool, home, context.deadline, work);
  try {
    const initial = await snapshot(r, (client) => point(client, mediaId, slot));
    if (
      !initial ||
      !usable(initial) ||
      routeOf(initial.container_id) !== r ||
      (expected !== undefined && signature(initial) !== signature(expected))
    )
      return null;
    const original = variant === 'original';
    if (initial.purpose === 'realm-icon' || initial.purpose === 'realm-banner') {
      if (original || initial.state !== 'available') return null;
      const authorized = await authorizedRealmMedia(dependencies, initial.container_id, [mediaId], {
        actor,
        deadline: context.deadline,
      });
      const current = authorized.get(mediaId);
      if (!current) return null;
      const selected = realmMediaVariants(current).find(
        (entry) => entry.format === slot.format && entry.width === slot.width,
      );
      if (!selected || Date.now() >= context.deadline) return null;
      return await snapshot(r, async (client) => {
        const current = await point(client, mediaId, slot);
        if (!current || !usable(current) || signature(current) !== signature(initial)) return null;
        return authorizedDecision(current, mediaId, variant, false, context.deadline);
      });
    }
    if (initial.purpose === 'avatar') {
      if (original || initial.state !== 'available' || initial.container_id !== initial.uploader_id) return null;
      const resource = { route: r, id: mediaId };
      const check = await accessCheck(
        dependencies.access,
        actor,
        'media:read',
        {
          ...resource,
          eligibility: createResourcePublicEligibility({
            resource,
            action: 'media:read',
            ...mediaEligibilityCallbacks({
              evidence: initial,
              media: { kind: 'download', route: r, id: mediaId, ...slot, credit: false, provenance: false },
              async verify({ client }, reads) {
                const current = await reads.media((bounded) =>
                  point(client, mediaId, slot, bounded, initial.credit !== null, initial.provenance !== null),
                );
                if (!current || !usable(current) || signature(current) !== signature(initial))
                  throw new GrantDeniedError();
                return true;
              },
            }),
          }),
        },
        { pool: dependencies.pool, deadline: context.deadline },
      );
      return await snapshot(r, async (client) => {
        const current = await point(client, mediaId, slot);
        if (!current || !usable(current) || signature(current) !== signature(initial) || !(await check(client)))
          return null;
        return authorizedDecision(current, mediaId, variant, true, context.deadline);
      });
    }
    if (original) {
      if (
        actor.kind !== 'account' ||
        actor.accountId !== initial.uploader_id ||
        !['uploaded', 'available'].includes(initial.state)
      )
        return null;
    } else if (
      initial.state !== 'available' ||
      initial.variant_key === null ||
      (initial.purpose === 'post-image' && initial.claimed_at === null)
    )
      return null;

    // A cover inherits its declared subject; candidate visibility belongs to the
    // semantic response. The tuple fence is read at its independent source home.
    if (initial.purpose === 'cover') {
      if (!context.routeKey) return null;
      const provenance = initial.provenance as {
        source?: unknown;
        external_id?: unknown;
        field_group?: unknown;
      } | null;
      if (
        !provenance ||
        typeof provenance.source !== 'string' ||
        typeof provenance.external_id !== 'string' ||
        provenance.field_group !== 'cover'
      )
        return null;
      const home = tupleRoute(context.routeKey, provenance.source, provenance.external_id);
      const tuple = {
        route: home,
        source: provenance.source,
        external_id: provenance.external_id,
        field_group: 'cover' as const,
      };
      const fenceAtHome = () => snapshot(home, async (client) => (await readFences(client, [tuple]))[0]);
      const fence = await fenceAtHome();
      if (!fence || fence.takenDown) return null;
      const resource = { route: r, id: initial.container_id };
      const subjectResource = { ...resource, eligibility: subjectReadEligibility(resource) };
      const accessContext = {
        pool: dependencies.pool,
        deadline: context.deadline,
        ...(context.time === undefined ? {} : { time: context.time }),
        ...(context.work === undefined ? {} : { work: context.work }),
      };
      if (context.work) {
        if (!context.time) throw new (AccessWorkUnavailableError())(COVER_MEDIA_WORK_DEPENDENCY);
        authoritativeTimeValue(context.time);
      }
      const subject = await accessCheck(dependencies.access, actor, 'subject:read', subjectResource, accessContext);
      const publicSubject = original
        ? null
        : actor.kind === 'anonymous'
          ? subject
          : await accessCheck(
              dependencies.access,
              { kind: 'anonymous' },
              'subject:read',
              subjectResource,
              accessContext,
            );
      const prepared = coverPreparedAccessWork(subject, publicSubject, accessContext);
      let publiclyVisible = false;
      const mediaResource = { route: r, id: mediaId };
      const media = await accessCheck(
        dependencies.access,
        actor,
        'media:read',
        {
          ...mediaResource,
          eligibility: createResourcePublicEligibility({
            resource: mediaResource,
            action: 'media:read',
            ...mediaEligibilityCallbacks({
              evidence: initial,
              dependency: COVER_MEDIA_WORK_DEPENDENCY,
              media: {
                kind: 'download',
                route: r,
                id: mediaId,
                ...slot,
                credit: initial.credit !== null,
                provenance: initial.provenance !== null,
              },
              cover: { ...resource, access: prepared },
              async verify({ client }, reads) {
                const current = await reads.media((bounded) =>
                  point(client, mediaId, slot, bounded, initial.credit !== null, initial.provenance !== null),
                );
                if (!current || !usable(current) || signature(current) !== signature(initial))
                  throw new GrantDeniedError();
                // Existence is a hard prerequisite even when an independent grant
                // could satisfy the subject formula without a public floor.
                if (
                  !(await reads.subject(async (bounded) => {
                    const input = { route: r, subject_id: initial.container_id };
                    if (!bounded) return subjectExists.run(client, input);
                    // Dispatch only the existing exact native statement: the SQL
                    // convenience wrapper may perform catalogue freshness reads.
                    const result = await client.query<{ found: number }>(
                      subjectExists.sql,
                      subjectExists.params.map((name) => input[name as keyof typeof input]),
                    );
                    return result.rows[0] ?? null;
                  }))
                )
                  throw new GrantDeniedError();
                if (!(await reads.prepared(subject))) throw new GrantDeniedError();
                // Anonymous viewing and public visibility use the same prepared
                // check on this snapshot; evaluate that formula only once.
                publiclyVisible =
                  publicSubject !== null && (publicSubject === subject || (await reads.prepared(publicSubject)));
                return publiclyVisible;
              },
            }),
          }),
        },
        accessContext,
      );
      const currentFence = await fenceAtHome();
      if (!currentFence || currentFence.takenDown || signature(currentFence) !== signature(fence)) return null;
      return await snapshot(r, async (client) => {
        const current = await point(client, mediaId, slot);
        if (
          !current ||
          !usable(current) ||
          signature(current) !== signature(initial) ||
          !(await media(client, context.time))
        )
          return null;
        return authorizedDecision(current, mediaId, variant, publiclyVisible, context.deadline);
      });
    }
    if (initial.purpose !== 'post-image') return null;
    const chain = await snapshot(r, (client) => disclosureChain(client, initial));
    const boardId = chain.at(-1)?.board_id;
    if (!boardId) return null;
    const board = await snapshot(route(boardId), (client) => mediaParentBoard(client, boardId));
    const accessContext = {
      pool: dependencies.pool,
      deadline: context.deadline,
    };
    let realmId: string | null = board.realm_id;
    let realmInitial: RealmView | null = null;
    let realmCheck: AccessCheck | null = null;
    let realmRoute: number | null = null;
    if (realmId !== null) {
      realmRoute = route(realmId);
      realmInitial = await readRealm(dependencies, actor, realmId, { deadline: context.deadline });
      if (!realmInitial) return null;
      const realmResource = { route: realmRoute, id: realmId };
      realmCheck = await accessCheck(
        dependencies.access,
        actor,
        'realm:read',
        { ...realmResource, eligibility: realmReadEligibility(realmResource) },
        accessContext,
      );
    }
    async function prepare(row: MediaParent): Promise<AccessCheck> {
      const action = `${row.kind}:read`;
      const resource = { route: route(row.id), id: row.id };
      return accessCheck(
        dependencies.access,
        actor,
        action,
        {
          ...resource,
          eligibility: createResourcePublicEligibility({
            resource,
            action,
            ...mediaEligibilityCallbacks({
              evidence: row,
              parent: {
                kind: row.kind,
                route: resource.route,
                id: row.id,
                author: row.visibility === 'draft' && actor.kind === 'account' && row.kind !== 'board',
              },
              async verify({ client }, reads) {
                const currentRows = await reads.parent(async () =>
                  row.kind === 'board'
                    ? mediaParentBoard(client, row.id)
                    : parent.run(client, { route: r, id: row.id, kind: row.kind }),
                );
                const current = Array.isArray(currentRows) ? currentRows[0] : currentRows;
                if (
                  !current ||
                  signature(current) !== signature(row) ||
                  !['published', 'protected', 'draft'].includes(current.visibility) ||
                  current.availability !== 'available'
                )
                  throw new GrantDeniedError();
                if (current.visibility === 'draft') {
                  if (actor.kind !== 'account' || (row.kind !== 'thread' && row.kind !== 'post'))
                    throw new GrantDeniedError();
                  const author = await reads.author(() =>
                    row.kind === 'thread'
                      ? readThreadAuthor.run(client, { route: r, id: row.id })
                      : readPostAuthor.run(client, { route: r, id: row.id }),
                  );
                  if (!author || author.author_account_id !== actor.accountId) throw new GrantDeniedError();
                }
                return current.visibility === 'published';
              },
            }),
          }),
        },
        accessContext,
      );
    }
    const boardCheck = await prepare(board);
    const checks: AccessCheck[] = [];
    for (const node of chain) checks.push(await prepare(node));
    const publiclyVisible =
      !original && board.visibility === 'published' && chain.every((node) => node.visibility === 'published');
    const resource = { route: r, id: mediaId };
    const mediaCheck = await accessCheck(
      dependencies.access,
      actor,
      'media:read',
      {
        ...resource,
        eligibility: createResourcePublicEligibility({
          resource,
          action: 'media:read',
          ...mediaEligibilityCallbacks({
            evidence: initial,
            media: {
              kind: 'download',
              route: r,
              id: mediaId,
              ...slot,
              ancestors: chain.map(({ id, kind }) => {
                if (kind === 'board') throw new GrantDeniedError();
                return { id, kind };
              }),
              credit: initial.credit !== null,
              provenance: initial.provenance !== null,
            },
            async verify({ client }, reads) {
              const current = await reads.media((bounded) =>
                point(client, mediaId, slot, bounded, initial.credit !== null, initial.provenance !== null),
              );
              if (!current || !usable(current) || signature(current) !== signature(initial))
                throw new GrantDeniedError();
              const currentChain = await disclosureChain(client, current, (input) =>
                reads.ancestor(input, () => parent.run(client, input)),
              );
              if (signature(currentChain) !== signature(chain)) throw new GrantDeniedError();
              return publiclyVisible;
            },
          }),
        }),
      },
      accessContext,
    );
    // The remote board is never read on a media/container transaction, including
    // when it happens to live in the same partition. No nested pool checkouts.
    const boardVisible = await snapshot(route(boardId), async (client) => {
      const current = await readBoardParent.run(client, { route: route(boardId), id: boardId });
      return current !== null && signature(current) === signature(board) && (await boardCheck(client));
    });
    if (!boardVisible) return null;
    const currentMedia = await snapshot(r, async (client) => {
      const current = await point(client, mediaId, slot);
      if (!current || !usable(current) || signature(current) !== signature(initial)) return null;
      const currentChain = await disclosureChain(client, current);
      if (signature(currentChain) !== signature(chain)) return null;
      for (const check of checks) if (!(await check(client))) return null;
      if (!(await mediaCheck(client))) return null;
      return current;
    });
    if (!currentMedia) return null;
    if (realmId !== null) {
      if (realmRoute === null || !realmInitial || !realmCheck || board.realm_id !== realmId) return null;
      const currentRealm = await snapshot(realmRoute, async (client) => {
        const time = await mintReadTime(client);
        try {
          if (!(await realmCheck!(client, time))) return false;
        } catch (error) {
          if (error instanceof ProblemError && error.code === 'not_found') return false;
          throw error;
        }
        const at = authoritativeTimeValue(time);
        const rows = await realmHead.run(client, { route: realmRoute!, id: realmId!, at });
        return rows !== null && realmSignature(rows) === realmSignature(realmInitial!);
      });
      if (!currentRealm) return null;
    }
    return authorizedDecision(currentMedia, mediaId, variant, publiclyVisible, context.deadline);
  } catch (error) {
    if (error instanceof GrantDeniedError || error instanceof RangeError) return null;
    throw error;
  }
}

function authorizedDecision(
  row: Row,
  mediaId: string,
  variant: DownloadVariant,
  publiclyVisible: boolean,
  deadline: number,
): AuthorizedDownload | null {
  const decision = bytesDecision(row, mediaId, variant, publiclyVisible, deadline);
  return decision.allowed ? { row, decision } : null;
}

function bytesDecision(
  row: Row,
  mediaId: string,
  variant: DownloadVariant,
  publiclyVisible: boolean,
  deadline: number,
): DownloadDecision {
  const original = variant === 'original';
  const key = original ? row.key : row.variant_key;
  const sha256 = original ? row.sha256 : row.variant_sha256;
  const mediaType = original ? row.media_type : row.variant_media_type;
  const byteCount = Number(original ? row.actual_byte_count : row.variant_byte_count);
  if (
    !key ||
    key !== `m/${mediaId}/${variant}` ||
    !sha256 ||
    !digest.test(sha256) ||
    !mediaType ||
    !Number.isSafeInteger(byteCount) ||
    byteCount < 1 ||
    Date.now() >= deadline
  )
    return denied;
  return {
    allowed: true,
    key,
    sha256,
    mediaType,
    byteCount,
    publicCache: false,
    cacheControl: publiclyVisible && !original ? 'private, no-cache' : 'private, no-store',
  };
}
