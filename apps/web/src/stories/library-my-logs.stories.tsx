import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { myLogsStoryActivity, setMyLogsStory, type MyLogsScenario } from '../kernel/fake/my-logs';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory } from './page';
import { logPreviewJourney } from '../../tests/log-preview-journey.test';

const meta = {
  title: 'Pages/Library/My published logs',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual history route and owner reader, using opt-in responses derived from the existing FULL published-log recording. Refusal, null-subject and pagination variations are constructed consumer examples. Ordinary Web review, native and privacy proof remain pending.',
      },
    },
  },
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

export const Owner: Story = { render, play: ready };
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
  play: async (context) => {
    await context.step('Published logs remain scannable with expandable full notes', () => logPreviewJourney(context));
  },
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
  name: 'Restarted owner history is empty',
  beforeEach: scenario('restart-empty'),
  render: () => <PageStory visitor="Signed In" path="/library/logs?cursor=expired-epoch" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_logs_empty());
    await expect(canvas.getByRole('status')).toHaveTextContent(m.library_my_logs_restarted());
  },
};
export const SignedOut: Story = {
  name: 'Signed out owner route requires sign in',
  render: () => <PageStory visitor="Signed Out" path="/library/logs" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const destination = `/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/library/logs`)}`;
    await waitFor(() => expect(myLogsStoryActivity().listReads).toBe(0));
    expect(canvas.queryByText('Kokoro', { exact: true })).toBeNull();
    expect(canvas.queryByRole('list', { name: m.library_logs_heading() })).toBeNull();
    expect(canvas.queryByText(m.library_logs_empty())).toBeNull();
    const signIn =
      canvas.queryByRole('link', { name: m.library_my_logs_sign_in() }) ??
      canvas.queryByRole('link', { name: m.account_sign_in() });
    if (signIn) expect(signIn).toHaveAttribute('href', destination);
    else {
      const url = new URL(window.location.href);
      expect(`${url.pathname}${url.search}`).toBe(destination);
    }
  },
};
