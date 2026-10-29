import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setCopiesStoryMode, type CopiesStoryMode } from '../kernel/fake/copies-page-stories';
import { PageStory, pagePaths } from './page';

const meta = { title: 'Pages/Library/Copies', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function CopiesStory({ mode }: { mode: CopiesStoryMode }) {
  setCopiesStoryMode(mode);
  return <PageStory visitor="Signed In" path={pagePaths['library-copies']} />;
}

const ready = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await within(canvasElement).findByRole('heading', { level: 1, name: /Copies|复本/ });
};

export const None: Story = { render: () => <CopiesStory mode="none" />, play: ready };
export const OneCopy: Story = { render: () => <CopiesStory mode="one" />, play: ready };
export const ManyCopies: Story = {
  render: () => <CopiesStory mode="many" />,
  async play(args) {
    await ready(args);
    await userEvent.hover(within(args.canvasElement).getByText('The Little Prince'));
  },
};
export const AddFormOpen: Story = {
  render: () => <CopiesStory mode="one" />,
  async play(args) {
    await ready(args);
    const canvas = within(args.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Add a copy|新增一份复本/ }));
    await within(document.body).findByRole('dialog');
  },
};
export const EditFormOpen: Story = {
  render: () => <CopiesStory mode="one" />,
  async play(args) {
    await ready(args);
    await userEvent.click(within(args.canvasElement).getByRole('button', { name: /Edit copy|Edit|编辑复本/ }));
    await within(document.body).findByRole('dialog');
  },
};
export const Refusal: Story = {
  render: () => <CopiesStory mode="refusal" />,
  async play(args) {
    await ready(args);
    const canvas = within(args.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Add a copy|新增一份复本/ }));
    const dialog = within(document.body);
    await dialog.findByRole('dialog');
    await userEvent.type(
      dialog.getByLabelText<HTMLInputElement>(/Edition|版本/),
      '0192f3a0-6c1e-7b2a-9d4e-000000000021',
    );
    await userEvent.click(dialog.getByRole('button', { name: /Add copy|新增复本/ }));
    await expect(dialog.findByRole('alert')).resolves.toBeVisible();
  },
};
