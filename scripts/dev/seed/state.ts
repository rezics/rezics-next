import { createHash } from 'node:crypto';
import type { SeedApi, SeedEndpoints } from './api.ts';
import type { LocalOperatorInput, operatorSeedSession } from './operator.ts';

export interface Session { id: string; accountId: string; cookie: string; token: string;
  issuedAt: number; actingSubject: string }
export interface WorkReceipt { work: string; mainVersion: string; workRevision: string;
  mainRevision: string; replayed: boolean }
export interface SpaceReceipt { space: string; realm: string; replayed: boolean }
export interface AgentReceipt { agent: string; state: string; replayed: boolean }
export interface ContributionReceipt { contribution: string; draftRevision: string; replayed: boolean }
export interface PublicationReceipt { publicationDecision: string; replayed: boolean }
export interface SeedState {
  api: SeedApi;
  endpoints: SeedEndpoints;
  fixture: { operator: { id: string; email: string; password: string } | null;
    accountDatabaseUrl: string | null; accountSecret: string | null; accessDatabaseUrl: string | null };
  optional<T>(label: string, operation: () => Promise<T>): Promise<T | null>;
  findings: Set<string>;
  sessions: Session[];
  penAgents: Map<string, string>;
  operatorInput: LocalOperatorInput | null;
  operatorSession: Awaited<ReturnType<typeof operatorSeedSession>> | null;
  agentCount: number;
  created: Map<string, WorkReceipt>;
  createdRealms: { id: string; receipt: SpaceReceipt; steward: Session }[];
  seededZones: string[];
  publishedCount: number;
  selectedCount: number;
  publicForRealm: Map<string, { contribution: string; decision: string }>;
  /** Works the official Zones published, by plan id, for later steps that adopt, discuss and rate them. */
  publicWorks: Map<string, { work: WorkReceipt; contribution: string; decision: string }>;
  /** The standing global rating question, once the ratings step has read it. */
  ratingContext: string | null;
  /** Community Realms by plan id, as later steps place discussions in them. */
  communityRealms: Map<string, { realm: string; owner: Session }>;
  commentCount: number;
  replyCount: number;
  reviewCount: number;
  profileCreditCount: number;
  profileFollowCount: number;
}

export type SeedStep = (state: SeedState) => Promise<void>;

/** OAuth access tokens are short lived; long demo phases renew their own sessions. */
export async function refreshSeedTokens(state: SeedState): Promise<void> {
  for (const session of state.sessions) {
    if (Date.now() - session.issuedAt > 120_000) {
      session.token = await state.api.token(session.cookie);
      session.issuedAt = Date.now();
    }
  }
  if (state.operatorSession && Date.now() - state.operatorSession.issuedAt > 120_000) {
    state.operatorSession.token = await state.operatorSession.api.token(state.operatorSession.cookie);
    state.operatorSession.issuedAt = Date.now();
  }
}

export function stableId(id: string): string {
  const hex = createHash('sha256').update(`rezics-dev-seed-v1:${id}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
