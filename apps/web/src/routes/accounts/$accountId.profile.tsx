import { nativeAccountProfileRuntime } from '../../accounts/profile-editor/adapters';
import { createFileRoute } from '@tanstack/react-router';
import * as profilePresentation from '../../settings/ports/profile-editor-view';
import { AccountProfilePage } from '../../accounts/profile-editor/page';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/accounts/$accountId/profile')({
  beforeLoad: requireSignedIn,
  head: ({ match }) =>
    pageHead({ title: m.account_profile_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ProfileRoute,
});
function ProfileRoute() {
  const { accountId } = Route.useParams();
  return (
    <AccountProfilePage
      accountId={accountId}
      presentation={profilePresentation}
      runtime={nativeAccountProfileRuntime}
    />
  );
}
