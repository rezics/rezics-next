import type { Meta, StoryObj } from '@storybook/react-vite';
import { CircleAlertIcon, InfoIcon } from 'lucide-react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Alert',
  component: Alert,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Alert>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Alert className="max-w-md">
      <InfoIcon />
      <AlertTitle>Your import is queued</AlertTitle>
      <AlertDescription>We will email you when the 128 Works on your shelf have been matched.</AlertDescription>
    </Alert>
  ),
  async play({ canvasElement }) {
    const alert = within(canvasElement).getByRole('alert');
    await expect(alert).toHaveTextContent('Your import is queued');
    await expect(alert).toHaveTextContent('128 Works');
  },
};

export const Destructive: Story = {
  render: () => (
    <Alert variant="destructive" className="max-w-md">
      <CircleAlertIcon />
      <AlertTitle>Payment failed</AlertTitle>
      <AlertDescription>Your card was declined. Update the payment method to keep your subscription.</AlertDescription>
    </Alert>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Payment failed');
  },
};

const Dismissible = () => {
  const [open, setOpen] = useState(true);
  return open ? (
    <Alert className="max-w-md">
      <InfoIcon />
      <AlertTitle>Draft saved</AlertTitle>
      <AlertDescription>Your review is saved on this device only.</AlertDescription>
      <AlertAction>
        <Button size="xs" variant="outline" onClick={() => setOpen(false)}>
          Dismiss
        </Button>
      </AlertAction>
    </Alert>
  ) : (
    <p>Dismissed</p>
  );
};

export const WithAction: Story = {
  render: () => <Dismissible />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Dismiss' }));
    await expect(await canvas.findByText('Dismissed')).toBeVisible();
    await expect(canvas.queryByRole('alert')).toBeNull();
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-3">
      <Alert>
        <InfoIcon />
        <AlertTitle>
          The edition you are trying to add already exists under a different title and publisher in the catalogue
        </AlertTitle>
        <AlertDescription>
          Open the existing edition to add your copy, or ask a librarian to merge the two records if you are sure they
          differ.
        </AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>匯入失敗：找不到「三體」的第二卷</AlertTitle>
        <AlertDescription>請確認檔案格式後重新上傳。日本語のエラーメッセージも折り返されます。</AlertDescription>
      </Alert>
    </div>
  ),
  async play({ canvasElement }) {
    const alerts = within(canvasElement).getAllByRole('alert');
    await expect(alerts).toHaveLength(2);
    await expect(alerts[1]).toHaveTextContent('匯入失敗');
  },
};
