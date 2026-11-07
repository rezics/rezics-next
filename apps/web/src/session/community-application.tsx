import { useMemo, type ComponentProps } from 'react';
import { useLocation } from '@tanstack/react-router';
import { useSession } from './index';
import { requestLanguages } from '../kernel/languages';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { coverSrc } from '../media/cover-src';
import { CommunityFollow } from '../library/adapters/community-follow';
import { communityPublicationVisitHref } from '../features/pages/subject-visit-navigation';
import {
  SpacePage as CommunitySpacePage,
  RealmShelf as CommunityRealmShelf,
  createCommunityReading,
  CommunityResourceAccess,
  AuthoringDepartureBoundary,
  type CommunityVisitApplication,
  type NativeRealmHomeOperations,
} from '../community';

/** Existing producers supply the visit's capabilities. This host owns no additional session or native startup. */
export function useCommunityApplication(operations?: NativeRealmHomeOperations): CommunityVisitApplication {
  const session = useSession();
  const location = useLocation();
  const locale = getLocale();
  const reading = useMemo(
    () => createCommunityReading(session.csrfToken, operations, requestLanguages(locale)),
    [session.csrfToken, operations, locale],
  );
  return {
    session,
    locale,
    href: location.publicHref,
    operationsIdentity: operations,
    reading,
    publicationHref: communityPublicationVisitHref,
    coverSrc,
    Heading: PageHeading,
    Follow: CommunityFollow,
    ResourceAccess: CommunityResourceAccess,
    Departure: AuthoringDepartureBoundary,
  };
}

export type SpacePageProps = Omit<ComponentProps<typeof CommunitySpacePage>, 'application'> & {
  nativeOperations?: NativeRealmHomeOperations;
};

/** Both ordinary routes and standalone mounts use this same composition. Route admission remains external. */
export function SpacePage({ nativeOperations, ...props }: SpacePageProps) {
  const application = useCommunityApplication(nativeOperations);
  return <CommunitySpacePage {...props} application={application} />;
}

export function RealmShelf(props: Omit<ComponentProps<typeof CommunityRealmShelf>, 'application'>) {
  const application = useCommunityApplication();
  return <CommunityRealmShelf {...props} application={application} />;
}

export type { RealmShelfTransport, RealmPublicationCompletion } from '../community';
