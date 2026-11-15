import type { Meta, StoryObj } from '@storybook/react-vite';
import { fromPlainText, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import { useState, type ComponentProps } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PreferredRichTextEditor } from '../editor/preferred-rich-text-editor';
import { localizedEditorPreferences } from '../editor/labels';
import { readingFixture } from '../kernel/fake/settings-preferences-reading';
import { m } from '../paraglide/messages.js';
import { SettingsPageView } from '../settings/settings-page';
import { settingsContent } from '../settings/adapters/presentation';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const meta = {
  title: 'Account/Settings',
  id: 'pages-account-settings-editor',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type PreferenceIO = NonNullable<ComponentProps<typeof SettingsPageView>['preferenceIO']>;
type Consumer = 'writing' | 'compact';
const consumers = ['writing', 'compact'] as const;
const viewer = 'story-viewer';

// Interface responses only. Native persistence and authorization belong to Kernel acceptance.
function fixture() {
  const preferences = readingFixture('default', {
    editor: { writingWidth: 64 },
    shelf: { gridSize: 'large' },
  });
  const documents = {
    writing: fromPlainText('Retained chapter text', 'blocks'),
    compact: fromPlainText('Retained reply text', 'text'),
  };
  const changes = { writing: 0, compact: 0 };
  let saves = 0;
  const io: PreferenceIO = {
    read: async () => ({ ...(await preferences.io.read()), accountId: viewer }),
    saveReading: (input) => preferences.io.save(input),
    saveNotifications: async () => {
      throw new Error('Editor preferences must not issue a notification command');
    },
  };
  return {
    preferences,
    documents,
    changes,
    io,
    saves: () => saves,
    save: () => {
      saves++;
    },
  };
}
type Composition = ReturnType<typeof fixture> & { mountConsumers: () => void };
const compositions = new WeakMap<Element, Composition>();

function EditorSettingsComposition() {
  const [bound] = useState(fixture);
  const [page] = useState(() => ({
    signedIn: true as const,
    accountId: viewer,
    preferences: bound.preferences.initial,
    notifications: bound.preferences.current().notifications,
    securityHref: null,
  }));
  const [documents, setDocuments] = useState(bound.documents);
  const [showConsumers, setShowConsumers] = useState(false);
  const change = (kind: Consumer, next: DocumentSnapshot) => {
    bound.changes[kind]++;
    bound.documents[kind] = next;
    setDocuments((previous) => ({ ...previous, [kind]: next }));
  };
  return (
    <div
      data-editor-settings-story
      ref={(element) => {
        if (element) compositions.set(element, { ...bound, mountConsumers: () => setShowConsumers(true) });
      }}
    >
      <AppShell>
        <SettingsPageView page={page} csrfToken={null} preferenceIO={bound.io} content={settingsContent} />
        {showConsumers ? (
          <div className="mx-auto grid max-w-6xl gap-6 p-4 md:grid-cols-2">
            <div data-editor-consumer="writing">
              <PreferredRichTextEditor
                value={documents.writing}
                onChange={(next) => change('writing', next)}
                label={m.studio_account_body()}
                onSave={bound.save}
              />
            </div>
            <div data-editor-consumer="compact">
              <PreferredRichTextEditor
                value={documents.compact}
                onChange={(next) => change('compact', next)}
                label={m.thread_reply_body_label()}
                compact
                onSave={bound.save}
              />
            </div>
          </div>
        ) : null}
      </AppShell>
    </div>
  );
}

// Preserve only these editor-owned keys. Each locale run uses a fresh browser context.
function isolateEditorStorage() {
  const stores = [
    { storage: window.localStorage, key: `rezics.editor.device.v1:${viewer}` },
    { storage: window.sessionStorage, key: `rezics.editor.session.v1:${viewer}` },
  ].map((entry) => ({ ...entry, previous: entry.storage.getItem(entry.key) }));
  stores.forEach(({ storage, key }) => storage.removeItem(key));
  return () => {
    stores.forEach(({ storage, key, previous }) => {
      if (previous === null) storage.removeItem(key);
      else storage.setItem(key, previous);
    });
  };
}

// Tiptap intentionally publishes its editor on view.dom for integration tests.
// Keep this local probe small; no production callback or editor dependency is added.
type MountedEditor = {
  isInitialized: boolean;
  state: { doc: { toJSON: () => unknown }; selection: { toJSON: () => unknown } };
  commands: {
    focus: (position: 'end') => unknown;
    insertContent: (text: string) => unknown;
    setTextSelection: (range: { from: number; to: number }) => unknown;
  };
};
type EditorElement = HTMLElement & { editor: MountedEditor };

async function prepare(canvasElement: HTMLElement) {
  const composition = await waitFor(() => {
    const current = canvasElement.querySelector('[data-editor-settings-story]');
    if (!current || !compositions.has(current)) throw new Error('Settings composition is not ready');
    return current;
  });
  const bound = compositions.get(composition)!;
  const labels = localizedEditorPreferences();
  const panel = await within(canvasElement).findByRole('region', { name: labels.heading });
  const controls = within(panel);
  await waitFor(() => expect(controls.getByRole('combobox', { name: labels.scope })).toHaveValue('account'));
  await waitFor(() => expect(controls.getByRole('spinbutton', { name: labels.textSize })).toBeEnabled());
  // Seed the existing shared account owner from Settings before mounting its consumers.
  bound.mountConsumers();
  await waitFor(() => expect(canvasElement.querySelectorAll('[data-editor-consumer] .tiptap')).toHaveLength(2));
  const retained = [];
  for (const kind of consumers) {
    const host = canvasElement.querySelector<HTMLElement>(`[data-editor-consumer="${kind}"]`)!;
    const element = host.querySelector<EditorElement>('.tiptap')!;
    const native = element.editor;
    await waitFor(() => expect(native.isInitialized).toBe(true));
    const original = JSON.stringify(native.state.doc.toJSON());
    native.commands.focus('end');
    native.commands.insertContent(' Unsaved edit');
    await waitFor(() => expect(bound.changes[kind]).toBeGreaterThan(0));
    native.commands.setTextSelection({ from: 8, to: 3 });
    retained.push({
      kind,
      host,
      element,
      native,
      original,
      document: JSON.stringify(native.state.doc.toJSON()),
      selection: native.state.selection.toJSON(),
      snapshot: serializeDocument(bound.documents[kind]),
      changes: bound.changes[kind],
    });
  }
  return { bound, labels, controls, retained };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;

async function unchanged(view: Prepared, size: number, spacing: number, width: number) {
  for (const item of view.retained) {
    await waitFor(() => {
      const surface = item.host.querySelector<HTMLElement>('[data-slot="rich-text-editor"]')!;
      expect(surface.style.getPropertyValue('--editor-text-size')).toBe(`${size}px`);
      expect(surface.style.getPropertyValue('--editor-line-spacing')).toBe(String(spacing));
      expect(surface.style.getPropertyValue('--editor-writing-width')).toBe(`${width}ch`);
      expect(getComputedStyle(item.element).fontSize).toBe(`${size}px`);
      expect(item.host.querySelector('.tiptap')).toBe(item.element);
      expect(item.element.editor).toBe(item.native);
      expect(JSON.stringify(item.native.state.doc.toJSON())).toBe(item.document);
      expect(item.native.state.selection.toJSON()).toEqual(item.selection);
      expect(serializeDocument(view.bound.documents[item.kind])).toBe(item.snapshot);
      expect(view.bound.changes[item.kind]).toBe(item.changes);
    });
  }
  await expect(view.bound.saves()).toBe(0);
}

async function retainedUndoRedo(view: Prepared) {
  for (const item of view.retained) {
    item.element.focus();
    item.element.dispatchEvent(
      new InputEvent('beforeinput', {
        inputType: 'historyUndo',
        bubbles: true,
        cancelable: true,
      }),
    );
    await waitFor(() => expect(JSON.stringify(item.native.state.doc.toJSON())).toBe(item.original));
    item.element.dispatchEvent(
      new InputEvent('beforeinput', {
        inputType: 'historyRedo',
        bubbles: true,
        cancelable: true,
      }),
    );
    await waitFor(() => expect(JSON.stringify(item.native.state.doc.toJSON())).toBe(item.document));
    await expect(item.host.querySelector('.tiptap')).toBe(item.element);
  }
  await expect(view.bound.saves()).toBe(0);
}

const render = () => (
  <PatternStory visitor="Signed In" path="/settings#display">
    <EditorSettingsComposition />
  </PatternStory>
);

export const SaveResetPropagates: Story = {
  beforeEach: isolateEditorStorage,
  render,
  play: async ({ canvasElement }) => {
    const view = await prepare(canvasElement);
    const original = view.bound.preferences.current();
    const size = view.controls.getByRole('spinbutton', { name: view.labels.textSize });
    await userEvent.clear(size);
    await userEvent.type(size, '20');
    const spacing = view.controls.getByRole('spinbutton', { name: view.labels.lineSpacing });
    await userEvent.clear(spacing);
    await userEvent.type(spacing, '1.8');
    await userEvent.tab();
    await waitFor(() =>
      expect(view.bound.preferences.current().editor).toEqual({
        writingWidth: 64,
        textSize: 20,
        lineSpacing: 1.8,
      }),
    );
    await view.controls.findByText(view.labels.saved);
    await unchanged(view, 20, 1.8, 64);
    const calls = view.bound.preferences.calls;
    await expect(calls.length).toBeGreaterThan(0);
    await expect(calls[0]!.expectedVersion).toBe(0);
    for (const call of calls) {
      await expect(call.idempotencyKey).toBeTruthy();
      await expect(Object.keys(call).sort()).toEqual(['editor', 'expectedVersion', 'idempotencyKey']);
    }
    await userEvent.click(view.controls.getByRole('button', { name: view.labels.reset }));
    await waitFor(() => expect(view.bound.preferences.current().editor).toEqual({}));
    await expect(calls.at(-1)!.editor).toBeNull();
    await unchanged(view, 16, 1.7, 72);
    const current = view.bound.preferences.current();
    await expect(current.shelf).toEqual(original.shelf);
    await expect(current.notifications).toEqual(original.notifications);
    await expect([current.spoilerLevel, current.suitability]).toEqual([original.spoilerLevel, original.suitability]);
    await retainedUndoRedo(view);
  },
};

export const ConflictReloadRetainsDocument: Story = {
  beforeEach: isolateEditorStorage,
  render,
  play: async ({ canvasElement }) => {
    const view = await prepare(canvasElement);
    view.bound.preferences.concurrent({ editor: { textSize: 24, writingWidth: 68 } });
    const concurrent = view.bound.preferences.current();
    const size = view.controls.getByRole('spinbutton', { name: view.labels.textSize });
    await userEvent.clear(size);
    await userEvent.type(size, '20');
    await userEvent.tab();
    await view.controls.findByText(view.labels.conflict);
    await expect(view.bound.preferences.calls).toHaveLength(1);
    await expect(view.bound.preferences.calls[0]).toMatchObject({ expectedVersion: 0, editor: { textSize: 20 } });
    await expect(size).toHaveValue(20);
    await expect(size).toBeDisabled();
    await unchanged(view, 20, 1.7, 64);
    await userEvent.click(view.controls.getByRole('button', { name: view.labels.reload }));
    await waitFor(() => expect(size).toHaveValue(24));
    await expect(size).toBeEnabled();
    await expect(view.bound.preferences.calls).toHaveLength(1);
    await unchanged(view, 24, 1.7, 68);
    await userEvent.click(view.controls.getByRole('button', { name: view.labels.reset }));
    await waitFor(() => expect(view.bound.preferences.current().editor).toEqual({}));
    await expect(view.bound.preferences.calls[1]).toMatchObject({ expectedVersion: 1, editor: null });
    await expect(view.bound.preferences.calls[1]!.idempotencyKey).not.toBe(
      view.bound.preferences.calls[0]!.idempotencyKey,
    );
    await expect(view.bound.preferences.current().notifications).toEqual(concurrent.notifications);
    await unchanged(view, 16, 1.7, 72);
    await retainedUndoRedo(view);
  },
};
