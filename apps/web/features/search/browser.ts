import { browserMainApi } from '../api/browser.ts';

/** Viewer suggestions may depend on the account even without a selected Agent. */
export function readBrowserTypeahead(prefix: string, language?: string, signedIn = true) {
  return browserMainApi(undefined, { anonymous: !signedIn }).v1.search.typeahead.get({
    query: { prefix, ...(language ? { language } : {}) },
  });
}
