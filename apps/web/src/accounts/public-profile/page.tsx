import type { ComponentProps } from 'react';
import { SubjectPage } from '../../features/pages/subject';
import { ContributionActionsPageScope } from './contribution-actions/host';
import { PublicAccountLinks } from './view';

/** Keep the native composition, Content activity and Library readers on the production account path. */
export function PublicProfilePage({
  publicRealms,
  cursor = null,
  ...props
}: ComponentProps<typeof SubjectPage> & { publicRealms: boolean; cursor?: string | null }) {
  return (
    <ContributionActionsPageScope page={props.page} cursor={cursor} view={props.view ?? 'overview'}>
      <SubjectPage
        {...props}
        curation={
          props.page.account ? (
            <PublicAccountLinks handle={props.page.account.handle} locale={props.locale} realms={publicRealms} />
          ) : undefined
        }
      />
    </ContributionActionsPageScope>
  );
}
