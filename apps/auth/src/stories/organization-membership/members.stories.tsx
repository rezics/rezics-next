import { OrganizationMembersPage } from '../../routes/organizations.members';
import { AuthShell } from '../../frame';
import { authLocale, reviewParameters } from '../accounts-operations/story';

// Source-only missing-selection story. Current-holder and mutation journeys need
// the installed native management/profile ports; this is not native evidence.
export default {
  title: 'Pages/Account/Organization membership',
  parameters: reviewParameters,
  decorators: [authLocale],
};
export const MissingSelection = {
  render: () => (
    <AuthShell>
      <OrganizationMembersPage organizationId="" />
    </AuthShell>
  ),
};
