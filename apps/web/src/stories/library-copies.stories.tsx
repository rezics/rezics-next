import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setCopiesStoryMode, type CopiesStoryMode } from '../kernel/fake/copies-page-stories';
import { setCopyKindsStory } from '../kernel/fake/copies-kinds';
import { m } from '../paraglide/messages.js';
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
    const canvas = within(args.canvasElement);
    const kokoro = canvas.getByText('Kokoro').closest('li');
    expect(kokoro?.textContent).toContain('Digital');
    expect(kokoro?.textContent).not.toContain('Physical');
    await userEvent.hover(canvas.getByText('The Little Prince'));
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
    const canvas = within(args.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /More actions|更多操作/ }));
    await userEvent.click(within(document.body).getByRole('menuitem', { name: /Edit copy|编辑复本/ }));
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

function ProfileStory({ retired = false }: { retired?: boolean }) {
  setCopiesStoryMode('one');
  setCopyKindsStory(retired);
  return <PageStory visitor="Signed In" path="/library/copies?subjectId=01a17a3b-0884-721b-91ef-d7ffd7bb58e4" />;
}
export const TwoKinds: Story = {
  render: () => <ProfileStory />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: m.library_copy_heading() });
    await userEvent.click(canvas.getByRole('button', { name: m.library_copy_add() }));
    await within(document.body).findByRole('combobox', { name: m.library_copy_kind() });
  },
};
export const NoLongerOffered: Story = {
  render: () => <ProfileStory retired />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: m.library_copy_heading() });
    await userEvent.click(canvas.getByRole('button', { name: m.library_copy_delete() }));
    await within(document.body).findByText(m.library_copy_no_longer_offered());
  },
};
