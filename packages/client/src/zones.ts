import type { KernelClient, ZoneCollectionPublicView } from './index.ts';

type ZonePath = ReturnType<KernelClient['zones']>;
type ZoneCollectionsEndpoint = ZonePath['collections'];
type ZoneCollectionsGet = ZoneCollectionsEndpoint['get'];
type ZoneCollectionsResponse = { collections: ZoneCollectionPublicView[]; next: string | null };
type ZoneCollectionsCallResult = Awaited<ReturnType<ZoneCollectionsGet>>;

/** The mounted Zone resource schema is selected by Library at composition time. */
export type ZoneCollectionsClient = Omit<ZoneCollectionsEndpoint, 'get'> & {
  get: (
    ...args: Parameters<ZoneCollectionsGet>
  ) => Promise<Omit<ZoneCollectionsCallResult, 'data'> & { data: ZoneCollectionsResponse | null }>;
};
export type ZoneCollectionsQuery = NonNullable<Parameters<ZoneCollectionsGet>[0]>['query'];
export type ZoneCollectionsCall = Awaited<ReturnType<ZoneCollectionsClient['get']>>;
export type ZoneCollectionsPage = NonNullable<ZoneCollectionsCall['data']>;

export type ZoneReadPageClient = ZonePath['$readPage'];
export type ZoneReadPageBody = Parameters<ZoneReadPageClient['post']>[0];
export type ZoneReadPageCall = Awaited<ReturnType<ZoneReadPageClient['post']>>;
export type ZoneReadPageResult = NonNullable<ZoneReadPageCall['data']>;

export type ZoneSubjectsClient = ZonePath['subjects'];
export type ZoneSubjectsQuery = NonNullable<Parameters<ZoneSubjectsClient['get']>[0]>['query'];
export type ZoneSubjectsCall = Awaited<ReturnType<ZoneSubjectsClient['get']>>;
export type ZoneSubjectListPage = Extract<NonNullable<ZoneSubjectsCall['data']>, { subjects: unknown }>;
export type ZoneSubjectListItem = ZoneSubjectListPage['subjects'][number];
export type ZoneSubjectListProgress = Exclude<NonNullable<ZoneSubjectsCall['data']>, ZoneSubjectListPage>;

/** Return the generated, native Zone Collection endpoint for the selected Zone. */
export function zoneCollections(client: KernelClient, zoneId: string): ZoneCollectionsClient {
  return client.zones({ id: zoneId }).collections as ZoneCollectionsClient;
}

/** Return the generated Zone page composition for the selected Zone. */
export function zoneReadPage(client: KernelClient, zoneId: string): ZoneReadPageClient {
  return client.zones({ id: zoneId }).$readPage;
}

/** Return the native canonical Zone subject list for the selected Zone. */
export function zoneSubjects(client: KernelClient, zoneId: string): ZoneSubjectsClient {
  return client.zones({ id: zoneId }).subjects;
}
