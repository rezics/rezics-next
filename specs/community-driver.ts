import type { DocumentSnapshot } from '@rezics/document';
import type { GrowthDatabase } from '../services/kernel/test/support/growth';

/**
 * COMMUNITY_DRIVER is an absolute path or file URL exporting
 * createCommunityDriver(): Promise<CommunityDriver>. Every factory call owns an
 * isolated migrated PostgreSQL database, real Auth-issued credentials, production
 * createAccess, createKernel.handle and the actual durable-work worker. Partial
 * setup failures clean themselves up; close removes only this call's resources.
 * No authorization, state transition, response, receipt or rank is simulated.
 *
 * Fixture accounts may be provisioned in setup. All grants and business changes
 * use the API, including fixture subjects, Contexts, schemes and lifecycle changes.
 * Accounts have consented client scopes for tested actions, without broad resource
 * grants. Each scenario has independent accounts, grant holders and unique slots.
 */
export interface Account {
  id: string;
  bearer: string;
}
export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface Command {
  actor: Account | null;
  method: Method;
  path: string;
  body?: unknown;
  /** Exact quoted Structured Field value, forwarded unchanged. */
  key?: string;
  /** Exact HTTP ETag, forwarded as If-Match, including quotes. */
  ifMatch?: string;
}
export interface Space {
  spaceId: string;
  headRevisionId: string;
  creator: string;
  title: string;
}
export interface Realm {
  realmId: string;
  spaceId: string;
  contextId: string;
  headRevisionId: string;
  creator: string;
  title: string;
  visibility: 'public' | 'protected';
  boardSchemeId: string | null;
}
export interface Board {
  id: string;
}
export interface Thread {
  id: string;
  boardId: string;
  title: string;
  firstPost: { id: string; body: DocumentSnapshot };
}
export interface ThreadPage {
  threads: Thread[];
  next: string | null;
  rankRefreshedAt?: string | null;
}
export interface Publication {
  realmId: string;
  subjectId: string;
  publicationId: string;
  verdict: 'adopt' | 'withdraw' | 'reject';
  predecessor?: string | null;
}
export interface Subject {
  id: string;
  type: string;
  revision: number;
  context: string;
  labels: Record<string, string>;
  descriptions: Record<string, string>;
  aliases: Record<string, string[]>;
  statements: Record<string, { id: string; rank: string; value: unknown }[]>;
  resolution?: Record<string, string>;
}
export interface Fixture {
  owner: Account;
  member: Account;
  moderator: Account;
  outsider: Account;
  /** Can edit and take down its own fixture subject through production API grants. */
  subjectOwner: Account;
  /** Owner owns this Context and can create Space/Realm/subjects on Global,
   * but has no edit or moderation grant on the fixture global subject. */
  contextId: string;
  /** Owned by subjectOwner, globally adopted author candidate and fallback language. */
  subject: { id: string; candidateId: string; property: 'schema:author'; fallback: 'schema:inLanguage' };
  /** Well-formed unused routed IDs. */
  unknown: { realm: string; board: string; thread: string };
}
export interface CommunityGrowth {
  /** openGrowthDatabase; every kernel/Access connection participates in capture. */
  database: GrowthDatabase;
  actor: Account;
  realmId: string;
  boardId: string;
  /** Exactly two visible fixed probe threads; all other seeded threads are elsewhere. */
  threadIds: [string, string];
  /**
   * Grow persisted Realms, members, threads and their dependent grant/history
   * relations to scale in the same measured partitions. Keep probe, page size,
   * actor and grants fixed. Seed through admin, ANALYZE without planner forcing,
   * then refresh real ranks outside capture. No unrelated worker traffic during
   * capture; no replacing the API query with a preselected SQL helper.
   */
  grow(scale: number, previous: number): Promise<void>;
  /** Independently count persisted populations, not seed-loop counters. */
  populations(): Promise<{ realms: number; members: number; threads: number }>;
  close(): Promise<void>;
}
export interface CommunityDriver {
  close(): Promise<void>;
  provision(): Promise<Fixture>;
  /** Original Response from createKernel.handle; never normalize failures or JSON. */
  request(command: Command): Promise<Response>;
  /** Drain only this fixture's actual queued workflows; never implement their effects. */
  settle(): Promise<void>;
  /**
   * API grant community.realm.moderator on this exact Realm, using an independent
   * authorized grantor. No grants on another Realm or Global. Returns native response.
   */
  grantModerator(realmId: string, account: Account): Promise<Response>;
  /** API account:suspend by fixture governance; retain the account's old bearer. */
  suspend(account: Account): Promise<Response>;
  /** Advance trusted scheduler by >=10 minutes and run the real rank refresh worker. */
  refreshRanks(): Promise<void>;
  /**
   * Independent authoritative SQL observation for this command key and actor.
   * lastAttempt comes from production authorization/receipt boundary tracing,
   * never from reconstructed policy or an inferred HTTP status.
   * A denied replay must not expose the original stored response. Original
   * successful receipt may remain; never delete it to make a denial appear fresh.
   */
  commandEvidence(
    actor: Account,
    key: string,
  ): Promise<{
    posts: string[];
    receipts: { key: string; responseDigest: string }[];
    lastAttempt: { authorized: boolean; receiptRead: boolean; storedResponseReturned: boolean };
  }>;
  /** A fresh probe owned by this driver, with real membership and hot ranks. */
  growthFixture(): Promise<CommunityGrowth>;
  /** Exact production subject edit and takeDown API commands, using expected revision. */
  subjectCommand(kind: 'edit' | 'takeDown', actor: Account, subjectId: string, key: string): Promise<Response>;
}

export type CreateCommunityDriver = () => Promise<CommunityDriver>;
