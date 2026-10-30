import type { ComponentProps } from 'react';
import { SubjectPage } from '../../features/pages/subject';
import { PublicAccountLinks } from './view';

/** Keep the native composition, Content activity and Library readers on the production account path. */
export function PublicProfilePage({
  publicRealms,
  ...props
}: ComponentProps<typeof SubjectPage> & { publicRealms: boolean }) {
  return (
    <SubjectPage
      {...props}
      curation={
        props.page.account ? (
          <PublicAccountLinks handle={props.page.account.handle} locale={props.locale} realms={publicRealms} />
        ) : undefined
      }
    />
  );
}
