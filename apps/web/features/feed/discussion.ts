import { spaceHref, threadHref, type AddressTarget } from '../address/path.ts';
// How a discussion reads. Main titles a discussion by its author's first line
// (`services/main/src/modules/realm-reply/discussion-text.ts`). Spoilers are the
// post's `spoiler` declaration, in every language; a title is never one.

/** Whether the author declared spoilers. Absent and `false` both leave the words visible. */
export function markedSpoiler(spoiler: boolean | undefined): boolean {
  return spoiler === true;
}

/** A thread's page: `/r/{realm}/discussions/{reply}`, under the Realm's Zone segment when it has one. */
export function threadPath(realmPath: string, reply: string): string {
  return threadHref(realmPath, reply);
}

/** A community's native identity or known name, through the shared address builder. */
export function communityHref(realm: AddressTarget, name?: string): string {
  return spaceHref(typeof realm === 'string' ? name ?? realm : realm, 'community');
}
