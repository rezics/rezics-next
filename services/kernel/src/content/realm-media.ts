import { memoizedValue } from '../memoized.ts';
import { Compile } from 'typebox/compile';
import type { Pool } from 'pg';
import { authoritativeTimeValue, currentCommand, type CommandTransaction } from '../command/command.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { Access, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { ReadContext } from './model.ts';
import { MediaUnavailableError } from './media.ts';
import claim from './realm-media-claim.sql';
import settings from './realm-media-settings.sql';
import { authorizedRealmMedia, realmMediaVariants } from './realm-media-read.ts';
import {
  RealmPresentationImageSchema,
  type RealmPresentationImage,
  type RealmPresentationOptional,
} from './realm-presentation-image.ts';

export {
  RealmPresentationImageSchema,
  type RealmPresentationImage,
  type RealmPresentationOptional,
} from './realm-presentation-image.ts';
function imageValidator() {
  return memoizedValue(imageValidator, () => Compile(RealmPresentationImageSchema()));
}

/** Exact JSON summary shared by native presentation consumers; never download authority. */
export function exactRealmPresentationImage(
  value: RealmPresentationImage,
): import('typebox').Static<ReturnType<typeof RealmPresentationImageSchema>> | null {
  if (!imageValidator().Check(value)) return null;
  return { ...value, variants: value.variants.map((variant) => ({ ...variant })) };
}

/** Called after the native settings revision/head writes, within their authorized command.
 * Null slots never undo claims made by an immutable earlier Realm revision. */
export async function claimRealmPresentationMedia(
  tx: CommandTransaction,
  input: Readonly<{ realmId: string; author: Actor; avatarMediaId: string | null; bannerMediaId: string | null }>,
): Promise<void> {
  const command = currentCommand(tx);
  const route = routeOf(input.realmId);
  if (
    route === null ||
    input.author.kind !== 'account' ||
    command.partition !== partitionOf(route) ||
    command.basis?.actorAccountId !== input.author.accountId ||
    command.basis.clientId !== input.author.clientId ||
    command.basis.requestedBy !== input.author.requestedBy ||
    command.authorization?.mode !== 'execute' ||
    command.authorization.action !== 'realm:manage' ||
    command.authorization.resource.route !== route ||
    command.authorization.resource.id !== input.realmId
  )
    throw new GrantDeniedError();
  if (!(await settings.run(tx, { route, realm_id: input.realmId, author_id: input.author.accountId })))
    throw new GrantDeniedError();
  const slots = [
    { id: input.avatarMediaId, purpose: 'realm-icon' },
    { id: input.bannerMediaId, purpose: 'realm-banner' },
  ].filter((slot): slot is { id: string; purpose: string } => slot.id !== null);
  if (new Set(slots.map((slot) => slot.id)).size !== slots.length || slots.some((slot) => routeOf(slot.id) !== route))
    throw new MediaUnavailableError();
  // Stable lock order for the at most two exact media keys.
  for (const slot of slots.sort((left, right) => left.id.localeCompare(right.id))) {
    if (
      (
        await claim.run(tx, {
          route,
          realm_id: input.realmId,
          uploader_id: input.author.accountId,
          media_id: slot.id,
          purpose: slot.purpose,
          at: authoritativeTimeValue(command.time),
        })
      ).length !== 1
    )
      throw new MediaUnavailableError();
  }
}

export async function readRealmPresentationImages(
  deps: Readonly<{ pool: Pool; access: Access; clock?: () => Date }>,
  input: Readonly<{ realmId: string; avatarMediaId: string | null; bannerMediaId: string | null }>,
  context: ReadContext,
): Promise<
  Readonly<{
    avatar: RealmPresentationOptional<RealmPresentationImage>;
    banner: RealmPresentationOptional<RealmPresentationImage>;
  }>
> {
  const none = { state: 'none', value: null } as const;
  try {
    const rows = await authorizedRealmMedia(deps, input.realmId, [input.avatarMediaId, input.bannerMediaId], context);
    const image = (id: string | null, purpose: string): RealmPresentationOptional<RealmPresentationImage> => {
      const row = id === null ? undefined : rows.get(id);
      if (!row || row.purpose !== purpose) return none;
      const variants = realmMediaVariants(row);
      const largest = variants.reduce<(typeof variants)[number] | null>(
        (current, value) => (current === null || value.width > current.width ? value : current),
        null,
      );
      if (!largest || !row.sha256) return none;
      return {
        state: 'available',
        value: {
          id: row.media_id,
          containerId: row.container_id,
          digest: largest.sha256,
          width: largest.width,
          height: largest.height,
          variants: variants.map(({ format, width, height }) => ({ format, width, height })),
          placeholder:
            row.thumbhash && row.average_color && /^#[0-9a-f]{6}$/i.test(row.average_color)
              ? { thumbhash: row.thumbhash, color: row.average_color }
              : null,
          focalPoint: row.focal_x === null || row.focal_y === null ? null : { x: row.focal_x, y: row.focal_y },
          credit: null,
        },
      };
    };
    return { avatar: image(input.avatarMediaId, 'realm-icon'), banner: image(input.bannerMediaId, 'realm-banner') };
  } catch (error) {
    if (error instanceof GrantDeniedError) return { avatar: none, banner: none };
    // Optional dependency failure never returns cached facts or identifying reasons.
    const unavailable = { state: 'unavailable', value: null } as const;
    return {
      avatar: input.avatarMediaId === null ? none : unavailable,
      banner: input.bannerMediaId === null ? none : unavailable,
    };
  }
}
