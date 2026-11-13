import { afterAll, expect, spyOn, test } from 'bun:test';
import { act, createElement } from 'react';
import type { BookStructure, StudioPort } from '../src/studio/contract';
import { installPostReadingDom } from './post-reading-dom';
import { chooseSelect, selectOptions, selectTrigger } from './support/select';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { default: userEvent } = await import('@testing-library/user-event');
const { fromPlainText } = await import('@rezics/document');
const { StudioController } = await import('../src/studio/controller');
const { BookOrganizer } = await import('../src/studio/book-organizer');
afterAll(() => dom.restore());

test('placement Selects retain labels, exact parents, root and saved-document eligibility', async () => {
  const exact = { postId: 'post', revisionId: 'saved-revision', sha256: 'a'.repeat(64) };
  const part = (occurrenceId: string, parentOccurrenceId: string | null = null) => ({
    occurrenceId,
    parentOccurrenceId,
    title: 'Same title',
    target: { kind: 'part' as const },
  });
  const structure: BookStructure = {
    catalogueId: 'book',
    revision: 'structure',
    canOrganize: true,
    limits: { maxDepth: 2, maxPlacements: 10 },
    placements: [
      part('first'),
      part('second'),
      part('too-deep', 'first'),
      {
        occurrenceId: 'chapter',
        parentOccurrenceId: null,
        title: 'Chapter',
        target: { kind: 'chapter', document: exact },
      },
    ],
  };
  const unavailable = async () => ({ ok: false as const, error: { kind: 'unavailable' as const, message: 'Unused' } });
  const port: StudioPort = {
    isCurrent: () => true,
    documents: unavailable,
    open: unavailable,
    createDraft: unavailable,
    saveDraft: unavailable,
    versions: unavailable,
    revision: unavailable,
    reviewPublication: unavailable,
    publish: unavailable,
    publications: unavailable,
  };
  const controller = new StudioController(
    {
      visitKey: 'placement',
      projectId: 'book',
      title: 'Book',
      profile: { kind: 'book', structure },
      documents: { items: [], nextCursor: null },
      publications: { items: [], nextCursor: null },
      canCreateDraft: true,
      canPublish: true,
      initialSelection: {
        revision: {
          exact,
          title: 'Saved document',
          body: fromPlainText('Saved', 'blocks'),
          mediaIds: [],
          savedAt: '2026-11-13T00:00:00Z',
        },
        permissions: { edit: true, publish: true },
      },
    },
    port,
    { change: unavailable },
  );
  const organize = spyOn(controller, 'organize').mockResolvedValue(true);
  const host = document.body.appendChild(document.createElement('main'));
  const root = createRoot(host);
  const initial = controller.snapshot();
  const render = async (state = initial) =>
    act(async () => {
      root.render(createElement(BookOrganizer, { controller, state, onOpen: () => {} }));
    });
  const user = userEvent.setup({ document });
  try {
    await render();
    host.querySelector<HTMLDetailsElement>('.studio-placement-form')!.open = true;
    const form = host.querySelector<HTMLFormElement>('.studio-placement-form form')!;
    const kind = selectTrigger(form);
    const parent = selectTrigger(form, 1);
    expect(form.querySelector('select')).toBeNull();
    expect([...form.querySelectorAll('label')].map((label) => label.htmlFor)).toContain(kind.id);
    expect([...form.querySelectorAll('label')].map((label) => label.htmlFor)).toContain(parent.id);
    expect(kind.textContent).toContain('Saved document as chapter');
    expect(parent.textContent).toContain('Book root');
    expect(document.getElementById(kind.getAttribute('aria-describedby')!)!.textContent).toContain('Saved document');
    expect((await selectOptions(parent)).map((option) => option.dataset.value)).toEqual(['', 'first', 'second']);
    await chooseSelect(parent, 'second');
    expect(parent.textContent).toContain('Same title');
    await act(async () => user.type(form.querySelector('input:not([type="hidden"])')!, 'Placed'));
    await act(async () => user.click(kind));
    await act(async () => user.keyboard('{Escape}'));
    expect(kind.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(kind);
    expect(organize).not.toHaveBeenCalled();
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => user.click(submit));
    expect(organize).toHaveBeenLastCalledWith({
      kind: 'insert',
      parentOccurrenceId: 'second',
      beforeOccurrenceId: null,
      title: 'Placed',
      target: { kind: 'chapter', document: exact },
    });
    await chooseSelect(parent, '');
    expect(parent.textContent).toContain('Book root');
    await chooseSelect(kind, 'part');
    expect(kind.textContent).toContain('Part');
    await act(async () => user.type(form.querySelector('input:not([type="hidden"])')!, 'Root part'));
    await act(async () => user.click(submit));
    expect(organize).toHaveBeenLastCalledWith({
      kind: 'insert',
      parentOccurrenceId: null,
      beforeOccurrenceId: null,
      title: 'Root part',
      target: { kind: 'part' },
    });
    await chooseSelect(kind, 'chapter');
    await act(async () => user.type(form.querySelector('input:not([type="hidden"])')!, 'Next'));
    for (const flag of ['dirty', 'snapshotPending', 'invalid', 'uploading'] as const) {
      await render({ ...initial, selected: { ...initial.selected!, [flag]: true } });
      expect(submit.disabled).toBe(true);
    }
    await render({ ...initial, selected: null });
    expect(submit.disabled).toBe(true);
    await render({ ...initial, busy: 'organize' });
    expect(kind.disabled).toBe(true);
    expect(parent.disabled).toBe(true);
    expect(organize).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    organize.mockRestore();
  }
});
