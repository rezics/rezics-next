import * as v from 'valibot';
import type { DocumentImagePresentation } from '../../threads/document-media';
import { isRecord } from './shared';

/** Consumer seam, not a claim that ordinary ThreadView or reviewContext supplies historical facts. */
export const COMMUNITY_CARD_BYTES = 32 * 1024;
export const COMMUNITY_ROW_BYTES = 2 * 1024 * 1024 + 64 * 1024;
export const COMMUNITY_PROJECTED_BYTES = 48 * 1024;
export const COMMUNITY_MEDIA_LIMIT = 2;
export const COMMUNITY_TEXT_LIMIT = 4096;
export const COMMUNITY_POSITION_LIMIT = 20;
const id = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/));
const text = v.pipe(v.string(), v.maxLength(COMMUNITY_TEXT_LIMIT));
const revision = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(2_147_483_647));
const units = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(4096));
const scale = v.pipe(
  v.strictObject({ min: units, max: units, displayStep: v.pipe(units, v.minValue(1)) }),
  v.check((value) => value.min < value.max && (value.max - value.min) % value.displayStep === 0),
);
const citation = v.variant('state', [
  v.strictObject({ state: v.literal('withheld') }),
  v.strictObject({ state: v.literal('absent') }),
  v.strictObject({
    state: v.literal('available'),
    postRevisionId: id,
    recorded: v.strictObject({ questionId: id, units, revision }),
    question: v.strictObject({
      id,
      revision,
      label: text,
      scale,
      lifecycle: v.strictObject({ state: v.picklist(['active', 'retired']), revision }),
    }),
    originalTarget: v.strictObject({ id, label: v.nullable(text), mergedInto: v.nullable(id) }),
  }),
]);
const dimension = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(65536));
const coordinate = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const creditText = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
const image = v.strictObject({
  id,
  containerId: id,
  digest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  width: dimension,
  height: dimension,
  variants: v.pipe(
    v.array(v.strictObject({ format: v.picklist(['avif', 'webp']), width: dimension, height: dimension })),
    v.minLength(1),
    v.maxLength(12),
    v.check((values) => new Set(values.map((value) => `${value.format}:${value.width}`)).size === values.length),
  ),
  placeholder: v.nullable(
    v.strictObject({ thumbhash: v.pipe(v.string(), v.maxLength(128)), color: v.pipe(v.string(), v.maxLength(64)) }),
  ),
  focalPoint: v.nullable(v.strictObject({ x: coordinate, y: coordinate })),
  credit: v.nullable(
    v.strictObject({
      rightsHolder: creditText,
      via: v.strictObject({ name: creditText, url: v.pipe(creditText, v.regex(/^https:\/\/[^\s]+$/)) }),
      license: v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9.+-]{0,79}$/)),
      obligations: v.pipe(
        v.array(v.picklist(['cc:Attribution', 'cc:ShareAlike', 'cc:Notice', 'cc:SourceCode'])),
        v.maxLength(4),
        v.check((values) => new Set(values).size === values.length),
      ),
    }),
  ),
}) satisfies v.GenericSchema<DocumentImagePresentation>;
const date = v.pipe(
  v.string(),
  v.maxLength(40),
  v.check((value) => Number.isFinite(Date.parse(value))),
);
const card = v.strictObject({
  version: v.literal(1),
  threadId: id,
  postRevisionId: id,
  citation,
  activity: v.nullable(
    v.strictObject({ replyCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)), lastActivityAt: date }),
  ),
  media: v.pipe(
    v.array(v.strictObject({ alt: text, image })),
    v.maxLength(COMMUNITY_MEDIA_LIMIT),
    v.check((values) => new Set(values.map((value) => value.image.id)).size === values.length),
  ),
});

export type CommunityCard = v.InferOutput<typeof card>;

const presentation = v.strictObject({
  state: v.literal('current'),
  language: v.nullable(v.pipe(v.string(), v.maxLength(256))),
  spoiler: v.boolean(),
});
const author = v.object({ displayName: v.nullable(text), handle: v.nullable(text) });
const comments = v.strictObject({
  state: v.literal('current'),
  cohort: v.literal('public'),
  count: v.strictObject({
    kind: v.picklist(['exact', 'lower-bound']),
    value: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  lastActivityAt: v.nullable(date),
  source: v.strictObject({
    epoch: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    position: v.pipe(v.string(), v.maxLength(COMMUNITY_POSITION_LIMIT), v.regex(/^[0-9]+$/)),
  }),
});

/** A bounded display projection of Content's installed card, separate from historical provenance. */
export type CommunityNativeCard = {
  author: v.InferOutput<typeof author> | null;
  presentation: v.InferOutput<typeof presentation> | null;
  comments: v.InferOutput<typeof comments> | null;
  media: { alt: string; image: DocumentImagePresentation }[];
};

export function projectNativeCommunityCard(
  value: unknown,
  source: { postId: string; mediaIds: readonly unknown[]; images: ReadonlyMap<string, string> },
): CommunityNativeCard | undefined {
  if (
    !isRecord(value) ||
    value.state !== 'current' ||
    !isRecord(value.currentness) ||
    value.currentness.source !== 'current' ||
    value.currentness.place !== 'current'
  )
    return;
  const currentness = value.currentness;
  const display = v.safeParse(presentation, value.presentation);
  const identity =
    isRecord(value.authors) &&
    isRecord(value.authors.thread) &&
    value.authors.thread.state === 'current' &&
    currentness.authors === 'current'
      ? v.safeParse(author, value.authors.thread.identity)
      : null;
  const activity = currentness.comments === 'current' ? v.safeParse(comments, value.comments) : null;
  const media: CommunityNativeCard['media'] = [];
  if (
    currentness.media === 'current' &&
    isRecord(value.media) &&
    value.media.state === 'available' &&
    withinCommunityBytes(value.media, COMMUNITY_CARD_BYTES)
  ) {
    const images = v.safeParse(v.pipe(v.array(image), v.maxLength(32)), value.media.images);
    if (
      images.success &&
      new Set(images.output.map((item) => item.id)).size === images.output.length &&
      images.output.every(
        (item) => item.containerId === source.postId && source.mediaIds.includes(item.id) && source.images.has(item.id),
      )
    ) {
      for (const item of images.output.slice(0, COMMUNITY_MEDIA_LIMIT))
        media.push({ image: item, alt: source.images.get(item.id)! });
    }
  }
  return {
    author: identity?.success ? identity.output : null,
    presentation: display.success ? display.output : null,
    comments: activity?.success ? activity.output : null,
    media,
  };
}

/** Bound accepted JSON bytes, including unknown fields, before retaining a projected card. */
export function withinCommunityBytes(value: unknown, maximum: number): boolean {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' && json.length <= maximum && new TextEncoder().encode(json).length <= maximum;
  } catch {
    return false;
  }
}

/** Historical facts must bind the exact first-post revision and recorded citation, not a current question read. */
export function projectCommunityCard(
  value: unknown,
  source: {
    id: string;
    postRevisionId: unknown;
    mediaIds: unknown;
    citation: { questionId: string; units: number; revision: number } | null | undefined;
  },
): CommunityCard | undefined {
  if (!withinCommunityBytes(value, COMMUNITY_CARD_BYTES)) return;
  const parsed = v.safeParse(card, value);
  if (!parsed.success) return;
  const result = parsed.output;
  if (result.threadId !== source.id || result.postRevisionId !== source.postRevisionId) return;
  if (
    result.media.some(
      ({ image }) =>
        image.containerId !== source.id || !Array.isArray(source.mediaIds) || !source.mediaIds.includes(image.id),
    )
  )
    return;
  if (result.citation.state === 'absent' && source.citation !== null) return;
  if (result.citation.state === 'available') {
    const { recorded, question } = result.citation;
    if (
      !source.citation ||
      result.citation.postRevisionId !== source.postRevisionId ||
      recorded.questionId !== source.citation.questionId ||
      recorded.units !== source.citation.units ||
      recorded.revision !== source.citation.revision ||
      question.id !== recorded.questionId ||
      recorded.units < question.scale.min ||
      recorded.units > question.scale.max ||
      (recorded.units - question.scale.min) % question.scale.displayStep !== 0
    )
      return;
  }
  return result;
}
