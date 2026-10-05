import type { MainClient } from '../discover/types.ts';

// Main's management shapes (`services/main/src/modules/management-reads/read-contract.ts`,
// `modules/realm-admin/contract.ts`, `modules/realm-submission/schema.ts`), taken from
// the typed Eden client so a contract change breaks this build.

/** The Eden client for Main: `mainApiWithToken()` on the server, `browserMainApi()` in the browser. */
export type { MainClient };
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Body<Call> = Call extends (body: infer Input, ...rest: never[]) => unknown ? Input : never;
type Realm = ReturnType<MainClient['v1']['realms']>;
type Submission = ReturnType<Realm['submissions']>;

/**
 * Main builds `submissionState` from a mapped array (`realm-submission/schema.ts`),
 * which its schema type reads as `never`; these are the values it validates.
 */
export type SubmissionState = 'pending' | 'deciding' | 'accepted' | 'rejected' | 'changes-requested' | 'withdrawn'
  | 'stale';
type RawModerationPage = Ok<Realm['moderation']['get']>;
type RawItem = RawModerationPage['items'][number];
export type ModerationItem = Omit<RawItem, 'submission'> & {
  submission: (Omit<NonNullable<RawItem['submission']>, 'state'> & { state: SubmissionState }) | null };
export type ModerationPage = Omit<RawModerationPage, 'items'> & { items: ModerationItem[] };
export type ModerationKind = ModerationItem['kind'];
export type AuditPage = Ok<Realm['audit']['get']>;
export type AuditItem = AuditPage['items'][number];
export type AuditKind = AuditItem['kind'];
export type PublicDecisionPage = Ok<Realm['decisions']['get']>;
export type PublicDecision = PublicDecisionPage['items'][number];
export type MemberPage = Ok<Realm['members']['get']>;
export type Member = MemberPage['items'][number];
export type MemberCommand = Body<Realm['members']['post']>;
export type MemberReceipt = Ok<Realm['members']['post']>;
export type RoleList = Ok<Realm['roles']['get']>;
export type Role = RoleList['roles'][number];
export type RealmPermission = Role['permissions'][number];
export type RoleCommand = Body<Realm['role-impact']['post']>;
export type RoleChange = RoleCommand['change'];
export type RoleImpact = Ok<Realm['role-impact']['post']>;
export type RoleReceipt = Ok<Realm['role-changes']['post']>;
export type SettingsView = Ok<Realm['settings']['get']>;
export type RealmSettings = SettingsView['settings'];
export type RealmRule = RealmSettings['rules'][number];
export type WhoMaySubmit = RealmSettings['whoMaySubmit'];
export type SettingsReceipt = Ok<Realm['settings']['put']>;
export type EscalationReceipt = Ok<Realm['escalations']['post']>;
export type InvitationCommand = Body<Realm['invitations']['post']>;
export type InvitationResult = Ok<Realm['invitations']['post']>;
export type InvitationPage = Ok<Realm['invitations']['get']>;
export type Invitation = InvitationPage['items'][number];
/** What a keep or remove decision must cite: the case, its retained reports and evidence, and the Realm's rules. */
export type DecisionBasis = Ok<ReturnType<Realm['moderation']>['get']>;
export type ModerationDecisionCommand = Body<MainClient['v1']['moderation']['decisions']['post']>;
export type ManagedRealmsPage = Ok<MainClient['v1']['me']['managed-realms']['get']>;
/** A Realm the acting Agent manages, with the permissions it holds there and its queue counts. */
export type ManagedRealm = ManagedRealmsPage['items'][number];
export type SubmissionReview = Ok<Submission['get']>;
export type SubmissionDecision = Body<Submission['decisions']['post']>;
export type SubmissionResult = Ok<Submission['decisions']['post']>;
export type RealmHeader = Ok<Realm['get']>;
export type RealmDirectoryPage = Ok<MainClient['v1']['realms']['get']>;
export type AgentProfile = Ok<ReturnType<MainClient['v1']['agents']>['get']>;
export type WorkHeader = Ok<ReturnType<MainClient['v1']['works']>['get']>;
/** Who submitted or reported, as this Realm knows them, and a queue Work's authors, mod card and prompt text. */
export type ModerationContext = Ok<Realm['moderation']['context']['get']>;
/** One person's membership and record here: their submissions for reviewers, their reports for moderators. */
export type PersonRecord = ModerationContext['people'][number];
/** A Work's authors, a mod's game, versions and loaders, and a prompt's or skill's text. */
export type WorkFacts = ModerationContext['works'][number];
export type ChapterRead = Ok<ReturnType<MainClient['v1']['chapters']>['get']>;
export type LocalizedName = RealmHeader['name'];
/** A rule as the Realm publishes it, in the reader's language; moderators cite rules by number. */
export type PublishedRule = NonNullable<RealmHeader['rules']>[number];
export type Avatar = RealmHeader['icon'];

/**
 * Why a management read has no data. `denied` is Main's 403, and its 404 for
 * management reads, which never says whether a Realm exists to someone who
 * cannot manage it; `moved` is its 409 when the basis changed under a cursor.
 */
export type ReadFailure = 'denied' | 'missing' | 'sign-in' | 'moved' | 'invalid' | 'budget' | 'unavailable';
export type Loaded<T> = { ok: true; data: T } | { ok: false; failure: ReadFailure };

export function failureOf(status: number, management = false): ReadFailure {
  if (status === 404) return management ? 'denied' : 'missing';
  if (status === 403) return 'denied';
  if (status === 401) return 'sign-in';
  if (status === 409) return 'moved';
  if (status === 400) return 'invalid';
  if (status === 422) return 'budget';
  return 'unavailable';
}

/** Main's problem code from an Eden error value, when it sent one. */
export function problemCode(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    ? value.code : undefined;
}

/** A person or organization as the workspace names them; `label` is null until Main answers. */
export interface AgentSummary { iri: string; label: string | null; handle: string | null }
/** A Work as a queue item shows it: its title in the reader's language and its cover. */
export interface WorkSummary { iri: string; title: LocalizedName; cover: Avatar; originalTitle: string | null;
  /** Main's semantic types, which choose the Work's cover. */
  types: readonly string[];
  /** The one-line hook, in the reader's language when Main has one. */
  tagline?: LocalizedName | null;
  completionStatus?: 'ongoing' | 'completed' | 'hiatus' | null;
  chapterCount?: number | null }

/** A chapter as the queue names and previews it: its label in its Book's contents and the start of its text. */
export interface ChapterSummary {
  label: { value: string; language: string } | null;
  /** The opening of the chapter's text, cut at a paragraph near `CHAPTER_EXCERPT` characters. */
  excerpt: string | null; truncated: boolean; language: string; direction: 'ltr' | 'rtl' | undefined }

export const uuidOf = (iri: string) => iri.slice(-36);
export const iriOf = (uuid: string) => `https://rezics.com/id/${uuid}`;
export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
