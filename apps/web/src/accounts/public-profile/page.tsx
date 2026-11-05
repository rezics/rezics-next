import type { ComponentProps } from 'react';
import { SubjectPage } from '../../features/pages/subject';
import { ContributionActionsPageScope } from './contribution-actions/host';
import { ProfileReadingResponse, ProfileReadingStatus } from './reader-presentation/view';
import type { ProfileReading } from './reader-presentation/adapter';
import { PublicAccountLinks } from './view';
import { ContributionWindowRouteScope, type ContributionWindowRoute } from './contribution-windows/route';

/** Keep the native composition, Content activity and Library readers on the production account path. */
export function PublicProfilePage({
  publicRealms,
  reading,
  cursor = null,
  contributionWindowRoute,
  ...props
}: ComponentProps<typeof SubjectPage> & {
  publicRealms: boolean;
  cursor?: string | null;
  reading?: ProfileReading;
  contributionWindowRoute?: ContributionWindowRoute;
}) {
  const isContributionView =
    props.view === 'posts' || props.view === 'reviews' || props.view === 'discussion';
  const handle = props.page.account?.handle;
  const windowRoute = isContributionView
    ? (contributionWindowRoute ?? {
        pathname:
          props.base && props.view
            ? `${props.base}/${props.view}`
            : `/${encodeURIComponent(props.locale)}/@${encodeURIComponent(handle ?? '')}/${props.view}`,
        search: '',
        hash: '',
        retry: () => {},
      })
    : null;
  return (
    <ContributionWindowRouteScope route={windowRoute}>
      <ContributionActionsPageScope page={props.page} cursor={cursor} view={props.view ?? 'overview'}>
        <ProfileReadingResponse value={reading?.response ?? 'public'}>
          <SubjectPage
            {...props}
            {...(reading ? { reader: reading.reader } : {})}
            curation={
              <>
                {reading && <ProfileReadingStatus reading={reading} locale={props.locale} />}
                {props.page.account && (
                  <PublicAccountLinks handle={props.page.account.handle} locale={props.locale} realms={publicRealms} />
                )}
              </>
            }
          />
        </ProfileReadingResponse>
      </ContributionActionsPageScope>
    </ContributionWindowRouteScope>
  );
}
