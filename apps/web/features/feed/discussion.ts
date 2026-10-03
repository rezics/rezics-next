import { spaceHref, threadHref, type AddressTarget } from '../address/path.ts';
// How a discussion reads. Main titles a discussion by its author's first line
// (`services/main/src/modules/realm-reply/discussion-text.ts`) but keeps no
// spoiler flag: people announce spoilers in that title ("【剧透】…",
// "Spoilers (chapter 35): …"), as on forums. These functions only read that
// convention; they never invent a title, flair or flag the author did not write.

// A spoiler announcement at the start of the title, bracketed or not.
const spoilerMark = /^\s*[【[(（「『]?\s*(?:剧透|劇透|ネタバレ|스포일러|spoilers?\b|spoiler alert\b)/iu;

/** Whether the author announced spoilers in the title, so the body stays veiled until the reader asks. */
export function announcesSpoilers(title: string): boolean {
  return spoilerMark.test(title);
}

/** A thread's page: `/r/{realm}/discussions/{reply}`, under the Realm's Zone segment when it has one. */
export function threadPath(realmPath: string, reply: string): string {
  return threadHref(realmPath, reply);
}

/** A community's native identity or known name, through the shared address builder. */
export function communityHref(realm: AddressTarget, name?: string): string {
  return spaceHref(typeof realm === 'string' ? name ?? realm : realm, 'community');
}
