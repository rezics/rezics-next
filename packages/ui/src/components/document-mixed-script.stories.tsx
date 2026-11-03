import type { DocumentSnapshot } from '@rezics/document';
import { parseDocument, serializeDocument, withDocumentIds } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { withSurface } from '../stories/support.tsx';
import { DocumentBody } from './document-body.tsx';
import { useLocale } from './locale.tsx';

const readerAccount = '11111111-1111-4111-8111-111111111111';
const longHref =
  'https://example.com/library/works/9789571368474/editions/hardcover-annotated-reader-notes-volume-three';

let unit = 0;
const snapshot = (content: DocumentSnapshot['doc']['content']): DocumentSnapshot =>
  parseDocument(
    JSON.parse(
      serializeDocument({
        version: 'rezics-document-v1',
        profile: 'text',
        doc: withDocumentIds({ type: 'doc', content }, () => `mixed-script-${++unit}`),
      }),
    ),
  );

type Inline = string | { readonly mention: true } | { readonly link: string; readonly href: string };

const text = (value: string) => ({ type: 'text' as const, text: value });
const inline = (part: Inline) => {
  if (typeof part === 'string') return text(part);
  if ('mention' in part) return { type: 'mention' as const, attrs: { accountId: readerAccount } };
  return { type: 'text' as const, text: part.link, marks: [{ type: 'link' as const, attrs: { href: part.href } }] };
};

const reading = (heading: string, lead: string, middle: Inline[], notes: string[]) =>
  snapshot([
    { type: 'heading', attrs: { level: 2 }, content: [text(heading)] },
    { type: 'paragraph', content: [text(lead)] },
    { type: 'paragraph', content: middle.map(inline) },
    {
      type: 'bulletList',
      content: notes.map((note) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [text(note)] }],
      })),
    },
  ]);

function Reading({ lang, document }: { lang: string; document: DocumentSnapshot }) {
  const { locale } = useLocale();
  return (
    <div lang={lang}>
      <DocumentBody document={document} locale={locale} mentions={{ [readerAccount]: { handle: 'reader' } }} />
    </div>
  );
}

const meta = {
  title: 'Components/Document Mixed Script',
  component: DocumentBody,
  args: { document: snapshot([{ type: 'paragraph' }]) },
  decorators: [withSurface],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Long mixed-script reading for the Prose bar. Content language is on the wrapper around DocumentBody; Storybook locale and theme globals stay the interface. Capture at Phone 390 and Desktop 1280 without narrowing the inner canvas.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '860px' } },
      },
    },
  },
} satisfies Meta<typeof DocumentBody>;
export default meta;
type Story = StoryObj<typeof meta>;

const expectReading =
  (lang: string, heading: string, excerpt: string, linkName: string): Story['play'] =>
  async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = canvasElement.querySelector<HTMLElement>('[data-slot="document-body"]');
    if (!body) throw new Error('document body is missing');
    const languageRoot = body.closest('[lang]');
    await expect(languageRoot).toHaveAttribute('lang', lang);
    expect(languageRoot).not.toBe(canvasElement.ownerDocument.documentElement);
    await expect(canvas.getByRole('heading', { name: heading })).toBeVisible();
    await expect(canvas.getByText(excerpt, { exact: false })).toBeVisible();
    const link = canvas.getByRole('link', { name: linkName });
    await expect(link).toHaveAttribute('href', longHref);
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
    link.focus();
    await expect(link).toHaveFocus();
    const mention = canvas.getByRole('link', { name: '@reader' });
    await expect(mention).toBeVisible();
    await expect(mention).toHaveAttribute('href', '/en/@reader');
    await expect(canvas.getByRole('list')).toBeVisible();
  };

const traditionalChinese = reading(
  '重讀《The Three-Body Problem》卷三',
  '紅岸基地的發射紀錄寫於 1967 年冬天，葉文潔把地球的坐標送進黑暗，而 Luo Ji 後來才把 The Dark Forest 寫成可以運算的公理。ISBN 9789571368474 的繁體版把這段排成直欄，數字、拉丁書名與漢字必須在同一行裡折開，而不是把欄寬撐破。',
  [
    '讀者 ',
    { mention: true },
    ' 把長連結留在欄內：',
    { link: longHref, href: longHref },
    '。volume 3 的註腳仍是 1280 字的英文對照。',
  ],
  ['紅岸發射：1967 / volume 3', '黑暗森林：Luo Ji', '文獻號 ISBN 9789571368474'],
);
const simplifiedChinese = reading(
  '重读《The Three-Body Problem》第三卷',
  '红岸基地的发射记录写于 1967 年冬天，叶文洁把地球的坐标送进黑暗，而 Luo Ji 后来才把 The Dark Forest 写成可以运算的公理。ISBN 9787229030933 的简体版把这段排成直栏，数字、拉丁书名与汉字必须在同一行里折开，而不是把栏宽撑破。',
  [
    '读者 ',
    { mention: true },
    ' 把长链接留在栏内：',
    { link: longHref, href: longHref },
    '。volume 3 的脚注仍是 1280 字的英文对照。',
  ],
  ['红岸发射：1967 / volume 3', '黑暗森林：Luo Ji', '文献号 ISBN 9787229030933'],
);
const japanese = reading(
  '『The Three-Body Problem』第 3 巻の読書メモ',
  '1970 年代の紅岸基地で Ye Wenjie が送信ボタンを押した夜のことは、volume 3 の中盤まで伏せられている。The Dark Forest は比喩ではなく、ISBN 9784150123456 が紙の上に固定した宇宙社会学の公理だ。漢字、かな、ラテン書名と数字が同じ行で折り返されなければならない。',
  [
    '読者 ',
    { mention: true },
    ' が残した長い URL は欄を壊さない：',
    { link: longHref, href: longHref },
    '。1280 語の英語対照もそのまま残す。',
  ],
  ['紅岸送信：1967 / volume 3', '暗黒森林：Luo Ji', '文献 ISBN 9784150123456'],
);
const korean = reading(
  '『The Three-Body Problem』3권 독서 메모',
  '1967년 홍안 기지에서 Ye Wenjie가 송신 버튼을 누른 밤은 volume 3 중반에야 드러난다. The Dark Forest는 비유가 아니라 ISBN 9788937461234가 종이 위에 고정한 우주사회학의 공리다. 한글, 한자, 라틴 서명과 숫자가 같은 줄에서 접혀야 하며 난폭하게 난을 밀어내면 안 된다.',
  [
    '독자 ',
    { mention: true },
    ' 가 남긴 긴 URL은 난 안에 남는다: ',
    { link: longHref, href: longHref },
    '. 1280단어 영어 대조도 그대로 둔다.',
  ],
  ['홍안 송신: 1967 / volume 3', '암흑의 숲: Luo Ji', '문헌 ISBN 9788937461234'],
);
const latinDominant = reading(
  'Notes on The Three-Body Problem, volume 3',
  'The Red Coast base transmission is dated 1967, and volume 3 waits a long time before Ye Wenjie is allowed to say it. The Dark Forest is not a metaphor in 《三體》; it is an axiom typeset beside ISBN 9780765377081 and the Japanese 三体 spelling so a Latin-dominant column still has to wrap mixed-script literals instead of overflowing.',
  [
    'Reader ',
    { mention: true },
    ' kept the long catalogue URL inside the column: ',
    { link: longHref, href: longHref },
    '. The 1280-word English recap stays literal.',
  ],
  ['Red Coast: 1967 / volume 3', 'Dark Forest: Luo Ji', 'ISBN 9780765377081'],
);

export const TraditionalChinese: Story = {
  render: () => <Reading lang="zh-Hant" document={traditionalChinese} />,
  play: expectReading('zh-Hant', '重讀《The Three-Body Problem》卷三', 'ISBN 9789571368474 的繁體版', longHref),
};

export const SimplifiedChinese: Story = {
  render: () => <Reading lang="zh-Hans" document={simplifiedChinese} />,
  play: expectReading('zh-Hans', '重读《The Three-Body Problem》第三卷', 'ISBN 9787229030933 的简体版', longHref),
};

export const Japanese: Story = {
  render: () => <Reading lang="ja" document={japanese} />,
  play: expectReading(
    'ja',
    '『The Three-Body Problem』第 3 巻の読書メモ',
    'ISBN 9784150123456 が紙の上に固定',
    longHref,
  ),
};

export const Korean: Story = {
  render: () => <Reading lang="ko" document={korean} />,
  play: expectReading('ko', '『The Three-Body Problem』3권 독서 메모', 'ISBN 9788937461234가 종이 위에 고정', longHref),
};

export const LatinDominant: Story = {
  render: () => <Reading lang="en" document={latinDominant} />,
  play: expectReading(
    'en',
    'Notes on The Three-Body Problem, volume 3',
    'ISBN 9780765377081 and the Japanese 三体',
    longHref,
  ),
};
