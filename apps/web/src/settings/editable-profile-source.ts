import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';

type ProfileRead = ReturnType<KernelClient['accounts']>['profile']['get'];
export type EditableProfile = NonNullable<Awaited<ReturnType<ProfileRead>>['data']>['profile'];

/** The private source uses the same server-held credential and account key as the existing PATCH. */
export type EditableProfileSource = {
  read: (authorization: string, accountId: string) => Promise<EditableProfile>;
};

const dimension = v.pipe(v.number(), v.integer(), v.minValue(1));
const coordinate = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const fields = {
  id: v.string(),
  handle: v.nullable(v.string()),
  displayName: v.nullable(v.string()),
  bio: v.nullable(v.string()),
  links: v.pipe(v.array(v.strictObject({ label: v.string(), url: v.string() })), v.maxLength(5)),
  avatar: v.nullable(
    v.strictObject({
      media: v.string(),
      width: dimension,
      height: dimension,
      placeholder: v.strictObject({ thumbhash: v.string(), color: v.string() }),
      variants: v.array(v.strictObject({ format: v.picklist(['avif', 'webp']), width: dimension })),
      focalPoint: v.nullable(v.strictObject({ x: coordinate, y: coordinate })),
      credit: v.null(),
    }),
  ),
  publicViews: v.strictObject({
    posts: v.boolean(),
    reviews: v.boolean(),
    collections: v.boolean(),
    realms: v.boolean(),
  }),
};
// Mirror the integrated route's closed actor/organization bodies, including Content's actual avatar summary.
const response = v.strictObject({
  profile: v.variant('kind', [
    v.strictObject({ ...fields, kind: v.literal('actor') }),
    v.strictObject({ ...fields, kind: v.literal('organization'), speakersListed: v.boolean() }),
  ]),
});

export function createEditableProfileSource(client: KernelClient): EditableProfileSource {
  return {
    async read(authorization, accountId) {
      const result = await client.accounts({ accountId }).profile.get({
        headers: { authorization, 'cache-control': 'no-store' },
        fetch: { cache: 'no-store' },
      });
      if (result.error || !result.data) throw new Error('Profile unavailable');
      const { profile } = v.parse(response, result.data);
      if (profile.id !== accountId) throw new Error('Profile unavailable');
      return profile;
    },
  };
}
