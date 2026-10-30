import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setMyLogsStory, type MyLogsScenario } from '../kernel/fake/my-logs';
import { m } from '../paraglide/messages.js';
import { MyLogsPageView } from '../library/my-logs-page';
import { myLogsNavigation } from '../library/my-logs';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';

const meta = {
  title: 'Pages/Library/My published logs',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
      },
    },
    docs: {
      description: {
        component:
          'Actual history route and owner reader, using opt-in responses derived from the existing FULL published-log recording. Refusal, null-subject and pagination variations are constructed consumer examples. Ordinary Web review, native and privacy proof remain pending.',
      },
    },
  },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  beforeEach() {
    setMyLogsStory('ready');
    return () => setMyLogsStory();
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const render = () => <PageStory visitor="Signed In" path="/library/logs" />;
function scenario(value: MyLogsScenario) {
  return () => {
    setMyLogsStory(value);
  };
}
async function ready({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await canvas.findByRole('heading', { name: m.library_my_logs_heading() });
  await expect(await canvas.findByText('Kokoro', { exact: true })).toBeVisible();
  await expect(canvas.queryByText(m.library_logs_empty())).toBeNull();
}

export const Desktop: Story = { name: 'Desktop 1280', render, play: ready };
export const Phone: Story = {
  name: 'Phone 390',
  render,
  play: ready,
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const Empty: Story = {
  render,
  beforeEach: scenario('empty'),
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.library_logs_empty());
  },
};
export const Long: Story = {
  render,
  beforeEach: scenario('long'),
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const UnknownSubject: Story = { render, beforeEach: scenario('unknown') };
export const Denied: Story = {
  render,
  beforeEach: scenario('denied'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_my_logs_denied());
    await expect(canvas.queryByText(m.library_logs_empty())).toBeNull();
  },
};
export const Unavailable: Story = {
  render,
  beforeEach: scenario('unavailable'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_my_logs_unavailable());
    await expect(canvas.queryByText(m.library_logs_empty())).toBeNull();
  },
};
export const Preparing: Story = { render, beforeEach: scenario('preparing') };
export const NewestPage: Story = {
  render,
  play: async (context) => {
    await ready(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('link', { name: m.library_logs_more() }));
    await canvas.findByText(`${m.library_logs_session_state()}: ${m.library_progress_state_abandoned()}`);
    await userEvent.click(canvas.getByRole('link', { name: m.library_my_logs_newest() }));
    await ready(context);
  },
};
export const Restarted: Story = {
  beforeEach: scenario('restart'),
  render: () => <PageStory visitor="Signed In" path="/library/logs?cursor=expired-epoch" />,
};
export const SignedOut: Story = {
  render: () => (
    <PatternStory visitor="Signed Out" path="/library/logs">
      <AppShell navigation={myLogsNavigation}>
        <MyLogsPageView page={{ state: 'signed-out' }} />
      </AppShell>
    </PatternStory>
  ),
};
