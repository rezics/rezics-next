import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { RouteError, RouteLoading, RouteNotFound } from './route-states.tsx';

const retry = fn();

const meta = { title: 'Shell/Route states', component: RouteNotFound } satisfies Meta<typeof RouteNotFound>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NotFound: Story = {
  parameters: { route: { pathname: '/nowhere' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/en');
  },
};

export const Failed: Story = {
  render: () => <RouteError digest="3348219744" onRetry={retry} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Something went wrong');
    await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    await expect(retry).toHaveBeenCalledOnce();
  },
};

export const FailedChineseDark: Story = {
  globals: { locale: 'zh-Hans', theme: 'dark' },
  render: () => <RouteError onRetry={() => undefined} />,
};

export const Loading: Story = {
  render: () => <RouteLoading />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status', { name: 'Loading…' })).toHaveAttribute('aria-busy', 'true');
  },
};
