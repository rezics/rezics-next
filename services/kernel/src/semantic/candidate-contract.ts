import type { Release } from '@rezics/definitions';
import type { BatchReference, Source } from '@rezics/definitions/bulk';
import type { Pool, PoolClient } from 'pg';
import type { CommandAuthorization } from '../command/command.ts';
import type { AccountActor } from '../request/access.ts';
import type { ProposalInstall } from './authored.ts';
import type { ConsentIdentity, ConsentIdentityReader } from './candidate-consent-identity.ts';
import type { Statement } from './item.ts';
import type { Adoption } from './slots.ts';
import type { AgentSelfSource } from './subject.ts';

export type EditorialWriteOptions = {
  subject: string;
  actor: AccountActor;
  idempotencyKey: string;
  digest: Uint8Array;
  authorization: CommandAuthorization;
  deadline: number;
  clock?: () => Date;
  routeKey?: Uint8Array;
};

export type ProposalStatementOptions = {
  subject: string;
  statement: unknown;
  actor: AccountActor;
  idempotencyKey: string;
  digest: Uint8Array;
  release: { digest: string; release: Release };
  authorization: CommandAuthorization;
  deadline: number;
  clock?: () => Date;
  routeKey?: Uint8Array;
  /** Server declaration only; allocation remains inside the native body. */
  expectedRevision?: number;
};

export type ProposalWriteOptions = Pick<ProposalStatementOptions, 'subject' | 'statement' | 'release'> & {
  expectedRevision?: number;
  source?: Source | AgentSelfSource;
  routeKey?: Uint8Array;
  /** Sourced bulk summary and cover store content's reference instead of rejecting the datatype. */
  allowContent?: boolean;
  /** Runs after the candidate id and revision are allocated and before the candidate row is inserted. */
  install?: ProposalInstall;
};

export type CandidateDecisionOptions = EditorialWriteOptions & {
  candidate: string;
  context: string;
  decision: 'accept' | 'reject';
  expectedHead: number | null;
};

export type CandidateAdoptionOptions = EditorialWriteOptions & {
  context: string;
  property: string;
  slot?: string;
  mode: Adoption['mode'];
  selection: { candidate: string; rank: 'normal' | 'preferred' | 'deprecated' }[];
  expectedHead: number | null;
  release: { digest: string; release: Release };
};

export type PageOptions = {
  subject: string;
  limit: number;
  cursor?: string;
  authorize: (client: PoolClient) => Promise<boolean>;
};

export type CandidatePageOptions = PageOptions & {
  property: string;
  context: string;
  slot?: string;
  routeKey?: Uint8Array;
  identity?: ConsentIdentityReader & {
    prepareSource: () => Promise<PageOptions['authorize']>;
    refreshAudience: () => Promise<void>;
  };
};

export type PageComponent = { partition: number; epoch: number; position: number };
export type PageResult<T> = T & { next: string | null; component: PageComponent };

export type CandidateObservation =
  | { id: string; deleted: true }
  | {
      consentIdentity?: ConsentIdentity;
      source: Source | null;
      retracted: number | null;
      retraction: { source: Source; references: BatchReference[] } | null;
      id: string;
      statement: Statement;
      release: string;
      revision: number;
      decision: 'accepted' | 'rejected' | 'abstained' | null;
      head: number | null;
      rank: 'normal' | 'preferred' | 'deprecated' | null;
    };

export type CandidatePageResult = PageResult<{
  candidates: CandidateObservation[];
  adoption: { mode: Adoption['mode']; head: number } | null;
}>;

export type RevisionPageResult = PageResult<{
  revisions: { revision: number; kind: string; release: string; source: Source | null }[];
}>;

export type CandidateDecisionResult = {
  acceptance: {
    context: string;
    candidate: string;
    decision: 'accept' | 'reject';
    head: number;
  };
  revision: number;
  component: PageComponent;
};

export type CandidateAdoptionResult = {
  adoption: {
    context: string;
    property: string;
    mode: Adoption['mode'];
    selection: Adoption['selection'];
    head: number;
  };
  revision: number;
  component: PageComponent;
};
