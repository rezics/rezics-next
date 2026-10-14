import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import { acting } from './fixtures.ts';
import { messages } from './messages.ts';
import { readZoneAttachments } from './read.ts';
import { RealmFrame } from './realm-frame.tsx';
import { ZoneAttachmentsPage, type ZoneAttachmentsRead } from './zone-attachments-page.tsx';
import { attachmentActor, attachmentFixture, attachmentRealm, attachmentRequests, type AttachmentState } from './zone-attachments-fixtures.ts';
import { recoveryIndexKey } from './safety-pending.ts';
const principal = 'storybook:realm-attachment-steward';

function Inventory({ state, persona = 'owner', delegated = false }: { state: AttachmentState; persona?: AnswerPersona; delegated?: boolean }) {
  const fixture = useMemo(() => {
    localStorage.removeItem(recoveryIndexKey(principal, attachmentRealm));
    return attachmentFixture(state, persona, delegated);
  }, [state, persona, delegated]);
  const [page, setPage] = useState<ZoneAttachmentsRead | null>(null);
  useEffect(() => {
    let active = true;
    setPage(null);
    void readZoneAttachments(fixture.client(), attachmentRealm, attachmentActor).then(read => { if (active) setPage(read); });
    return () => { active = false; };
  }, [fixture]);
  return <RealmFrame realm={attachmentRealm} header={null} agent={{ ...acting, iri: attachmentActor }} locale="en" messages={messages}>
    <ZoneAttachmentsPage principal={principal} page={page} realm={attachmentRealm} actingSubject={attachmentActor} locale="en" messages={messages}
      client={fixture.client} retryHref={`/en/manage/r/${attachmentRealm}/zones`} />
  </RealmFrame>;
}

const meta = {
  title: 'Manage/Realm attachment inventory (contract states)', component: Inventory,
  args: { state: 'populated' as AttachmentState, persona: 'owner' as AnswerPersona, delegated: false },
  parameters: { route: { pathname: `/en/manage/r/${attachmentRealm}/zones` },
    contractState: { source: 'unrecorded zone/list-attached-zones and zone/withdraw-a-realm-attachment',
      requests: attachmentRequests, rights: 'Original synthetic Zone names; no imported content.' } },
} satisfies Meta<typeof Inventory>;
export default meta;
type Story = StoryObj<typeof meta>;

const populated: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByText('Reading room 1', { exact: true })).resolves.toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: messages.loadMore }));
  await expect(canvas.findByText('Reading room 48', { exact: true })).resolves.toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: messages.loadMore }));
  await expect(canvas.findByText('Reading room 51', { exact: true })).resolves.toBeVisible();
  await expect(canvas.getAllByRole('button', { name: messages.zonesWithdraw })).toHaveLength(51);
  await expect(canvas.queryByRole('button', { name: messages.loadMore })).toBeNull();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
} };
const empty: Story = { args: { state: 'empty' }, async play({ canvasElement }) {
  await expect(within(canvasElement).findByRole('heading', { name: messages.zonesEmpty })).resolves.toBeVisible();
  await expect(within(canvasElement).queryByRole('button', { name: messages.zonesWithdraw })).toBeNull();
} };
const loading: Story = { args: { state: 'loading' }, async play({ canvasElement }) {
  await expect(within(canvasElement).getByRole('status')).toHaveAttribute('aria-busy', 'true');
  await expect(within(canvasElement).queryByText('Reading room 1')).toBeNull();
} };
const error: Story = { args: { state: 'error' }, async play({ canvasElement }) {
  await expect(within(canvasElement).findByRole('heading', { name: messages.unavailableTitle })).resolves.toBeVisible();
} };
const withdrawal: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await canvas.findByText('Reading room 1', { exact: true });
  await userEvent.click(canvas.getAllByRole('button', { name: messages.zonesWithdraw })[0]!);
  await expect(canvas.findByText(messages.zonesWithdrawn)).resolves.toBeVisible();
  await expect(canvas.queryByText('Reading room 1', { exact: true })).toBeNull();
} };
const pending: Story = { args: { state: 'pending' }, parameters: { contractState: { status: 202, path: attachmentRequests.withdraw, body: attachmentRequests.body } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByText('Reading room 1', { exact: true });
    await userEvent.click(canvas.getAllByRole('button', { name: messages.zonesWithdraw })[0]!);
    await expect(canvas.findByText(messages.decisionStillPending)).resolves.toBeVisible();
    await expect(canvas.getByText('Reading room 1', { exact: true })).toBeVisible();
    await expect(canvas.queryByText(messages.zonesWithdrawn)).toBeNull();
    await expect(canvas.getByRole('button', { name: messages.decisionResume })).toBeVisible();
  } };
const refused: Story = { args: { state: 'refused' }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await canvas.findByText('Reading room 1', { exact: true });
  await userEvent.click(canvas.getAllByRole('button', { name: messages.zonesWithdraw })[0]!);
  await expect(canvas.findByText('Realm stewardship has ended')).resolves.toBeVisible();
  await expect(canvas.getByText('Reading room 1', { exact: true })).toBeVisible();
} };
const revoked: Story = { args: { state: 'revoked', persona: 'moderator', delegated: true }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await canvas.findByText('Reading room 1', { exact: true });
  await userEvent.click(canvas.getByRole('button', { name: messages.loadMore }));
  await expect(canvas.findByText('Realm is unavailable')).resolves.toBeVisible();
  await expect(canvas.queryByText('Reading room 1', { exact: true })).toBeNull();
  await expect(canvas.queryByRole('button', { name: messages.loadMore })).toBeNull();
} };
const moved: Story = { args: { state: 'moved' }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await canvas.findByText('Reading room 1', { exact: true });
  await userEvent.click(canvas.getByRole('button', { name: messages.loadMore }));
  await expect(canvas.findByText('Attachment inventory changed')).resolves.toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: messages.startOver }));
  await expect(canvas.findByRole('button', { name: messages.loadMore })).resolves.toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: messages.loadMore }));
  await expect(canvas.findByText('Reading room 48', { exact: true })).resolves.toBeVisible();
} };
const at = (story: Story, viewport: 'phone' | 'desktop'): Story => ({ ...story, globals: { viewport: { value: viewport } } });
export const PopulatedPhone = at(populated, 'phone');
export const PopulatedDesktop = at(populated, 'desktop');
export const EmptyPhone = at(empty, 'phone');
export const EmptyDesktop = at(empty, 'desktop');
export const LoadingPhone = at(loading, 'phone');
export const LoadingDesktop = at(loading, 'desktop');
export const ErrorPhone = at(error, 'phone');
export const ErrorDesktop = at(error, 'desktop');
export const WithdrawPhone = at(withdrawal, 'phone');
export const WithdrawDesktop = at(withdrawal, 'desktop');
export const PendingPhone = at(pending, 'phone');
export const PendingDesktop = at(pending, 'desktop');
export const RefusedPhone = at(refused, 'phone');
export const RefusedDesktop = at(refused, 'desktop');
export const RevokedPhone = at(revoked, 'phone');
export const RevokedDesktop = at(revoked, 'desktop');
export const MovedPhone = at(moved, 'phone');
export const MovedDesktop = at(moved, 'desktop');
const concealed: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('heading', { name: messages.missingTitle })).resolves.toBeVisible();
  await expect(canvas.queryByText('Reading room 1', { exact: true })).toBeNull();
  await expect(canvas.queryByRole('button', { name: messages.loadMore })).toBeNull();
  await expect(canvas.queryByRole('button', { name: messages.zonesWithdraw })).toBeNull();
} };
export const Visitor = { ...at(concealed, 'phone'), args: { persona: 'visitor' as const } };
export const Stranger = { ...Visitor, args: { persona: 'stranger' as const } };
export const Member = { ...Visitor, args: { persona: 'member' as const } };
export const ModeratorWithoutStewardship = { ...Visitor, args: { persona: 'moderator' as const } };
export const OperatorWithoutMandate = { ...Visitor, args: { persona: 'operator' as const } };
export const OperatorWithMandate = { ...at(populated, 'desktop'), args: { persona: 'operator' as const, delegated: true } };
