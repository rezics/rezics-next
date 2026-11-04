import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AppShell } from '../shell/app-shell';
import { m } from '../paraglide/messages.js';
import { PatternStory, pagePaths, pageReady } from './page';

const meta = {
  title: 'Patterns/App Shell/CSP Rendering',
  globals: { viewport: { value: 'phone' } },
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
        desktop: { name: 'Desktop', styles: { width: '1440px', height: '960px' } },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function CspShellPreview() {
  return (
    <PatternStory visitor="Signed Out" path={pagePaths.home}>
      <AppShell communities={null} search={<input aria-label={m.shell_search()} />}>
        <h1 className="text-2xl font-semibold">{m.nav_home()}</h1>
        <p className="mt-3 text-muted-foreground">Choose a destination from the shared shell.</p>
      </AppShell>
    </PatternStory>
  );
}

export const PhoneShell: Story = {
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    await view.findByRole('navigation', { name: m.shell_phone_tabs() });
    await view.findByRole('link', { name: m.shell_you() });
    await expect(view.getByRole('heading', { name: m.nav_home() })).toBeVisible();
  },
  render: () => <CspShellPreview />,
};
