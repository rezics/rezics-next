import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { dismissed } from '../test/waits.ts';
import { settled, withSurface } from '../stories/support.tsx';
import { Button } from '@rezics/ui/shadcn/button';
import { ReportDialog } from './report-dialog.tsx';

const meta = {
  title: 'Components/Report Dialog',
  component: ReportDialog,
  tags: ['autodocs'],
  decorators: [withSurface],
  args: {
    onOpenChange: fn(),
    onSubmit: fn(async () => undefined),
    open: false,
    verified: true,
  },
  parameters: { docs: { story: { inline: false, iframeHeight: 700 } } },
} satisfies Meta<typeof ReportDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

const ReportReasonsDemo = () => <ReportDialog onOpenChange={fn()} onSubmit={fn(async () => undefined)} open verified />;

const DetailsRequiredDemo = () => (
  <ReportDialog maxDetails={12} onOpenChange={fn()} onSubmit={fn(async () => undefined)} open verified />
);

const VerificationSlotDemo = () => {
  const [verified, setVerified] = useState(false);

  return (
    <ReportDialog
      onOpenChange={fn()}
      onSubmit={fn(async () => undefined)}
      open
      verification={
        <div aria-label="Human verification" className="flex flex-col gap-2" role="group">
          <p>Complete this host supplied challenge.</p>
          <Button onClick={() => setVerified(true)} size="sm" variant="outline">
            Complete verification
          </Button>
        </div>
      }
      verified={verified}
    />
  );
};

const SubmitStatesDemo = () => {
  const [open, setOpen] = useState(true);
  const attempts = useRef(0);

  const submit = async () => {
    attempts.current += 1;
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (attempts.current === 1) throw new Error('The moderation service is temporarily unavailable.');
  };

  return <ReportDialog onOpenChange={setOpen} onSubmit={submit} open={open} verified />;
};

export const ReportReasons: Story = {
  render: () => <ReportReasonsDemo />,
  async play() {
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Report this content' }));
    const group = within(dialog).getByRole('radiogroup', { name: 'Why are you reporting this?' });
    const reasons: [string, string][] = [
      ['Off topic', 'This content does not belong in this discussion.'],
      ['Inappropriate', 'This content is harmful or unsuitable.'],
      ['Spam', 'This content is repetitive or promotional.'],
      ['Illegal activity', 'This content may break the law.'],
      ['Other', 'The issue does not fit the options above.'],
    ];
    for (const [name, description] of reasons) {
      const radio = within(group).getByRole('radio', { name });
      await expect(radio).toBeVisible();
      await expect(within(group).getByText(description)).toBeVisible();
    }
  },
};

export const DetailsRequired: Story = {
  render: () => <DetailsRequiredDemo />,
  async play() {
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Report this content' }));
    const details = within(dialog).getByRole('textbox', { name: 'Additional details' });
    const submit = within(dialog).getByRole('button', { name: 'Submit report' });
    await expect(details).not.toBeRequired();
    await expect(submit).toBeDisabled();

    await userEvent.click(within(dialog).getByRole('radio', { name: 'Off topic' }));
    await expect(details).not.toBeRequired();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Illegal activity' }));
    await expect(details).toBeRequired();
    await expect(submit).toBeDisabled();
    await userEvent.type(details, 'Too long for this limit');
    await expect(details).toHaveValue('Too long for');
    await expect(within(dialog).getByRole('status', { name: 'Character count' })).toHaveTextContent(
      '12 of 12 characters',
    );
    await expect(submit).toBeEnabled();

    await userEvent.clear(details);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Other' }));
    await expect(details).toBeRequired();
    await expect(submit).toBeDisabled();
  },
};

export const VerificationSlot: Story = {
  render: () => <VerificationSlotDemo />,
  async play() {
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Report this content' }));
    const submit = within(dialog).getByRole('button', { name: 'Submit report' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Spam' }));
    await expect(within(dialog).getByRole('group', { name: 'Human verification' })).toBeVisible();
    await expect(submit).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Complete verification' }));
    await expect(submit).toBeEnabled();
  },
};

export const SubmitStates: Story = {
  render: () => <SubmitStatesDemo />,
  async play() {
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Report this content' }));
    const details = within(dialog).getByRole('textbox', { name: 'Additional details' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Illegal activity' }));
    await userEvent.type(details, 'This listing promotes a prohibited sale.');

    const submit = within(dialog).getByRole('button', { name: 'Submit report' });
    await userEvent.click(submit);
    await waitFor(() => expect(submit).toHaveAttribute('aria-busy', 'true'));
    await expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The moderation service is temporarily unavailable.',
    );
    await expect(details).toHaveValue('This listing promotes a prohibited sale.');
    await expect(within(dialog).getByRole('radio', { name: 'Illegal activity' })).toBeChecked();

    await userEvent.click(submit);
    await expect(await within(dialog).findByRole('status', { name: 'Thank you for your report.' })).toHaveTextContent(
      'Our moderation team will review it.',
    );
    await dismissed('dialog');
  },
};
