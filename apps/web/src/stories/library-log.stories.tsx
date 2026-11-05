import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setMyLogsStory, type MyLogsScenario } from '../kernel/fake/my-logs';
import { m } from '../paraglide/messages.js';
import { PageStory, libraryLogReady, pagePaths } from './page';

const meta = {
  title: 'Pages/Library/Published Log',
  parameters: { layout: 'fullscreen' },
  beforeEach() {
    setMyLogsStory();
    return () => setMyLogsStory();
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: libraryLogReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-log']} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: libraryLogReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['library-log']} />,
};

// Constructed response variations through the public route, pending native recordings and rendered review.
function publicScenario(value: MyLogsScenario) {
  return () => setMyLogsStory(value);
}
const publicRoute = () => <PageStory visitor="Signed Out" path={pagePaths['library-log']} />;
export const Refused: Story = {
  beforeEach: publicScenario('public-refused'),
  render: publicRoute,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: m.error_heading() });
    expect(canvas.queryByText('Kokoro', { exact: true })).toBeNull();
  },
};
export const Withdrawn: Story = {
  beforeEach: publicScenario('public-withdrawn'),
  render: publicRoute,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('heading', { level: 1, name: m.not_found_heading() });
  },
};
export const UnavailableRecovery: Story = {
  beforeEach: publicScenario('public-recovery'),
  render: publicRoute,
  play: async (context) => {
    const canvas = within(context.canvasElement);
    await canvas.findByRole('heading', { level: 1, name: m.error_heading() });
    await userEvent.click(canvas.getByRole('button', { name: m.status_retry() }));
    await libraryLogReady(context);
    expect(canvas.queryByRole('button', { name: m.library_logs_delete() })).toBeNull();
  },
};
