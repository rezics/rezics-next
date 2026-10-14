import type { VerifiedPrincipal } from '../access/admission.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { DEFAULT_MEDIA_CONTEXT } from './store.ts';

/** A reply has no resource-summary title. Its Content owner and current Realm
 * placement establish its audience, just as they do for a direct reply read. */
export async function readableReplyAttachments(
  replies: MainWorkDependencies['realmReplies'], resources: readonly string[], context: string,
  principal?: VerifiedPrincipal, actor?: string,
): Promise<ReadonlySet<string>> {
  const available = new Set<string>();
  if (!replies) return available;
  for (let offset = 0; offset < resources.length; offset += 32) {
    const batch = resources.slice(offset, offset + 32);
    const results = await replies.readPublicBatch(batch, principal, actor);
    for (const [index, result] of results.entries()) {
      // A Use cannot select a sibling Realm or manufacture an independent audience.
      if (result && (result.originRealm ?? DEFAULT_MEDIA_CONTEXT) === context) available.add(batch[index]!);
    }
  }
  return available;
}
