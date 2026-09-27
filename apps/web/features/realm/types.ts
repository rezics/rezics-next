import type { MainClient } from '../discover/types.ts';

// Main's Realm, Zone presentation and Zone module read shapes, taken from the
// typed Eden client so a contract change breaks this build.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Realm = ReturnType<MainClient['v1']['realms']>;
type Zone = ReturnType<MainClient['v1']['zones']>;

export type RealmHeader = Ok<Realm['get']>;
export type RealmWorksPage = Ok<Realm['works']['get']>;
export type RealmWork = RealmWorksPage['items'][number];
export type RealmDecisionsPage = Ok<Realm['decisions']['get']>;
export type RealmDecision = RealmDecisionsPage['items'][number];
export type ZoneWorkPage = Ok<Realm['modules']['new-adoptions']['get']>;
export type ZoneChapterPage = Ok<Realm['modules']['latest-chapters']['get']>;
export type ZoneDecisionPage = Ok<Realm['modules']['recent-decisions']['get']>;
export type RankingPage = Ok<Realm['rankings']['get']>;
export type RankingMetric = RankingPage['metric'];
export type ZonePresentationRead = Ok<Zone['presentation']['get']>;
export type RealmDirectoryPage = Ok<MainClient['v1']['realms']['get']>;
export type OfficialZone = Ok<ReturnType<MainClient['v1']['zones']['by-segment']>['get']>;
/** The Work card fields every Realm and Zone module read shares. */
export type WorkCard = Pick<RealmWork, 'id' | 'title' | 'cover' | 'types' | 'tagline' | 'completionStatus'
  | 'chapterCount' | 'wordCount' | 'lastUpdatedAt'>;
export type MainName = RealmHeader['name'];
export type MainAvatar = RealmHeader['icon'];

/** Why a region has no data. Each region shows its own; the rest of the page stays. */
export type ReadFailure = 'missing' | 'moved' | 'invalid' | 'budget' | 'unavailable';

export type Loaded<T> = { ok: true; data: T } | { ok: false; failure: ReadFailure };

export function failureOf(status: number): ReadFailure {
  if (status === 404 || status === 410 || status === 401 || status === 403) return 'missing';
  if (status === 409) return 'moved';
  if (status === 400) return 'invalid';
  if (status === 422) return 'budget';
  return 'unavailable';
}
