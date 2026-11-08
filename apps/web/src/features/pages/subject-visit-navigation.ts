export {
  connectionReturnGroup,
  connectionReturnHref,
  connectionReturnWindow,
  connectionWindowFragment,
  organizationHistoryVisitReturn,
  organizationHistoryVisitReturnFragment,
  personBiographyReturn,
  personBiographyReturnFragment,
  subjectCommunityVisitReturn,
  subjectRouteSearchLimit,
  subjectVisitReturn,
  subjectVisitReturnHref,
  summaryReadingFragment,
  summaryReadingReturn,
  withSubjectVisitReturn,
  workCastVisitReturn,
  workCastVisitReturnFragment,
  workFranchiseRestartHref,
  workFranchiseReturnHref,
  workTagOriginatingReturn,
  workTagReturn,
  workTagReturnFragment,
  workTagReturnHref,
  zoneVisitReturn,
} from './subject-visit-return';
export type {
  ConnectionReturnWindow,
  OrganizationHistoryVisitReturn,
  PersonBiographyReturn,
  SummaryReadingReturn,
  WorkCastVisitReturn,
  WorkTagReturn,
} from './subject-visit-return';

import { subjectHref } from '../../subject/subject-href';
import { withSubjectVisitReturn } from './subject-visit-return';

/** Public handoff for a disclosed publication; the Realm operand and return address grant no authority. */
export function communityPublicationVisitHref(
  subject: { id: string; label: string },
  realmId: string,
  returnTo: string,
  locale: string,
): string {
  return withSubjectVisitReturn(
    `${subjectHref(subject, locale).href}?realm=${encodeURIComponent(realmId)}`,
    returnTo,
    locale,
  );
}
