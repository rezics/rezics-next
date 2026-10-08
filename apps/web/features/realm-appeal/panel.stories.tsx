import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { BanReading } from './reading.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { RealmBanPanel, type AppealActions } from './panel.tsx';

const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const receiptId = '00000000-0000-4000-8000-0000000000aa';
const caseId = '00000000-0000-4000-8000-0000000000bb';
const liftingReceiptId = '00000000-0000-4000-8000-0000000000dd';
const reason = 'Posted the same chapter five times.';

function ban(
  appeal: BanReading['appeal'],
  bannedUntil: string | null = null,
  lift: Pick<BanReading, 'liftedAt' | 'liftingReceiptId'> = { liftedAt: null, liftingReceiptId: null },
): BanReading {
  return {
    realm, receiptId, action: 'ban', reason, bannedUntil, permanent: bannedUntil === null,
    happenedAt: '2026-10-01T12:00:00.000Z', appeal, ...lift,
  };
}

const longReason = `${reason}\n${'https://example.invalid/'.repeat(12)}and a note that stays with the recorded words.`;

const meta = {
  title: 'Realm/Ban appeal',
  component: RealmBanPanel,
  args: {
    reading: ban({ state: 'none' }),
    realm,
    locale: 'en' as const,
    messages,
  },
} satisfies Meta<typeof RealmBanPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

async function fits(canvasElement: HTMLElement) {
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
}

/** Permanent ban, the recorded reason, and one appeal. The form starts clean. */
export const CanAppeal: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'You are banned from this community' })).toBeVisible();
    await expect(canvas.getByText('This ban does not end.')).toBeVisible();
    await expect(canvas.getByText(reason)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Send appeal' })).toBeVisible();
    await expect(canvas.queryByRole('alert')).toBeNull();
    await expect(canvas.getByRole('textbox', { name: 'Your statement' })).toHaveValue('');
  },
};

/** A member who is not banned sees none of this. */
export const NotBanned: Story = {
  args: { reading: null },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('region', { name: 'Your ban' })).toBeNull();
  },
};

/** A ban with an end date, on a phone, including a long recorded reason. */
export const UntilADate: Story = {
  args: { reading: { ...ban({ state: 'none' }, '2026-11-01T15:00:00.000Z'), reason: longReason } },
  globals: { viewport: { value: 'phone' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/This ban ends on/)).toBeVisible();
    await expect(canvas.getByText(/Banned on/)).toBeVisible();
    await fits(canvasElement);
  },
};

/** Sending the statement shows that it was received and does not offer another. */
export const Received: Story = {
  args: {
    actions: {
      async submit(statement) {
        return {
          kind: 'sent',
          reading: ban({ state: 'open', caseId, statement }),
        };
      },
    } satisfies AppealActions,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Your statement' }), 'I posted it once.');
    await userEvent.click(canvas.getByRole('button', { name: 'Send appeal' }));
    await expect(canvas.getByRole('heading', { name: 'Appeal received' })).toBeVisible();
    await expect(canvas.getByText('I posted it once.')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Send appeal' })).toBeNull();
    await expect(canvas.queryByText(moderatorName)).toBeNull();
  },
};

const moderatorName = 'Harbour Moderator';

/** Upheld, with the shared rationale and when it was decided. No second appeal. */
export const Upheld: Story = {
  args: {
    reading: ban({
      state: 'decided', caseId, statement: 'I posted it once.', outcome: 'dismiss',
      rationale: 'The posts were the same chapter.', decidedAt: '2026-10-02T08:30:00.000Z',
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: /Moderators upheld the ban on/ })).toBeVisible();
    await expect(canvas.getByText('The posts were the same chapter.')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'You are banned from this community' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Send appeal' })).toBeNull();
    await expect(canvasElement.textContent).not.toContain(moderatorName);
  },
};

/** A reversal lifts the ban. The page names the date and not a remaining ban. */
export const Reversed: Story = {
  args: {
    reading: ban({
      state: 'decided', caseId, statement: 'I posted it once.', outcome: 'restore',
      rationale: null, decidedAt: '2026-10-02T08:30:00.000Z',
    }, null, { liftedAt: '2026-10-02T08:30:00.000Z', liftingReceiptId }),
  },
  globals: { viewport: { value: 'desktop' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: /Your ban was lifted on/ })).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: 'You are banned from this community' })).toBeNull();
    await expect(canvas.queryByText(/stay banned/)).toBeNull();
    await expect(canvas.queryByText('What they shared')).toBeNull();
    await expect(canvas.queryByRole('button', { name: 'Send appeal' })).toBeNull();
    await expect(canvasElement.textContent).not.toContain(liftingReceiptId);
    await fits(canvasElement);
  },
};

/** A failed send keeps the statement. */
export const SendFailed: Story = {
  args: {
    actions: { async submit() { return { kind: 'failed', reuseKey: true }; } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = canvas.getByRole('textbox', { name: 'Your statement' });
    await userEvent.type(box, 'I posted it once.');
    await userEvent.click(canvas.getByRole('button', { name: 'Send appeal' }));
    await expect(canvas.getByRole('alert')).toHaveTextContent('The appeal was not sent');
    await expect(box).toHaveValue('I posted it once.');
  },
};

/** Chinese copy stays inside a phone width. */
export const ChinesePhone: Story = {
  args: {
    locale: 'zh-Hans',
    messages: zhHans as unknown as typeof messages,
    reading: { ...ban({ state: 'none' }, '2026-11-01T15:00:00.000Z'), reason: longReason },
  },
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('heading', { name: '你被这个社区封禁了' })).toBeVisible();
    await fits(canvasElement);
  },
};
