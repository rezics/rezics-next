import { checkDocument, fromPlainText, type DocumentProfile, type DocumentSnapshot } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { waitForFocus } from '../test/focus.ts';
import { RichTextEditor } from './rich-text-editor.tsx';

function demo(linked = false) {
  const initial = structuredClone(fromPlainText('A useful resource'));
  if (linked)
    initial.doc.content![0]!.content![0]!.marks = [{ type: 'link', attrs: { href: 'https://example.com/original' } }];
  const latest = { current: initial };
  function Demo() {
    const [value, setValue] = useState(initial);
    return (
      <RichTextEditor
        compact
        value={value}
        label="Post"
        onChange={(next) => {
          latest.current = next;
          setValue(next);
        }}
      />
    );
  }
  return { Demo, latest, initial };
}
function checked(snapshot: DocumentSnapshot) {
  expect(checkDocument(snapshot)).toBe(true);
  return snapshot.doc.content?.[0]?.content?.[0];
}
async function select(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('textbox', { name: 'Post' }));
  const range = document.createRange();
  range.selectNodeContents(canvas.getByRole('textbox', { name: 'Post' }));
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  await canvas.findByRole('toolbar', { name: 'Format text' });
  return canvas;
}
const meta = {
  title: 'Components/Editor Link',
  component: RichTextEditor,
  args: { value: fromPlainText(''), label: 'Post', onChange: () => undefined },
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl bg-background p-16 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RichTextEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
const insert = demo();
const unsafe = demo();
const existing = demo(true);

export const InsertLink: Story = {
  render: () => <insert.Demo />,
  async play({ canvasElement }) {
    const canvas = await select(canvasElement);
    await userEvent.keyboard('{Control>}k{/Control}');
    const address = await canvas.findByRole('textbox', { name: 'URL' });
    expect(address).toHaveFocus();
    await userEvent.type(address, 'https://example.com/resource');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(checked(insert.latest.current)?.marks?.[0]?.attrs?.href).toBe('https://example.com/resource'),
    );
    expect(checked(insert.latest.current)?.text).toBe('A useful resource');
    // The editor returns focus on the next animation frame and restores its own selection then, so collapse after that.
    await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Post' })).toHaveFocus());
    // An empty selection accepts an address as linked text.
    window.getSelection()?.collapseToEnd();
    document.dispatchEvent(new Event('selectionchange'));
    await waitFor(() => expect(canvas.queryByRole('toolbar')).toBeNull());
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await canvas.findByRole('textbox', { name: 'URL' }), 'mailto:hello@example.com');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(checkDocument(insert.latest.current)).toBe(true);
      expect(JSON.stringify(insert.latest.current)).toContain('mailto:hello@example.com');
    });
  },
};

export const UnsafeLinkRefused: Story = {
  render: () => <unsafe.Demo />,
  async play({ canvasElement }) {
    const canvas = await select(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Link' }));
    const address = await canvas.findByRole('textbox', { name: 'URL' });
    for (const url of ['javascript:alert(1)', 'data:text/html,unsafe', '/relative', 'ftp://example.com']) {
      await userEvent.clear(address);
      await userEvent.type(address, url);
      await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
      expect(await canvas.findByRole('alert')).toHaveTextContent('Enter an http:, https: or mailto: address.');
      expect(address).toHaveAttribute('aria-invalid', 'true');
      expect(getComputedStyle(address).color).toBe(
        getComputedStyle(canvas.getByRole('textbox', { name: 'Post' })).color,
      );
      expect(unsafe.latest.current).toEqual(unsafe.initial);
      checked(unsafe.latest.current);
    }
    await userEvent.keyboard('{Escape}');
    expect(canvas.queryByRole('textbox', { name: 'URL' })).toBeNull();
    await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Post' })).toHaveFocus());
    expect(window.getSelection()?.toString()).toBe('A useful resource');
    expect(checked(unsafe.latest.current)?.marks ?? []).toEqual([]);
  },
};

export const EditAndRemoveLink: Story = {
  render: () => <existing.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('textbox', { name: 'Post' }));
    const text = canvas.getByRole('textbox', { name: 'Post' }).querySelector('a')!.firstChild!;
    window.getSelection()?.collapse(text, 1);
    document.dispatchEvent(new Event('selectionchange'));
    const open = await canvas.findByRole('link', { name: 'Open link' });
    expect(open).toHaveAttribute('href', 'https://example.com/original');
    await userEvent.click(canvas.getByRole('button', { name: 'Edit link' }));
    const address = await canvas.findByRole('textbox', { name: 'URL' });
    expect(address).toHaveValue('https://example.com/original');
    await userEvent.clear(address);
    await userEvent.type(address, 'http://example.com/edited');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(checked(existing.latest.current)?.marks?.[0]?.attrs?.href).toBe('http://example.com/edited'),
    );
    window.getSelection()?.collapse(canvas.getByRole('textbox', { name: 'Post' }).querySelector('a')!.firstChild!, 1);
    document.dispatchEvent(new Event('selectionchange'));
    await userEvent.click(await canvas.findByRole('button', { name: 'Remove link' }));
    await waitFor(() => expect(checked(existing.latest.current)?.marks ?? []).toEqual([]));
    expect(checked(existing.latest.current)?.text).toBe('A useful resource');
  },
};

type PendingLookup = {
  query: string;
  signal: AbortSignal;
  resolve: (account: { accountId: string; handle: string; name?: string } | null) => void;
  reject: (reason?: unknown) => void;
};
type JourneyAccount = { accountId: string; handle: string; name?: string };
type JourneyFiber = { memoizedProps?: Record<string, unknown>; return?: JourneyFiber | null };

type JourneyEvidence = {
  latest: DocumentSnapshot;
  publications: number;
  requests: PendingLookup[];
};

function inlineJourney() {
  const initial = fromPlainText('Draft text', 'blocks');
  const evidence: JourneyEvidence = { latest: initial, publications: 0, requests: [] };

  function replace(setValue: (value: DocumentSnapshot) => void, text: string, profile: DocumentProfile = 'blocks') {
    const snapshot = fromPlainText(text, profile);
    evidence.latest = snapshot;
    setValue(snapshot);
  }

  function Demo() {
    const [value, setValue] = useState(initial);
    const [sourceEnabled, setSourceEnabled] = useState(true);
    const [mode, setMode] = useState<'editable' | 'disabled' | 'readOnly'>('editable');
    const [toolbar, setToolbar] = useState<'auto' | 'always'>('auto');
    const [mounted, setMounted] = useState(true);

    // This callback is intentionally reallocated on every parent render. Request identity belongs to its admitted
    // visit, not to function allocation.
    const lookupMention = sourceEnabled
      ? (query: string, signal: AbortSignal) =>
          new Promise<JourneyAccount | null>((resolve, reject) => {
            evidence.requests.push({
              query,
              signal,
              resolve: resolve as PendingLookup['resolve'],
              reject,
            });
          })
      : undefined;

    const external = (text: string, profile?: DocumentProfile) => replace(setValue, text, profile ?? value.profile);

    return (
      <section className="space-y-3">
        <div className="flex flex-wrap gap-2" aria-label="Document controls">
          <button type="button" onClick={() => external('Fresh document')}>
            Replace with fresh document
          </button>
          <button type="button" onClick={() => external('@same')}>
            Replace with same query
          </button>
          <button type="button" onClick={() => external('@a')}>
            Replace with A
          </button>
          <button type="button" onClick={() => external('@b')}>
            Replace with B
          </button>
          <button type="button" onClick={() => external('@remove')}>
            Replace with source-removal query
          </button>
          <button type="button" onClick={() => external('@locked')}>
            Replace with locked query
          </button>
          <button type="button" onClick={() => external('@fresh')}>
            Replace with fresh query
          </button>
          <button type="button" onClick={() => external('@profile', 'blocks')}>
            Replace with profile pending query
          </button>
          <button type="button" onClick={() => external('@profile', 'text')}>
            Replace profile query
          </button>
          <button type="button" onClick={() => external('@unmount')}>
            Replace with unmount query
          </button>
          <button type="button" onClick={() => external('Touch target')}>
            Replace with touch target
          </button>
          <button type="button" onClick={() => external('Selection target')}>
            Replace with selection target
          </button>
          <button type="button" onClick={() => external('First line\nTarget line')}>
            Replace with two paragraphs
          </button>
          <button type="button" onClick={() => external('')}>
            Replace with empty document
          </button>
          <button type="button" onClick={() => setValue(structuredClone(evidence.latest))}>
            Echo current document
          </button>
          <button type="button" onClick={() => setToolbar('always')}>
            Use touch toolbar
          </button>
          <button type="button" onClick={() => setToolbar('auto')}>
            Use selection toolbar
          </button>
          <button type="button" onClick={() => setSourceEnabled(false)}>
            Remove mention source
          </button>
          <button type="button" onClick={() => setSourceEnabled(true)}>
            Restore mention source
          </button>
          <button type="button" onClick={() => setMode('disabled')}>
            Disable editor
          </button>
          <button type="button" onClick={() => setMode('readOnly')}>
            Make editor read only
          </button>
          <button type="button" onClick={() => setMode('editable')}>
            Enable editor
          </button>
          {mounted ? (
            <button type="button" onClick={() => setMounted(false)}>
              Unmount editor
            </button>
          ) : (
            <button type="button" onClick={() => setMounted(true)}>
              Mount editor
            </button>
          )}
        </div>
        {mounted ? (
          <RichTextEditor
            compact
            value={value}
            label="Post"
            toolbar={toolbar}
            disabled={mode === 'disabled'}
            readOnly={mode === 'readOnly'}
            lookupMention={lookupMention}
            onChange={(next) => {
              evidence.latest = next;
              evidence.publications += 1;
              setValue(next);
            }}
          />
        ) : (
          <p>Editor unmounted</p>
        )}
      </section>
    );
  }

  return { Demo, evidence };
}

function journeyText(snapshot: DocumentSnapshot): string {
  const text = (node: NonNullable<DocumentSnapshot['doc']['content']>[number]): string => {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'mention') return '@';
    if (node.type === 'hardBreak') return '\n';
    return (node.content ?? []).map((child) => text(child)).join('');
  };
  return (snapshot.doc.content ?? []).map((node) => text(node)).join('\n');
}

function checkJourneyDocument(snapshot: DocumentSnapshot) {
  expect(checkDocument(snapshot)).toBe(true);
  return snapshot;
}

async function caretAtEnd(canvas: ReturnType<typeof within>) {
  const textbox = canvas.getByRole('textbox', { name: 'Post' });
  await userEvent.click(textbox);
  const range = document.createRange();
  range.selectNodeContents(textbox);
  range.collapse(false);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  return textbox;
}

async function selectJourneyText(canvas: ReturnType<typeof within>) {
  const textbox = canvas.getByRole('textbox', { name: 'Post' });
  await userEvent.click(textbox);
  const range = document.createRange();
  range.selectNodeContents(textbox);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  return textbox;
}

async function selectJourneyParagraph(canvas: ReturnType<typeof within>, paragraph: number, collapse: boolean) {
  const textbox = canvas.getByRole('textbox', { name: 'Post' });
  await userEvent.click(textbox);
  const apply = () => {
    const node = textbox.querySelectorAll('p')[paragraph]?.firstChild;
    if (!node) throw new Error(`Paragraph ${paragraph} has no text node`);
    const range = document.createRange();
    range.selectNodeContents(node);
    if (collapse) range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  };
  apply();
  await waitForFocus(textbox, undefined, () => {
    textbox.focus();
    apply();
  });
  return textbox;
}

function reactCallback(element: Element, name: string): (...args: never[]) => unknown {
  let current: Element | null = element;
  while (current) {
    const fiberName = Object.getOwnPropertyNames(current).find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberName
      ? ((current as unknown as Record<string, unknown>)[fiberName] as JourneyFiber | undefined)
      : undefined;
    while (fiber) {
      const callback = fiber.memoizedProps?.[name];
      if (typeof callback === 'function') return callback as (...args: never[]) => unknown;
      fiber = fiber.return ?? undefined;
    }
    current = current.parentElement;
  }
  throw new Error(`Could not retain the mounted ${name} callback`);
}

const inlineLifetime = inlineJourney();

export const InlineLifetimeJourney: Story = {
  render: () => <inlineLifetime.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const evidence = inlineLifetime.evidence;
    const account = (handle: string, last: string) => ({
      accountId: `0192f3a0-6c1e-7b2a-9d4e-${last}`,
      handle,
    });
    const requestCount = evidence.requests.length;

    // A real edit publishes into the controlled parent. The next render allocates a fresh source callback.
    let textbox = await caretAtEnd(canvas);
    await userEvent.type(textbox, ' local edit');
    await waitFor(() => expect(evidence.publications).toBeGreaterThan(0));
    expect(journeyText(checkJourneyDocument(evidence.latest))).toContain('Draft text local edit');

    // Selection formatting and shortcut link creation operate on the mounted ProseMirror selection.
    textbox = await selectJourneyText(canvas);
    const selectionToolbar = within(await canvas.findByRole('toolbar', { name: 'Format text' }));
    await userEvent.click(selectionToolbar.getByRole('button', { name: 'Bold' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('"type":"bold"'));
    textbox = await selectJourneyText(canvas);
    await userEvent.keyboard('{Control>}k{/Control}');
    let address = await canvas.findByRole('textbox', { name: 'URL' });
    await userEvent.type(address, 'https://shortcut.example/resource');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('https://shortcut.example/resource'));

    // Escape cancels a shortcut draft without changing the link or inserting a URL.
    await caretAtEnd(canvas);
    await userEvent.keyboard('{Control>}k{/Control}');
    address = await canvas.findByRole('textbox', { name: 'URL' });
    await userEvent.type(address, 'https://cancelled.example');
    await userEvent.keyboard('{Escape}');
    expect(canvas.queryByRole('textbox', { name: 'URL' })).toBeNull();
    expect(JSON.stringify(evidence.latest)).not.toContain('https://cancelled.example');

    // Link editing, cancel, replacement, and removal remain attached to the current anchor.
    textbox = canvas.getByRole('textbox', { name: 'Post' });
    const anchor = textbox.querySelector('a');
    expect(anchor).not.toBeNull();
    window.getSelection()?.collapse(anchor!.firstChild!, 1);
    document.dispatchEvent(new Event('selectionchange'));
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit link' }));
    address = await canvas.findByRole('textbox', { name: 'URL' });
    expect(address).toHaveValue('https://shortcut.example/resource');
    await userEvent.clear(address);
    await userEvent.type(address, 'https://cancel-edit.example');
    await userEvent.keyboard('{Escape}');
    expect(JSON.stringify(evidence.latest)).toContain('https://shortcut.example/resource');
    expect(JSON.stringify(evidence.latest)).not.toContain('https://cancel-edit.example');
    window.getSelection()?.collapse(anchor!.firstChild!, 1);
    document.dispatchEvent(new Event('selectionchange'));
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit link' }));
    address = await canvas.findByRole('textbox', { name: 'URL' });
    await userEvent.clear(address);
    await userEvent.type(address, 'https://edited.example/resource');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('https://edited.example/resource'));
    textbox = canvas.getByRole('textbox', { name: 'Post' });
    const editedAnchor = textbox.querySelector('a');
    window.getSelection()?.collapse(editedAnchor!.firstChild!, 1);
    document.dispatchEvent(new Event('selectionchange'));
    await userEvent.click(await canvas.findByRole('button', { name: 'Remove link' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).not.toContain('https://edited.example/resource'));

    // The selection menu can create a link, and a touch visit can create, cancel, edit, and remove one.
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with selection target' }));
    textbox = await selectJourneyText(canvas);
    const formatSelection = within(await canvas.findByRole('toolbar', { name: 'Format text' }));
    await userEvent.click(formatSelection.getByRole('button', { name: 'Link' }));
    address = await canvas.findByRole('textbox', { name: 'URL' });
    await userEvent.type(address, 'https://selection.example');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('https://selection.example'));
    let currentSelectionToolbar = within(await canvas.findByRole('toolbar', { name: 'Format text' }));
    await userEvent.click(currentSelectionToolbar.getByRole('button', { name: 'Link' }));
    address = await canvas.findByRole('textbox', { name: 'URL' });
    expect(address).toHaveValue('https://selection.example');
    await userEvent.clear(address);
    await userEvent.type(address, 'https://selection-cancel.example');
    await userEvent.keyboard('{Escape}');
    expect(JSON.stringify(evidence.latest)).toContain('https://selection.example');
    expect(JSON.stringify(evidence.latest)).not.toContain('https://selection-cancel.example');
    currentSelectionToolbar = within(await canvas.findByRole('toolbar', { name: 'Format text' }));
    await userEvent.click(currentSelectionToolbar.getByRole('button', { name: 'Link' }));
    address = await canvas.findByRole('textbox', { name: 'URL' });
    await userEvent.clear(address);
    await userEvent.type(address, 'https://selection-edited.example');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('https://selection-edited.example'));
    currentSelectionToolbar = within(await canvas.findByRole('toolbar', { name: 'Format text' }));
    await userEvent.click(currentSelectionToolbar.getByRole('button', { name: 'Link' }));
    await canvas.findByRole('textbox', { name: 'URL' });
    await userEvent.click(currentSelectionToolbar.getByRole('button', { name: 'Remove link' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).not.toContain('https://selection-edited.example'));

    await userEvent.click(canvas.getByRole('button', { name: 'Use touch toolbar' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with touch target' }));
    textbox = await selectJourneyText(canvas);
    let touchToolbar = within(await canvas.findByRole('toolbar', { name: 'Formatting toolbar' }));
    await userEvent.click(touchToolbar.getByRole('button', { name: 'Bold' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('"type":"bold"'));
    touchToolbar = within(await canvas.findByRole('toolbar', { name: 'Formatting toolbar' }));
    await userEvent.click(touchToolbar.getByRole('button', { name: 'Link' }));
    address = await canvas.findByRole('textbox', { name: 'URL' });
    await userEvent.type(address, 'https://touch.example');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('https://touch.example'));
    textbox = canvas.getByRole('textbox', { name: 'Post' });
    let touchAnchor = textbox.querySelector('a');
    expect(touchAnchor).not.toBeNull();
    window.getSelection()?.collapse(touchAnchor!.firstChild!, 1);
    document.dispatchEvent(new Event('selectionchange'));
    touchToolbar = within(await canvas.findByRole('toolbar', { name: 'Formatting toolbar' }));
    await userEvent.click(touchToolbar.getByRole('button', { name: 'Link' }));
    address = await canvas.findByRole('textbox', { name: 'URL' });
    await userEvent.clear(address);
    await userEvent.type(address, 'https://touch-cancel.example');
    await userEvent.keyboard('{Escape}');
    expect(JSON.stringify(evidence.latest)).toContain('https://touch.example');
    expect(JSON.stringify(evidence.latest)).not.toContain('https://touch-cancel.example');
    touchToolbar = within(await canvas.findByRole('toolbar', { name: 'Formatting toolbar' }));
    await userEvent.click(touchToolbar.getByRole('button', { name: 'Link' }));
    address = await canvas.findByRole('textbox', { name: 'URL' });
    await userEvent.clear(address);
    await userEvent.type(address, 'https://touch-edited.example');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('https://touch-edited.example'));
    textbox = canvas.getByRole('textbox', { name: 'Post' });
    touchAnchor = textbox.querySelector('a');
    window.getSelection()?.collapse(touchAnchor!.firstChild!, 1);
    document.dispatchEvent(new Event('selectionchange'));
    touchToolbar = within(await canvas.findByRole('toolbar', { name: 'Formatting toolbar' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Remove link' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).not.toContain('https://touch-edited.example'));

    // Slash supports both a block command and link creation; command insertion keeps the slash text out of the doc.
    await userEvent.click(canvas.getByRole('button', { name: 'Use selection toolbar' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with empty document' }));
    textbox = await caretAtEnd(canvas);
    await userEvent.type(textbox, '/link');
    const slash = await canvas.findByRole('listbox', { name: 'Insert block' });
    expect(within(slash).getByRole('option', { name: 'Link' })).toBeVisible();
    await userEvent.keyboard('{Enter}');
    address = await canvas.findByRole('textbox', { name: 'URL' });
    await userEvent.type(address, 'https://slash.example');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('https://slash.example'));
    expect(canvas.getByRole('textbox', { name: 'Post' })).not.toHaveAttribute('data-slash-aria-owner');
    expect(canvas.getByRole('textbox', { name: 'Post' })).not.toHaveAttribute('aria-activedescendant');
    textbox = canvas.getByRole('textbox', { name: 'Post' });
    let slashAnchor = textbox.querySelector('a');
    expect(slashAnchor).not.toBeNull();
    window.getSelection()?.collapse(slashAnchor!.firstChild!, 1);
    document.dispatchEvent(new Event('selectionchange'));
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit link' }));
    address = await canvas.findByRole('textbox', { name: 'URL' });
    expect(address).toHaveValue('https://slash.example');
    await userEvent.clear(address);
    await userEvent.type(address, 'https://slash-cancel.example');
    await userEvent.keyboard('{Escape}');
    expect(JSON.stringify(evidence.latest)).toContain('https://slash.example');
    expect(JSON.stringify(evidence.latest)).not.toContain('https://slash-cancel.example');
    textbox = canvas.getByRole('textbox', { name: 'Post' });
    slashAnchor = textbox.querySelector('a');
    window.getSelection()?.collapse(slashAnchor!.firstChild!, 1);
    document.dispatchEvent(new Event('selectionchange'));
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit link' }));
    address = await canvas.findByRole('textbox', { name: 'URL' });
    await userEvent.clear(address);
    await userEvent.type(address, 'https://slash-edited.example');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('https://slash-edited.example'));
    textbox = canvas.getByRole('textbox', { name: 'Post' });
    slashAnchor = textbox.querySelector('a');
    window.getSelection()?.collapse(slashAnchor!.firstChild!, 1);
    document.dispatchEvent(new Event('selectionchange'));
    await userEvent.click(await canvas.findByRole('button', { name: 'Remove link' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).not.toContain('https://slash-edited.example'));
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with empty document' }));
    textbox = await caretAtEnd(canvas);
    await userEvent.type(textbox, '/h2');
    await canvas.findByRole('listbox', { name: 'Insert block' });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(checkJourneyDocument(evidence.latest).doc.content?.[0]?.type).toBe('heading'));
    expect(checkJourneyDocument(evidence.latest).doc.content?.[0]?.attrs?.level).toBe(2);
    expect(JSON.stringify(evidence.latest)).not.toContain('/h2');

    // A URL draft follows its saved range through a legitimate edit and controlled echo in the same document.
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with two paragraphs' }));
    textbox = await selectJourneyParagraph(canvas, 1, false);
    await userEvent.keyboard('{Control>}k{/Control}');
    address = await canvas.findByRole('textbox', { name: 'URL' });
    await userEvent.type(address, 'https://retained-draft.example');
    await userEvent.click(canvas.getByRole('button', { name: 'Echo current document' }));
    address = await canvas.findByRole('textbox', { name: 'URL' });
    expect(address).toHaveValue('https://retained-draft.example');
    textbox = await selectJourneyParagraph(canvas, 0, true);
    await userEvent.keyboard('X');
    await waitFor(() => expect(journeyText(evidence.latest)).toContain('XFirst line'));
    address = await canvas.findByRole('textbox', { name: 'URL' });
    expect(address).toHaveValue('https://retained-draft.example');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('https://retained-draft.example'));

    // A late Apply handler cannot reuse the same numeric position in a replacement document.
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with selection target' }));
    await caretAtEnd(canvas);
    await userEvent.keyboard('{Control>}k{/Control}');
    address = await canvas.findByRole('textbox', { name: 'URL' });
    await userEvent.type(address, 'https://retired-draft.example');
    const retainedSubmit = reactCallback(address.closest('form')!, 'onSubmit');
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with selection target' }));
    retainedSubmit({ preventDefault: () => undefined } as never);
    expect(canvas.queryByRole('textbox', { name: 'URL' })).toBeNull();
    expect(JSON.stringify(evidence.latest)).not.toContain('https://retired-draft.example');

    // Same-position, same-query replacement retires the old request while preserving one fresh request.
    const sameStart = evidence.requests.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with same query' }));
    await caretAtEnd(canvas);
    await waitFor(() => expect(evidence.requests.length).toBe(sameStart + 1));
    const oldSame = evidence.requests[sameStart]!;
    expect(oldSame.query).toBe('same');
    const requestCountWithSamePending = evidence.requests.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Echo current document' }));
    expect(oldSame.signal.aborted).toBe(false);
    expect(evidence.requests.length).toBe(requestCountWithSamePending);
    const sameReplacementStart = evidence.requests.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Use touch toolbar' }));
    await waitFor(() => expect(evidence.requests.length).toBe(sameReplacementStart));
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with same query' }));
    await caretAtEnd(canvas);
    await waitFor(() => expect(evidence.requests.length).toBe(sameReplacementStart + 1));
    const freshSame = evidence.requests[sameReplacementStart]!;
    expect(oldSame.signal.aborted).toBe(true);
    oldSame.resolve(account('obsolete-same', '000000000101'));
    await Promise.resolve();
    expect(canvas.queryByRole('option', { name: /obsolete-same/ })).toBeNull();
    freshSame.resolve(account('same-current', '000000000102'));
    const freshSameOption = await canvas.findByRole('option', { name: /@same-current/ });
    const retainedPointer = reactCallback(freshSameOption, 'onSelect');
    expect(canvas.getByRole('textbox', { name: 'Post' })).toHaveAttribute('role', 'combobox');
    expect(canvas.getByRole('textbox', { name: 'Post' })).toHaveAttribute('aria-controls');

    // A retained option and keyboard callback from the old visit cannot affect the replacement document.
    const editorSurface = canvasElement.querySelector<HTMLElement>('[data-slot="rich-text-editor"]')!;
    const retainedKeyboard = reactCallback(editorSurface, 'onKeyDown');
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with fresh document' }));
    const freshSnapshot = evidence.latest;
    const publicationsBeforeStaleCallbacks = evidence.publications;
    const syntheticKey = {
      nativeEvent: { isComposing: false, keyCode: 0 },
      defaultPrevented: false,
      key: 'k',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    retainedKeyboard(syntheticKey as never);
    retainedPointer();
    expect(evidence.latest).toBe(freshSnapshot);
    expect(evidence.publications).toBe(publicationsBeforeStaleCallbacks);
    expect(canvas.queryByRole('textbox', { name: 'URL' })).toBeNull();
    expect(canvas.queryByRole('option')).toBeNull();
    const cleanTextbox = canvas.getByRole('textbox', { name: 'Post' });
    expect(cleanTextbox).toHaveAttribute('role', 'textbox');
    expect(cleanTextbox).toHaveAttribute('aria-multiline', 'true');
    expect(cleanTextbox).not.toHaveAttribute('aria-controls');
    expect(cleanTextbox).not.toHaveAttribute('aria-activedescendant');
    expect(cleanTextbox).not.toHaveAttribute('data-mention-aria-owner');

    // A/B/A replacement rejects late success, error, and finally from both old requests, then admits fresh A.
    const abaStart = evidence.requests.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with A' }));
    await caretAtEnd(canvas);
    await waitFor(() => expect(evidence.requests.length).toBe(abaStart + 1));
    const requestA1 = evidence.requests[abaStart]!;
    expect(requestA1.query).toBe('a');
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with B' }));
    await caretAtEnd(canvas);
    await waitFor(() => expect(evidence.requests.length).toBe(abaStart + 2));
    const requestB = evidence.requests[abaStart + 1]!;
    expect(requestB.query).toBe('b');
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with A' }));
    await caretAtEnd(canvas);
    await waitFor(() => expect(evidence.requests.length).toBe(abaStart + 3));
    const requestA2 = evidence.requests[abaStart + 2]!;
    expect(requestA2.query).toBe('a');
    expect(requestA1.signal.aborted).toBe(true);
    expect(requestB.signal.aborted).toBe(true);
    requestA1.resolve(account('obsolete-a', '000000000103'));
    requestB.reject(new Error('late obsolete lookup failure'));
    await Promise.resolve();
    expect(canvas.getByText('Looking up account…')).toBeVisible();
    expect(canvas.queryByRole('option', { name: /obsolete/ })).toBeNull();
    requestA2.resolve(account('current-a', '000000000104'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('0192f3a0-6c1e-7b2a-9d4e-000000000104'));
    expect(JSON.stringify(evidence.latest)).not.toContain('current-a');
    expect(canvas.getByRole('textbox', { name: 'Post' })).toHaveAttribute('role', 'textbox');

    // Source removal, readonly, disabled, profile change, and unmount all retire their own pending work.
    const removeIndex = evidence.requests.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with source-removal query' }));
    await caretAtEnd(canvas);
    await waitFor(() => expect(evidence.requests.length).toBe(removeIndex + 1));
    const removedSourceRequest = evidence.requests[removeIndex]!;
    await userEvent.click(canvas.getByRole('button', { name: 'Remove mention source' }));
    expect(removedSourceRequest.signal.aborted).toBe(true);
    removedSourceRequest.resolve(account('source-removed', '000000000105'));
    await Promise.resolve();
    expect(canvas.queryByRole('option')).toBeNull();
    expect(canvas.getByRole('textbox', { name: 'Post' })).toHaveAttribute('role', 'textbox');

    await userEvent.click(canvas.getByRole('button', { name: 'Restore mention source' }));
    const lockedIndex = evidence.requests.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with locked query' }));
    await caretAtEnd(canvas);
    await waitFor(() => expect(evidence.requests.length).toBe(lockedIndex + 1));
    const readonlyRequest = evidence.requests[lockedIndex]!;
    await userEvent.click(canvas.getByRole('button', { name: 'Make editor read only' }));
    readonlyRequest.resolve(account('readonly-late', '000000000106'));
    await Promise.resolve();
    expect(canvas.queryByRole('option')).toBeNull();
    expect(canvas.queryByText('Looking up account…')).toBeNull();

    await userEvent.click(canvas.getByRole('button', { name: 'Enable editor' }));
    const reenabledIndex = evidence.requests.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with fresh query' }));
    await caretAtEnd(canvas);
    await waitFor(() => expect(evidence.requests.length).toBe(reenabledIndex + 1));
    evidence.requests[reenabledIndex]!.resolve(account('reenabled', '000000000107'));
    await canvas.findByRole('option', { name: /@reenabled/ });
    await userEvent.keyboard('{Tab}');
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('000000000107'));

    const disabledIndex = evidence.requests.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with locked query' }));
    await caretAtEnd(canvas);
    await waitFor(() => expect(evidence.requests.length).toBe(disabledIndex + 1));
    const disabledRequest = evidence.requests[disabledIndex]!;
    await userEvent.click(canvas.getByRole('button', { name: 'Disable editor' }));
    disabledRequest.reject(new Error('late disabled lookup failure'));
    await Promise.resolve();
    expect(canvas.queryByRole('option')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Enable editor' }));
    const afterDisabledIndex = evidence.requests.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with fresh query' }));
    await caretAtEnd(canvas);
    await waitFor(() => expect(evidence.requests.length).toBe(afterDisabledIndex + 1));
    evidence.requests[afterDisabledIndex]!.resolve(account('after-disabled', '000000000112'));
    await canvas.findByRole('option', { name: /@after-disabled/ });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('000000000112'));

    const profileIndex = evidence.requests.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with profile pending query' }));
    await caretAtEnd(canvas);
    await waitFor(() => expect(evidence.requests.length).toBe(profileIndex + 1));
    const profileRequest = evidence.requests[profileIndex]!;
    const newProfileIndex = profileIndex + 1;
    await userEvent.click(canvas.getByRole('button', { name: 'Replace profile query' }));
    await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Post' })).toHaveTextContent('@profile'));
    expect(profileRequest.signal.aborted).toBe(true);
    profileRequest.resolve(account('old-profile', '000000000108'));
    await Promise.resolve();
    expect(canvas.queryByRole('option', { name: /old-profile/ })).toBeNull();
    await caretAtEnd(canvas);
    await waitFor(() => expect(evidence.requests.length).toBe(newProfileIndex + 1));
    evidence.requests[newProfileIndex]!.resolve(account('new-profile', '000000000109'));
    await canvas.findByRole('option', { name: /@new-profile/ });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('000000000109'));

    const unmountIndex = evidence.requests.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with unmount query' }));
    await caretAtEnd(canvas);
    await waitFor(() => expect(evidence.requests.length).toBe(unmountIndex + 1));
    const unmountRequest = evidence.requests[unmountIndex]!;
    await userEvent.click(canvas.getByRole('button', { name: 'Unmount editor' }));
    unmountRequest.resolve(account('unmounted', '000000000110'));
    await Promise.resolve();
    expect(canvas.queryByRole('textbox', { name: 'Post' })).toBeNull();
    expect(canvas.queryByRole('option')).toBeNull();

    const remountIndex = evidence.requests.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Mount editor' }));
    await caretAtEnd(canvas);
    await waitFor(() => expect(evidence.requests.length).toBe(remountIndex + 1));
    evidence.requests[remountIndex]!.resolve(account('remounted', '000000000111'));
    await canvas.findByRole('option', { name: /@remounted/ });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(JSON.stringify(evidence.latest)).toContain('000000000111'));

    // The phone sheet owns its deferred focus callback for this visit; a replacement retires it before it runs.
    await userEvent.click(canvas.getByRole('button', { name: 'Use touch toolbar' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with touch target' }));
    touchToolbar = within(await canvas.findByRole('toolbar', { name: 'Formatting toolbar' }));
    await userEvent.click(touchToolbar.getByRole('button', { name: 'Blocks' }));
    const dialog = await page.findByRole('dialog', { name: 'Blocks' });
    const finalFocus = reactCallback(dialog, 'finalFocus');
    const frames: FrameRequestCallback[] = [];
    const requestFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }) as typeof window.requestAnimationFrame;
    try {
      finalFocus();
    } finally {
      window.requestAnimationFrame = requestFrame;
    }
    const replacementControl = canvas.getByRole('button', { name: 'Replace with fresh document' });
    reactCallback(replacementControl, 'onClick')();
    await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Post' })).toHaveTextContent('Fresh document'));
    replacementControl.focus();
    for (const frame of frames) frame(0);
    expect(replacementControl).toHaveFocus();
    expect(page.queryByRole('dialog', { name: 'Blocks' })).toBeNull();
    expect(canvas.queryByRole('listbox', { name: 'Insert block' })).toBeNull();
    expect(evidence.requests.length).toBeGreaterThan(requestCount);
    expect(checkJourneyDocument(evidence.latest)).toBe(evidence.latest);
  },
};
