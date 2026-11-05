import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../../../../paraglide/messages.js';
import { PageStory } from '../../../page';
import { attempts, selectVerificationStory, viewport } from '../fixtures';

const meta = {
  title: 'Pages/Account/Verification review',
  parameters: { layout: 'fullscreen', viewport },
  beforeEach: () => selectVerificationStory('pending'),
  render: () => <PageStory visitor="Signed In" path="/review/account-verifications" />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('heading', { name: m.av_review_title() });
    const evidence = await view.findByText(m.av_evidence());
    evidence.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.type(
      await view.findByRole('textbox', { name: m.av_reason() }),
      'Checked the official domain challenge and confirmed authority through the publisher.',
    );
    await userEvent.click(view.getByRole('button', { name: m.av_approve() }));
    await expect(view.getByRole('button', { name: m.av_confirm_button() })).toBeVisible();
    expect(attempts).toHaveLength(0);
  },
};
export const Empty: Story = { beforeEach: () => selectVerificationStory('empty') };
export const Denied: Story = {
  beforeEach: () => selectVerificationStory('denied'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.av_denied());
    expect(view.queryByText(m.av_evidence())).toBeNull();
    expect(view.queryByRole('textbox')).toBeNull();
  },
};
export const Preparing: Story = { beforeEach: () => selectVerificationStory('preparing') };
export const Unavailable: Story = { beforeEach: () => selectVerificationStory('unavailable') };
export const Loading: Story = { tags: ['!dev'], beforeEach: () => selectVerificationStory('loading') };
export const ResumeDecision: Story = {
  beforeEach: () => selectVerificationStory('lost-response'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByText(m.av_evidence()));
    await userEvent.type(
      await view.findByRole('textbox', { name: m.av_reason() }),
      'Confirmed the official domain challenge.',
    );
    await userEvent.click(view.getByRole('button', { name: m.av_approve() }));
    await userEvent.click(view.getByRole('button', { name: m.av_confirm_button() }));
    await view.findByText(m.av_uncertain());
    await userEvent.click(view.getByRole('button', { name: m.av_resume({ action: m.av_approve() }) }));
    await view.findByText(m.av_approval_accepted());
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
  },
};
export const Pagination: Story = {
  tags: ['!dev'],
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.av_next_page() }));
    await view.findByText(m.av_empty());
    await userEvent.click(view.getByRole('button', { name: m.av_previous_page() }));
    await view.findByText(m.av_evidence());
    await userEvent.click(view.getByRole('button', { name: m.av_next_page() }));
    await view.findByText(m.av_empty());
    await userEvent.click(view.getByRole('button', { name: m.av_first_page() }));
    await view.findByText(m.av_evidence());
  },
};
