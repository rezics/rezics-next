import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@rezics/ui/shadcn/hover-card';
import { settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Hover card',
  component: HoverCard,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 320 } } },
} satisfies Meta<typeof HoverCard>;
export default meta;
type Story = StoryObj<typeof meta>;

const closed = () => waitFor(() => expect(screen.queryByText(/Hugo Award/)).not.toBeInTheDocument());

const Preview = ({ name, text }: { name: string; text: string }) => (
  <p className="text-sm">
    Written by{' '}
    <HoverCard>
      <HoverCardTrigger delay={0} closeDelay={0} render={<a href="#author" className="text-primary underline" />}>
        {name}
      </HoverCardTrigger>
      <HoverCardContent>
        <p className="font-medium">{name}</p>
        <p className="mt-1 text-muted-foreground">{text}</p>
      </HoverCardContent>
    </HoverCard>
    .
  </p>
);

export const Hover: Story = {
  render: () => <Preview name="Liu Cixin" text="Chinese science fiction writer. Hugo Award for Best Novel, 2015." />,
  async play({ canvasElement }) {
    const link = within(canvasElement).getByRole('link', { name: 'Liu Cixin' });
    await userEvent.hover(link);
    await settled(await screen.findByText(/Hugo Award/));
    await userEvent.unhover(link);
    await closed();
  },
};

export const KeyboardFocus: Story = {
  render: () => <Preview name="Liu Cixin" text="Chinese science fiction writer. Hugo Award for Best Novel, 2015." />,
  async play({ canvasElement }) {
    const link = within(canvasElement).getByRole('link', { name: 'Liu Cixin' });
    // The card is a preview for pointer users: focus opens it too, so keyboard users are not left out.
    await userEvent.tab();
    await expect(link).toHaveFocus();
    await settled(await screen.findByText(/Hugo Award/));
    await userEvent.tab();
    await closed();
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <Preview
      name="劉慈欣"
      text="中國科幻作家，《三體》系列作者。Hugo Award 獲獎作品，已被翻譯成超過三十種語言，並在世界各地的讀者之間引起廣泛討論，內容橫跨宇宙社會學與黑暗森林法則。"
    />
  ),
  async play({ canvasElement }) {
    await userEvent.hover(within(canvasElement).getByRole('link', { name: '劉慈欣' }));
    const text = await settled(await screen.findByText(/中國科幻作家/));
    await expect(text).toBeVisible();
  },
};
