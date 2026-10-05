import {
  Carousel,
  CarouselAutoplayTrigger,
  CarouselContent,
  CarouselIndicator,
  CarouselItem,
  useCarousel,
} from '@rezics/ui/carousel';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, spyOn, userEvent, waitFor, within } from 'storybook/test';

function Status() {
  const api = useCarousel();
  return (
    <>
      <CarouselAutoplayTrigger
        aria-label={api.isRotationRequested ? 'Pause rotation' : 'Start rotation'}
      >
        Rotation
      </CarouselAutoplayTrigger>
      <button type="button" onClick={() => api.scrollNext(true)}>
        Manual next
      </button>
      <output data-testid="rotation" data-playing={api.isPlaying} data-page={api.page}>
        Page {api.page + 1}
      </output>
    </>
  );
}
function Rotation() {
  return (
    <div className="p-4">
      <Carousel
        aria-label="Rotation behavior"
        slideCount={3}
        autoplay={{ delay: 200 }}
        loop
        style={{ width: '400px', maxWidth: '100%' }}
      >
        <Status />
        <CarouselContent>
          {[0, 1, 2].map((index) => (
            <CarouselItem index={index} key={index}>
              <a href={`/work/${index}`} className="block h-32 p-4">
                Work {index + 1}
              </a>
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselIndicator index={0} aria-label="First slide" />
      </Carousel>
      <button type="button">Outside</button>
      <div style={{ height: '200vh' }} />
    </div>
  );
}
const meta = { title: 'Showcase/Rotation', component: Rotation } satisfies Meta<typeof Rotation>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectPlaying(canvasElement: HTMLElement, playing: boolean) {
  const canvas = within(canvasElement);
  const root = canvas.getByRole('region', { name: 'Rotation behavior' });
  try {
    await waitFor(
      () =>
        expect(
          canvas.getByTestId('rotation'),
          `Rotation state: ${root.dataset.rotationState}; tab: ${document.visibilityState}`,
        ).toHaveAttribute('data-playing', String(playing)),
      { timeout: 3000 },
    );
  } catch (cause) {
    throw new Error(
      `Rotation fixture: ${root.dataset.rotationState}; tab=${document.visibilityState}; bounds=${JSON.stringify(root.getBoundingClientRect().toJSON())}`,
      { cause },
    );
  }
}

export const HoverAndManual: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const status = canvas.getByTestId('rotation');
    await userEvent.hover(canvas.getByRole('button', { name: 'Outside' }));
    await expectPlaying(canvasElement, true);
    const region = canvas.getByRole('region', { name: 'Rotation behavior' });
    await userEvent.hover(region);
    await expect(status).toHaveAttribute('data-playing', 'false');
    await userEvent.unhover(region);
    await waitFor(() => expect(status).toHaveAttribute('data-playing', 'true'));
    await userEvent.click(canvas.getByRole('button', { name: 'Manual next' }));
    await expect(status).toHaveAttribute('data-playing', 'false');
    await expect(canvas.getByRole('button', { name: 'Start rotation' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Outside' }));
    await expect(status).toHaveAttribute('data-playing', 'false');
  },
};
export const FocusRequiresRestart: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const status = canvas.getByTestId('rotation');
    await userEvent.hover(canvas.getByRole('button', { name: 'Outside' }));
    await expectPlaying(canvasElement, true);
    canvas.getByRole('link').focus();
    await waitFor(() => expect(status).toHaveAttribute('data-playing', 'false'));
    canvas.getByRole('button', { name: 'Outside' }).focus();
    await expect(status).toHaveAttribute('data-playing', 'false');
    await userEvent.click(canvas.getByRole('button', { name: 'Start rotation' }));
    await userEvent.unhover(canvas.getByRole('region', { name: 'Rotation behavior' }));
    await waitFor(() => expect(status).toHaveAttribute('data-playing', 'true'));
  },
};
export const HiddenAndOffscreen: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const status = canvas.getByTestId('rotation');
    await userEvent.hover(canvas.getByRole('button', { name: 'Outside' }));
    await expectPlaying(canvasElement, true);
    const visibility = spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    try {
      await waitFor(() => expect(status).toHaveAttribute('data-playing', 'false'));
    } finally {
      visibility.mockRestore();
      document.dispatchEvent(new Event('visibilitychange'));
    }
    await waitFor(() => expect(status).toHaveAttribute('data-playing', 'true'));
    window.scrollTo(0, document.body.scrollHeight);
    await waitFor(() => expect(status).toHaveAttribute('data-playing', 'false'));
    window.scrollTo(0, 0);
    await waitFor(() => expect(status).toHaveAttribute('data-playing', 'true'));
  },
};

export const AutomaticAdvance: Story = {
  async play({ canvasElement }) {
    await expectPlaying(canvasElement, true);
    await waitFor(
      () =>
        expect(
          canvasElement.querySelector('[data-slot="carousel-group"]')!.scrollLeft,
        ).toBeGreaterThan(0),
      { timeout: 3000 },
    );
  },
};

export const ExplicitPauseWhileHovered: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expectPlaying(canvasElement, true);
    const root = canvas.getByRole('region', { name: 'Rotation behavior' });
    await userEvent.hover(root);
    await expectPlaying(canvasElement, false);
    await userEvent.click(canvas.getByRole('button', { name: 'Pause rotation' }));
    await userEvent.unhover(root);
    await expectPlaying(canvasElement, false);
    await expect(canvas.getByRole('button', { name: 'Start rotation' })).toBeEnabled();
  },
};
