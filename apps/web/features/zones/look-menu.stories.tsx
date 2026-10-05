import { spaceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { chooseMenuItem } from '../stories/choose-option.ts';
import { LookMenu } from './look-menu.tsx';
import { messages } from './messages.ts';

const labels = {
  menu: messages.lookLabel,
  zone: messages.lookZone,
  standard: messages.lookStandard,
  help: messages.lookHelp,
  saveFailed: messages.lookSaveFailed,
};
const meta = {
  title: 'Zones/Page style',
  component: LookMenu,
  args: { enabled: true, labels, save: async () => 'failed' as const },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'site'), 'en') } },
} satisfies Meta<typeof LookMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SaveFailed: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Page style' }));
    await chooseMenuItem(within(document.body), 'menuitemradio', 'Standard look');
    await expect(await within(document.body).findByRole('alert')).toHaveTextContent(
      'Couldn’t save your page style. Try again.',
    );
  },
};
