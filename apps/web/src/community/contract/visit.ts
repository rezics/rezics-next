import type { BrowserSession } from '../../reader/lifetime/index';
import type { ReadCredentialMode } from '../../reader/lifetime/contract';
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import type { CoverCard } from '@rezics/ui/cover-card';
import type { PublicationPrepare } from '../realm-publication-preparation';
import type { PublicationSend } from '../publication-subject-picker';
import type { PublishedSubject, RealmBoard, ShelfPage } from '../space';

/** Presentation never supplies native admission. These are the existing browser producer's states. */
export type CommunitySession = BrowserSession;

export type RealmShelfTransport = {
  boards(input: { cursor?: string; credentialMode: ReadCredentialMode }): Promise<ShelfPage<RealmBoard>>;
  publications(input: { cursor?: string; credentialMode: ReadCredentialMode }): Promise<ShelfPage<PublishedSubject>>;
  change?: PublicationSend;
  prepare?: PublicationPrepare;
};

/** Each method makes one physical native page read, retaining sparse windows and native order. */
export type CommunityRealmReading = {
  transport: RealmShelfTransport & { change: PublicationSend; prepare: PublicationPrepare };
  requireReaderOrigin: boolean;
};

/**
 * The complete Space/Realm visit's bounded application dependencies. The route host supplies these values;
 * the consumer neither starts a session nor constructs another owner's browser/native implementation.
 */
export type CommunityVisitApplication = {
  readonly session: CommunitySession;
  readonly locale: string;
  readonly href: string;
  /** The original operations object, not a newly wrapped transport, is part of source retirement. */
  readonly operationsIdentity: object | undefined;
  readonly reading: (realmId: string, locale: string) => CommunityRealmReading;
  readonly publicationHref: (
    subject: { id: string; label: string },
    realmId: string,
    returnTo: string,
    locale: string,
  ) => string;
  readonly coverSrc: ComponentProps<typeof CoverCard>['cover']['src'];
  readonly Heading: ComponentType<{ className?: string; children: ReactNode }>;
  readonly Follow: ComponentType<{ targetId: string }>;
  readonly ResourceAccess: ComponentType<{ resourceId: string }>;
  readonly Departure: ComponentType<{ children: ReactNode }>;
};
