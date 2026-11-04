import { AuthShell } from '../../frame';
import { MembershipRecoveryView } from '../../membership-recovery-view';
import type { MembershipPage } from '../../organization-membership';
import { m } from '../../paraglide/messages.js';
import { OrganizationMembershipRoster } from '../../routes/organizations.members';
import { authLocale, reviewParameters } from '../accounts-operations/story';

export default {
  title: 'Pages/Account/Organization members',
  parameters: reviewParameters,
  decorators: [authLocale],
};

const organizationId = '00000000-0000-4000-8000-000000000001';
const ownerId = '00000000-0000-4000-8000-000000000002';
const memberId = '00000000-0000-4000-8000-000000000003';

const ownerPage: Extract<MembershipPage, { kind: 'ready' }> = {
  kind: 'ready',
  organizationId,
  viewer: { accountId: ownerId, role: 'owner', leave: 'unavailable' },
  members: {
    state: 'ready',
    holders: [
      {
        accountId: ownerId,
        account: { id: ownerId, kind: 'actor', handle: 'owner', displayName: 'Ari Owner' },
        role: 'owner',
        actions: { changeRole: 'last-owner', remove: 'last-owner' },
      },
      {
        accountId: memberId,
        account: { id: memberId, kind: 'actor', handle: 'reader', displayName: 'Rae Reader' },
        role: 'member',
        actions: { changeRole: 'allowed', remove: 'allowed' },
      },
    ],
    next: null,
  },
};

const memberPage: Extract<MembershipPage, { kind: 'ready' }> = {
  kind: 'ready',
  organizationId,
  viewer: { accountId: memberId, role: 'member', leave: 'unavailable' },
  members: { state: 'unavailable' },
};

function StoryPage({ page }: { page: typeof ownerPage | typeof memberPage }) {
  return (
    <AuthShell>
      <main className="mx-auto w-full max-w-2xl space-y-5 p-6">
        <h1 className="text-2xl font-semibold">Organization members</h1>
        <OrganizationMembershipRoster
          page={page}
          busy={false}
          pending={false}
          onSelect={() => {}}
          onReload={() => {}}
        />
      </main>
    </AuthShell>
  );
}

// Presentation fixtures only; native membership advice comes from the running source.
export const OwnerRoster = { render: () => <StoryPage page={ownerPage} /> };
export const MemberWithoutLeave = { render: () => <StoryPage page={memberPage} /> };
export const UnresolvedAfterAuthorityLoss = {
  render: () => (
    <AuthShell>
      <main className="mx-auto w-full max-w-2xl space-y-5 p-6">
        <h1 className="text-2xl font-semibold">Organization members</h1>
        <MembershipRecoveryView
          status={m.auth_members_recovery_review()}
          outcome={m.auth_members_unknown()}
          pending={false}
          canRetry
          canSignIn
          retry={() => {}}
          signIn={() => {}}
        />
      </main>
    </AuthShell>
  ),
};
