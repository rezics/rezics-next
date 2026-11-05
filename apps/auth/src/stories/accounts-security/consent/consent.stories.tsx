import { SecurityInventory, type InventorySource } from '../../../security-inventory-view';
import type { GrantedConsent, InventoryPage } from '../../../security-inventory';
import { AuthPage } from '../../../frame';
import { m } from '../../../paraglide/messages.js';
import { permissionRemovalLabel } from '../../../permission-description';
import {
  AuthStory,
  authLocale,
  reviewParameters,
  button,
  waitFor,
  preparingInventory,
  unavailableInventory,
} from '../../accounts-operations/story';

export default { title: 'Pages/Account/Consent permissions', parameters: reviewParameters, decorators: [authLocale] };
const consent: GrantedConsent = {
  client_id: 'third-party',
  display_name: 'Reading companion',
  granted: ['openid', 'offline_access', 'subject:read'],
  status: 'current',
  reducible: true,
  pending_reduction: false,
};
function inventory(rows: () => GrantedConsent[]): InventorySource {
  return async (view) =>
    ({ kind: 'ready', rows: view === 'clients' ? [] : rows(), next: null }) as InventoryPage<typeof view>;
}
const current = inventory(() => [consent]);

async function expectAuthPage(canvas: HTMLElement, heading = m.auth_security_heading()) {
  const main = await waitFor(() => canvas.querySelector('main'));
  if (canvas.querySelectorAll('main, [role="main"]').length !== 1)
    throw new Error('Consent pages must have exactly one main landmark');
  const headings = canvas.querySelectorAll('h1');
  if (headings.length !== 1 || !main.contains(headings[0]!) || headings[0]?.textContent !== heading)
    throw new Error('Consent pages must have their localized page heading inside main');
}

async function selectSubset(canvas: HTMLElement) {
  await expectAuthPage(canvas);
  (await waitFor(() => button(canvas, m.auth_inventory_review_named({ name: 'Reading companion' })))).click();
  const review = await waitFor(() => button(canvas, m.auth_inventory_review_removal()));
  if (!review.disabled) throw new Error('Unchanged selection cannot be submitted');
  await waitFor(() => canvas.textContent?.includes(m.auth_permission_description_subject_read()));
  (
    await waitFor(() =>
      [...canvas.querySelectorAll('button')].find(
        (entry) => entry.getAttribute('aria-label') === permissionRemovalLabel('offline_access'),
      ),
    )
  ).click();
  (await waitFor(() => !review.disabled && review)).click();
  await waitFor(() => canvas.textContent?.includes(m.auth_inventory_reduce_confirm({ name: 'Reading companion' })));
  const fieldset = canvas.querySelector('fieldset');
  if (!fieldset?.textContent?.includes('offline_access'))
    throw new Error('Confirmation must show exact removed permission');
  if (fieldset.querySelector('input[type="checkbox"]')) throw new Error('No grant or restore checkbox is allowed');
}

export const SubsetReduction = {
  render: () => (
    <AuthStory>
      <AuthPage heading={m.auth_security_heading()}>
        <SecurityInventory source={current} />
      </AuthPage>
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await selectSubset(canvasElement);
    (await waitFor(() => button(canvasElement, m.auth_inventory_reduce()))).click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_inventory_reduced()));
    if (canvasElement.querySelector('code')) throw new Error('Acknowledgement must discard old permission rows');
    await waitFor(() => canvasElement.querySelector('a[href="/login"]'));
  },
};
export const UnknownResponse = {
  render: () => (
    <AuthStory mode="unknown">
      <AuthPage heading={m.auth_security_heading()}>
        <SecurityInventory source={current} />
      </AuthPage>
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await selectSubset(canvasElement);
    (await waitFor(() => button(canvasElement, m.auth_inventory_reduce()))).click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_inventory_unknown()));
    if (canvasElement.textContent?.includes(m.auth_inventory_reduced()))
      throw new Error('Unknown cannot confirm reduction');
    if (button(canvasElement, m.auth_inventory_reduce())) throw new Error('Unknown cannot replay the old draft');
    await waitFor(() => canvasElement.querySelector('a[href="/login"]'));
  },
};
export const PendingOnConfirmation = {
  render: () => {
    let reads = 0;
    const source = inventory(() => [{ ...consent, pending_reduction: ++reads > 1 }]);
    return (
      <AuthStory>
        <AuthPage heading={m.auth_security_heading()}>
          <SecurityInventory source={source} />
        </AuthPage>
      </AuthStory>
    );
  },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await selectSubset(canvasElement);
    (await waitFor(() => button(canvasElement, m.auth_inventory_reduce()))).click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_inventory_denied()));
    if (canvasElement.textContent?.includes(m.auth_inventory_reduced())) throw new Error('Stale DTO must not write');
  },
};
export const StaleReviewRequiresFreshDecision = {
  render: () => {
    let reads = 0;
    const source = inventory(() => [
      {
        ...consent,
        granted: reads++ < 2 ? consent.granted : [...consent.granted, 'account:read'],
      },
    ]);
    return (
      <AuthStory mode="refused">
        <AuthPage heading={m.auth_security_heading()}>
          <SecurityInventory source={source} />
        </AuthPage>
      </AuthStory>
    );
  },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await selectSubset(canvasElement);
    (await waitFor(() => button(canvasElement, m.auth_inventory_reduce()))).click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_consent_stale_review()));
    await waitFor(() => canvasElement.textContent?.includes('account:read'));
    if (canvasElement.textContent?.includes(m.auth_inventory_reduced()))
      throw new Error('A stale review cannot confirm or replay a reduction');
    if (!button(canvasElement, m.auth_inventory_review_named({ name: 'Reading companion' })))
      throw new Error('The updated grant must be available for a fresh decision');
  },
};
const restricted = inventory(() => [
  { ...consent, reducible: false },
  { ...consent, client_id: 'pending', pending_reduction: true },
  { ...consent, client_id: 'inactive', status: 'inactive', granted: [] },
  { ...consent, client_id: 'unavailable', status: 'unavailable', granted: [], reducible: false },
]);
export const Restricted = {
  render: () => (
    <AuthStory>
      <AuthPage heading={m.auth_security_heading()}>
        <SecurityInventory source={restricted} />
      </AuthPage>
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await expectAuthPage(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_inventory_consent_pending()));
    if (button(canvasElement, m.auth_inventory_review_named({ name: 'Reading companion' })))
      throw new Error('Restricted grants are read-only');
  },
};
export const DeletionPreflight = {
  render: () => (
    <AuthStory>
      <AuthPage heading={m.auth_account_delete_heading()}>
        <SecurityInventory
          preflight
          source={inventory(() => [
            {
              ...consent,
              granted: ['openid', '<unknown:permission>', `subject:read:${'unfamiliar_'.repeat(10)}`],
            },
          ])}
        />
      </AuthPage>
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await expectAuthPage(canvasElement, m.auth_account_delete_heading());
    await waitFor(() =>
      [...canvasElement.querySelectorAll('code')].some((code) => code.textContent === '<unknown:permission>'),
    );
    await waitFor(() => canvasElement.textContent?.includes(m.auth_permission_description_unknown_detail()));
    if (canvasElement.querySelector('unknown\\:permission')) throw new Error('Unknown tokens must render as text');
    if (
      button(canvasElement, m.auth_inventory_review_named({ name: 'Reading companion' })) ||
      button(canvasElement, m.auth_inventory_remove_named({ name: 'Reading companion' }))
    )
      throw new Error('Deletion preflight must remain read-only');
  },
};
export const Loading = {
  render: () => (
    <AuthStory>
      <AuthPage heading={m.auth_security_heading()}>
        <SecurityInventory source={preparingInventory} />
      </AuthPage>
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await expectAuthPage(canvasElement);
  },
};
export const Unavailable = {
  render: () => (
    <AuthStory>
      <AuthPage heading={m.auth_security_heading()}>
        <SecurityInventory source={unavailableInventory} />
      </AuthPage>
    </AuthStory>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await expectAuthPage(canvasElement);
  },
};
