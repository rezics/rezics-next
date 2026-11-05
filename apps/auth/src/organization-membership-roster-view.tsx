import { useLayoutEffect, useRef } from 'react';
import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';
import type { MembershipPage } from './organization-membership';
import type { RosterNavigationState, RosterDirection } from './organization-membership-roster';

type ReadyMembershipPage = Extract<MembershipPage, { kind: 'ready' }>;
export function OrganizationMembershipRoster({
  page,
  busy,
  pending,
  onSelect,
  onReload,
  navigation,
  onNavigate,
  focusHeading = false,
}: {
  page: ReadyMembershipPage;
  busy: boolean;
  pending: boolean;
  onSelect: (accountId: string, role: 'owner' | 'member' | null) => void;
  onReload: (cursor?: string) => void;
  navigation?: RosterNavigationState | undefined;
  onNavigate?: (direction: RosterDirection, cursor?: string) => void;
  focusHeading?: boolean;
}) {
  const members = page.members;
  const heading = useRef<HTMLHeadingElement>(null);
  const rows = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    // Disclosure belongs to this observation, including native command readback.
    rows.current?.querySelectorAll('details').forEach((details) => {
      details.open = false;
    });
    if (focusHeading) heading.current?.focus();
  }, [page, focusHeading]);
  const navigate =
    onNavigate ??
    ((direction: RosterDirection, cursor?: string) => onReload(direction === 'next' ? cursor : undefined));
  return (
    <section aria-labelledby="organization-members-heading" className="space-y-5">
      <div>
        <h2 ref={heading} tabIndex={-1} id="organization-members-heading" className="text-lg font-semibold">
          {m.auth_members_holders()}
        </h2>
        <p className="break-all">{page.organizationId}</p>
        <p>{page.viewer.role === 'owner' ? m.auth_members_owner() : m.auth_members_member()}</p>
      </div>
      {page.viewer.role === 'member' ? (
        page.viewer.leave === 'allowed' ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy || pending}
            onClick={() => onSelect(page.viewer.accountId, null)}
          >
            {m.auth_members_leave_organization()}
          </Button>
        ) : (
          <p role="status">{m.auth_members_leave_unavailable()}</p>
        )
      ) : null}
      {members.state === 'unavailable' ? (
        <div className="space-y-3">
          <p role="status">{m.auth_members_inventory_unavailable()}</p>
          <RosterPageControls navigation={navigation} busy={busy} onNavigate={navigate} />
        </div>
      ) : (
        <>
          <p>{m.auth_members_page_count({ count: members.holders.length })}</p>
          <p>{members.next ? m.auth_members_more_offered() : m.auth_members_no_more_offered()}</p>
          <ul ref={rows} className="divide-y" aria-label={m.auth_members_holders()}>
            {members.holders.map((holder) => {
              const displayName = holder.account?.displayName?.trim();
              const handle = holder.account?.handle?.trim();
              const change = holder.actions.changeRole;
              const remove = holder.actions.remove;
              return (
                <li key={holder.accountId} className="space-y-2 py-4">
                  <div>
                    <p className="font-medium">
                      {displayName || (handle ? `@${handle}` : m.auth_members_identity_unavailable())}
                    </p>
                    {displayName && handle ? <p className="text-sm text-muted-foreground">@{handle}</p> : null}
                    <p>{holder.role === 'owner' ? m.auth_members_owner() : m.auth_members_member()}</p>
                    <details
                      className="mt-1 text-sm"
                      onToggle={(event) => {
                        const details = event.currentTarget;
                        if (!details.open && details.contains(document.activeElement) && details.isConnected)
                          details.querySelector('summary')?.focus();
                      }}
                    >
                      <summary className="cursor-pointer">{m.auth_members_account_address()}</summary>
                      <code className="break-all">{holder.accountId}</code>
                    </details>
                  </div>
                  {page.viewer.role === 'owner' ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        {change === 'allowed' ? (
                          <Button
                            type="button"
                            variant="outline"
                            disabled={busy || pending}
                            onClick={() => onSelect(holder.accountId, holder.role === 'owner' ? 'member' : 'owner')}
                          >
                            {m.auth_members_change_role()}
                          </Button>
                        ) : change === 'last-owner' ? (
                          <Button
                            type="button"
                            variant="outline"
                            disabled
                            aria-describedby={`member-last-owner-${holder.accountId}`}
                          >
                            {m.auth_members_change_role()}
                          </Button>
                        ) : (
                          <Button type="button" variant="outline" disabled title={m.auth_members_actions_unavailable()}>
                            {m.auth_members_change_role()}
                          </Button>
                        )}
                        {remove === 'allowed' ? (
                          <Button
                            type="button"
                            variant="outline"
                            disabled={busy || pending}
                            onClick={() => onSelect(holder.accountId, null)}
                          >
                            {m.auth_members_remove()}
                          </Button>
                        ) : remove === 'last-owner' ? (
                          <Button
                            type="button"
                            variant="outline"
                            disabled
                            aria-describedby={`member-last-owner-${holder.accountId}`}
                          >
                            {m.auth_members_remove()}
                          </Button>
                        ) : (
                          <Button type="button" variant="outline" disabled title={m.auth_members_actions_unavailable()}>
                            {m.auth_members_remove()}
                          </Button>
                        )}
                      </div>
                      {change === 'last-owner' || remove === 'last-owner' ? (
                        <p id={`member-last-owner-${holder.accountId}`} role="status">
                          {m.auth_members_last_owner()}
                        </p>
                      ) : null}
                      {change === 'unavailable' || remove === 'unavailable' ? (
                        <p role="status">{m.auth_members_actions_unavailable()}</p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {!members.holders.length ? <p>{m.auth_members_empty_page()}</p> : null}
          <RosterPageControls navigation={navigation} busy={busy} next={members.next} onNavigate={navigate} />
        </>
      )}
    </section>
  );
}

export function rosterDirectionLabel(direction: Exclude<RosterDirection, 'retry'>) {
  switch (direction) {
    case 'previous':
      return m.auth_members_previous_page();
    case 'first':
      return m.auth_members_first_page();
    case 'next':
      return m.auth_inventory_next();
    case 'reload':
      return m.auth_members_reload_current();
  }
}
export function RosterPageControls({
  navigation,
  busy,
  next,
  failed = false,
  onNavigate,
}: {
  navigation?: RosterNavigationState | undefined;
  busy: boolean;
  next?: string | null;
  failed?: boolean;
  onNavigate: (direction: RosterDirection, cursor?: string) => void;
}) {
  return (
    <nav className="space-y-2" aria-label={m.auth_members_holders()}>
      <div className="flex flex-wrap gap-2">
        {failed ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => onNavigate('retry')}>
            {m.auth_members_recovery_retry()}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !navigation?.previous.length}
              onClick={() => onNavigate('previous')}
            >
              {m.auth_members_previous_page()}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              aria-label={m.auth_members_reload_current()}
              onClick={() => onNavigate('reload')}
            >
              {m.auth_inventory_reload()}
            </Button>
            {next ? (
              <Button type="button" variant="outline" disabled={busy} onClick={() => onNavigate('next', next)}>
                {m.auth_inventory_next()}
              </Button>
            ) : null}
          </>
        )}
        <Button type="button" variant="outline" disabled={busy} onClick={() => onNavigate('first')}>
          {m.auth_members_first_page()}
        </Button>
      </div>
      {navigation && !navigation.previous.length && navigation.truncated ? (
        <p role="status">{m.auth_members_previous_boundary()}</p>
      ) : null}
    </nav>
  );
}
