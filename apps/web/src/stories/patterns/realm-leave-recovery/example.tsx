import type { StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { RealmMembership } from '../../../community/realm-membership';
import realm from '../../../kernel/recorded/realm.json';
import { m } from '../../../paraglide/messages.js';
import { PatternStory } from '../../page';
import { withCommunityCurrentClaim } from '../../community-current-claim';

type Scenario = 'owner-required' | 'generic-refusal' | 'access-denied' | 'uncertain-retry' | 'accepted-pending';
const realmId = realm.realm.realmId;

export function RealmLeaveExample() {
  return (
    <PatternStory visitor="Signed In" path="/spaces/atlas-member">
      <RealmMembership realm={{ id: realmId, visibility: 'public', viewer: null }} returnTo="/spaces/atlas-member" />
    </PatternStory>
  );
}

/** Constructed native failure/acceptance envelopes around the real controller and recorded home.
 * A same-subject retry keeps its original key and CSRF token after current standing is re-read. No grant, transfer or
 * successful leave is fabricated. These stories do not prove native guard binding.
 */
export function leaveRecoveryStory(scenario: Scenario): Pick<StoryObj, 'beforeEach' | 'play'> {
  const keys: (string | null)[] = [];
  let accessReads = 0;
  let membershipReads = 0;
  return {
    beforeEach: () => {
      keys.length = 0;
      accessReads = 0;
      membershipReads = 0;
      const previous = globalThis.fetch;
      const currentClaim = withCommunityCurrentClaim(previous);
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), 'http://rezics.local');
        if (url.origin !== 'http://kernel.local') return previous(input, init);
        const request = new Request(input, init);
        const problem = (owner: boolean) => ({
          type: `https://rezics.com/problems/${owner ? 'realm_last_owner' : 'forbidden'}`,
          title: owner ? 'Realm Ownership Transfer Required' : 'Forbidden',
          code: owner ? 'realm_last_owner' : 'forbidden',
          status: owner ? 409 : 403,
          retryable: false,
          effect_status: 'not_applied',
          request_id: 'constructed-leave-response',
        });
        if (url.pathname === `/v1/realms/${realmId}/membership` && request.method === 'DELETE') {
          keys.push(request.headers.get('idempotency-key'));
          if (scenario === 'uncertain-retry' && keys.length === 1) throw new Error('Constructed lost response');
          if (scenario === 'accepted-pending' || scenario === 'uncertain-retry')
            return Response.json({ workflowId: 'constructed-pending-workflow' }, { status: 202 });
          const body = problem(scenario !== 'generic-refusal');
          return Response.json(body, { status: body.status });
        }
        if (url.pathname === `/v1/realms/${realmId}/members/me`) {
          membershipReads++;
          return Response.json({ state: 'member', since: null });
        }
        if (url.pathname === '/v1/grants' && url.searchParams.get('resourceId') === realmId) {
          accessReads++;
          return Response.json(problem(false), { status: 403 });
        }
        return currentClaim(input, init);
      }) as typeof fetch;
      return () => {
        globalThis.fetch = previous;
      };
    },
    play: async ({ canvasElement }) => {
      const view = within(canvasElement);
      const membership = within(await view.findByRole('region', { name: m.realm_membership_label() }));
      const leave = await membership.findByRole('button', { name: m.realm_leave() });
      await waitFor(() => expect(leave).toBeEnabled());
      await userEvent.click(leave);
      if (scenario === 'accepted-pending') {
        await membership.findByText(m.realm_state_pending());
        await membership.findByText(m.realm_membership_still_pending());
        await expect(view.queryByRole('region', { name: m.realm_leave_recovery_label() })).toBeNull();
        await expect(keys).toHaveLength(1);
        return;
      }
      const recovery = within(await view.findByRole('region', { name: m.realm_leave_recovery_label() }));
      await recovery.findByText(scenario === 'uncertain-retry' ? m.realm_leave_uncertain() : m.realm_leave_refused());
      await expect(membership.getByText(m.realm_state_member())).toBeVisible();
      await expect(leave).toBeDisabled();
      await expect(keys).toHaveLength(1);
      if (scenario === 'uncertain-retry') {
        await expect(recovery.queryByRole('button', { name: m.realm_leave_review_access() })).toBeNull();
        await userEvent.click(recovery.getByRole('button', { name: m.realm_membership_retry() }));
        await recovery.findByText(m.realm_leave_not_settled());
        await expect(keys).toHaveLength(1);
        await userEvent.click(recovery.getByRole('button', { name: m.realm_leave_retry_same() }));
        await membership.findByText(m.realm_state_pending());
        await expect(keys).toHaveLength(2);
        await expect(keys[1]).toBe(keys[0]);
        return;
      }
      await recovery.findByText(
        scenario === 'generic-refusal' ? m.realm_leave_owner_policy() : m.realm_leave_owner_required(),
      );
      await expect(recovery.queryByRole('button', { name: m.realm_leave_retry_same() })).toBeNull();
      if (scenario === 'access-denied') {
        const before = accessReads;
        await userEvent.click(recovery.getByRole('button', { name: m.realm_leave_review_access() }));
        await waitFor(() => expect(accessReads).toBe(before + 1));
        await recovery.findByText(m.realm_leave_access_note());
        await expect(recovery.queryByRole('link')).toBeNull();
      } else {
        const before = membershipReads;
        await userEvent.click(recovery.getByRole('button', { name: m.realm_membership_retry() }));
        await waitFor(() => expect(membershipReads).toBeGreaterThan(before));
        await waitFor(() =>
          expect(
            within(view.getByRole('region', { name: m.realm_membership_label() })).getByRole('button', {
              name: m.realm_leave(),
            }),
          ).toBeEnabled(),
        );
      }
      await expect(keys).toHaveLength(1);
    },
  };
}
