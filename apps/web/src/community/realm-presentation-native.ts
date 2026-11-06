import type { KernelClient } from '@rezics/client';
import { documentText, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import type { Media } from '../media/kernel';
import { dependencyUnavailable, MediaProblem } from '../media/kernel';
import { boardCommunitySource } from '../threads/board-community-source';
import {
  sameRealmPresentation,
  type RealmAppearanceRead,
  type RealmAppearanceResult,
  type RealmAppearanceSelection,
  type RealmAppearanceCommand,
  type RealmAppearanceChoice,
  type RealmAppearanceSnapshot,
  type RealmRulesSummary,
} from './realm-presentation';

type RealmRoutes = ReturnType<KernelClient['realms']>;
type Realm = NonNullable<Awaited<ReturnType<RealmRoutes['get']>>['data']>['realm'];
export type RealmMediaReservation = Parameters<RealmRoutes['media']['post']>[0];

/**
 * The mounted Realm route owns parent authorization, reservation identity and native purpose. The caller's
 * exact-command key is forwarded unchanged so a repeated command finds the same reservation.
 */
export async function reserveRealmMedia(
  client: KernelClient,
  authorization: string | null,
  realmId: string,
  input: RealmMediaReservation,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<Media> {
  const result = await client.realms({ realmId }).media.post(input, {
    headers: {
      ...(authorization ? { authorization } : {}),
      'idempotency-key': JSON.stringify(idempotencyKey),
    },
  });
  if (result.error) {
    const value: unknown = result.error.value;
    if (
      value &&
      typeof value === 'object' &&
      'type' in value &&
      typeof value.type === 'string' &&
      'title' in value &&
      typeof value.title === 'string' &&
      'code' in value &&
      typeof value.code === 'string'
    ) {
      const retry = new Headers(result.headers).get('retry-after');
      throw new MediaProblem(
        { type: value.type, title: value.title, code: value.code, status: result.error.status },
        retry ? { 'retry-after': retry } : undefined,
      );
    }
    throw dependencyUnavailable(503);
  }
  if (
    !result.data?.media ||
    result.data.media.containerId !== realmId ||
    !('purpose' in result.data.media) ||
    result.data.media.purpose !== input.purpose
  )
    throw dependencyUnavailable(503);
  return result.data.media;
}

const active = (realm: Realm, realmId: string) =>
  realm.realmId === realmId &&
  realm.state === 'active' &&
  realm.ownershipState !== 'orphaned' &&
  !realm.governanceReadOnly;
const sameBinding = (before: Realm, final: Realm) =>
  active(final, before.realmId) &&
  final.headRevisionId === before.headRevisionId &&
  final.contextId === before.contextId &&
  final.spaceId === before.spaceId;
const concealed = (status: number) => [401, 403, 404].includes(status);

function rulesSummary(value: { postId: string; revisionId: string; body: DocumentSnapshot }): RealmRulesSummary {
  const text = documentText(value.body);
  const [first = '', ...rest] = text.split('\n');
  return {
    postId: value.postId,
    revisionId: value.revisionId,
    title: first.slice(0, 160),
    summary: rest.join('\n').slice(0, 800),
  };
}

/** One Realm, one viewer-actions batch, its native Space presentation, and the original final Realm binding. */
export async function readRealmAppearance(
  client: KernelClient,
  authorization: string | null,
  realmId: string,
): Promise<RealmAppearanceRead> {
  if (!authorization) return { kind: 'hidden' };
  const auth = { headers: { authorization } };
  try {
    const before = await client.realms({ realmId }).get(auth);
    if (before.error) return { kind: concealed(before.status) ? 'hidden' : 'unavailable' };
    if (!active(before.data.realm, realmId)) return { kind: 'hidden' };
    const actions = await client.viewerActions.post({ resources: [{ type: 'community.realm', id: realmId }] }, auth);
    if (actions.error) return { kind: concealed(actions.status) ? 'hidden' : 'unavailable' };
    if (
      !actions.data.resources.some(
        (resource) =>
          resource.type === 'community.realm' &&
          resource.id === realmId &&
          'viewerActions' in resource &&
          resource.viewerActions.some((action) => action.operations.includes('realm.update')),
      )
    )
      return { kind: 'hidden' };
    // An older/malformed response is a missing dependency, never synthetic empty settings.
    if (!before.data.realm.presentation) {
      const final = await client.realms({ realmId }).get(auth);
      return { kind: !final.error && sameBinding(before.data.realm, final.data.realm) ? 'unavailable' : 'hidden' };
    }
    const home = await client.spaces({ spaceId: before.data.realm.spaceId }).get(auth);
    if (home.error) return { kind: concealed(home.status) ? 'hidden' : 'unavailable' };
    const source = boardCommunitySource({ realmId, ...{ community: home.data.community } });
    const final = await client.realms({ realmId }).get(auth);
    if (final.error) return { kind: concealed(final.status) ? 'hidden' : 'unavailable' };
    if (
      !sameBinding(before.data.realm, final.data.realm) ||
      home.data.space.state !== 'active' ||
      home.data.space.spaceId !== final.data.realm.spaceId ||
      home.data.space.realmId !== realmId
    )
      return { kind: 'hidden' };
    if (!source || source.state !== 'available') return { kind: 'unavailable' };
    const community = source.value;
    const current = final.data.realm;
    if (
      community.spaceId !== current.spaceId ||
      community.contextId !== current.contextId ||
      community.name !== current.title ||
      community.description !== current.summary
    )
      return { kind: 'hidden' };
    for (const [image, id] of [
      [community.avatar, current.presentation.avatarMediaId],
      [community.banner, current.presentation.bannerMediaId],
    ] as const)
      if (image.state === 'available' && image.value.id !== id) return { kind: 'unavailable' };
    if (
      community.rules.state === 'available' &&
      (community.rules.value.postId !== current.presentation.rules?.postId ||
        community.rules.value.revisionId !== current.presentation.rules?.revisionId)
    )
      return { kind: 'unavailable' };
    return {
      kind: 'ready',
      snapshot: {
        realmId,
        head: current.headRevisionId,
        title: current.title,
        contextId: current.contextId,
        state: 'active',
        canManage: true,
        presentation: current.presentation,
        avatar: community.avatar,
        banner: community.banner,
        rules:
          community.rules.state === 'available'
            ? { state: 'available', value: rulesSummary(community.rules.value) }
            : community.rules,
      },
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** A lost response or a failed confirming read retains the caller's exact command for manual retry. */
export async function changeRealmAppearance(
  command: RealmAppearanceCommand,
  client?: KernelClient,
  authorization: string | null = null,
): Promise<RealmAppearanceResult> {
  if (!client) return { kind: 'unavailable' };
  if (!authorization) return { kind: 'denied' };
  try {
    const headers = {
      authorization,
      'if-match': JSON.stringify(command.head),
      'idempotency-key': JSON.stringify(command.key),
    };
    const result = await client
      .realms({ realmId: command.realmId })
      .patch({ presentation: command.presentation }, { headers });
    if (result.error) {
      if (concealed(result.status)) return { kind: 'denied' };
      if (result.status === 409 || result.status === 412) return { kind: 'conflict' };
      if (result.status === 400 || result.status === 422) return { kind: 'invalid' };
      return { kind: 'unavailable' };
    }
    const saved = result.data.realm;
    if (!active(saved, command.realmId) || !sameRealmPresentation(saved.presentation, command.presentation))
      return { kind: 'unavailable' };
    const read = await readRealmAppearance(client, authorization, command.realmId);
    if (read.kind !== 'ready') return { kind: 'unavailable', read };
    if (
      read.snapshot.head !== saved.headRevisionId ||
      read.snapshot.contextId !== saved.contextId ||
      !sameRealmPresentation(read.snapshot.presentation, command.presentation)
    )
      return { kind: 'unavailable' };
    return { kind: 'confirmed', snapshot: read.snapshot };
  } catch {
    return { kind: 'unavailable' };
  }
}

async function stillBound(client: KernelClient, authorization: string, snapshot: RealmAppearanceSnapshot) {
  const final = await client.realms({ realmId: snapshot.realmId }).get({ headers: { authorization } });
  return (
    !final.error &&
    active(final.data.realm, snapshot.realmId) &&
    final.data.realm.headRevisionId === snapshot.head &&
    final.data.realm.contextId === snapshot.contextId
  );
}

/** Preview current native facts only. A processed reservation is a reference awaiting the ordinary save's claim. */
export async function selectRealmAppearance(
  choice: RealmAppearanceChoice,
  client: KernelClient,
  authorization: string | null,
): Promise<RealmAppearanceSelection> {
  if (!authorization) return { kind: 'unavailable' };
  try {
    const read = await readRealmAppearance(client, authorization, choice.realmId);
    if (read.kind !== 'ready' || !read.snapshot.canManage) return { kind: 'unavailable' };
    const snapshot = read.snapshot;
    const auth = { headers: { authorization } };
    if (choice.kind === 'image') {
      const image = choice.purpose === 'realm-icon' ? snapshot.avatar : snapshot.banner;
      const selectedId =
        choice.purpose === 'realm-icon' ? snapshot.presentation.avatarMediaId : snapshot.presentation.bannerMediaId;
      if (selectedId === choice.mediaId)
        return image.state === 'available' && image.value.id === choice.mediaId
          ? { kind: 'image', image: image.value }
          : { kind: 'unavailable' };
      const result = await client.media({ id: choice.mediaId }).get(auth);
      if (
        result.error ||
        result.data.media.id !== choice.mediaId ||
        result.data.media.state !== 'available' ||
        result.data.media.containerId !== choice.realmId ||
        !('purpose' in result.data.media) ||
        result.data.media.purpose !== choice.purpose ||
        !(await stillBound(client, authorization, snapshot))
      )
        return { kind: 'unavailable' };
      return { kind: 'image-reference', mediaId: choice.mediaId, realmId: choice.realmId, purpose: choice.purpose };
    }
    if (
      snapshot.presentation.rules?.postId === choice.postId &&
      snapshot.presentation.rules.revisionId === choice.revisionId
    )
      return snapshot.rules.state === 'available'
        ? { kind: 'rules', rules: snapshot.rules.value }
        : { kind: 'unavailable' };
    const revision = () => client.posts({ id: choice.postId }).revisions({ revisionId: choice.revisionId }).get(auth);
    const before = await revision();
    if (before.error) return { kind: 'unavailable' };
    const post = before.data.post;
    if (
      post.id !== choice.postId ||
      post.availability !== 'available' ||
      !('revisionId' in post) ||
      post.revisionId !== choice.revisionId ||
      post.visibility !== 'published' ||
      !post.body ||
      post.body.profile !== 'text'
    )
      return { kind: 'unavailable' };
    const bytes = new TextEncoder().encode(serializeDocument(post.body));
    if (bytes.length > 65536) return { kind: 'unavailable' };
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    if (digest !== post.sha256 || !post.licence) return { kind: 'unavailable' };
    // The ordinary native revision read owns document/SPDX validity and source/ancestor disclosure.
    const board = await client.boards({ id: post.boardId }).get(auth);
    if (board.error || board.data.board.realmId !== choice.realmId) return { kind: 'unavailable' };
    const final = await revision();
    if (
      final.error ||
      final.data.post.availability !== 'available' ||
      !('revisionId' in final.data.post) ||
      final.data.post.revisionId !== choice.revisionId ||
      final.data.post.sha256 !== post.sha256 ||
      final.data.post.securityRevision !== post.securityRevision ||
      final.data.post.boardId !== post.boardId ||
      final.data.post.visibility !== 'published' ||
      !(await stillBound(client, authorization, snapshot))
    )
      return { kind: 'unavailable' };
    return { kind: 'rules', rules: rulesSummary({ ...choice, body: final.data.post.body }) };
  } catch {
    return { kind: 'unavailable' };
  }
}
