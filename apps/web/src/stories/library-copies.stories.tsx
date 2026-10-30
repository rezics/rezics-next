import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setCopiesStoryMode, type CopiesStoryMode } from '../kernel/fake/copies-page-stories';
import { setCopyKindsStory } from '../kernel/fake/copies-kinds';
import recording from '../kernel/recorded/library-copies.json';
import { unprofiledSubjectId } from '../kernel/fake/library-unprofiled-subject';
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

export const ManyCopies: Story = {
  name: 'Owner',
  render: () => <CopiesStory mode="many" />,
  async play(args) {
    await ready(args);
    const canvas = within(args.canvasElement);
    const recordedCopy = recording.copies[1];
    const coverMedia = recordedCopy?.subject.cover?.media;
    if (!recordedCopy || typeof coverMedia !== 'string' || !recordedCopy.note) {
      throw new Error('The recorded Kokoro copy has no cover media or identifying note.');
    }
    const kokoro = (await canvas.findByText(recordedCopy.note, { exact: true })).closest('li');
    if (!kokoro) throw new Error('The recorded Kokoro copy did not render in the list.');
    expect(kokoro.textContent).toContain('Kokoro');
    expect(kokoro?.textContent).toContain('Digital');
    expect(kokoro?.textContent).not.toContain('Physical');
    const image = kokoro.querySelector('[data-slot="cover"] img');
    if (!image?.getAttribute('src')?.includes(`/media/${coverMedia}/`)) {
      throw new Error('The recorded Kokoro copy cover did not render from its /media/ fixture.');
    }
    await userEvent.hover(kokoro);
  },
};
export const None: Story = {
  name: 'Owner, empty',
  render: () => <CopiesStory mode="none" />,
  play: ready,
};
export const OneCopy: Story = {
  name: 'Owner, one copy',
  render: () => <CopiesStory mode="one" />,
  play: ready,
};

function ProfileStory({ retired = false }: { retired?: boolean }) {
  setCopiesStoryMode('one');
  setCopyKindsStory(retired);
  return <PageStory visitor="Signed In" path="/library/copies?subjectId=01a17a3b-0884-721b-91ef-d7ffd7bb58e4" />;
}
export const NoLongerOffered: Story = {
  name: 'Owner, copy type unavailable',
  render: () => <ProfileStory retired />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: m.library_copy_heading() });
    await userEvent.click(canvas.getByRole('button', { name: m.library_copy_delete() }));
    await within(document.body).findByText(m.library_copy_no_longer_offered());
  },
};

export const UnsupportedProfile: Story = {
  name: 'No add option for an unprofiled subject',
  render: () => (
    <PageStory visitor="Signed In" path={`/library/copies?subjectId=${encodeURIComponent(unprofiledSubjectId)}`} />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: m.library_copy_heading() });
    await canvas.findByRole('status', { name: m.library_copy_unsupported() });
    expect(canvas.queryByRole('button', { name: m.library_copy_add() })).not.toBeInTheDocument();
  },
};
