import { afterAll, expect, spyOn, test } from 'bun:test';
import { act, createElement, useSyncExternalStore } from 'react';
import type { StudioState } from '../src/studio/controller';
import type { BookOrganizerPort, BookStructure, StudioPort } from '../src/studio/contract';
import { installPostReadingDom } from './post-reading-dom';
import { chooseSelect, selectOptions, selectTrigger } from './support/select';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { default: userEvent } = await import('@testing-library/user-event');
const { getByRole } = await import('@testing-library/dom');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const { fromPlainText } = await import('@rezics/document');
const { StudioController } = await import('../src/studio/controller');
const { BookOrganizer } = await import('../src/studio/book-organizer');
const { BookOrganizationCanvas, useBookOrganization } = await import('../src/studio/book-organization-canvas');

function OrganizationHarness({
  controller,
  state,
  onOpen = () => {},
  outlineVisible = true,
}: {
  controller: InstanceType<typeof StudioController>;
  state?: StudioState;
  onOpen?: (post: string) => void;
  outlineVisible?: boolean;
}) {
  const live = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const current = state ?? live;
  const organization = useBookOrganization(controller, current);
  return (
    <>
      {outlineVisible ? (
        <BookOrganizer controller={controller} state={current} onOpen={onOpen} onOrganize={organization.open} />
      ) : null}
      <BookOrganizationCanvas
        organization={organization}
        active
        disabled={Boolean(current.busy) || controller.hasUnresolvedCommand()}
        onCancel={organization.discard}
      />
    </>
  );
}

afterAll(() => dom.restore());

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
      root.render(createElement(OrganizationHarness, { controller, state, onOpen: () => {} }));
    });
  const user = userEvent.setup({ document });
  try {
    await render();
    await act(async () => user.click(getByRole(host, 'button', { name: 'Add part or chapter', exact: true })));
    const form = host.querySelector<HTMLFormElement>('.studio-placement-form')!;
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

test('Move to uses labelled exact destinations, retains failures and rechecks the current outline before one saved move', async () => {
  const exact = { postId: 'post', revisionId: 'pinned-revision', sha256: 'b'.repeat(64) };
  const part = (occurrenceId: string) => ({
    occurrenceId,
    parentOccurrenceId: null,
    title: 'Same title',
    target: { kind: 'part' as const },
  });
  const chapter = (occurrenceId: string, parentOccurrenceId: string) => ({
    occurrenceId,
    parentOccurrenceId,
    title: occurrenceId,
    target: { kind: 'chapter' as const, document: exact },
  });
  const structure: BookStructure = {
    catalogueId: 'book',
    revision: 'initial',
    canOrganize: true,
    limits: { maxDepth: 3, maxPlacements: 10 },
    placements: [
      part('origin'),
      chapter('source', 'origin'),
      part('distant'),
      chapter('anchor', 'distant'),
      part('empty'),
    ],
  };
  const moved: BookStructure = {
    ...structure,
    revision: 'moved',
    placements: [
      structure.placements[0]!,
      structure.placements[2]!,
      { ...structure.placements[1]!, parentOccurrenceId: 'distant' },
      ...structure.placements.slice(3),
    ],
  };
  const requests: Parameters<BookOrganizerPort['change']>[0][] = [];
  let fail = true;
  const controller = new StudioController(
    {
      visitKey: 'move',
      projectId: 'book',
      title: 'Book',
      profile: { kind: 'book', structure },
      documents: { items: [], nextCursor: null },
      publications: { items: [], nextCursor: null },
      canCreateDraft: true,
      canPublish: true,
    },
    port,
    {
      change: async (input) => {
        requests.push(input);
        return fail
          ? { ok: false, error: { kind: 'stale', message: 'Refresh the outline.' } }
          : { ok: true, value: moved };
      },
    },
  );
  const disconnect = controller.connect();
  controller.toggleOccurrence('source', true);
  const host = document.body.appendChild(document.createElement('main'));
  const root = createRoot(host);
  const render = async () =>
    act(async () =>
      root.render(createElement(OrganizationHarness, { controller, state: controller.snapshot(), onOpen: () => {} })),
    );
  const user = userEvent.setup({ document });
  try {
    await render();
    const entry = [...host.querySelectorAll('.studio-toc-entry')].find(
      (entry) => entry.querySelector('.studio-toc-open')?.textContent === 'source',
    )!;
    entry.querySelector<HTMLDetailsElement>('details')!.open = true;
    const buttons = [...entry.querySelectorAll<HTMLButtonElement>('button')];
    await act(async () => user.click(buttons.find((button) => button.textContent === 'Move to…')!));
    const form = host.querySelector<HTMLFormElement>('.studio-move-form')!;
    const parent = selectTrigger(form);
    const before = selectTrigger(form, 1);
    const parents = await selectOptions(parent);
    expect(parents.map((option) => option.dataset.value)).toEqual(['', 'distant', 'empty']);
    expect(parents[1]!.textContent).toContain('2 · Same title');
    expect(parents[2]!.textContent).toContain('3 · Same title');
    await chooseSelect(parent, 'distant');
    expect(before.textContent).toContain('End of list');
    expect((await selectOptions(before)).map((option) => option.dataset.value)).toEqual(['anchor', '']);
    await chooseSelect(before, 'anchor');
    expect(requests).toHaveLength(0);
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => user.click(submit));
    expect(host.querySelector('.studio-move-form')).toBe(form);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      expectedRevision: 'initial',
      change: { kind: 'move', occurrenceId: 'source', parentOccurrenceId: 'distant', beforeOccurrenceId: 'anchor' },
    });
    // The form's rendered options can lag the controller's current structure.
    const snapshot = controller.snapshot();
    const fresh = spyOn(controller, 'snapshot').mockReturnValue({
      ...snapshot,
      structure: {
        ...structure,
        revision: 'refreshed',
        placements: structure.placements.filter((placement) => placement.occurrenceId !== 'anchor'),
      },
    });
    await act(async () => user.click(submit));
    expect(requests).toHaveLength(1);
    fresh.mockRestore();
    await render();
    fail = false;
    await act(async () => user.click(submit));
    expect(requests).toHaveLength(2);
    expect(requests[1]!.change).toEqual(requests[0]!.change);
    expect(host.querySelector('.studio-move-form')).toBeNull();
    expect(controller.snapshot().structure!.revision).toBe('moved');
    expect(controller.snapshot().selectedOccurrences).toEqual(new Set(['source']));
    await render();
    expect(
      [...host.querySelectorAll('.studio-toc-entry')].find(
        (entry) => entry.querySelector('.studio-toc-open')?.textContent === 'source',
      )!.textContent,
    ).toContain('Pinned version: pinned-revision');
  } finally {
    await act(async () => root.unmount());
    disconnect();
    host.remove();
  }
});

test('current locale translates nested placement and removal names while authored titles and exact versions stay unchanged', async () => {
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const exact = { postId: 'post', revisionId: 'pinned-revision-α', sha256: 'c'.repeat(64) };
  const saved = { ...exact, revisionId: 'saved-revision-β', sha256: 'd'.repeat(64) };
  const partTitle = 'Part One / 作者 {title}';
  const nestedTitle = 'Nested unchanged';
  const chapterTitle = 'Chapter <raw> & 原稿';
  const draftTitle = 'Saved manuscript / 原文';
  const structure: BookStructure = {
    catalogueId: 'book-unchanged',
    revision: 'structure-unchanged',
    canOrganize: true,
    limits: { maxDepth: 4, maxPlacements: 10 },
    placements: [
      { occurrenceId: 'part', parentOccurrenceId: null, title: partTitle, target: { kind: 'part' } },
      { occurrenceId: 'nested', parentOccurrenceId: 'part', title: nestedTitle, target: { kind: 'part' } },
      {
        occurrenceId: 'chapter',
        parentOccurrenceId: 'nested',
        title: chapterTitle,
        target: { kind: 'chapter', document: exact },
      },
    ],
  };
  const controller = new StudioController(
    {
      visitKey: 'localized-placement',
      projectId: 'book',
      title: 'Book',
      profile: { kind: 'book', structure },
      documents: { items: [], nextCursor: null },
      publications: { items: [], nextCursor: null },
      canCreateDraft: true,
      canPublish: true,
      initialSelection: {
        revision: {
          exact: saved,
          title: draftTitle,
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
  const onOpen = spyOn({ open(_postId: string) {} }, 'open');
  const host = document.body.appendChild(document.createElement('main'));
  const root = createRoot(host);
  const render = () =>
    act(async () =>
      root.render(createElement(OrganizationHarness, { controller, state: controller.snapshot(), onOpen })),
    );
  const user = userEvent.setup({ document });
  try {
    await render();
    expect(getByRole(host, 'region', { name: 'Book table of contents' })).toBeTruthy();
    await act(async () => user.click(getByRole(host, 'button', { name: 'Add part or chapter', exact: true })));
    const form = host.querySelector<HTMLFormElement>('.studio-placement-form')!;
    const input = getByRole(form, 'textbox', { name: 'Placement title' }) as HTMLInputElement;
    await act(async () => user.type(input, 'New chapter / 原稿'));
    const chapter = [...host.querySelectorAll<HTMLElement>('.studio-toc-entry')].find(
      (entry) => entry.querySelector('.studio-toc-open')?.textContent === chapterTitle,
    )!;
    chapter.querySelector<HTMLDetailsElement>('details')!.open = true;
    setLocale('ja', { reload: false });
    await render();
    expect(getByRole(host, 'region', { name: 'ブックの目次' })).toBeTruthy();
    expect(getByRole(host, 'heading', { name: '目次' })).toBeTruthy();
    expect(host.textContent).toContain('3 / 10');
    expect(host.textContent).toContain('1 章中 0 章を選択');
    expect(getByRole(form, 'heading').textContent).toBe('部または章を追加');
    expect(getByRole(form, 'textbox', { name: '配置タイトル' })).toBe(input);
    expect(input.value).toBe('New chapter / 原稿');
    const kind = getByRole(form, 'combobox', { name: '追加' }) as HTMLButtonElement;
    const parent = getByRole(form, 'combobox', { name: '配置先' }) as HTMLButtonElement;
    expect(kind.textContent).toContain('保存済み文書を章として追加');
    expect(parent.textContent).toContain('本の最上位');
    expect(document.getElementById(kind.getAttribute('aria-describedby')!)!.textContent).toBe(
      `選択中の文書：${draftTitle}。配置する前にすべての変更を保存してください。`,
    );
    expect((await selectOptions(parent)).map((option) => option.textContent)).toContain(`— ${nestedTitle}`);
    await chooseSelect(parent, 'nested');
    await act(async () => user.click(getByRole(form, 'button', { name: '章を追加', exact: true })));
    expect(organize).toHaveBeenLastCalledWith({
      kind: 'insert',
      parentOccurrenceId: 'nested',
      beforeOccurrenceId: null,
      title: 'New chapter / 原稿',
      target: { kind: 'chapter', document: saved },
    });
    await chooseSelect(kind, 'part');
    expect(kind.textContent).toContain('部');
    expect(getByRole(form, 'button', { name: '部を追加', exact: true })).toBeTruthy();
    expect(chapter.querySelector('summary')!.getAttribute('aria-label')).toBe(`「${chapterTitle}」を整理`);
    for (const name of ['上へ移動', '下へ移動', '一階層下げる', '一階層上げる'])
      expect(getByRole(chapter, 'button', { name: `「${chapterTitle}」を${name}`, exact: true }).textContent).toBe(
        name,
      );
    expect(chapter.textContent).toContain(`固定バージョン：${exact.revisionId}`);
    await act(async () => user.click(getByRole(chapter, 'button', { name: chapterTitle, exact: true })));
    expect(onOpen).toHaveBeenCalledWith(exact.postId);
    await act(async () => user.click(getByRole(chapter, 'button', { name: '保存済みバージョンを使用', exact: true })));
    expect(organize).toHaveBeenLastCalledWith({ kind: 'pin', occurrenceId: 'chapter', document: saved });
    await act(async () =>
      user.click(getByRole(chapter, 'button', { name: `「${chapterTitle}」を一階層上げる`, exact: true })),
    );
    expect(organize).toHaveBeenLastCalledWith({
      kind: 'move',
      occurrenceId: 'chapter',
      parentOccurrenceId: 'part',
      beforeOccurrenceId: null,
    });
    await act(async () => user.click(getByRole(chapter, 'button', { name: '名前を変更', exact: true })));
    const renameForm = host.querySelector<HTMLFormElement>('.studio-organization-form')!;
    const rename = getByRole(renameForm, 'textbox', { name: '配置タイトル' }) as HTMLInputElement;
    expect(rename.value).toBe(chapterTitle);
    await act(async () => user.clear(rename));
    await act(async () => user.type(rename, 'Renamed / 改稿'));
    await act(async () => user.click(getByRole(renameForm, 'button', { name: '名前を変更', exact: true })));
    expect(organize).toHaveBeenLastCalledWith({ kind: 'rename', occurrenceId: 'chapter', title: 'Renamed / 改稿' });
    const callsBeforeRemoval = organize.mock.calls.length;
    await act(async () => user.click(getByRole(chapter, 'button', { name: '削除…', exact: true })));
    const leafConfirmation = getByRole(host, 'group', { name: `「${chapterTitle}」を削除`, exact: true });
    expect(leafConfirmation.textContent).toContain('この配置を削除しますか？文書と過去の公開版は保持されます。');
    await act(async () =>
      user.click(getByRole(leafConfirmation.closest('form')!, 'button', { name: '配置を保持', exact: true })),
    );
    expect(organize.mock.calls).toHaveLength(callsBeforeRemoval);
    const part = host.querySelector<HTMLElement>('.studio-toc-entry')!;
    part.querySelector<HTMLDetailsElement>('details')!.open = true;
    await act(async () => user.click(getByRole(part, 'button', { name: '削除…', exact: true })));
    const confirmation = getByRole(host, 'group', { name: `「${partTitle}」を削除`, exact: true });
    expect(confirmation.textContent).toContain(
      'この配置とその配下の配置を削除しますか？文書と過去の公開版は保持されます。',
    );
    expect(organize.mock.calls).toHaveLength(callsBeforeRemoval);
    await act(async () =>
      user.click(getByRole(confirmation.closest('form')!, 'button', { name: '配置を削除', exact: true })),
    );
    expect(organize).toHaveBeenLastCalledWith({ kind: 'remove', occurrenceId: 'part' });
    expect(host.querySelector('.studio-part-title')!.textContent).toBe(partTitle);
    expect(chapter.querySelector('.studio-toc-open')!.textContent).toBe(chapterTitle);
    expect(host.querySelector('.studio-technical summary')!.textContent).toBe('構成のバージョン');
    expect([...host.querySelectorAll('.studio-technical dt')].map((label) => label.textContent)).toEqual([
      'カタログ',
      '版',
    ]);
    expect([...host.querySelectorAll('.studio-technical dd')].map((value) => value.textContent)).toEqual([
      'book-unchanged',
      'structure-unchanged',
    ]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    organize.mockRestore();
    onOpen.mockRestore();
    setLocale(previousLocale, { reload: false });
  }
});

test('navigation dismissal retains a pending organization form and exact unknown retry cannot erase newer values', async () => {
  setLocale('en', { reload: false });
  const structure: BookStructure = {
    catalogueId: 'book',
    revision: 'before',
    canOrganize: true,
    limits: { maxDepth: 3, maxPlacements: 10 },
    placements: [{ occurrenceId: 'part', parentOccurrenceId: null, title: 'Original', target: { kind: 'part' } }],
  };
  const requests: Parameters<BookOrganizerPort['change']>[0][] = [];
  let finish!: () => void;
  const acknowledgement = new Promise<void>((resolve) => (finish = resolve));
  const controller = new StudioController(
    {
      visitKey: 'retained-organization',
      projectId: 'book',
      title: 'Book',
      profile: { kind: 'book', structure },
      documents: { items: [], nextCursor: null },
      publications: { items: [], nextCursor: null },
      canCreateDraft: true,
      canPublish: true,
    },
    port,
    {
      change: async (input) => {
        requests.push(input);
        if (requests.length === 1) return { ok: false, error: { kind: 'uncertain', message: 'Response lost' } };
        await acknowledgement;
        return {
          ok: true,
          value: { ...structure, revision: 'after', placements: [{ ...structure.placements[0]!, title: 'Submitted' }] },
        };
      },
    },
  );
  const disconnect = controller.connect();
  const host = document.body.appendChild(document.createElement('main'));
  const root = createRoot(host);
  const user = userEvent.setup({ document });
  const render = (outlineVisible = true) =>
    act(async () => root.render(<OrganizationHarness controller={controller} outlineVisible={outlineVisible} />));
  try {
    await render();
    host.querySelector<HTMLDetailsElement>('.studio-toc-actions')!.open = true;
    await act(async () => user.click(getByRole(host, 'button', { name: 'Rename', exact: true })));
    const form = getByRole(host, 'form', { name: 'Rename', exact: true });
    const title = getByRole(form, 'textbox', { name: 'Placement title' }) as HTMLInputElement;
    await act(async () => user.clear(title));
    await act(async () => user.type(title, 'Submitted'));
    await act(async () => user.click(getByRole(form, 'button', { name: 'Rename', exact: true })));
    expect(controller.hasUnresolvedCommand()).toBe(true);
    await render(false);
    expect(host.querySelector('.studio-toc')).toBeNull();
    expect(getByRole(host, 'form', { name: 'Rename', exact: true })).toBe(form);
    await act(async () => user.clear(title));
    await act(async () => user.type(title, 'Newer local title'));
    let replay!: ReturnType<typeof controller.retry>;
    await act(async () => {
      replay = controller.retry();
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]!.change).toEqual({ kind: 'rename', occurrenceId: 'part', title: 'Submitted' });
    await act(async () => {
      finish();
      await replay;
    });
    expect(title.value).toBe('Newer local title');
    expect(getByRole(form, 'button', { name: 'Rename', exact: true }).hasAttribute('disabled')).toBe(false);
    await render();
    expect(host.querySelector('.studio-part-title')!.textContent).toBe('Submitted');
    expect(title.value).toBe('Newer local title');
  } finally {
    finish();
    await act(async () => root.unmount());
    disconnect();
    host.remove();
  }
});

test('add, rename and remove recheck current identities without resetting retained fields on structure replacement', async () => {
  const structure: BookStructure = {
    catalogueId: 'book',
    revision: 'before',
    canOrganize: true,
    limits: { maxDepth: 3, maxPlacements: 10 },
    placements: [{ occurrenceId: 'part', parentOccurrenceId: null, title: 'Part', target: { kind: 'part' } }],
  };
  const controller = new StudioController(
    {
      visitKey: 'current-organization',
      projectId: 'book',
      title: 'Book',
      profile: { kind: 'book', structure },
      documents: { items: [], nextCursor: null },
      publications: { items: [], nextCursor: null },
      canCreateDraft: true,
      canPublish: true,
    },
    port,
    { change: unavailable },
  );
  const organize = spyOn(controller, 'organize').mockResolvedValue(false);
  const snapshot = controller.snapshot();
  const fresh = spyOn(controller, 'snapshot').mockReturnValue(snapshot);
  const host = document.body.appendChild(document.createElement('main'));
  const root = createRoot(host);
  const user = userEvent.setup({ document });
  const render = (state = snapshot) =>
    act(async () => root.render(<OrganizationHarness controller={controller} state={state} />));
  const removed = { ...snapshot, structure: { ...structure, revision: 'after', placements: [] } };
  try {
    await render();
    await act(async () => user.click(getByRole(host, 'button', { name: 'Add part or chapter', exact: true })));
    const form = host.querySelector<HTMLFormElement>('.studio-placement-form')!;
    await chooseSelect(selectTrigger(form), 'part');
    await chooseSelect(selectTrigger(form, 1), 'part');
    const title = getByRole(form, 'textbox', { name: 'Placement title' }) as HTMLInputElement;
    await act(async () => user.type(title, 'Retained part'));
    fresh.mockReturnValue(removed);
    await act(async () => user.click(getByRole(form, 'button', { name: 'Add part', exact: true })));
    expect(organize).not.toHaveBeenCalled();
    await render(removed);
    expect(title.value).toBe('Retained part');
    expect((getByRole(form, 'button', { name: 'Add part' }) as HTMLButtonElement).disabled).toBe(true);
    fresh.mockReturnValue(snapshot);
    await render();
    await act(async () => user.click(getByRole(form, 'button', { name: 'Cancel', exact: true })));
    for (const action of ['Rename', 'Remove…']) {
      host.querySelector<HTMLDetailsElement>('.studio-toc-actions')!.open = true;
      await act(async () => user.click(getByRole(host, 'button', { name: action, exact: true })));
      const currentForm = host.querySelector<HTMLFormElement>('.studio-organization-form')!;
      if (action === 'Rename') {
        await act(async () => user.type(getByRole(currentForm, 'textbox', { name: 'Placement title' }), ' changed'));
      }
      fresh.mockReturnValue(removed);
      await act(async () => user.click(currentForm.querySelector<HTMLButtonElement>('button[type="submit"]')!));
      expect(organize).not.toHaveBeenCalled();
      fresh.mockReturnValue(snapshot);
      await act(async () =>
        user.click(
          getByRole(currentForm, 'button', { name: action === 'Rename' ? 'Cancel' : 'Keep placement', exact: true }),
        ),
      );
    }
  } finally {
    await act(async () => root.unmount());
    organize.mockRestore();
    fresh.mockRestore();
    host.remove();
  }
});
