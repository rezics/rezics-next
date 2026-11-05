import { checkDocument, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import type { CommunityPresentation } from '../../../../packages/client/src/kernel/content/community-presentation-model';
import type {
  RealmPresentationImage,
  RealmPresentationOptional,
} from '../../../../packages/client/src/kernel/content/realm-media';
import * as v from 'valibot';

export type { CommunityPresentation, RealmPresentationImage, RealmPresentationOptional };

/** Null is exclusively Global. An uninstalled/unreadable optional producer has no cached positive value. */
export type BoardCommunitySource =
  | Readonly<{ state: 'available'; value: CommunityPresentation }>
  | Readonly<{ state: 'unavailable'; value: null }>
  | null;

const id = v.pipe(v.string(), v.uuid());
const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
const dimension = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const coordinate = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const credit = v.strictObject({
  rightsHolder: v.string(),
  via: v.strictObject({ name: v.string(), url: v.pipe(v.string(), v.url(), v.startsWith('https://')) }),
  license: v.string(),
  obligations: v.pipe(
    v.array(v.picklist(['cc:Attribution', 'cc:ShareAlike', 'cc:Notice', 'cc:SourceCode'])),
    v.maxLength(4),
  ),
});
const image = v.strictObject({
  id,
  containerId: id,
  digest,
  width: dimension,
  height: dimension,
  variants: v.pipe(
    v.array(v.strictObject({ format: v.picklist(['avif', 'webp']), width: dimension, height: dimension })),
    v.minLength(1),
    v.maxLength(12),
  ),
  placeholder: v.nullable(v.strictObject({ thumbhash: v.string(), color: v.string() })),
  focalPoint: v.nullable(v.strictObject({ x: coordinate, y: coordinate })),
  credit: v.nullable(credit),
});
function optional<T extends v.GenericSchema>(value: T) {
  return v.variant('state', [
    v.strictObject({ state: v.literal('available'), value }),
    v.strictObject({ state: v.picklist(['none', 'unavailable']), value: v.null() }),
  ]);
}
const presentation = v.strictObject({
  realmId: id,
  spaceId: id,
  contextId: id,
  name: v.string(),
  description: v.string(),
  avatar: optional(image),
  banner: optional(image),
  members: v.variant('state', [
    v.strictObject({
      state: v.literal('current'),
      count: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
      version: v.pipe(v.string(), v.minLength(1)),
    }),
    v.strictObject({ state: v.literal('unknown'), count: v.null(), version: v.null() }),
  ]),
  rules: optional(
    v.strictObject({
      postId: id,
      revisionId: id,
      body: v.pipe(
        v.custom<DocumentSnapshot>(checkDocument),
        v.check((body) => body.profile === 'text' && new TextEncoder().encode(serializeDocument(body)).length <= 65536),
      ),
      licence: v.string(),
      sha256: digest,
    }),
  ),
  join: v.strictObject({
    membership: v.picklist(['member', 'nonmember', 'unknown']),
    action: v.nullable(v.picklist(['join', 'leave', 'sign-in'])),
  }),
}) satisfies v.GenericSchema<CommunityPresentation>;

/** Consume only the existing board response. No guessed endpoint, count read or per-card enrichment. */
export function boardCommunitySource(board: { realmId: string | null }): BoardCommunitySource {
  if (board.realmId === null) return null;
  if (!('community' in board)) return { state: 'unavailable', value: null };
  const parsed = v.safeParse(presentation, board.community);
  if (!parsed.success || parsed.output.realmId !== board.realmId) return { state: 'unavailable', value: null };
  const community = parsed.output;
  for (const slot of [community.avatar, community.banner])
    if (slot.state === 'available' && slot.value.containerId !== board.realmId)
      return { state: 'unavailable', value: null };
  return { state: 'available', value: community };
}
