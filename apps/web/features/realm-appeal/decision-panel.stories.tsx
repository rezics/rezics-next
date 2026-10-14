import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { messages } from '../manage/messages.ts';
import { RealmAppealDecisionPanel } from './decision-panel.tsx';
import { appealActor, appealDecisionFixture, appealDecisionRequests, appealItem, appealRealm, type DecisionState } from './decision-fixtures.ts';
import { recoveryIndexKey } from '../manage/safety-pending.ts';

const principal = 'storybook:realm-sanction-reviewer';
function Review({ state, manageMembers = true }: { state: DecisionState; manageMembers?: boolean }) {
  const fixture = useMemo(() => {
    localStorage.removeItem(recoveryIndexKey(principal, appealRealm));
    return appealDecisionFixture(state);
  }, [state]);
  const [generation, setGeneration] = useState(0);
  useEffect(() => () => fixture.dispose(), [fixture]);
  return <div className="mx-auto max-w-3xl p-4">
    <RealmAppealDecisionPanel key={generation} item={appealItem} realm={appealRealm} actingSubject={appealActor} principal={principal}
      authority={{ dismiss: true, restore: manageMembers }} locale="en" messages={messages} client={fixture.client}
      onDecided={() => setGeneration(value => value + 1)} />
  </div>;
}
const meta = {
  title: 'Manage/Realm sanction decisions (contract states)', component: Review,
  args: { state: 'open' as DecisionState, manageMembers: true },
  parameters: { route: { pathname: `/en/manage/r/${appealRealm}` },
    contractState: { source: 'Decision command and follow-up reads are unrecorded; initial reason and statement use unchanged owner answers.',
      requests: appealDecisionRequests } },
} satisfies Meta<typeof Review>;
export default meta;
type Story = StoryObj<typeof meta>;

async function fill(canvasElement: HTMLElement, outcome: 'Lift ban' | 'Uphold ban') {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: outcome }));
  const element = await within(document.body).findByRole('dialog', { name: outcome });
  await waitFor(() => expect(element.contains(document.activeElement)).toBe(true));
  await Promise.all(element.getAnimations().map(animation => animation.finished));
  const dialog = within(element);
  await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'The statement and the original sanction were reviewed.');
  await userEvent.click(dialog.getByRole('button', { name: messages.decisionSend }));
  return dialog;
}
const populated: Story = { async play({ canvasElement }) {
  await expect(within(canvasElement).findByRole('button', { name: 'Uphold ban' })).resolves.toBeVisible();
  await expect(within(canvasElement).getByRole('button', { name: 'Lift ban' })).toBeVisible();
} };
const moderator: Story = { args: { manageMembers: false }, async play({ canvasElement }) {
  await expect(within(canvasElement).findByRole('button', { name: 'Uphold ban' })).resolves.toBeVisible();
  await waitFor(() => expect(within(canvasElement).queryByRole('button', { name: 'Lift ban' })).toBeNull());
} };
const restore: Story = { async play({ canvasElement }) {
  await fill(canvasElement, 'Lift ban');
  await expect(within(canvasElement).findByRole('heading', { name: 'Ban appeal' })).resolves.toBeVisible();
  await expect(within(canvasElement).queryByRole('button', { name: 'Lift ban' })).toBeNull();
} };
const dismiss: Story = { async play({ canvasElement }) {
  await fill(canvasElement, 'Uphold ban');
  await expect(within(canvasElement).findByRole('heading', { name: 'Ban appeal' })).resolves.toBeVisible();
  await waitFor(() => expect(within(canvasElement).queryByRole('button', { name: 'Uphold ban' })).toBeNull());
} };
const pending: Story = { args: { state: 'pending' }, async play({ canvasElement }) {
  const dialog = await fill(canvasElement, 'Lift ban');
  await expect(dialog.findByRole('alert')).resolves.toHaveTextContent(messages.decisionStillPending);
  await expect(dialog.getByRole('button', { name: messages.decisionResume })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Reason' })).toBeDisabled();
} };
const refusal: Story = { args: { state: 'denied' }, async play({ canvasElement }) {
  const dialog = await fill(canvasElement, 'Lift ban');
  await expect(dialog.findByRole('alert')).resolves.toHaveTextContent('Member management permission is required');
  await expect(dialog.getByRole('textbox', { name: 'Reason' })).toHaveValue('The statement and the original sanction were reviewed.');
} };
const stale: Story = { args: { state: 'stale' }, async play({ canvasElement }) {
  const dialog = await fill(canvasElement, 'Lift ban');
  await expect(dialog.findByRole('alert')).resolves.toHaveTextContent('Case changed since review');
} };
const lost: Story = { args: { state: 'lost-response' }, async play({ canvasElement }) {
  const dialog = await fill(canvasElement, 'Lift ban');
  await expect(dialog.findByRole('button', { name: messages.decisionResume })).resolves.toBeVisible();
  await userEvent.click(dialog.getByRole('button', { name: messages.decisionResume }));
  await expect(within(canvasElement).findByRole('heading', { name: 'Ban appeal' })).resolves.toBeVisible();
  await expect(within(canvasElement).queryByRole('button', { name: 'Lift ban' })).toBeNull();
} };
const loading: Story = { args: { state: 'loading' }, async play({ canvasElement }) {
  await expect(within(canvasElement).getByRole('status')).toBeVisible();
  await expect(within(canvasElement).queryByRole('button', { name: 'Lift ban' })).toBeNull();
} };
const error: Story = { args: { state: 'error' }, async play({ canvasElement }) {
  await expect(within(canvasElement).findByRole('alert')).resolves.toHaveTextContent('Appeal is temporarily unavailable');
} };
const at = (story: Story, viewport: 'phone' | 'desktop'): Story => ({ ...story, globals: { viewport: { value: viewport } } });
export const PopulatedPhone = at(populated, 'phone');
export const PopulatedDesktop = at(populated, 'desktop');
export const ModeratorPhone = at(moderator, 'phone');
export const ModeratorDesktop = at(moderator, 'desktop');
export const RestorePhone = at(restore, 'phone');
export const RestoreDesktop = at(restore, 'desktop');
export const DismissPhone = at(dismiss, 'phone');
export const DismissDesktop = at(dismiss, 'desktop');
export const PendingPhone = at(pending, 'phone');
export const PendingDesktop = at(pending, 'desktop');
export const RefusalPhone = at(refusal, 'phone');
export const RefusalDesktop = at(refusal, 'desktop');
export const StalePhone = at(stale, 'phone');
export const StaleDesktop = at(stale, 'desktop');
export const LostResponsePhone = at(lost, 'phone');
export const LostResponseDesktop = at(lost, 'desktop');
export const LoadingPhone = at(loading, 'phone');
export const LoadingDesktop = at(loading, 'desktop');
export const ErrorPhone = at(error, 'phone');
export const ErrorDesktop = at(error, 'desktop');
