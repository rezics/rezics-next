import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { DocumentSnapshot } from '@rezics/document';
import { DocumentBody } from './document-body.tsx';

const snapshot = (profile: 'text' | 'blocks', content: DocumentSnapshot['doc']['content']): DocumentSnapshot => ({
  version: 'rezics-document-v1',
  profile,
  doc: { type: 'doc', content },
});
const meta = { title: 'Components/Document Body', component: DocumentBody } satisfies Meta<typeof DocumentBody>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TextProfile: Story = {
  args: {
    document: snapshot('text', [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Reading notes' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' italic', marks: [{ type: 'italic' }] },
          { type: 'text', text: ' underline', marks: [{ type: 'underline' }] },
          { type: 'text', text: ' strike', marks: [{ type: 'strike' }] },
          { type: 'text', text: ' code', marks: [{ type: 'code' }] },
          { type: 'text', text: ' ruby', marks: [{ type: 'language', attrs: { lang: 'en' } }] },
          { type: 'ruby', attrs: { rt: 'book' }, content: [{ type: 'text', text: '本' }] },
        ],
      },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A quotation.' }] }] },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A list item' }] }] },
        ],
      },
      {
        type: 'orderedList',
        attrs: { start: 2 },
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ordered item' }] }] },
        ],
      },
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: true },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Task' }] }],
          },
        ],
      },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const answer = 42;' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Emphasis', marks: [{ type: 'textEmphasis' }] },
          { type: 'text', text: ' colored', marks: [{ type: 'textStyle', attrs: { color: '#123456' } }] },
          { type: 'text', text: ' language', marks: [{ type: 'language', attrs: { dir: 'rtl' } }] },
        ],
      },
      { type: 'horizontalRule' },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Reading notes' })).toBeVisible();
    await expect(canvas.getByRole('checkbox', { name: 'Task status' })).toBeChecked();
    await expect(canvas.getByText('const answer = 42;')).toBeVisible();
  },
};

export const BlocksProfile: Story = {
  args: {
    document: snapshot('blocks', [
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] }] },
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Dune' }] }] },
            ],
          },
        ],
      },
      { type: 'image', attrs: { src: 'cover-1', alt: 'Desert planet cover', width: 320, height: 480 } },
      { type: 'media', attrs: { src: 'media-1', kind: 'file', caption: 'Audio edition' } },
      { type: 'extensionBlock', attrs: { definition: 'rating', fallback: '4 stars' } },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Inline component: ' },
          { type: 'extensionInline', attrs: { definition: 'badge', fallback: 'Verified' } },
          { type: 'hardBreak' },
          { type: 'text', text: 'after break' },
        ],
      },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('table')).toBeVisible();
    await expect(canvas.getByRole('img', { name: 'Desert planet cover' })).toBeVisible();
    await expect(canvas.getByText('4 stars')).toBeVisible();
  },
};

export const SafeLinks: Story = {
  args: {
    document: snapshot('text', [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Website', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
          { type: 'text', text: ' email', marks: [{ type: 'link', attrs: { href: 'mailto:reader@example.com' } }] },
          { type: 'text', text: ' unsafe', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
        ],
      },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Website' })).toHaveAttribute(
      'rel',
      'noopener noreferrer nofollow ugc',
    );
    await expect(canvas.getByRole('link', { name: 'email' })).toHaveAttribute('href', 'mailto:reader@example.com');
    await expect(canvas.getByText('unsafe')).not.toHaveAttribute('href');
  },
};

export const Spoilers: Story = {
  args: {
    document: snapshot('text', [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hidden reveal', marks: [{ type: 'spoiler' }] }] },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', { name: 'Reveal spoiler' });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByText('Hidden reveal')).toBeVisible();
  },
};

const secretOf = (button: HTMLElement, secret: string): HTMLElement => {
  const hidden = button.querySelector('[aria-hidden="true"]');
  if (!(hidden instanceof HTMLElement) || hidden.textContent !== secret) {
    throw new Error(`concealed text for ${secret} is missing`);
  }
  return hidden;
};

const unreadable = (element: HTMLElement): boolean => {
  const style = getComputedStyle(element);
  return style.color === 'rgba(0, 0, 0, 0)' || style.color === 'transparent' || style.opacity === '0';
};

const painted = (canvas: HTMLElement, property: 'backgroundColor' | 'outlineColor', value: string): string => {
  const probe = canvas.ownerDocument.createElement('span');
  if (property === 'backgroundColor') probe.style.backgroundColor = value;
  else probe.style.outline = `2px solid ${value}`;
  canvas.append(probe);
  const read = getComputedStyle(probe)[property];
  probe.remove();
  return read;
};

const selectedText = (root: Node): string => {
  const selection = root.ownerDocument?.getSelection();
  if (!selection) return '';
  const range = root.ownerDocument!.createRange();
  range.selectNodeContents(root);
  selection.removeAllRanges();
  selection.addRange(range);
  const text = selection.toString();
  selection.removeAllRanges();
  return text;
};

const expectConcealed = async (button: HTMLElement, secret: string, canvas: HTMLElement) => {
  const hidden = secretOf(button, secret);
  const paragraph = button.closest('p');
  const lead = paragraph?.firstChild;
  if (!paragraph || !lead || lead.nodeType !== Node.TEXT_NODE) throw new Error('spoiler is not inside the sentence');

  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toHaveAccessibleName('Reveal spoiler');
  expect(unreadable(hidden)).toBe(true);
  expect(getComputedStyle(hidden).userSelect).toBe('none');
  expect(getComputedStyle(button).display).toContain('inline');
  expect(parseFloat(getComputedStyle(button).borderTopLeftRadius)).toBeGreaterThan(0);
  expect(getComputedStyle(button).backgroundColor).toBe(painted(canvas, 'backgroundColor', 'var(--muted-foreground)'));
  expect(getComputedStyle(button).backgroundColor).not.toBe(painted(canvas, 'backgroundColor', 'var(--brand)'));

  const leadRange = paragraph.ownerDocument.createRange();
  leadRange.setStart(lead, 0);
  leadRange.setEnd(lead, lead.textContent?.length ?? 0);
  const leadBox = leadRange.getBoundingClientRect();
  const barBox = button.getBoundingClientRect();
  expect(barBox.height).toBeGreaterThan(0);
  expect(barBox.top).toBeLessThan(leadBox.bottom);
  expect(barBox.bottom).toBeGreaterThan(leadBox.top);
  expect(barBox.left).toBeGreaterThanOrEqual(leadBox.left - 1);

  const textWidth = hidden.getBoundingClientRect().width;
  expect(textWidth).toBeGreaterThan(0);
  expect(barBox.width).toBeGreaterThanOrEqual(textWidth - 1);
  expect(barBox.width - textWidth).toBeLessThan(24);
  expect(selectedText(paragraph)).not.toContain(secret);
  expect(selectedText(hidden)).not.toContain(secret);

  button.focus();
  expect(getComputedStyle(button).outlineStyle).toBe('solid');
  expect(getComputedStyle(button).outlineColor).toBe(painted(canvas, 'outlineColor', 'var(--ring)'));
};

const expectRevealed = async (canvas: ReturnType<typeof within>, secret: string, root: HTMLElement) => {
  const revealed = canvas.getByText(secret);
  const paragraph = revealed.closest('p');
  if (!paragraph) throw new Error('revealed spoiler left the paragraph');
  await expect(revealed).toHaveFocus();
  expect(unreadable(revealed)).toBe(false);
  expect(getComputedStyle(revealed).color).toBe(getComputedStyle(paragraph).color);
  expect(getComputedStyle(revealed).backgroundColor).toBe(
    painted(root, 'backgroundColor', 'color-mix(in oklab, var(--primary) 16%, transparent)'),
  );
  expect(paragraph.contains(root.ownerDocument.activeElement)).toBe(true);
  expect(root.ownerDocument.activeElement).not.toBe(root.ownerDocument.body);
};

export const InlineSpoiler: Story = {
  args: {
    document: snapshot('text', [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'The captain learned that ' },
          { type: 'text', text: 'the ship was already gone', marks: [{ type: 'spoiler' }] },
          { type: 'text', text: ' before dawn.' },
        ],
      },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const secret = 'the ship was already gone';
    const button = canvas.getByRole('button', { name: 'Reveal spoiler' });
    await expectConcealed(button, secret, canvasElement);
    await userEvent.click(button);
    await expectRevealed(canvas, secret, canvasElement);
    expect(canvas.queryByRole('button', { name: 'Reveal spoiler' })).toBeNull();
  },
};

export const TwoSpoilers: Story = {
  args: {
    document: snapshot('text', [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'She knew ' },
          { type: 'text', text: 'the ending', marks: [{ type: 'spoiler' }] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'the traitor', marks: [{ type: 'spoiler' }] },
          { type: 'text', text: ' before anyone else.' },
        ],
      },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const buttons = canvas.getAllByRole('button', { name: 'Reveal spoiler' });
    const ending = buttons[0];
    const traitor = buttons[1];
    if (!ending || !traitor) throw new Error('expected two spoilers');
    await expectConcealed(ending, 'the ending', canvasElement);
    await expectConcealed(traitor, 'the traitor', canvasElement);

    ending.focus();
    await userEvent.keyboard('{Enter}');
    await expectRevealed(canvas, 'the ending', canvasElement);
    await expect(traitor).toHaveAttribute('aria-expanded', 'false');
    expect(unreadable(secretOf(traitor, 'the traitor'))).toBe(true);

    traitor.focus();
    await userEvent.keyboard('{Space}');
    await expectRevealed(canvas, 'the traitor', canvasElement);
    await expect(canvas.getByText('the ending')).toBeVisible();
    expect(canvas.queryAllByRole('button', { name: 'Reveal spoiler' })).toHaveLength(0);
  },
};

export const LocalizedLabel: Story = {
  args: {
    document: snapshot('text', [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '結末は' },
          { type: 'text', text: '船はもうなかった', marks: [{ type: 'spoiler' }] },
          { type: 'text', text: 'だった。' },
        ],
      },
    ]),
    labels: { revealSpoiler: 'ネタバレを表示' },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByRole('button', { name: 'Reveal spoiler' })).toBeNull();
    const button = canvas.getByRole('button', { name: 'ネタバレを表示' });
    await expect(button).toHaveAccessibleName('ネタバレを表示');
    expect(button.textContent).not.toContain('ネタバレを表示');
    await userEvent.click(button);
    await expect(canvas.getByText('船はもうなかった')).toBeVisible();
  },
};

export const MediaImages: Story = {
  args: {
    document: snapshot('blocks', [
      { type: 'image', attrs: { src: 'asset-7', variant: 'medium', alt: 'Mountain at dawn', width: 640, height: 400 } },
    ]),
  },
  play: async ({ canvasElement }) => {
    const image = within(canvasElement).getByRole('img', { name: 'Mountain at dawn' });
    await expect(image).toHaveAttribute('src', '/media/asset-7/medium');
    await expect(image).toHaveAttribute('loading', 'lazy');
    await expect(image).toHaveAttribute('width', '640');
  },
};
