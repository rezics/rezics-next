import { t } from 'elysia';
import { Compile } from 'typebox/compile';

export type RealmPresentation = Readonly<{
  avatarMediaId: string | null;
  bannerMediaId: string | null;
  rules: Readonly<{ postId: string; revisionId: string }> | null;
}>;
const closed = { additionalProperties: false } as const;
const id = t.String({
  format: 'uuid',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
export const RealmPresentationSchema = t.Object(
  {
    avatarMediaId: t.Union([id, t.Null()]),
    bannerMediaId: t.Union([id, t.Null()]),
    rules: t.Union([t.Object({ postId: id, revisionId: id }, closed), t.Null()]),
  },
  closed,
);
const validator = Compile(RealmPresentationSchema);
export const emptyRealmPresentation: RealmPresentation = Object.freeze({
  avatarMediaId: null,
  bannerMediaId: null,
  rules: null,
});
export function realmPresentation(value: unknown): RealmPresentation {
  if (!validator.Check(value)) throw new TypeError('Invalid Realm presentation');
  return Object.freeze({
    avatarMediaId: value.avatarMediaId,
    bannerMediaId: value.bannerMediaId,
    rules: value.rules && Object.freeze({ postId: value.rules.postId, revisionId: value.rules.revisionId }),
  });
}
