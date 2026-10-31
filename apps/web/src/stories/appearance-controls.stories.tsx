import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { AppearanceControls } from '../shell/appearance-controls';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Patterns/Appearance',
  component: AppearanceControls,
  beforeEach: () => {
    const cookie = /(?:^|;\s*)rezics_contrast=([^;]*)/.exec(document.cookie)?.[1];
    const contrast = document.documentElement.dataset.contrast;
    document.cookie = 'rezics_contrast=system; Path=/; SameSite=Lax';
    return () => {
      document.cookie = `rezics_contrast=${cookie ?? ''}; ${cookie === undefined ? 'Max-Age=0;' : ''} Path=/; SameSite=Lax`;
      if (contrast === undefined) delete document.documentElement.dataset.contrast;
      else document.documentElement.dataset.contrast = contrast;
      window.dispatchEvent(new Event('rezics:contrast'));
    };
  },
} satisfies Meta<typeof AppearanceControls>;
export default meta;
type Story = StoryObj<typeof meta>;

// Locale, color theme and viewport use the catalogue globals on this same state.
export const ReaderPreferences: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const phone = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
    const trigger = view.getByRole('button', { name: m.shell_theme() });
    await expect(trigger).toBeEnabled();
    await expect(view.getByRole('button', { name: (name) => name.startsWith(m.shell_language()) })).toBeEnabled();
    await userEvent.click(trigger);
    await userEvent.click(await body.findByRole(phone ? 'button' : 'menuitem', { name: m.shell_contrast() }));
    await userEvent.click(await body.findByRole(phone ? 'radio' : 'menuitemradio', { name: m.shell_contrast_more() }));
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-contrast', 'more'));
    await expect(document.cookie).toContain('rezics_contrast=more');
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};
