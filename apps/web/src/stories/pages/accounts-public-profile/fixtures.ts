import recording from '../../../kernel/recorded/agent-page.json';
import readerRecording from '../../../kernel/recorded/agent-page-reader.json';
import type { SubjectPageData } from '../../../features/pages/subject';
import { isRecord } from '../../../features/pages/shared';

/** Public recordings with small wire-state variations; no private verification request is used. */
export function profilePage(
  options: {
    verified?: boolean;
    profile?: Record<string, unknown>;
    activityStatus?: number;
    empty?: boolean;
  } = {},
): SubjectPageData {
  const source = structuredClone(options.verified ? recording : readerRecording);
  const page = { ...source, account: { id: source.account, handle: source.handle } } as unknown as SubjectPageData;
  for (const result of Object.values(page.reads)) {
    if (!isRecord(result.body)) continue;
    if (Array.isArray(result.body.accounts)) {
      result.body.accounts = result.body.accounts.map((profile) =>
        isRecord(profile)
          ? {
              ...profile,
              publicViews: { posts: true, reviews: true, collections: true, realms: true },
              ...options.profile,
            }
          : profile,
      );
    }
    for (const field of ['posts', 'threads', 'collections'])
      if (Array.isArray(result.body[field])) {
        if (options.activityStatus) {
          result.status = options.activityStatus;
          result.body = {};
          break;
        }
        if (options.empty) {
          result.body[field] = [];
          result.body.next = null;
        }
      }
  }
  return page;
}
