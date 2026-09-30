import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { agents, ids, storyMain, workHeader } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { ChapterPublishDialog } from './publish-dialog.tsx';
import { TextEditor, type TextEditorProps } from './text-editor.tsx';
import type { MainClient } from './types.ts';

const basisProblem = () => Promise.resolve({ data: null,
  error: { status: 409, value: { code: 'translation_basis_required' } } });
const localized = { ...messages, ...zhHans };
const header = workHeader(ids.story, '雨夜书店 · 译文', 'zh-Hans', 'document');

function editor(): TextEditorProps {
  const story = storyMain();
  const body = '第三章 最后一班车\n末班车到站时，整座站台只有她一个人。';
  const head = story.seed(ids.texts.story, body, 'zh-Hans', header.id);
  // Exercise the real adapter with Main's problem code, not a pre-mapped UI outcome.
  const main = { ...story.main, v1: { ...story.main.v1,
    'contribution-publications': { post: basisProblem } } } as unknown as MainClient;
  return { agent: agents[0]!, work: { id: header.id, title: header.title, mainVersion: header.mainVersion, book: false },
    language: 'zh-Hans', text: ids.texts.story,
    initial: { head, body, publication: 'draft', publicationHead: null },
    locale: 'zh-Hans', messages: localized, main };
}

const meta = { title: 'Studio/Translation publication', component: TextEditor,
  globals: { locale: 'zh-Hans' }, beforeEach() { localStorage.clear(); },
  render: (props: TextEditorProps) => <TextEditor {...props} />,
} satisfies Meta<TextEditorProps>;
export default meta;
type Story = StoryObj<typeof meta>;

async function publish(dialog: ReturnType<typeof within>) {
  await userEvent.click(dialog.getByRole('checkbox', { name: localized.publishRights }));
  await userEvent.click(dialog.getByRole('button', { name: /^发布$/ }));
  await expect(await dialog.findByRole('alert')).toHaveTextContent(localized.publishTranslationBasisRequired);
  await expect(dialog.queryByText(localized.publishStale)).toBeNull();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

export const TextTranslation: Story = {
  args: editor(),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /^发布$/ }));
    await publish(within(await within(document.body).findByRole('dialog')));
  },
};
export const TextTranslationPhone: Story = { ...TextTranslation, args: editor(),
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

export const ChapterTranslation: Story = {
  args: editor(),
  render: () => <ChapterPublishDialog open onOpenChange={() => {}} agent={agents[0]!}
    book={{ value: '雨夜书店', language: 'zh-Hans' }} title={{ value: '第三章 最后一班车', language: 'zh-Hans' }}
    target={{ actingSubject: agents[0]!.iri, chapter: ids.story, variant: 'urn:rezics:variant:chapter',
      language: 'zh-Hans', direction: 'ltr' }}
    basis={{ head: 'draft', digest: 'a'.repeat(64), epoch: 'epoch', body: '末班车到站时，整座站台只有她一个人。' }}
    current={null} onPublished={() => {}} locale="zh-Hans" messages={localized}
    main={{ v1: { 'content-publications': { post: async () => ({ data: { status: 'succeeded', decision: 'publication' }, error: null }) },
      'content-search-eligibility': { post: basisProblem } } } as unknown as MainClient} />,
  async play() {
    const dialog = within(await within(document.body).findByRole('dialog'));
    await publish(dialog);
    await expect(dialog.getByText('完成')).toBeInTheDocument();
    await expect(dialog.queryByText(localized.eligibilityStale)).toBeNull();
  },
};
export const ChapterTranslationPhone: Story = { ...ChapterTranslation,
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };
