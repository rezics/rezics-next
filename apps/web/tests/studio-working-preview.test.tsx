import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { act } from 'react';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, queryByRole, waitFor } = await import('@testing-library/dom');
const { serializeDocument } = await import('@rezics/document');
const { StudioWorkbench } = await import('../src/studio/workspace');
const { studioWorkbenchFixture, studioWorkingPreviewBody } = await import('../src/kernel/fake/studio-workbench');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
afterAll(async () => {
  setLocale('en', { reload: false });
  await dom.restore();
});
const button = (root: HTMLElement, name: string) =>
  getByRole(root, 'button', { name, exact: true }) as HTMLButtonElement;
async function click(root: HTMLElement, name: string) {
  await act(async () => button(root, name).click());
}
async function finishClose(dialog: HTMLElement) {
  await act(async () => dialog.dispatchEvent(new window.Event('transitionend', { bubbles: true })));
  await waitFor(() => expect(queryByRole(document.body, 'dialog')).toBeNull());
}
async function mount(profile: 'book' | 'column' = 'book', missing = false) {
  setLocale('en', { reload: false });
  const fixture = await studioWorkbenchFixture(profile, missing ? 'working-preview-missing' : 'working-preview', 'en');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(async () => root.render(<StudioWorkbench {...fixture.props} controller={fixture.controller} />));
  await render();
  return {
    ...fixture,
    host,
    render,
    preview: () => getByRole(host, 'region', { name: m.studio_workspace_preview_region(), exact: true }),
    close: async () => {
      await act(async () => root.unmount());
      fixture.dispose();
      host.remove();
    },
  };
}

test.each(['book', 'column'] as const)(
  '%s working preview reads structured unsaved content and preserves the editor owner',
  async (profile) => {
    const v = await mount(profile);
    const reader = mock(v.props.presentation!.reader!);
    v.props.presentation = { reader };
    await v.render();
    const opens = spyOn(v.props.port, 'open');
    try {
      const editor = v.host.querySelector('.tiptap');
      const saved = v.controller.snapshot().selected!.source.revision;
      const working = studioWorkingPreviewBody(true, true);
      await act(async () => v.controller.changeBody(working));
      await click(v.host, m.studio_workspace_preview());
      const preview = v.preview();
      expect(getByRole(preview, 'heading', { name: 'Harbour observations' })).toBeTruthy();
      expect(button(preview, m.post_sections_title())).toBeTruthy();
      expect(preview.textContent).toContain('A new observation still in the working draft.');
      expect(preview.textContent).not.toContain('The notebook opens beside the harbour wall.');
      expect(preview.querySelector('ul li')?.textContent).toBe('Watch the tide');
      expect(preview.querySelector('blockquote')?.textContent).toBe('The harbour is a place of small returns.');
      expect(preview.querySelector('th[scope="col"]')?.textContent).toBe('Station');
      expect(getByRole(preview, 'link', { name: 'field source' }).getAttribute('href')).toContain('edition=1#notes');
      expect(getByRole(preview, 'link', { name: '@harbour-keeper' })).toBeTruthy();
      expect(preview.querySelector('[data-slot="document-footnotes"] details')?.hasAttribute('open')).toBe(false);
      expect(preview.querySelector('img, video, iframe')).toBeNull();
      expect(preview.textContent).toContain(m.content_edition_image_unavailable());
      expect(preview.textContent).toContain(m.studio_workspace_preview_unsaved());
      expect(preview.textContent).not.toContain(m.studio_workspace_preview_saved());
      const provenance = getByRole(preview, 'group', { name: m.studio_revision_current() });
      expect(provenance.textContent).toContain(saved.exact.revisionId);
      expect(provenance.textContent).toContain(saved.exact.sha256);
      expect(provenance.querySelector('time')?.getAttribute('datetime')).toBe(saved.savedAt);
      expect(reader.mock.calls.at(-1)?.[0]).toBe(saved.exact);
      await act(async () => v.controller.uploadState(true));
      await click(v.host, m.studio_workspace_write());
      expect(v.host.querySelector('.tiptap')).toBe(editor);
      expect(v.controller.snapshot().selected).toMatchObject({ body: working, dirty: true, uploading: true });
      expect(opens).not.toHaveBeenCalled();
    } finally {
      opens.mockRestore();
      await v.close();
    }
  },
);

test('wide and reference inspection recover to the working reader, and Write starts a fresh disclosure visit', async () => {
  const v = await mount('column');
  try {
    const originalAddress = window.location.href;
    await click(v.host, m.studio_workspace_preview());
    const preview = v.preview();
    await click(preview, m.thread_reveal_spoiler());
    const inspection = button(preview, m.wide_document_code_inspect());
    inspection.focus();
    await act(async () => inspection.click());
    let dialog = getByRole(document.body, 'dialog');
    await click(dialog, m.wide_document_code_wrap());
    expect(dialog.querySelector('code')?.textContent).toContain('const readings');
    await click(dialog, m.wide_document_inspector_close());
    await finishClose(dialog);
    expect(document.activeElement).toBe(inspection);
    await click(preview, m.wide_document_table_inspect());
    dialog = getByRole(document.body, 'dialog');
    expect(getByRole(dialog, 'cell', { name: 'East harbour' })).toBeTruthy();
    await click(dialog, m.wide_document_inspector_close());
    await finishClose(dialog);
    await click(preview, m.post_references_title());
    dialog = getByRole(document.body, 'dialog');
    await click(dialog, m.post_references_entry({ number: 1, label: 'field source' }));
    expect((getByRole(dialog, 'textbox', { name: m.post_references_destination() }) as HTMLTextAreaElement).value).toBe(
      'https://example.org/harbour?edition=1#notes',
    );
    await click(dialog, m.post_references_return());
    await finishClose(dialog);
    expect(document.activeElement).toBe(getByRole(preview, 'link', { name: 'field source' }));
    expect(window.location.href).toBe(originalAddress);
    await click(v.host, m.studio_workspace_write());
    await click(v.host, m.studio_workspace_preview());
    expect(v.preview().querySelector('.document-spoiler-revealed')).toBeNull();
    expect(queryByRole(document.body, 'dialog')).toBeNull();
  } finally {
    await v.close();
  }
});

test('pending and invalid snapshots withhold stale content, then a valid body resumes the preview', async () => {
  const v = await mount();
  try {
    await click(v.host, m.studio_workspace_preview());
    for (const fail of [false, true]) {
      await act(async () => (fail ? v.controller.snapshotError() : v.controller.snapshotPending()));
      expect(v.preview().querySelector('[data-slot="post-reading-body"]')).toBeNull();
      expect(v.preview().textContent).toContain(
        fail ? m.studio_workspace_snapshot_error() : m.studio_workspace_snapshot_pending(),
      );
    }
    await act(async () => v.controller.changeBody(studioWorkingPreviewBody(false, true)));
    expect(v.preview().textContent).toContain('A new observation still in the working draft.');
    expect(queryByRole(v.preview(), 'button', { name: m.post_references_title(), exact: true })).toBeNull();
    expect(v.preview().querySelector('img')).toBeNull();
    expect(v.preview().textContent).toContain(m.content_edition_image_unavailable());
  } finally {
    await v.close();
  }
});

test('missing operands remain absent and supplied media and disclosure labels pass through without a lookup', async () => {
  const v = await mount('column', true);
  try {
    await click(v.host, m.studio_workspace_preview());
    expect(queryByRole(v.preview(), 'button', { name: m.post_references_title(), exact: true })).toBeNull();
    expect(v.preview().textContent).toContain(m.content_edition_image_unavailable());
    v.props.presentation = {
      reader: () => ({
        labels: { revealSpoiler: 'Supplied disclosure label' },
        renderImage: ({ alt }) => <span>Supplied media: {alt}</span>,
      }),
    };
    await v.render();
    expect(v.preview().textContent).toContain('Supplied media: Harbour notebook illustration');
    expect(button(v.preview(), 'Supplied disclosure label')).toBeTruthy();
    expect(v.preview().querySelector('img')).toBeNull();
  } finally {
    await v.close();
  }
});

test.each(['body', 'reload', 'post', 'save', 'locale', 'source', 'write'] as const)(
  '%s replacement retires wide inspection and late clipboard effects; same-document autosave preserves the editor',
  async (replacement) => {
    const v = await mount();
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    let finishCopy!: () => void;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((resolve) => {
            finishCopy = resolve;
          }),
      },
    });
    const outside = document.createElement('button');
    document.body.append(outside);
    try {
      const editor = v.host.querySelector('.tiptap');
      const before = v.controller.snapshot().selected!;
      await click(v.host, m.studio_workspace_preview());
      await click(v.preview(), m.thread_reveal_spoiler());
      await click(v.preview(), m.wide_document_code_inspect());
      const dialog = getByRole(document.body, 'dialog');
      if (replacement === 'save') {
        await act(async () => v.controller.changeTitle('Working title'));
        expect(getByRole(document.body, 'dialog')).toBe(dialog);
      }
      await click(dialog, m.wide_document_code_copy());
      await act(async () => {
        switch (replacement) {
          case 'body':
            v.controller.changeBody(studioWorkingPreviewBody(true, true));
            break;
          case 'reload':
            await v.controller.open(before.source.revision.exact.postId);
            break;
          case 'post':
            await v.controller.open(v.props.input.documents.items[2]!.postId);
            break;
          case 'save':
            await waitFor(() => expect(v.controller.snapshot().selected!.dirty).toBe(false), { timeout: 3000 });
            break;
          case 'locale':
            setLocale('ja', { reload: false });
            break;
          case 'source':
            v.props.port.isCurrent = () => false;
            break;
          case 'write':
            button(v.host, m.studio_workspace_write()).click();
            break;
        }
      });
      await v.render();
      await waitFor(() => expect(queryByRole(document.body, 'dialog')).toBeNull());
      outside.focus();
      await act(async () => finishCopy());
      expect(document.activeElement).toBe(outside);
      expect(v.host.textContent).not.toContain(m.wide_document_code_copied());
      expect(v.host.querySelector('.document-spoiler-revealed')).toBeNull();
      if (replacement === 'save') {
        const after = v.controller.snapshot().selected!;
        expect(after.dirty).toBe(false);
        expect(after.editorGeneration).toBe(before.editorGeneration);
        expect(after.source.revision.exact.revisionId).not.toBe(before.source.revision.exact.revisionId);
        expect(serializeDocument(after.body)).toBe(serializeDocument(before.body));
        expect(v.preview().textContent).toContain(m.studio_workspace_preview_saved());
        expect(v.preview().textContent).toContain(after.source.revision.exact.revisionId);
        await click(v.host, m.studio_workspace_write());
        expect(v.host.querySelector('.tiptap')).toBe(editor);
      }
      if (replacement === 'reload') {
        expect(serializeDocument(v.controller.snapshot().selected!.body)).toBe(serializeDocument(before.body));
        await click(v.host, m.studio_workspace_preview());
        expect(v.preview().querySelector('.document-spoiler-revealed')).toBeNull();
      }
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
      outside.remove();
      await v.close();
      setLocale('en', { reload: false });
    }
  },
);
