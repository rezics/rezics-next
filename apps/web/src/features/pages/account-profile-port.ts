import type { ComponentType, ReactNode } from 'react';
import type { PageRead } from '@rezics/composition';
import type { SubjectPageData } from './page-model';
import type {
  ContributionReactionMount,
  ContributionReplyMount,
  ContributionWatchMount,
} from '../../threads/contract/contribution-actions';
import type { ContributionReportMount } from '../../report/contract/contribution-actions';

export type {
  ContributionReactionKind,
  ContributionReactionMount,
  ContributionReactionTransport,
  ContributionReplyCommand,
  ContributionReplyMount,
  ContributionWatchMount,
  ContributionWatchNative,
} from '../../threads/contract/contribution-actions';
export type { ContributionReportMount, VerificationConfig } from '../../report/contract/contribution-actions';

/** Public-profile capabilities needed by page assembly; no Accounts implementation is loaded here. */
export type ContributionWindowView = 'posts' | 'reviews' | 'discussion';
export type ContributionCoordinate = string | null;
export type ContributionWindowOwner = {
  accountId: string;
  view: ContributionWindowView;
  locale: string;
  published: boolean;
};
export type ContributionWindowAction = 'next' | 'previous' | 'first' | 'retry';
export type ContributionWindowOutcome = 'admitted' | 'failed' | 'pending';
export type AccountListFailure = 'denied' | 'preparing' | 'unavailable' | 'invalid-cursor';

export type ContributionPageSelection = {
  page: SubjectPageData;
  cursor: ContributionCoordinate;
  view: string;
};

export type ContributionListInput = {
  accountId: string;
  view: ContributionWindowView;
  cursor: ContributionCoordinate;
  locale: string;
  page: SubjectPageData;
  read: PageRead;
  source: Record<string, unknown>;
  selection: unknown;
  publication: object;
  postsPublished: boolean;
  reviewsPublished: boolean;
  rows: Record<string, unknown>[];
  children: ReactNode;
};

export type ContributionControlsInput = {
  owner: ContributionWindowOwner;
  cursor: ContributionCoordinate;
  next: string | null;
  outcome: ContributionWindowOutcome;
  failure?: AccountListFailure;
  title: string;
  region: { current: HTMLElement | null };
};

export type CollectionControlsInput = {
  next?: string | null;
  locale: string;
  failed?: boolean;
  invalid?: boolean;
};

/** The route passes only an admitted page reading to Accounts' local collection visit. */
export type CollectionWindowReading = {
  accountId: string;
  publication: string;
  published: boolean;
  admitted: boolean;
  denied: boolean;
};

/** Threads watch/reaction/reply and Report engines the public profile host can mount. */
export type ContributionActionCapabilities = {
  Watch: ComponentType<ContributionWatchMount>;
  Reaction: ComponentType<ContributionReactionMount>;
  Reply: ComponentType<ContributionReplyMount>;
  Report: ComponentType<ContributionReportMount>;
};

const UnavailableAction = () => null;

/** Ordinary Subject composition has no private action cohort. */
export const unavailableContributionActions: ContributionActionCapabilities = {
  Watch: UnavailableAction,
  Reaction: UnavailableAction,
  Reply: UnavailableAction,
  Report: UnavailableAction,
};

export type AccountProfilePort = {
  useCollectionWindow: () => boolean;
  useContributionPage: () => ContributionPageSelection | null;
  useContributionRoute: () => boolean;
  retireContributionWindow: () => void;
  CollectionControls: ComponentType<CollectionControlsInput>;
  ContributionControls: ComponentType<ContributionControlsInput>;
  ContributionList: ComponentType<ContributionListInput>;
  /** Bound watch, reaction, reply and report engines; lifetime stays on the session facade. */
  contributionActions: ContributionActionCapabilities;
};

/** Admission of the native continuation at the page-response boundary. */
export function contributionCoordinateIsBounded(cursor: unknown): cursor is string {
  return typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 4096;
}
