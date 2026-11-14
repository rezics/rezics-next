import { afterAll, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { default: userEvent } = await import('@testing-library/user-event');
const { getByRole, getAllByRole, queryByRole, waitFor } = await import('@testing-library/dom');
const { serializeDocument } = await import('@rezics/document');
const { StudioWorkbench } = await import('../src/studio/workspace');
const { studioWorkbenchFixture } = await import('../src/kernel/fake/studio-workbench');
const { workbenchCopy } = await import('../src/studio/workbench-copy');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');

afterAll(async () => {
  setLocale('en', { reload: false });
  await dom.restore();
});

async function mount(profile: 'book' | 'column', scenario: 'populated' | 'dirty' | 'comparison' = 'populated') {
  setLocale('en', { reload: false });
  const fixture = await studioWorkbenchFixture(profile, scenario, 'en');
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  await act(async () => root.render(<StudioWorkbench {...fixture.props} controller={fixture.controller} />));
  const button = (name: string) => getByRole(host, 'button', { name, exact: true }) as HTMLButtonElement;
  return {
    ...fixture,
    host,
    button,
    click: async (name: string) => {
      await act(async () => {
        const control = button(name);
        control.focus();
        control.click();
      });
    },
    close: async () => {
      await act(async () => root.unmount());
      fixture.dispose();
      host.remove();
    },
  };
}

const profiles = ['book', 'column'] as const;
test.each(profiles)(
  '%s: New draft resolves dirty work and retains one form beside the same selected editor',
  async (profile) => {
    const v = await mount(profile, 'dirty');
    const opens = spyOn(v.props.port, 'open');
    try {
      const editor = v.host.querySelector('.tiptap');
      const body = serializeDocument(v.controller.snapshot().selected!.body);
      const navigation = v.host.querySelector('.studio-context-navigation')!;
      expect(navigation.querySelector('.studio-new-draft, .studio-native-create, .tiptap')).toBeNull();
      expect(v.host.querySelector('.studio-new-draft')).toBeNull();
      await v.click(workbenchCopy.en.newDraft);
      expect(getByRole(v.host, 'region', { name: m.studio_workspace_switch_region() })).toBeTruthy();
      await v.click(m.studio_workspace_keep_editing());
      expect(v.host.querySelector('.tiptap')).toBe(editor);
      expect(serializeDocument(v.controller.snapshot().selected!.body)).toBe(body);
      await act(async () => {
        v.controller.snapshotPending();
        v.controller.uploadState(true);
      });
      await v.click(workbenchCopy.en.newDraft);
      expect(v.button(m.studio_workspace_save_switch()).disabled).toBe(true);
      expect(v.button(m.studio_workspace_discard_switch()).disabled).toBe(true);
      await v.click(m.studio_workspace_keep_editing());
      await act(async () => {
        v.controller.uploadState(false);
        v.controller.changeBody(v.controller.snapshot().selected!.body);
      });
      await v.click(workbenchCopy.en.newDraft);
      await v.click(m.studio_workspace_save_switch());
      const form = getByRole(v.host, 'form', { name: workbenchCopy.en.newDraft });
      expect(v.host.querySelectorAll('.studio-new-draft')).toHaveLength(1);
      expect(v.host.querySelector('.studio-document')?.hasAttribute('inert')).toBe(true);
      const title = getByRole(form, 'textbox', { name: m.studio_workspace_new_title() }) as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
          title,
          'One unsent title',
        );
        title.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await v.click(workbenchCopy.en.returnToDocument);
      expect(v.host.querySelector('.tiptap')).toBe(editor);
      expect(serializeDocument(v.controller.snapshot().selected!.body)).toBe(body);
      expect(queryByRole(v.host, 'form', { name: workbenchCopy.en.newDraft })).toBeNull();
      await v.click(m.studio_workspace_versions());
      await waitFor(() => expect(v.controller.snapshot().versions).not.toBeNull());
      const versions = v.controller.snapshot().versions;
      await v.click(workbenchCopy.en.newDraft);
      expect(getByRole(v.host, 'form', { name: workbenchCopy.en.newDraft })).toBe(form);
      expect(title.value).toBe('One unsent title');
      await v.click(workbenchCopy.en.returnToDocument);
      expect(getByRole(v.host, 'region', { name: m.studio_workspace_versions() })).toBeTruthy();
      expect(v.controller.snapshot().versions).toBe(versions);
      expect(opens).not.toHaveBeenCalled();
    } finally {
      opens.mockRestore();
      await v.close();
    }
  },
);

test.each([
  ['column', 'create'],
  ['book', 'organize'],
] as const)(
  '%s: Keep editing cancels %s entry even when the requested save acknowledges later',
  async (profile, destination) => {
    const v = await mount(profile, 'dirty');
    const original = v.props.port.saveDraft;
    let finish!: () => void;
    const response = new Promise<void>((resolve) => (finish = resolve));
    const save = spyOn(v.props.port, 'saveDraft').mockImplementation(async (...args) => {
      await response;
      return original(...args);
    });
    try {
      const editor = v.host.querySelector('.tiptap');
      await v.click(destination === 'create' ? workbenchCopy.en.newDraft : m.studio_book_add_heading());
      await v.click(m.studio_workspace_save_switch());
      await v.click(m.studio_workspace_keep_editing());
      await act(async () => finish());
      await waitFor(() => expect(v.controller.snapshot().operation).toBeNull());
      expect(v.host.querySelector('.studio-new-draft, .studio-organization-form')).toBeNull();
      expect(v.host.querySelector('.tiptap')).toBe(editor);
      expect(getByRole(v.host, 'textbox', { name: m.studio_workspace_title() })).toBeTruthy();
    } finally {
      finish();
      save.mockRestore();
      await v.close();
    }
  },
);

test('simple first-save replay keeps its original title and acknowledgement retains a newer unsent title', async () => {
  const v = await mount('column');
  const original = v.props.port.createDraft;
  const create = spyOn(v.props.port, 'createDraft')
    .mockResolvedValueOnce({ ok: false, error: { kind: 'uncertain', message: 'The response was lost.' } })
    .mockImplementation(original);
  try {
    await v.click(workbenchCopy.en.newDraft);
    const title = getByRole(v.host, 'textbox', { name: m.studio_workspace_new_title() }) as HTMLInputElement;
    const change = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(title, value);
        title.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    await change('Submitted title');
    await v.click(m.studio_workspace_create());
    await waitFor(() => expect(v.controller.snapshot().issue?.kind).toBe('uncertain'));
    await change('A newer unsent title');
    await v.click(workbenchCopy.en.returnToDocument);
    await v.click(workbenchCopy.en.newDraft);
    expect(title.value).toBe('A newer unsent title');
    await v.click(m.studio_workspace_retry());
    await waitFor(() => expect(v.controller.snapshot().result).toBe('created'));
    expect(create.mock.calls).toHaveLength(2);
    expect(create.mock.calls[1]![0]).toEqual(create.mock.calls[0]![0]);
    expect(v.controller.snapshot().selected!.title).toBe('Submitted title');
    expect(getByRole(v.host, 'textbox', { name: m.studio_workspace_new_title() })).toBe(title);
    expect(title.value).toBe('A newer unsent title');
  } finally {
    create.mockRestore();
    await v.close();
  }
});

test.each(profiles)(
  '%s: preview and history close preserve unsaved body, caret and real editor undo',
  async (profile) => {
    const matchMedia = window.matchMedia.bind(window);
    const pointer = spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...matchMedia(query),
      matches: query === '(pointer: coarse)',
    }));
    const v = await mount(profile);
    const versions = spyOn(v.props.port, 'versions');
    const revision = spyOn(v.props.port, 'revision');
    const saves = spyOn(v.props.port, 'saveDraft').mockResolvedValue({
      ok: false,
      error: { kind: 'stale', message: 'A supplied stale save leaves this working text unsaved.' },
    });
    try {
      const editor = v.host.querySelector<HTMLElement>('.tiptap')!;
      const initialText = editor.textContent;
      const saved = v.controller.snapshot().selected!.source.revision;
      await act(async () => {
        editor.focus();
        const selection = document.getSelection()!;
        selection.selectAllChildren(editor);
        selection.collapseToEnd();
        const clipboardData = new dom.window.DataTransfer();
        clipboardData.setData('text/html', '<p>Unsaved harbour observation.</p>');
        editor.dispatchEvent(
          new dom.window.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
        );
      });
      await waitFor(() => expect(v.controller.snapshot().selected!.snapshotPending).toBe(false));
      await act(async () => {
        await v.controller.save();
      });
      expect(editor.textContent).toContain('Unsaved harbour observation.');
      const working = serializeDocument(v.controller.snapshot().selected!.body);
      const text = Array.from(editor.querySelectorAll('p')).find((paragraph) =>
        paragraph.textContent?.includes('Unsaved harbour observation.'),
      )!.firstChild!;
      await act(async () => {
        editor.focus();
        document.getSelection()!.setBaseAndExtent(text, profile === 'book' ? 7 : 14, text, 7);
      });
      expect(versions).not.toHaveBeenCalled();
      expect(revision).not.toHaveBeenCalled();
      expect(queryByRole(v.host, 'button', { name: m.studio_workspace_write(), exact: true })).toBeNull();
      expect(v.button(m.studio_workspace_versions()).getAttribute('aria-expanded')).toBe('false');
      expect(v.host.querySelector('.studio-document-toolbar [aria-pressed]')).toBeNull();

      await v.click(m.studio_workspace_preview());
      expect(getByRole(v.host, 'region', { name: m.studio_workspace_preview_region() }).textContent).toContain(
        'Unsaved harbour observation.',
      );
      await v.click(m.studio_workspace_write());
      expect(v.host.querySelector('.tiptap')).toBe(editor);
      expect(document.activeElement).toBe(editor);
      expect(document.getSelection()!.anchorNode).toBe(text);
      expect(document.getSelection()!.anchorOffset).toBe(profile === 'book' ? 7 : 14);
      expect(document.getSelection()!.focusOffset).toBe(7);

      await v.click(m.studio_workspace_versions());
      await waitFor(() => expect(v.controller.snapshot().operation).toBeNull());
      expect(versions).toHaveBeenCalledTimes(1);
      expect(revision).not.toHaveBeenCalled();
      const list = v.host.querySelector<HTMLElement>('.studio-version-list')!;
      await act(async () => getAllByRole(list, 'button').at(-1)!.click());
      await waitFor(() => expect(v.controller.snapshot().historical).not.toBeNull());
      expect(revision).toHaveBeenCalledTimes(1);
      await v.click(m.studio_revision_use());
      expect(getByRole(v.host, 'group', { name: m.studio_revision_copy_review() })).toBeTruthy();
      expect(serializeDocument(v.controller.snapshot().selected!.body)).toBe(working);
      expect(v.controller.snapshot().selected!.source.revision).toBe(saved);
      await v.click(workbenchCopy.en.closeHistory);
      expect(v.host.querySelector('.tiptap')).toBe(editor);
      expect(document.activeElement).toBe(editor);
      expect(document.getSelection()!.anchorNode).toBe(text);
      expect(document.getSelection()!.anchorOffset).toBe(profile === 'book' ? 7 : 14);
      expect(document.getSelection()!.focusOffset).toBe(7);
      expect(editor.textContent).toContain('Unsaved harbour observation.');
      expect(serializeDocument(v.controller.snapshot().selected!.body)).toBe(working);

      await act(async () => v.button(m.editor_undo()).click());
      await waitFor(() => expect(editor.textContent).toBe(initialText));
      await act(async () => v.button(m.editor_redo()).click());
      await waitFor(() => expect(editor.textContent).toContain('Unsaved harbour observation.'));
      await waitFor(() => expect(v.controller.snapshot().selected!.snapshotPending).toBe(false));
      await v.click(m.studio_workspace_versions());
      expect(versions).toHaveBeenCalledTimes(1);
      expect(revision).toHaveBeenCalledTimes(1);
      expect(getByRole(v.host, 'group', { name: m.studio_revision_copy_review() })).toBeTruthy();
    } finally {
      versions.mockRestore();
      revision.mockRestore();
      saves.mockRestore();
      await v.close();
      pointer.mockRestore();
    }
  },
);

test.each(profiles)(
  '%s: one navigation contribution chooses drafts through keep, save and discard',
  async (profile) => {
    const v = await mount(profile, 'dirty');
    const opens = spyOn(v.props.port, 'open');
    const saves = spyOn(v.props.port, 'saveDraft');
    try {
      const navigation = v.host.querySelector<HTMLElement>('.studio-context-navigation')!;
      expect(v.host.querySelectorAll('.studio-context-navigation')).toHaveLength(1);
      expect(v.host.querySelector('.studio-document .studio-context-navigation')).toBeNull();
      expect(v.host.querySelector('.studio-sidebar, .studio-mobile-navigation')).toBeNull();
      const choose = async (name: string) => {
        expect(getAllByRole(navigation, 'button', { name, exact: true })).toHaveLength(1);
        await act(async () => {
          const control = getByRole(navigation, 'button', { name, exact: true });
          control.focus();
          control.click();
        });
      };
      const editor = v.host.querySelector('.tiptap');
      const working = serializeDocument(v.controller.snapshot().selected!.body);
      await choose(v.titles.second);
      expect(getByRole(v.host, 'region', { name: m.studio_workspace_switch_region() })).toBeTruthy();
      expect(opens).not.toHaveBeenCalled();
      await v.click(m.studio_workspace_keep_editing());
      expect(v.host.querySelector('.tiptap')).toBe(editor);
      expect(serializeDocument(v.controller.snapshot().selected!.body)).toBe(working);
      await choose(v.titles.second);
      await v.click(m.studio_workspace_save_switch());
      await waitFor(() => expect(v.controller.snapshot().selected!.title).toBe(v.titles.second));
      expect(saves).toHaveBeenCalledTimes(1);
      expect(opens).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(getByRole(v.host, 'heading', { name: v.titles.second, exact: true }));
      const secondBody = serializeDocument(v.controller.snapshot().selected!.body);
      await act(async () => v.controller.changeTitle('Local changes before switching'));
      await choose(v.titles.third);
      await v.click(m.studio_workspace_discard_switch());
      await waitFor(() => expect(v.controller.snapshot().selected!.title).toBe(v.titles.third));
      expect(saves).toHaveBeenCalledTimes(1);
      expect(opens).toHaveBeenCalledTimes(2);
      expect(serializeDocument(saves.mock.calls[0]![0].body)).toBe(working);
      expect(secondBody).not.toBe(working);
    } finally {
      opens.mockRestore();
      saves.mockRestore();
      await v.close();
    }
  },
);

test('closing loading history restores title selection and a late response cannot move focus or replace work', async () => {
  const v = await mount('column');
  const original = v.props.port.versions;
  let finish!: () => void;
  const response = new Promise<void>((resolve) => (finish = resolve));
  const versions = spyOn(v.props.port, 'versions').mockImplementation(async (...args) => {
    await response;
    return original(...args);
  });
  try {
    const title = getByRole(v.host, 'textbox', { name: m.studio_workspace_title() }) as HTMLInputElement;
    const body = v.controller.snapshot().selected!.body;
    await act(async () => {
      title.focus();
      title.setSelectionRange(2, 9, 'backward');
    });
    await v.click(m.studio_workspace_versions());
    expect(document.activeElement?.textContent).toBe(m.studio_revision_heading());
    await v.click(workbenchCopy.en.closeHistory);
    expect(document.activeElement).toBe(title);
    expect([title.selectionStart, title.selectionEnd, title.selectionDirection]).toEqual([2, 9, 'backward']);
    const outside = v.host.appendChild(document.createElement('button'));
    outside.textContent = 'Another deliberate focus destination';
    outside.focus();
    await act(async () => finish());
    await waitFor(() => expect(v.controller.snapshot().versions).not.toBeNull());
    expect(document.activeElement).toBe(outside);
    expect(v.controller.snapshot().selected!.body).toBe(body);
    await v.click(m.studio_workspace_versions());
    expect(versions).toHaveBeenCalledTimes(1);
    const history = getByRole(v.host, 'region', { name: m.studio_workspace_versions() });
    await act(async () => history.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(queryByRole(v.host, 'region', { name: m.studio_workspace_versions() })).toBeNull();
    expect(document.activeElement).toBe(title);
  } finally {
    finish();
    versions.mockRestore();
    await v.close();
  }
});

test('only a confirmed version copy replaces the editor and closing history retires its old caret', async () => {
  const v = await mount('book', 'comparison');
  try {
    const source = v.controller.snapshot().selected!.source.revision;
    const historical = v.controller.snapshot().historical!;
    await v.click(workbenchCopy.en.closeHistory);
    const oldEditor = v.host.querySelector<HTMLElement>('.tiptap')!;
    await act(async () => {
      oldEditor.focus();
      document.getSelection()!.selectAllChildren(oldEditor);
      document.getSelection()!.collapseToEnd();
    });
    await v.click(m.studio_workspace_versions());
    await v.click(m.studio_revision_use());
    expect(v.host.querySelector('.tiptap')).toBe(oldEditor);
    expect(v.controller.snapshot().selected!.source.revision).toBe(source);
    await v.click(m.studio_revision_copy());
    expect(v.controller.snapshot().selected!.body).toBe(historical.body);
    expect(v.controller.snapshot().selected!.dirty).toBe(true);
    expect(v.controller.snapshot().selected!.source.revision).toBe(source);
    await v.click(workbenchCopy.en.closeHistory);
    expect(v.host.querySelector('.tiptap')).not.toBe(oldEditor);
    expect(oldEditor.isConnected).toBe(false);
    expect(document.activeElement).toBe(getByRole(v.host, 'textbox', { name: m.studio_workspace_title() }));
    expect(queryByRole(v.host, 'group', { name: m.studio_revision_copy_review() })).toBeNull();
  } finally {
    await v.close();
  }
});

test('a file picker cannot become a text-caret return target', async () => {
  const v = await mount('column');
  try {
    const canvas = v.host.querySelector('.studio-writing-canvas')!;
    const file = canvas.appendChild(document.createElement('input'));
    file.type = 'file';
    file.setAttribute('aria-label', 'Supplied editor attachment picker');
    await act(async () => file.focus());
    await v.click(m.studio_workspace_preview());
    await v.click(m.studio_workspace_write());
    expect(document.activeElement).toBe(getByRole(v.host, 'textbox', { name: m.studio_workspace_title() }));
    expect(v.host.querySelector('.tiptap')).not.toBeNull();
  } finally {
    await v.close();
  }
});

test('Book organization stays central and retained, returns to the same caret, and reviews incompatible dirty switches', async () => {
  const v = await mount('book');
  const opens = spyOn(v.props.port, 'open');
  try {
    const title = getByRole(v.host, 'textbox', { name: m.studio_workspace_title() }) as HTMLInputElement;
    const editor = v.host.querySelector('.tiptap');
    title.focus();
    title.setSelectionRange(2, 6);
    const exact = v.controller.snapshot().selected!.source.revision.exact;
    await v.click(m.studio_book_add_heading());
    const form = getByRole(v.host, 'form', { name: m.studio_book_add_heading() });
    expect(v.host.querySelector('.studio-context-navigation')!.querySelector('form, input[type="text"]')).toBeNull();
    expect(v.host.querySelector('.studio-document')!.hasAttribute('inert')).toBe(true);
    const input = getByRole(form, 'textbox', { name: m.studio_book_placement_title() }) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'Unsent placement',
      );
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const user = userEvent.setup({ document });
    v.button(workbenchCopy.en.returnToDocument).focus();
    await act(async () => user.keyboard('{Enter}'));
    expect(document.activeElement).toBe(title);
    expect([title.selectionStart, title.selectionEnd]).toEqual([2, 6]);
    expect(v.host.querySelector('.studio-organization-canvas')!.hasAttribute('inert')).toBe(true);
    await v.click(m.studio_book_organize());
    expect(getByRole(v.host, 'form', { name: m.studio_book_add_heading() })).toBe(form);
    expect(input.value).toBe('Unsent placement');
    const outline = getByRole(v.host, 'region', { name: m.studio_book_outline_label() });
    const other = getByRole(outline, 'button', { name: v.titles.second, exact: true });
    await act(async () => other.click());
    expect(v.host.querySelector('.studio-organization-switch')).toBeTruthy();
    expect(opens).not.toHaveBeenCalled();
    await v.click(m.studio_workspace_keep_changes());
    expect(input.value).toBe('Unsent placement');
    expect(v.controller.snapshot().selected!.source.revision.exact).toEqual(exact);
    const entry = other.closest('.studio-toc-entry')!;
    entry.querySelector<HTMLDetailsElement>('details')!.open = true;
    await act(async () => getByRole(entry, 'button', { name: m.studio_book_move_to(), exact: true }).click());
    expect(v.host.querySelector('.studio-organization-switch')).toBeTruthy();
    await v.click(m.studio_workspace_discard_switch());
    expect(getByRole(v.host, 'form', { name: m.studio_book_move_to() })).toBeTruthy();
    await v.click(m.action_cancel());
    expect(v.host.querySelector('.tiptap')).toBe(editor);
    expect(v.controller.snapshot().selected!.source.revision.exact).toEqual(exact);
    expect(opens).not.toHaveBeenCalled();
  } finally {
    opens.mockRestore();
    await v.close();
  }
});

test('a pending Book organization draft remains reachable beside newer document work and late retry keeps both drafts', async () => {
  const v = await mount('book');
  const original = v.props.bookPort!.change;
  let finish!: () => void;
  const acknowledgement = new Promise<void>((resolve) => (finish = resolve));
  const change = spyOn(v.props.bookPort!, 'change')
    .mockResolvedValueOnce({ ok: false, error: { kind: 'uncertain', message: 'Response lost' } })
    .mockImplementation(async (...args) => {
      await acknowledgement;
      return original(...args);
    });
  try {
    const editor = v.host.querySelector('.tiptap');
    await v.click(m.studio_book_add_heading());
    const form = getByRole(v.host, 'form', { name: m.studio_book_add_heading() });
    const title = getByRole(form, 'textbox', { name: m.studio_book_placement_title() }) as HTMLInputElement;
    const type = (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(title, value);
        title.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    await type('Submitted placement');
    await v.click(m.studio_book_add_chapter());
    expect(v.controller.hasUnresolvedCommand()).toBe(true);
    await type('Newer placement');
    await v.click(workbenchCopy.en.returnToDocument);
    await act(async () => {
      v.controller.changeTitle('Newer document text');
      v.controller.snapshotPending();
    });
    await v.click(m.studio_book_organize());
    expect(getByRole(v.host, 'form', { name: m.studio_book_add_heading() })).toBe(form);
    expect(queryByRole(v.host, 'region', { name: m.studio_workspace_switch_region() })).toBeNull();
    await v.click(m.studio_workspace_retry());
    expect(change.mock.calls[1]![0]).toEqual(change.mock.calls[0]![0]);
    await act(async () => finish());
    await waitFor(() => expect(v.controller.snapshot().operation).toBeNull());
    expect(title.value).toBe('Newer placement');
    expect(v.controller.snapshot().selected!.title).toBe('Newer document text');
    expect(v.controller.snapshot().selected!.dirty).toBe(true);
    expect(v.host.querySelector('.tiptap')).toBe(editor);
  } finally {
    finish();
    change.mockRestore();
    await v.close();
  }
});
