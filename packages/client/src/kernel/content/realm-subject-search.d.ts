import { contentRealmApplication } from './adapters/realm-binding.ts';
/** The installed application receives the original Pool and Semantic reader. */
export declare function createRealmSubjectSearchSource(...args: Parameters<ReturnType<typeof contentRealmApplication>['search']['source']>): import("./realm-subject-source.ts").RealmSubjectSource | undefined;
