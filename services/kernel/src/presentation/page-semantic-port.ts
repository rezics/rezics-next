import type { PresentationProfile } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { PageDocumentRelease, PageExecution, SelectedPageSnapshot } from './page-contract.ts';
import type { activateProfile, publishProfile } from './profiles.ts';
import type { PageReadBudget } from './reads.ts';
import type { readPage } from './reads.ts';

export type PageItemDetails = {
  type: string;
  agentAccountId: string | null;
  agentVerified: boolean;
};

export type PageSubjectState = {
  id: string;
  visibility: string;
  securityRevision: string;
  redirect: string | null;
  revision: number;
};

export type PageQueryable = Pick<Pool | PoolClient, 'query'>;

export type PageActiveRelease = {
  digest: string;
  head: number;
  release: Release;
};

/** Presentation-owned Semantic document and metadata producers. Adapters bind public native leaves. */
export type PageSemanticPort = Readonly<{
  characterDocumentProperties(
    release: PageDocumentRelease | undefined,
    type: string,
    available: readonly string[],
  ): string[];
  activeRelease(pool: Pool | CommandTransaction): Promise<PageActiveRelease | null>;
  readItemTypes(client: PageQueryable, ids: readonly string[]): Promise<Map<string, string>>;
  readItemDetails(client: PageQueryable, ids: readonly string[]): Promise<Map<string, PageItemDetails>>;
  readSubjectPageStates(client: PageQueryable, home: number, ids: readonly string[]): Promise<PageSubjectState[]>;
  globalReadEligibility(action: 'subject:read' | 'definitions:read' | 'presentation:read'): unknown;
  relatedReadEligibility(resource: { route: number; id: string }, ids: readonly string[]): unknown;
  withReadTransaction<T>(pool: Pool, read: (client: PoolClient) => Promise<T>, deadline?: number): Promise<T>;
}>;

export type PageSelectedPort = Readonly<{
  selectPage(execution: PageExecution, realmId: string, subject: string): Promise<SelectedPageSnapshot>;
  guardSelectedPage(execution: PageExecution, selected: SelectedPageSnapshot): Promise<void>;
}>;

export type PageProfilePort = Readonly<{
  activeProfile(pool: Pool): Promise<{ digest: string; head: number; profile: PresentationProfile } | null>;
  readProfile(pool: Pool | CommandTransaction, digest: string): Promise<PresentationProfile | null>;
  publishProfile: typeof publishProfile;
  activateProfile: typeof activateProfile;
  bootstrapProfile(pool: Pool, profile: PresentationProfile): Promise<string>;
}>;

export type PageReadPort = Readonly<{
  readPage: typeof readPage;
  createBudget: () => PageReadBudget;
}>;

export type PageApplicationPorts = Readonly<{
  semantic: PageSemanticPort;
  selected: PageSelectedPort;
  profiles: PageProfilePort;
  pageRead: PageReadPort;
}>;
