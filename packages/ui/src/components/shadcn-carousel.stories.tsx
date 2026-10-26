import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Card, CardContent } from '@rezics/ui/shadcn/card';
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from '@rezics/ui/shadcn/carousel';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Carousel',
  component: Carousel,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Carousel>;
export default meta;
type Story = StoryObj<typeof meta>;

const slides = ['Dune', 'Hyperion', 'Neuromancer', 'Solaris'];

const Shelf = ({ titles = slides, ...props }: { titles?: string[] } & React.ComponentProps<typeof Carousel>) => (
  <div className="mx-auto w-full max-w-xs px-12">
    <Carousel aria-label="Featured books" {...props}>
      <CarouselContent>
        {titles.map((title) => (
          <CarouselItem key={title}>
            <Card>
              <CardContent className="grid aspect-square place-items-center text-center text-lg font-medium">
                {title}
              </CardContent>
            </Card>
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  </div>
);

export const Default: Story = {
  render: () => <Shelf />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const next = canvas.getByRole('button', { name: 'Next slide' });
    const previous = canvas.getByRole('button', { name: 'Previous slide' });
    await waitFor(() => expect(previous).toBeDisabled());
    await userEvent.click(next);
    await waitFor(() => expect(previous).toBeEnabled());
    await expect(canvas.getByRole('region', { name: 'Featured books' })).toHaveAttribute(
      'aria-roledescription',
      'carousel',
    );
  },
};

export const KeyboardNavigation: Story = {
  render: () => <Shelf />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const previous = canvas.getByRole('button', { name: 'Previous slide' });
    const next = canvas.getByRole('button', { name: 'Next slide' });
    await waitFor(() => expect(previous).toBeDisabled());
    next.focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(previous).toBeEnabled());
    next.focus();
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(previous).toBeDisabled());
  },
};

export const Vertical: Story = {
  render: () => (
    <div className="mx-auto w-full max-w-xs py-12">
      <Carousel orientation="vertical" aria-label="Featured books" opts={{ align: 'start' }}>
        <CarouselContent className="h-48">
          {slides.map((title) => (
            <CarouselItem key={title} className="basis-1/2">
              <Card size="sm">
                <CardContent className="text-center font-medium">{title}</CardContent>
              </Card>
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious />
        <CarouselNext />
      </Carousel>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const next = canvas.getByRole('button', { name: 'Next slide' });
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.click(next);
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Previous slide' })).toBeEnabled());
  },
};

export const SingleSlideAndCjkText: Story = {
  render: () => <Shelf titles={['三體：地球往事——一部很長很長的書名也應該在卡片內折行顯示']} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/^三體/)).toBeVisible();
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Next slide' })).toBeDisabled());
    await expect(canvas.getByRole('button', { name: 'Previous slide' })).toBeDisabled();
  },
};
