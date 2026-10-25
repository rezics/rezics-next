import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { StarIcon } from 'lucide-react';
import { expect, userEvent, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { LinkBox, LinkOverlay } from './link-overlay.tsx';

const surface: Decorator = (Story, { parameters }) => (
  <div className={cn('max-w-md bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Layout/Link Overlay',
  component: LinkBox,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'Makes a whole card clickable through one real link while other links inside it keep working: a Work card whose title opens the Work while the author and Realm links go elsewhere, or a feed post whose headline opens the thread. Wrap the card in `LinkBox` and render its main link as `LinkOverlay`; the overlay stretches over the box and inner links stack above it. Screen readers and keyboard users meet ordinary, separately named links.',
      },
    },
  },
} satisfies Meta<typeof LinkBox>;
export default meta;
type Story = StoryObj<typeof meta>;

const WorkCard = ({ lang }: { lang?: string }) => {
  const chinese = lang === 'zh-CN';

  return (
    <LinkBox
      className="flex flex-col gap-2 rounded-2xl border border-border/60 bg-card p-5 shadow-(--aura-shadow-card) transition-shadow hover:shadow-(--aura-shadow-card-hover)"
      lang={lang}
    >
      <span className="text-muted-foreground text-xs">
        {chinese ? '在 ' : 'In '}
        <a className="text-primary hover:underline" href="#realm">
          {chinese ? '硬科幻' : 'Hard Science Fiction'}
        </a>
      </span>
      <h3 className="font-heading font-medium text-lg">
        <LinkOverlay href="#work">
          {chinese ? '《三体》The Three-Body Problem' : 'The Dispossessed'}
        </LinkOverlay>
      </h3>
      <p className="text-muted-foreground text-sm">
        {chinese ? '作者 ' : 'by '}
        <a className="text-foreground hover:underline" href="#author">
          {chinese ? '刘慈欣' : 'Ursula K. Le Guin'}
        </a>
      </p>
      <p className="flex items-center gap-1 text-sm">
        <StarIcon aria-hidden className="size-4 fill-rating text-rating" />
        <span className="tabular-nums">{chinese ? '8.8' : '4.3'}</span>
        <span className="text-muted-foreground">
          {chinese ? '· 12,480 人评分' : '· 2,309 ratings in this Realm'}
        </span>
      </p>
    </LinkBox>
  );
};

export const Default: Story = {
  render: () => <WorkCard />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const overlay = canvas.getByRole('link', { name: 'The Dispossessed' });
    const realm = canvas.getByRole('link', { name: 'Hard Science Fiction' });
    const author = canvas.getByRole('link', { name: 'Ursula K. Le Guin' });

    // Tab order follows the DOM: Realm, Work, author.
    await userEvent.tab();
    await expect(realm).toHaveFocus();
    await userEvent.tab();
    await expect(overlay).toHaveFocus();
    await userEvent.tab();
    await expect(author).toHaveFocus();

    // A click on empty card space lands on the overlay; inner links stay on top.
    const box = canvasElement.querySelector<HTMLElement>('[data-slot="link-box"]');
    const rect = box?.getBoundingClientRect();
    if (rect) {
      const target = document.elementFromPoint(rect.right - 12, rect.bottom - 12);
      await expect(target).toBe(overlay);
    }
    const authorRect = author.getBoundingClientRect();
    await expect(
      document.elementFromPoint(authorRect.left + 4, authorRect.top + authorRect.height / 2),
    ).toBe(author);
  },
};

export const Chinese: Story = {
  name: 'zh-CN',
  render: () => <WorkCard lang="zh-CN" />,
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => <WorkCard />,
};
