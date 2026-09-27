import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  Carousel,
  CarouselContent,
  CarouselIndicator,
  CarouselIndicatorGroup,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from './carousel.tsx';

const works = [
  {
    title: '《三体》讨论',
    summary: 'Readers compare how the first contact reshapes life on Earth.',
  },
  {
    title: 'Notes on a City of Rivers',
    summary: 'A reading group maps the neighborhoods in this essay collection.',
  },
  {
    title: 'The Quiet Archive',
    summary: 'Realm members collect translations and publication notes.',
  },
];

const meta = {
  title: 'UI/Carousel',
  component: Carousel,
  tags: ['autodocs'],
  args: { slideCount: works.length },
  parameters: {
    docs: {
      description: {
        component:
          'Use a carousel in REZICS when a short, ordered set of featured Works needs a compact browse surface, such as a Realm highlight or a reading shelf preview.',
      },
    },
  },
  decorators: [
    (Story, context) => (
      <main
        className={
          context.name === 'Dark Mode'
            ? 'dark aura-canvas flex min-h-screen items-center justify-center bg-background p-6'
            : 'aura-canvas flex min-h-screen items-center justify-center bg-background p-6'
        }
      >
        <div className="w-full max-w-3xl px-14">
          <Story />
        </div>
      </main>
    ),
  ],
} satisfies Meta<typeof Carousel>;

export default meta;
type Story = StoryObj<typeof meta>;

const FeaturedWorks = ({ dark = false }: { dark?: boolean }) => (
  <div className={dark ? 'dark rounded-2xl bg-background p-6 text-foreground' : undefined}>
    <Carousel
      aria-label="Featured Works in the Science Fiction Realm"
      slideCount={works.length}
      slidesPerPage={1}
    >
      <CarouselContent>
        {works.map((work, index) => (
          <CarouselItem index={index} key={work.title}>
            <article className="min-h-48 rounded-2xl border border-border/60 bg-card p-6 shadow-[var(--aura-shadow-card)]">
              <p className="text-sm text-muted-foreground">Featured Work {index + 1}</p>
              <h2 className="mt-3 font-semibold text-xl text-foreground">{work.title}</h2>
              <p className="mt-2 max-w-prose text-sm text-muted-foreground">{work.summary}</p>
            </article>
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
      <CarouselIndicatorGroup aria-label="Choose a featured Work" className="mt-4">
        {works.map((work, index) => (
          <CarouselIndicator aria-label={`Show ${work.title}`} index={index} key={work.title} />
        ))}
      </CarouselIndicatorGroup>
    </Carousel>
  </div>
);

export const Featured: Story = {
  render: () => <FeaturedWorks />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(
      canvas.getByRole('button', { name: 'Show Notes on a City of Rivers' }),
    ).toHaveAttribute('data-current', '');
    await userEvent.click(canvas.getByRole('button', { name: 'Show 《三体》讨论' }));
    await expect(canvas.getByRole('button', { name: 'Show 《三体》讨论' })).toHaveAttribute(
      'data-current',
      '',
    );
  },
};

export const LongMultilingualTitle: Story = {
  render: () => (
    <Carousel aria-label="Long-title reading list" slideCount={1} slidesPerPage={1}>
      <CarouselContent>
        <CarouselItem index={0}>
          <article className="rounded-2xl border border-border/60 bg-card p-6">
            <h2 className="break-words font-semibold text-foreground text-xl">
              《三体》与跨文化阅读：Notes from a community conversation across languages and
              editions
            </h2>
          </article>
        </CarouselItem>
      </CarouselContent>
    </Carousel>
  ),
};

export const DarkMode: Story = { render: () => <FeaturedWorks dark /> };
