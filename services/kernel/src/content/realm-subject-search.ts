import { contentRealmApplication } from './adapters/realm-binding.ts';
/** The installed application receives the original Pool and Semantic reader. */
export function createRealmSubjectSearchSource(
  ...args: Parameters<ReturnType<typeof contentRealmApplication>['search']['source']>
) {
  return contentRealmApplication().search.source(...args);
}
