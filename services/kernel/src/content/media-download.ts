import { createResourcePublicEligibility } from '../access/index.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { accessCheck, type AccessCheck, type Actor, type AccessClient } from '../request/access.ts';
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

type Row = NonNullable<Awaited<ReturnType<typeof read.run>>>;
export type DownloadContext = Readonly<{
  deadline: number;
  routeKey?: Uint8Array;
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
async function point(client: AccessClient, id: string, slot: { format: string; width: number }): Promise<Row | null> {
  const input = { route: route(id), media_id: id, ...slot };
  const result = await client.query<Row>(
    read.sql,
    read.params.map((name) => input[name as keyof typeof input]),
  );
  return result.rows.length === 1 ? result.rows[0]! : null;
}
const signature = (value: unknown) => JSON.stringify(value);
const usable = (row: Row) => !row.erased && !row.collection_pending && !row.taken_down;

/** No image bytes or object-store operations cross this boundary. Prepared
 * facts are independently anchored and released, then revalidated at each home.
 * H is bounded by mediaParentChain; the final media query probes one exact slot.
 */
export async function downloadMedia(
  dependencies: MediaDependencies,
  mediaId: string,
  actor: Actor,
  variant: DownloadVariant,
  context: DownloadContext,
): Promise<DownloadDecision> {
  const slot = selection(variant);
  if (!slot || routeOf(mediaId) === null || !Number.isFinite(context.deadline) || Date.now() >= context.deadline)
    return denied;
  const r = route(mediaId);
  const snapshot = <T>(home: number, work: (client: AccessClient) => Promise<T>) =>
    mediaParentSnapshot(dependencies.pool, home, context.deadline, work);
  try {
    const initial = await snapshot(r, (client) => point(client, mediaId, slot));
    if (!initial || !usable(initial) || routeOf(initial.container_id) !== r) return denied;
    const original = variant === 'original';
    if (initial.purpose === 'avatar') {
      if (original || initial.state !== 'available' || initial.container_id !== initial.uploader_id) return denied;
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
            async prepare() {
              return initial;
            },
            async verify({ client }) {
              const current = await point(client, mediaId, slot);
              if (!current || !usable(current) || signature(current) !== signature(initial))
                throw new GrantDeniedError();
              return true;
            },
          }),
        },
        { pool: dependencies.pool, deadline: context.deadline },
      );
      return await snapshot(r, async (client) => {
        const current = await point(client, mediaId, slot);
        if (!current || !usable(current) || signature(current) !== signature(initial) || !(await check(client)))
          return denied;
        return bytesDecision(current, mediaId, variant, true, context.deadline);
      });
    }
    if (original) {
      if (
        actor.kind !== 'account' ||
        actor.accountId !== initial.uploader_id ||
        !['uploaded', 'available'].includes(initial.state)
      )
        return denied;
    } else if (
      initial.state !== 'available' ||
      initial.variant_key === null ||
      (initial.purpose === 'post-image' && initial.claimed_at === null)
    )
      return denied;

    // A cover inherits its declared subject; candidate visibility belongs to the
    // semantic response. The tuple fence is read at its independent source home.
    if (initial.purpose === 'cover') {
      if (!context.routeKey) return denied;
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
        return denied;
      const home = tupleRoute(context.routeKey, provenance.source, provenance.external_id);
      const tuple = {
        route: home,
        source: provenance.source,
        external_id: provenance.external_id,
        field_group: 'cover' as const,
      };
      const fenceAtHome = () => snapshot(home, async (client) => (await readFences(client, [tuple]))[0]);
      const fence = await fenceAtHome();
      if (!fence || fence.takenDown) return denied;
      const resource = { route: r, id: initial.container_id };
      const subjectResource = { ...resource, eligibility: subjectReadEligibility(resource) };
      const accessContext = { pool: dependencies.pool, deadline: context.deadline };
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
            async prepare() {
              return initial;
            },
            async verify({ client }) {
              const current = await point(client, mediaId, slot);
              if (!current || !usable(current) || signature(current) !== signature(initial))
                throw new GrantDeniedError();
              // Existence is a hard prerequisite even when an independent grant
              // could satisfy the subject formula without a public floor.
              if (!(await subjectExists.run(client, { route: r, subject_id: initial.container_id })))
                throw new GrantDeniedError();
              if (!(await subject(client))) throw new GrantDeniedError();
              // Anonymous viewing and public visibility use the same prepared
              // check on this snapshot; evaluate that formula only once.
              publiclyVisible = publicSubject !== null && (publicSubject === subject || (await publicSubject(client)));
              return publiclyVisible;
            },
          }),
        },
        accessContext,
      );
      const currentFence = await fenceAtHome();
      if (!currentFence || currentFence.takenDown || signature(currentFence) !== signature(fence)) return denied;
      return await snapshot(r, async (client) => {
        const current = await point(client, mediaId, slot);
        if (!current || !usable(current) || signature(current) !== signature(initial) || !(await media(client)))
          return denied;
        return bytesDecision(current, mediaId, variant, publiclyVisible, context.deadline);
      });
    }
    if (initial.purpose !== 'post-image') return denied;
    const chain = await snapshot(r, (client) => mediaParentChain(client, initial.container_id));
    const boardId = chain.at(-1)?.board_id;
    if (!boardId) return denied;
    const board = await snapshot(route(boardId), (client) => mediaParentBoard(client, boardId));
    const accessContext = {
      pool: dependencies.pool,
      deadline: context.deadline,
    };
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
            async prepare() {
              return row;
            },
            async verify({ client }) {
              const current =
                row.kind === 'board'
                  ? await mediaParentBoard(client, row.id)
                  : (await parent.run(client, { route: r, id: row.id, kind: row.kind }))[0];
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
                const author =
                  row.kind === 'thread'
                    ? await readThreadAuthor.run(client, { route: r, id: row.id })
                    : await readPostAuthor.run(client, { route: r, id: row.id });
                if (!author || author.author_account_id !== actor.accountId) throw new GrantDeniedError();
              }
              return current.visibility === 'published';
            },
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
          async prepare() {
            return initial;
          },
          async verify({ client }) {
            const current = await point(client, mediaId, slot);
            if (!current || !usable(current) || signature(current) !== signature(initial)) throw new GrantDeniedError();
            const currentChain = await mediaParentChain(client, current.container_id);
            if (signature(currentChain) !== signature(chain)) throw new GrantDeniedError();
            return publiclyVisible;
          },
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
    if (!boardVisible) return denied;
    return await snapshot(r, async (client) => {
      const current = await point(client, mediaId, slot);
      if (!current || !usable(current) || signature(current) !== signature(initial)) return denied;
      const currentChain = await mediaParentChain(client, current.container_id);
      if (signature(currentChain) !== signature(chain)) return denied;
      for (const check of checks) if (!(await check(client))) return denied;
      if (!(await mediaCheck(client))) return denied;
      return bytesDecision(current, mediaId, variant, publiclyVisible, context.deadline);
    });
  } catch (error) {
    if (error instanceof GrantDeniedError || error instanceof RangeError) return denied;
    throw error;
  }
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
