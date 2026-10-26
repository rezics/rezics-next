import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChevronsUpDownIcon } from 'lucide-react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/shadcn/collapsible';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Collapsible',
  component: Collapsible,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Collapsible>;
export default meta;
type Story = StoryObj<typeof meta>;

const Editions = ({
  heading = '3 editions of Dune',
  editions = ['Chilton, 1965', 'Ace, 1990', 'Ace, 2019'],
  ...props
}: { heading?: string; editions?: string[] } & React.ComponentProps<typeof Collapsible>) => (
  <Collapsible className="flex w-80 flex-col gap-2" {...props}>
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-sm font-medium">{heading}</h4>
      <CollapsibleTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Toggle editions" />}>
        <ChevronsUpDownIcon />
      </CollapsibleTrigger>
    </div>
    <div className="rounded-xl border px-3 py-2 text-sm">{editions[0]}</div>
    <CollapsibleContent className="flex flex-col gap-2">
      {editions.slice(1).map((edition) => (
        <div key={edition} className="rounded-xl border px-3 py-2 text-sm">
          {edition}
        </div>
      ))}
    </CollapsibleContent>
  </Collapsible>
);

export const Default: Story = {
  render: () => <Editions />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Toggle editions' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));
    await expect(await canvas.findByText('Ace, 1990')).toBeVisible();
    await userEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  },
};

export const OpenByDefault: Story = {
  render: () => <Editions defaultOpen />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Toggle editions' })).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.getByText('Ace, 2019')).toBeVisible();
  },
};

export const KeyboardAndDisabled: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <Editions />
      <Editions disabled heading="No other editions" editions={['Chilton, 1965', 'Not available']} />
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const [first, second] = canvas.getAllByRole('button', { name: 'Toggle editions' });
    await userEvent.tab();
    await expect(first).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(first).toHaveAttribute('aria-expanded', 'true'));
    await expect(second).toBeDisabled();
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <Editions
      defaultOpen
      heading="沙丘：共 3 個版本，包含繁體中文與日本語（ハヤカワ文庫）譯本"
      editions={[
        '時報文化，2021（繁體中文）',
        'Ace Books, anniversary hardcover edition with an introduction by Brian Herbert',
      ]}
    />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: /^沙丘/ })).toBeVisible();
    await expect(canvas.getByText(/^Ace Books/)).toBeVisible();
  },
};
