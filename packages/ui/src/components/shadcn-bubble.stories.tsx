import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Bubble, BubbleContent, BubbleGroup, BubbleReactions } from '@rezics/ui/shadcn/bubble';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Bubble',
  component: Bubble,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Bubble>;
export default meta;
type Story = StoryObj<typeof meta>;

const variants = ['default', 'secondary', 'muted', 'tinted', 'outline', 'ghost', 'destructive'] as const;

export const Default: Story = {
  render: () => (
    <BubbleGroup className="max-w-md">
      <Bubble>
        <BubbleContent>Did you finish chapter nine yet?</BubbleContent>
      </Bubble>
      <Bubble align="end" variant="secondary">
        <BubbleContent>Last night. The ending of the chapter is a lot to take in.</BubbleContent>
      </Bubble>
    </BubbleGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Did you finish chapter nine yet?')).toBeVisible();
    await expect(canvas.getByText(/^Last night/).closest('[data-slot="bubble"]')).toHaveAttribute('data-align', 'end');
  },
};

export const Variants: Story = {
  render: () => (
    <BubbleGroup className="max-w-md">
      {variants.map((variant) => (
        <Bubble key={variant} variant={variant}>
          <BubbleContent>{`The ${variant} bubble`}</BubbleContent>
        </Bubble>
      ))}
    </BubbleGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    for (const variant of variants)
      await expect(canvas.getByText(`The ${variant} bubble`).closest('[data-slot="bubble"]')).toHaveAttribute(
        'data-variant',
        variant,
      );
  },
};

export const WithReactions: Story = {
  render: () => (
    <BubbleGroup className="max-w-md pb-4">
      <Bubble variant="muted">
        <BubbleContent>That twist at the end was brilliant.</BubbleContent>
        <BubbleReactions>
          <span aria-label="3 likes">👍 3</span>
        </BubbleReactions>
      </Bubble>
    </BubbleGroup>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByLabelText('3 likes')).toBeVisible();
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <BubbleGroup className="max-w-sm">
      <Bubble>
        <BubbleContent>
          Supercalifragilisticexpialidocious-and-other-unbreakable-strings-like-https://example.com/a/very/long/path/that/does/not/stop
        </BubbleContent>
      </Bubble>
      <Bubble align="end" variant="tinted">
        <BubbleContent>
          我昨晚讀完了第九章，結局真的讓人喘不過氣。日本語のメッセージもきちんと折り返されます。
        </BubbleContent>
      </Bubble>
    </BubbleGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const content = canvas.getByText(/^Supercalifragilistic/);
    await expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth);
    await expect(canvas.getByText(/^我昨晚讀完了/)).toBeVisible();
  },
};
