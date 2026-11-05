import { useState } from 'react';
import { AuthPage } from '../../../frame';
import { AuthButton as Button } from '../../../button';
import { m } from '../../../paraglide/messages.js';
import { OrganizationMembershipReturnView } from '../../../organization-membership-return-view';
import type { MembershipHistory } from '../../../organization-membership-return';
import type { MembershipPage } from '../../../organization-membership';
import { OrganizationMembershipRoster } from '../../../routes/organizations.members';
import { AuthStory, authLocale, reviewParameters } from '../story';

export default {
  title: 'Pages/Account/Membership browser return',
  parameters: reviewParameters,
  decorators: [authLocale],
};

const ready: Extract<MembershipPage, { kind: 'ready' }> = {
  kind: 'ready',
  organizationId: '10000000-0000-4000-8000-000000000001',
  viewer: { accountId: '10000000-0000-4000-8000-000000000002', role: 'owner', leave: 'unavailable' },
  members: { state: 'ready', holders: [], next: null },
};

/** Presentation fixtures reuse the route's roster and generic-history view; no command transport. */
function ReturnStory({
  initialHistory,
  current = 'unavailable',
  dark = false,
}: {
  initialHistory: MembershipHistory;
  current?: 'ready' | 'empty' | 'unavailable' | 'denied';
  dark?: boolean;
}) {
  const [history, setHistory] = useState(initialHistory);
  const [pending, setPending] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const read = () => {
    if (pending) return;
    setPending(true);
    setTimeout(() => {
      setPending(false);
      setReviewed(true);
    }, 300);
  };
  const page =
    current === 'ready'
      ? {
          ...ready,
          members: {
            state: 'ready' as const,
            next: 'next-page',
            holders: [
              {
                accountId: '10000000-0000-4000-8000-000000000003',
                account: {
                  id: '10000000-0000-4000-8000-000000000003',
                  kind: 'actor' as const,
                  handle: 'reading-companion',
                  displayName: 'International reading companion — 世界の読書会',
                },
                role: 'member' as const,
                actions: { changeRole: 'allowed' as const, remove: 'allowed' as const },
              },
            ],
          },
        }
      : ready;
  return (
    <AuthStory>
      <div className={dark ? 'dark bg-background text-foreground' : undefined}>
        <AuthPage heading={m.auth_members_heading()}>
          <a href="/security" className="inline-flex min-h-11 items-center underline">
            {m.auth_members_back()}
          </a>
          <OrganizationMembershipReturnView history={history} dismiss={() => setHistory([])} />
          <section className="space-y-4" aria-busy={pending}>
            <h2>{m.auth_members_current_heading()}</h2>
            <p>{m.auth_members_recovery_review()}</p>
            <Button type="button" disabled={pending} onClick={read}>
              {m.auth_members_recovery_retry()}
            </Button>
            {pending ? (
              <p role="status">{m.auth_members_loading()}</p>
            ) : reviewed && (current === 'ready' || current === 'empty') ? (
              <OrganizationMembershipRoster
                page={page}
                busy={false}
                pending={true}
                onSelect={() => {}}
                onReload={read}
              />
            ) : (
              <p role="status">{current === 'denied' ? m.auth_members_denied() : m.auth_members_unavailable()}</p>
            )}
          </section>
        </AuthPage>
      </div>
    </AuthStory>
  );
}
const phone = { ...reviewParameters, viewport: { ...reviewParameters.viewport, defaultViewport: 'phone390' } };
const desktop = { ...reviewParameters, viewport: { ...reviewParameters.viewport, defaultViewport: 'desktop1280' } };
export const UnsentPhoneLight = {
  parameters: phone,
  render: () => <ReturnStory initialHistory={['unsent']} current="empty" />,
};
export const UnknownPhoneDark = {
  parameters: phone,
  render: () => <ReturnStory initialHistory={['unresolved']} dark />,
};
export const AcknowledgedDesktopLight = {
  parameters: desktop,
  render: () => <ReturnStory initialHistory={['acknowledged']} current="ready" />,
};
export const UnknownThenAcknowledgedDesktopDark = {
  parameters: desktop,
  render: () => <ReturnStory initialHistory={['unresolved', 'acknowledged']} current="ready" dark />,
};
export const RefusedPhoneLight = {
  parameters: phone,
  render: () => <ReturnStory initialHistory={['refused']} current="denied" />,
};
export const UnknownThenUnsentDesktopDark = {
  parameters: desktop,
  render: () => <ReturnStory initialHistory={['unresolved', 'unsent']} current="empty" dark />,
};
