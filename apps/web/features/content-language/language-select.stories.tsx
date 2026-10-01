import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { MarkdownEditor } from '../post-composer/markdown-editor.tsx';
import { LanguageSelect } from './language-select.tsx';
import { textAttributes, writingLanguage } from './writing-language.ts';

// A writer states the language of their text. The interface language only
// names languages on screen: under a Japanese interface a Korean post is
// Korean, an Arabic bio is Arabic and right to left.

/** A writing surface as the post and review forms use it, with the language it would send. */
function Writing({ locale, reading, existing }: { locale: UiLocale; reading: string[]; existing?: string }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [text, setText] = useState('');
  const language = writingLanguage({ chosen, existing, reading });
  const written = textAttributes(language, text);
  return <div className="grid max-w-xl gap-3 p-5">
    <LanguageSelect value={language} onChange={setChosen} locale={locale} reading={reading}
      original={existing ? 'en' : null} label="Language of your post" />
    <MarkdownEditor label="Your post" value={text} onChange={setText} rows={4} maxLength={8000} editLabel="Write"
      previewLabel="Preview" showSpoiler="Show spoiler" lang={written.lang} dir={written.dir} />
    <output data-testid="sent">{language}</output>
  </div>;
}

const meta = { title: 'Content language/Language select', component: Writing,
  args: { locale: 'en', reading: [] } } satisfies Meta<typeof Writing>;
export default meta;
type Story = StoryObj<typeof meta>;

const body = () => within(document.body);
const open = async (canvas: ReturnType<typeof within>, name: RegExp) => {
  await userEvent.click(canvas.getByRole('button', { name }));
  return body().findByRole('searchbox');
};

/** The search field is controlled. A short query keeps a different list than the one the story asked for. */
async function typeQuery(canvas: ReturnType<typeof within>, opener: RegExp, query: string) {
  const search = await open(canvas, opener);
  await waitFor(() => expect(search).toBeVisible());
  await waitFor(async () => {
    const box = body().getByRole('searchbox') as HTMLInputElement;
    if (box.value !== query) {
      await userEvent.click(box);
      await userEvent.clear(box);
      await userEvent.type(box, query);
    }
    expect(body().getByRole('searchbox')).toHaveValue(query);
  }, { timeout: 5000 });
}

/** Nothing is known about the writer: the text says so instead of claiming the interface language. */
export const NotSpecified: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('sent')).toHaveTextContent('und');
    await expect(canvas.getByRole('button', { name: 'Language of your post: Language not specified' })).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Your post' })).not.toHaveAttribute('lang');
  },
};

/** The first reading language is the default; the others are offered first. */
export const StartsInReadingLanguage: Story = {
  args: { reading: ['ja', 'en'], locale: 'ko' },
  globals: { locale: 'ko' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('sent')).toHaveTextContent('ja');
    await expect(canvas.getByRole('textbox', { name: 'Your post' })).toHaveAttribute('lang', 'ja');
    await open(canvas, /^Language of your post: 日本語/);
    const suggested = within(await body().findByRole('list', { name: '추천' }));
    await expect(suggested.getAllByRole('button').map(button => button.textContent)).toEqual([
      expect.stringContaining('日本語'), expect.stringContaining('English'), expect.stringContaining('언어 지정 안 함')]);
  },
};

/** Under a Japanese interface a post is written in Korean: what is sent and shown is Korean. */
export const KoreanUnderJapaneseInterface: Story = {
  args: { reading: ['ja'], locale: 'ja' },
  globals: { locale: 'ja' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(await open(canvas, /^Language of your post: 日本語/), '韓国語');
    await userEvent.click(await body().findByRole('button', { name: /한국어/ }));
    await expect(canvas.getByTestId('sent')).toHaveTextContent('ko');
    await expect(canvas.getByRole('textbox', { name: 'Your post' })).toHaveAttribute('lang', 'ko');
    await expect(canvas.getByRole('textbox', { name: 'Your post' })).toHaveAttribute('dir', 'ltr');
  },
};

/** Arabic is right to left because of its script, whatever the interface direction. */
export const ArabicIsRightToLeft: Story = {
  args: { reading: ['ja'], locale: 'ja' },
  globals: { locale: 'ja' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(await open(canvas, /^Language of your post: 日本語/), 'アラビア');
    await userEvent.click(await body().findByRole('button', { name: /العربية/ }));
    await expect(canvas.getByTestId('sent')).toHaveTextContent('ar');
    await expect(canvas.getByRole('textbox', { name: 'Your post' })).toHaveAttribute('lang', 'ar');
    await expect(canvas.getByRole('textbox', { name: 'Your post' })).toHaveAttribute('dir', 'rtl');
  },
};

/** Any valid BCP 47 tag can be typed, including one no list names. */
export const TypedTag: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await typeQuery(canvas, /^Language of your post:/, 'pt-br');
    const match = await body().findByRole('button', { name: /Brazilian Portuguese/ }, { timeout: 5000 });
    // The row is in the tree while the popover is still fading in.
    await waitFor(() => expect(match).toBeVisible());
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByTestId('sent')).toHaveTextContent('pt-BR'));
  },
};

/** An invalid tag finds nothing rather than being sent. */
export const NoMatch: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await typeQuery(canvas, /^Language of your post:/, 'not a tag!');
    // `<output>` is also a status, so match the message. It is in the tree before the popover finishes fading in.
    const status = await body().findByText(/No language matches/, {}, { timeout: 5000 });
    await waitFor(() => expect(status).toBeVisible());
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByTestId('sent')).toHaveTextContent('und');
  },
};

/** Editing keeps the item's own language, and offers the original beside it. */
export const EditingKeepsItsLanguage: Story = {
  args: { reading: ['ko'], existing: 'fr', locale: 'en' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('sent')).toHaveTextContent('fr');
    await open(canvas, /^Language of your post: français/);
    const suggested = within(await body().findByRole('list', { name: 'Suggested' }));
    await expect(suggested.getAllByRole('button')).toHaveLength(4);
  },
};

/** Tags Main keeps but `Intl` cannot name (private use, grandfathered) show as the tag rather than crashing. */
export const PrivateUseTag: Story = {
  args: { reading: ['x-klingon'], existing: 'i-klingon' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Language of your post: i-klingon' })).toBeVisible();
    await open(canvas, /^Language of your post: i-klingon/);
    const suggestion = await body().findByRole('button', { name: /x-klingon/ });
    // The popover fades in; the tag is listed as itself.
    await waitFor(() => expect(suggestion).toBeVisible());
  },
};
