import type { Meta, StoryObj } from '@storybook/react-vite';
import { act, useRef, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { parseDocument, serializeDocument, withDocumentIds, type DocumentSnapshot } from '@rezics/document';
import { waitForFocus } from '../test/focus.ts';
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

const expectConcealed = async (button: HTMLElement, secret: string, canvas: HTMLElement, label = 'Reveal spoiler') => {
  const hidden = secretOf(button, secret);
  const paragraph = button.closest('p');
  const lead = paragraph?.firstChild;
  if (!paragraph || !lead || lead.nodeType !== Node.TEXT_NODE) throw new Error('spoiler is not inside the sentence');

  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toHaveAccessibleName(label);
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
  const revealed = canvas.getByText(secret, { selector: '.document-spoiler-revealed' });
  const paragraph = revealed.closest('p');
  if (!paragraph) throw new Error('revealed spoiler left the paragraph');
  await waitForFocus(revealed);
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
      { type: 'image', attrs: { src: 'asset-8', alt: '' } },
      { type: 'media', attrs: { src: 'recording-1', kind: 'audio', caption: 'Recorded at dawn' } },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const image = canvas.getByRole('img', { name: 'Mountain at dawn' });
    await expect(image).toBeVisible();
    await expect(image).toHaveTextContent('Image unavailable — Mountain at dawn');
    await expect(canvas.getByRole('img', { name: 'Image unavailable' })).toBeVisible();
    await expect(canvas.getByText('Recorded at dawn', { selector: 'figcaption' })).toBeVisible();
    expect(canvasElement.querySelector('img, source, [src], [srcset]')).toBeNull();
    expect(canvasElement.innerHTML).not.toContain('/media/');
  },
};

const readerAccount = '11111111-1111-4111-8111-111111111111';

const wiredSnapshot = (
  profile: 'text' | 'blocks',
  content: DocumentSnapshot['doc']['content'],
): DocumentSnapshot =>
  parseDocument(
    JSON.parse(
      serializeDocument({
        version: 'rezics-document-v1',
        profile,
        doc: withDocumentIds({ type: 'doc', content }),
      }),
    ),
  );

const disclosureVisitDocument = (context: string): DocumentSnapshot =>
  wiredSnapshot('blocks', [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'She knew ' },
        { type: 'text', text: 'the ending', marks: [{ type: 'spoiler' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'the traitor', marks: [{ type: 'spoiler' }] },
        { type: 'text', text: '. The account ' },
        { type: 'mention', attrs: { accountId: readerAccount } },
        { type: 'text', text: ' also read the ' },
        { type: 'text', text: 'ordinary link', marks: [{ type: 'link', attrs: { href: 'https://example.com/read' } }] },
        { type: 'text', text: '.' },
      ],
    },
    { type: 'paragraph', content: [{ type: 'text', text: context }] },
    { type: 'image', attrs: { src: 'private-reader-media', alt: 'Reader image' } },
  ]);

const disclosureWithoutSpoilers = wiredSnapshot('blocks', [
  { type: 'paragraph', content: [{ type: 'text', text: 'There are no concealed passages in this visit.' }] },
  { type: 'image', attrs: { src: 'private-reader-media', alt: 'Reader image' } },
]);
const disclosureRevisionA = disclosureVisitDocument('Revision A context');
const disclosureRevisionB = disclosureVisitDocument('Revision B context');

type RetainedReactHandlers = {
  onClick?: (event: any) => void;
  onKeyDown?: (event: any) => void;
};

function retainedReactHandlers(element: HTMLElement): RetainedReactHandlers {
  const property = Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactProps$'));
  if (!property) throw new Error('the mounted control has no retained React event props');
  return (element as unknown as Record<string, RetainedReactHandlers>)[property] ?? {};
}

function retainedEvent(target: HTMLElement, key?: string) {
  let defaultPrevented = false;
  return {
    nativeEvent: key
      ? new KeyboardEvent('keydown', { bubbles: true, key, code: key === ' ' ? 'Space' : key })
      : new MouseEvent('click', { bubbles: true }),
    currentTarget: target,
    target,
    get defaultPrevented() {
      return defaultPrevented;
    },
    preventDefault() {
      defaultPrevented = true;
    },
    stopPropagation() {},
  };
}

function DisclosureReplacementReader() {
  const [document, setDocument] = useState(disclosureRevisionA);
  const [mounted, setMounted] = useState(true);
  const [locale, setLocale] = useState('en');
  const [label, setLabel] = useState('Reveal spoiler');
  const [className, setClassName] = useState('');
  const [callbackOnlyRender, setCallbackOnlyRender] = useState(0);
  const imageBoundaryCalls = useRef(0);

  return (
    <section className="space-y-4" data-callback-only-render={callbackOnlyRender}>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="disclosure-options"
          onClick={() => {
            setLocale('fr');
            setLabel('Afficher le spoiler');
            setClassName('text-sm');
          }}
        >
          Change reader options
        </button>
        <button
          type="button"
          data-testid="disclosure-equal-snapshot"
          onClick={() => setDocument(parseDocument(JSON.parse(serializeDocument(disclosureRevisionA))))}
        >
          Supply independently serialized equal content
        </button>
        <button
          type="button"
          data-testid="disclosure-fresh-callback"
          onClick={() => setCallbackOnlyRender((current) => current + 1)}
        >
          Allocate a fresh reader callback
        </button>
        <button type="button" data-testid="disclosure-show-a" onClick={() => setDocument(disclosureRevisionA)}>
          Show revision A
        </button>
        <button type="button" data-testid="disclosure-show-b" onClick={() => setDocument(disclosureRevisionB)}>
          Show revision B
        </button>
        <button
          type="button"
          data-testid="disclosure-remove-spoilers"
          onClick={() => setDocument(disclosureWithoutSpoilers)}
        >
          Remove spoilers
        </button>
        <button type="button" data-testid="disclosure-unmount" onClick={() => setMounted(false)}>
          Unmount the reader
        </button>
        <button type="button" data-testid="disclosure-remount" onClick={() => setMounted(true)}>
          Mount the reader
        </button>
      </div>
      <p tabIndex={-1} data-testid="disclosure-focus-boundary">
        Focus boundary outside the current document visit.
      </p>
      {mounted ? (
        <DocumentBody
          document={document}
          className={className}
          labels={{ revealSpoiler: label }}
          mentions={{ [readerAccount]: { handle: 'reader' } }}
          locale={locale}
          renderImage={({ alt }) => {
            const call = ++imageBoundaryCalls.current;
            return <span data-image-boundary-call={call}>{alt}</span>;
          }}
        />
      ) : null}
    </section>
  );
}

export const DisclosureReplacement: Story = {
  args: { document: disclosureRevisionA },
  render: () => <DisclosureReplacementReader />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const firstSecret = 'the ending';
    const secondSecret = 'the traitor';
    const label = 'Reveal spoiler';
    const imageBoundary = () => canvasElement.querySelector<HTMLElement>('[data-image-boundary-call]');
    const imageCall = () => imageBoundary()?.getAttribute('data-image-boundary-call');
    const firstButtons = () => canvas.getAllByRole('button', { name: label });
    const runControl = async (testId: string) => {
      const control = canvas.getByTestId(testId);
      const handler = retainedReactHandlers(control).onClick;
      if (!handler) throw new Error(`the ${testId} control has no click handler`);
      await act(async () => handler(retainedEvent(control)));
    };
    const runControlWithOneImageRender = async (testId: string) => {
      const before = Number(imageCall());
      await runControl(testId);
      await expect(imageCall()).toBe(String(before + 1));
    };

    const initialButtons = firstButtons();
    const initialImageCall = imageCall();
    if (!initialButtons[0] || !initialButtons[1] || !initialImageCall) {
      throw new Error('the initial document visit did not render both spoilers and its image boundary');
    }
    const retiredFirst = retainedReactHandlers(initialButtons[0]);
    const retiredSecond = retainedReactHandlers(initialButtons[1]);
    await expectConcealed(initialButtons[0], firstSecret, canvasElement);
    await expectConcealed(initialButtons[1], secondSecret, canvasElement);

    initialButtons[0].focus();
    await userEvent.keyboard('{Enter}');
    await expectRevealed(canvas, firstSecret, canvasElement);
    const remaining = canvas.getByRole('button', { name: label });
    await expectConcealed(remaining, secondSecret, canvasElement);
    const callsBeforePointerReveal = imageCall();
    await userEvent.click(remaining);
    await expectRevealed(canvas, secondSecret, canvasElement);
    expect(imageCall()).toBe(callsBeforePointerReveal);

    await runControlWithOneImageRender('disclosure-fresh-callback');
    await expectRevealed(canvas, secondSecret, canvasElement);
    await runControlWithOneImageRender('disclosure-options');
    await expectRevealed(canvas, secondSecret, canvasElement);
    await expect(canvas.getByRole('link', { name: '@reader' })).toHaveAttribute('href', '/fr/@reader');
    await expect(canvas.getByRole('link', { name: 'ordinary link' })).toHaveAttribute(
      'href',
      'https://example.com/read',
    );
    await runControlWithOneImageRender('disclosure-equal-snapshot');
    await expectRevealed(canvas, secondSecret, canvasElement);
    await expect(canvas.getByText('Revision A context')).toBeVisible();

    await runControlWithOneImageRender('disclosure-show-b');
    const replacementButtons = canvas.getAllByRole('button', { name: 'Afficher le spoiler' });
    if (!replacementButtons[0] || !replacementButtons[1])
      throw new Error('revision B did not mount two fresh spoilers');
    await expectConcealed(replacementButtons[0], firstSecret, canvasElement, 'Afficher le spoiler');
    await expectConcealed(replacementButtons[1], secondSecret, canvasElement, 'Afficher le spoiler');
    await expect(canvas.getByText('Revision B context')).toBeVisible();
    await expect(canvas.getByRole('link', { name: '@reader' })).toHaveAttribute('href', '/fr/@reader');
    await expect(canvas.getByRole('link', { name: 'ordinary link' })).toHaveAttribute(
      'href',
      'https://example.com/read',
    );
    expect(canvasElement.querySelector('img, source, [src], [srcset]')).toBeNull();
    expect(canvasElement.innerHTML).not.toContain('/media/');

    const boundary = canvas.getByTestId('disclosure-focus-boundary');
    boundary.focus();
    const callsBeforeRetiredHandlers = imageCall();
    await act(async () => {
      retiredFirst.onClick?.(retainedEvent(initialButtons[0]!));
      retiredFirst.onKeyDown?.(retainedEvent(initialButtons[0]!, 'Enter'));
      retiredSecond.onClick?.(retainedEvent(initialButtons[1]!));
      retiredSecond.onKeyDown?.(retainedEvent(initialButtons[1]!, ' '));
    });
    await expect(canvas.getAllByRole('button', { name: 'Afficher le spoiler' })[0]!).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(canvas.getAllByRole('button', { name: 'Afficher le spoiler' })[1]!).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(canvasElement.ownerDocument.activeElement).toBe(boundary);
    expect(imageCall()).toBe(callsBeforeRetiredHandlers);

    const imageCallBeforeReplacementReveal = imageCall();
    await userEvent.click(replacementButtons[0]!);
    await expectRevealed(canvas, firstSecret, canvasElement);
    await expect(canvas.getByRole('button', { name: 'Afficher le spoiler' })).toHaveAttribute('aria-expanded', 'false');
    expect(imageCall()).toBe(imageCallBeforeReplacementReveal);

    await runControlWithOneImageRender('disclosure-show-a');
    const revisitA = canvas.getAllByRole('button', { name: 'Afficher le spoiler' });
    await expectConcealed(revisitA[0]!, firstSecret, canvasElement, 'Afficher le spoiler');
    await expectConcealed(revisitA[1]!, secondSecret, canvasElement, 'Afficher le spoiler');
    await runControlWithOneImageRender('disclosure-show-b');
    const revisitB = canvas.getAllByRole('button', { name: 'Afficher le spoiler' });
    await expectConcealed(revisitB[0]!, firstSecret, canvasElement, 'Afficher le spoiler');
    await expectConcealed(revisitB[1]!, secondSecret, canvasElement, 'Afficher le spoiler');
    await runControlWithOneImageRender('disclosure-show-a');
    const secondAVisit = canvas.getAllByRole('button', { name: 'Afficher le spoiler' });
    await expectConcealed(secondAVisit[0]!, firstSecret, canvasElement, 'Afficher le spoiler');
    await expectConcealed(secondAVisit[1]!, secondSecret, canvasElement, 'Afficher le spoiler');

    const unmountedHandlers = retainedReactHandlers(secondAVisit[0]!);
    await runControlWithOneImageRender('disclosure-remove-spoilers');
    await expect(canvas.queryAllByRole('button', { name: 'Afficher le spoiler' })).toHaveLength(0);
    await runControlWithOneImageRender('disclosure-show-a');
    const reappeared = canvas.getAllByRole('button', { name: 'Afficher le spoiler' });
    await expectConcealed(reappeared[0]!, firstSecret, canvasElement, 'Afficher le spoiler');

    const unmountCallback = retainedReactHandlers(reappeared[0]!);
    const callsBeforeUnmount = imageCall();
    await runControl('disclosure-unmount');
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
    boundary.focus();
    await act(async () => {
      unmountCallback.onClick?.(retainedEvent(reappeared[0]!));
      unmountCallback.onKeyDown?.(retainedEvent(reappeared[0]!, 'Enter'));
      unmountedHandlers.onClick?.(retainedEvent(secondAVisit[0]!));
    });
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
    expect(canvasElement.ownerDocument.activeElement).toBe(boundary);

    await runControl('disclosure-remount');
    await expect(imageCall()).toBe(String(Number(callsBeforeUnmount) + 1));
    const remounted = canvas.getAllByRole('button', { name: 'Afficher le spoiler' });
    await expectConcealed(remounted[0]!, firstSecret, canvasElement, 'Afficher le spoiler');
    const callsBeforeFreshReveal = imageCall();
    remounted[0]!.focus();
    await userEvent.keyboard('{Space}');
    await expectRevealed(canvas, firstSecret, canvasElement);
    expect(imageCall()).toBe(callsBeforeFreshReveal);
  },
};
