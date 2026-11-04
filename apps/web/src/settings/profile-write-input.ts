import * as v from 'valibot';
import { accountProfileEditingSchema } from './editable-profile-source';

const profile = v.object({
  accountId: v.string(),
  kind: v.picklist(['actor', 'organization']),
  displayName: v.nullable(v.string()),
  biography: v.nullable(v.string()),
  avatar: v.nullable(v.object({ media: v.string() })),
  links: v.array(v.object({ label: v.string(), url: v.string() })),
  publicViews: v.object({ posts: v.boolean(), reviews: v.boolean(), collections: v.boolean(), realms: v.boolean() }),
  speakersListed: v.exactOptional(v.boolean()),
  editing: accountProfileEditingSchema,
});
const submission = v.object({ before: profile, after: profile, idempotencyKey: v.pipe(v.string(), v.uuid()) });

/** Parse the BFF payload without treating a submitted snapshot as identity or write authority. */
export function parseProfileWrite(input: unknown) {
  return v.parse(submission, input);
}
