import { useRef, useState } from 'react';
import { AuthPage } from '../../../frame';
import { m } from '../../../paraglide/messages.js';
import type { Holder, MembershipPage } from '../../../organization-membership';
import { MembershipRosterNavigation, type RosterDirection } from '../../../organization-membership-roster';
import {
  OrganizationMembershipRoster,
  RosterPageControls,
  rosterDirectionLabel,
} from '../../../organization-membership-roster-view';
import { AuthStory, authLocale, reviewParameters } from '../story';

export default {
  title: 'Account/Roster navigation',
  id: 'pages-account-roster-navigation',
  parameters: reviewParameters,
  decorators: [authLocale],
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const holders: Holder[] = [
  {
    accountId: id(2),
    account: {
      id: id(2),
      kind: 'actor',
      displayName: 'International reading companion — 世界の読書会',
      handle: 'reading-companion',
    },
    role: 'owner',
    actions: { changeRole: 'last-owner', remove: 'last-owner' },
  },
  {
    accountId: id(3),
    account: { id: id(3), kind: 'actor', displayName: 'International reading companion — 世界の読書会', handle: null },
    role: 'member',
    actions: { changeRole: 'allowed', remove: 'unavailable' },
  },
  { accountId: id(4), account: null, role: 'member', actions: { changeRole: 'allowed', remove: 'allowed' } },
  { accountId: id(5), account: null, role: 'member', actions: { changeRole: 'allowed', remove: 'allowed' } },
];
type Mode = 'first' | 'middle' | 'backwards' | 'empty' | 'failed' | 'unavailable' | 'pending';
function RosterStory({ mode }: { mode: Mode }) {
  const navigation = useRef<MembershipRosterNavigation | null>(null);
  if (!navigation.current) {
    const local = new MembershipRosterNavigation();
    local.accept(local.request('reload'));
    if (mode !== 'first') local.accept(local.request('next', 'middle'));
    if (mode === 'backwards') {
      local.accept(local.request('next', 'last'));
      local.accept(local.request('previous'));
    }
    if (mode === 'failed' || mode === 'pending') local.request('previous');
    navigation.current = local;
  }
  const [state, setState] = useState(navigation.current.state);
  const [failed, setFailed] = useState(mode === 'failed');
  const [pending, setPending] = useState(mode === 'pending');
  const run = (direction: RosterDirection, cursor?: string) => {
    if (pending) return;
    const request = navigation.current!.request(direction, cursor);
    setState(navigation.current!.state);
    setPending(true);
    setTimeout(() => {
      navigation.current!.accept(request);
      setState(navigation.current!.state);
      setPending(false);
      setFailed(false);
    }, 600);
  };
  const page: Extract<MembershipPage, { kind: 'ready' }> = {
    kind: 'ready',
    organizationId: id(1),
    viewer: { accountId: id(2), role: 'owner', leave: 'unavailable' },
    members:
      mode === 'unavailable'
        ? { state: 'unavailable' }
        : {
            state: 'ready',
            holders: mode === 'empty' ? [] : holders,
            next: state.cursor === 'last' ? null : state.cursor ? 'last' : 'middle',
          },
  };
  return (
    <AuthStory>
      <div className="bg-background text-foreground">
        <AuthPage heading={m.auth_members_heading()}>
          {pending ? (
            <p role="status">
              {m.auth_members_navigation_pending({ action: rosterDirectionLabel(state.requested!.direction) })}
            </p>
          ) : null}
          {failed ? (
            <div role="status">
              <p>{m.auth_members_conflict()}</p>
              <RosterPageControls navigation={state} busy={pending} failed onNavigate={run} />
            </div>
          ) : (
            <OrganizationMembershipRoster
              key={state.observation}
              page={page}
              navigation={state}
              busy={pending}
              pending={false}
              onNavigate={run}
              onReload={() => run('reload')}
              onSelect={() => {}}
              focusHeading={false}
            />
          )}
        </AuthPage>
      </div>
    </AuthStory>
  );
}

export const First = { parameters: reviewParameters, render: () => <RosterStory mode="first" /> };
export const Middle = { parameters: reviewParameters, render: () => <RosterStory mode="middle" /> };
export const Backwards = { parameters: reviewParameters, render: () => <RosterStory mode="backwards" /> };
export const EmptyWithNext = { parameters: reviewParameters, render: () => <RosterStory mode="empty" /> };
export const InaccessiblePrevious = { parameters: reviewParameters, render: () => <RosterStory mode="failed" /> };
export const MembersUnavailable = {
  parameters: reviewParameters,
  render: () => <RosterStory mode="unavailable" />,
};
export const PendingPrevious = { parameters: reviewParameters, render: () => <RosterStory mode="pending" /> };
export const LongGermanLabels = {
  parameters: reviewParameters,
  globals: { locale: 'de' },
  render: () => <RosterStory mode="middle" />,
};
