import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import {
  Tour,
  TourActions,
  TourBody,
  TourContent,
  TourDescription,
  TourHeader,
  TourProgressText,
  TourTitle,
  TourTrigger,
} from './tour.tsx';

const steps = [
  {
    id: 'shelf',
    type: 'dialog' as const,
    title: 'Start a personal shelf',
    description: 'Save 《三体》 to keep its editions and your reading notes together.',
    actions: [{ label: 'Next step', action: 'next' as const }],
  },
  {
    id: 'realm',
    type: 'dialog' as const,
    title: 'Join a Realm conversation',
    description: 'Open the Science Fiction Realm to see community ratings and moderation context.',
    actions: [
      { label: 'Back', action: 'prev' as const },
      { label: 'Finish', action: 'dismiss' as const },
    ],
  },
];

const meta = {
  title: 'UI/Tour',
  component: Tour,
  tags: ['autodocs'],
  args: { steps },
  parameters: {
    docs: {
      description: {
        component:
          'Use a tour in REZICS to introduce a new catalogue flow, such as saving a Work and joining its Realm; keep each step short and let members close it at any time.',
      },
    },
  },
  decorators: [
    (Story, context) => (
      <main
        className={'aura-canvas flex min-h-screen items-center justify-center bg-background p-6'}
      >
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Tour>;

export default meta;
type Story = StoryObj<typeof meta>;

const ReadingTour = ({ dark = false }: { dark?: boolean }) => (
  <div className={dark ? 'rounded-2xl bg-background p-6 text-foreground' : 'p-6'}>
    <Tour keyboardNavigation steps={steps}>
      <TourTrigger className="rounded-xl bg-primary px-5 py-2.5 font-medium text-primary-foreground shadow-[var(--aura-shadow-card)] focus-visible:outline-2 focus-visible:outline-ring">
        Show reading guide
      </TourTrigger>
      <TourContent>
        <TourHeader className="px-5 pt-5">
          <TourTitle />
          <TourProgressText />
        </TourHeader>
        <TourBody className="px-5 pb-1">
          <TourDescription />
        </TourBody>
        <TourActions className="px-5 pb-5" />
      </TourContent>
    </Tour>
  </div>
);

export const GuidedReading: Story = {
  render: () => <ReadingTour />,
  async play({ canvasElement }) {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Show reading guide' }),
    );
    await waitFor(() => expect(page.getByRole('alertdialog')).toBeVisible());
    await expect(page.getByRole('heading', { name: 'Start a personal shelf' })).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'next step' }));
    await waitFor(() =>
      expect(page.getByRole('heading', { name: 'Join a Realm conversation' })).toBeVisible(),
    );
    await userEvent.keyboard('{Escape}');
    await expect(page.getByRole('alertdialog')).toHaveAttribute('data-state', 'closed');
  },
};

export const DarkMode: Story = { globals: { theme: 'dark' }, render: () => <ReadingTour dark /> };
