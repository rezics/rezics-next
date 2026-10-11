import { browserMainApi } from '../api/browser.ts';

/** Community choices are the public directory, independently of who is composing. */
export function readPublicRealmChoices(q?: string, cursor?: string) {
  return browserMainApi(undefined, { anonymous: true }).v1.realms.get({
    query: { limit: 20, sort: 'activity', ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) },
  });
}
