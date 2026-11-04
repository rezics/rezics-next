import * as v from 'valibot';
import type { ProfileValues } from './profile-data';
import { profileFieldErrors } from './profile-write';

const profile = v.strictObject({
  accountId: v.string(),
  kind: v.picklist(['actor', 'organization']),
  displayName: v.nullable(v.pipe(v.string(), v.maxLength(4096))),
  biography: v.nullable(v.pipe(v.string(), v.maxLength(4096))),
  // Project only the reference from Content's summary; no client-supplied media metadata is trusted.
  avatar: v.nullable(v.object({ media: v.string() })),
  links: v.pipe(v.array(v.strictObject({ label: v.string(), url: v.string() })), v.maxLength(5)),
  publicViews: v.strictObject({
    posts: v.boolean(),
    reviews: v.boolean(),
    collections: v.boolean(),
    realms: v.boolean(),
  }),
  speakersListed: v.exactOptional(v.boolean()),
});
const submission = v.strictObject({ before: profile, after: profile, idempotencyKey: v.pipe(v.string(), v.uuid()) });

/** Parse the BFF payload without treating a submitted snapshot as identity or write authority. */
export function parseProfileWrite(input: unknown) {
  const parsed = v.parse(submission, input);
  if (parsed.before.kind !== parsed.after.kind) throw new Error('Profile kind changed');
  if (parsed.after.kind !== 'organization' && 'speakersListed' in parsed.after)
    throw new Error('Speaker listing requires an organization');
  if (Object.keys(profileFieldErrors(parsed.after as ProfileValues)).length) throw new Error('Invalid profile fields');
  return parsed;
}
