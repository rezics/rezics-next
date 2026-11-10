import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { createStoryFetch } from '../../.storybook/cloudflare-workers';
import { createStoryRecordedKernelFetch } from '../kernel/fake';
import { setCollectionStoryMode } from '../kernel/fake/collection-page-stories';
import collection from '../kernel/recorded/library-collection.json';
import recorded from '../kernel/recorded/library-collection-members.json';
import { CollectionPage } from '../library/collection-page';
import { collectionPageQuery, readCollectionPage } from '../library/collection-queries';
import { m } from '../paraglide/messages.js';
import { PatternStory, pagePaths } from './page';

// There is no recorded add-occurrence response. These opt-in native-shaped HTTP outcomes
// exercise the actual owner page/form/BFF, rather than claiming a read-only PageStory wrote.
const id = collection.collection.id;
const original = recorded.members[0]!;
const title = `Selected subject 0 — ${'A long reading title 閱讀 読書 '.repeat(10)}${'界'.repeat(180)}`;
const note = `  Exact occurrence note 0\n\t${'界'.repeat(19_960)}\n `;
type Outcome = 'accepted' | 'refused' | 'uncertain' | 'lost' | 'reload' | 'pending';
type Command = { subjectId: string; note?: string };
type Fixture = {
  calls: string[];
  posts: { body: Command; key: string | null; authorization: string | null }[];
  reloads: number;
  release: () => void;
};
let fixture: Fixture;

function suppliedOutcomes(outcome: Outcome) {
  setCollectionStoryMode('private', true);
  const previous = globalThis.fetch;
  const recordedFetch = createStoryRecordedKernelFetch();
  let accepted = false;
  let failedReload = false;
  let created: typeof original | undefined;
  let release = () => {};
  fixture = { calls: [], posts: [], reloads: 0, release: () => release() };
  const current = fixture;
  const kernel = (async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    current.calls.push(`${request.method} ${path}`);
    if (path === `/v1/collections/${id}/members` && request.method === 'POST') {
      const body = (await request.json()) as Command;
      const key = request.headers.get('idempotency-key');
      current.posts.push({ body, key, authorization: request.headers.get('authorization') });
      if (outcome === 'pending')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (current.posts.length === 1) {
        if (outcome === 'refused') return Response.json({ code: 'collection_full' }, { status: 409 });
        if (outcome === 'uncertain') return Response.json({ code: 'unavailable' }, { status: 503 });
        if (outcome === 'lost') throw new Error('Supplied lost response');
      }
      // One supplied occurrence per key, including a subject already in the recorded Collection.
      if (!accepted)
        created = {
          ...original,
          id: '01a17a3b-6ea0-7370-82d5-f4ccb3199f99',
          subjectId: body.subjectId,
          note: body.note ?? null,
          subject: { ...original.subject, label: { value: title, language: 'en' } },
        };
      accepted = true;
      return Response.json({ member: created }, { status: 201 });
    }
    if (accepted && path === `/v1/collections/${id}` && request.method === 'GET') {
      current.reloads++;
      if (outcome === 'reload' && !failedReload) {
        failedReload = true;
        return Response.json({ code: 'unavailable' }, { status: 503 });
      }
    }
    const response = await recordedFetch(request);
    if (accepted && response.ok && request.method === 'GET') {
      if (path === `/v1/collections/${id}/members`) {
        const page = (await response.json()) as typeof recorded;
        return Response.json({ ...page, members: [...page.members, created!] });
      }
      if (path === `/v1/collections/${id}`) {
        const page = (await response.json()) as typeof collection;
        return Response.json({
          ...page,
          collection: {
            ...page.collection,
            memberCount: page.collection.memberCount + 1,
            revision: page.collection.revision + 1,
          },
        });
      }
    }
    return response;
  }) as typeof fetch;
  const bridge = createStoryFetch(previous, kernel);
  const transport = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin === window.location.origin && url.pathname === '/api/search/suggestions') {
      current.calls.push(`GET ${url.pathname}${url.search}`);
      return Response.json({
        subjects: [{ id: original.subjectId, type: 'schema:Book', labels: { en: title }, facts: {}, summary: null }],
        types: { 'schema:Book': { en: 'Book' } },
      });
    }
    return bridge(input, init);
  }) as typeof fetch;
  globalThis.fetch = transport;
  return () => {
    release();
    if (globalThis.fetch === transport) globalThis.fetch = previous;
  };
}

const meta = {
  title: 'Library/Collections/Collection Editor',
  id: 'patterns-collection-editor',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'UNRUN add-occurrence coverage using the actual CollectionPage and CollectionAddMembers in PatternStory, with the installed owner route recordings, recorded session and scoped exposure helpers. Add, refusal, uncertainty and reload outcomes are local native-shaped illustrations: no add recording exists. Long supported subject/note data is supplied before rendering, never patched into the DOM. Review these same IDs at phone390/desktop1280, all locale globals and themes. Long subject and note also constrains the rendered composition to 320px. Authored plays are future geometry/focus/recovery coverage, not browser, native, visual or full acceptance proof.',
      },
    },
  },
  beforeEach: ({ parameters }) => suppliedOutcomes(parameters.addMembersOutcome ?? 'accepted'),
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function EditorRegion() {
  const query = collectionPageQuery(id, undefined, 'session');
  const { data } = useSuspenseQuery(query);
  if ('preparing' in data) throw new Error('Expected installed curated Collection fixture');
  const read = async (editor = false) => {
    const page = await readCollectionPage({ data: { id, credentialMode: 'session', ...(editor ? { editor } : {}) } });
    if ('preparing' in page) throw new Error('Expected curated Collection');
    return page;
  };
  return (
    <CollectionPage
      page={data}
      cursor={undefined}
      queryKey={query.queryKey}
      readEditorPage={() => read(true)}
      refreshPage={() => read()}
    />
  );
}
function renderEditor(narrow = false) {
  return (
    <PatternStory visitor="Signed In" path={pagePaths['library-collection']}>
      <Suspense fallback={null}>
        <div className="w-full min-w-0 p-4" style={narrow ? { maxWidth: 320 } : undefined}>
          <EditorRegion />
        </div>
      </Suspense>
    </PatternStory>
  );
}
async function openForm(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const add = await canvas.findByRole('button', { name: m.library_collection_add_items() });
  await waitFor(() => expect(add).toBeEnabled());
  await userEvent.click(add);
  const form = await canvas.findByRole('form', { name: m.library_collection_add_items() });
  return { canvas, form: form as HTMLFormElement, fields: within(form) };
}
async function selectAndNote(canvasElement: HTMLElement) {
  const ui = await openForm(canvasElement);
  const input = ui.fields.getByRole('combobox', { name: m.library_collection_find_subject() });
  await userEvent.type(input, 'Original');
  const body = within(canvasElement.ownerDocument.body);
  const option = await body.findByRole('option', { name: new RegExp('Selected subject 0') });
  await userEvent.click(option);
  await expect(input).toHaveValue(title);
  await expect(ui.fields.getByText(title, { selector: 'p' })).toBeVisible();
  // Native keyboard order: search, disclosure, note, submit, cancel.
  input.focus();
  await userEvent.tab();
  const summary = ui.fields.getByText(m.library_member_note(), { selector: 'summary' });
  await expect(summary).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await expect(summary.parentElement).toHaveAttribute('open');
  await userEvent.tab();
  const textarea = ui.fields.getByRole('textbox', { name: m.library_member_note() });
  await expect(textarea).toHaveFocus();
  await userEvent.paste(note);
  await expect(textarea).toHaveValue(note);
  await expect(textarea).toHaveAttribute('maxlength', '20000');
  await userEvent.tab();
  const submit = ui.fields.getByRole('button', { name: m.library_collection_add_selected() });
  await expect(submit).toHaveFocus();
  await focused(submit);
  await userEvent.tab();
  const cancel = ui.fields.getByRole('button', { name: m.library_collection_cancel() });
  await expect(cancel).toHaveFocus();
  await focused(cancel);
  await userEvent.tab({ shift: true });
  await expect(submit).toHaveFocus();
  await layout(canvasElement, ui.form);
  await expect(fixture.posts).toHaveLength(0);
  return { ...ui, input, textarea, summary, submit, cancel };
}
async function focused(control: HTMLElement) {
  await expect(control).toHaveFocus();
  const style = getComputedStyle(control);
  await expect(
    style.boxShadow !== 'none' || (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0),
  ).toBe(true);
}
async function layout(canvasElement: HTMLElement, form: HTMLFormElement) {
  const before = [...fixture.calls];
  await expect(form.querySelector('button button, button a, summary button, summary a')).toBeNull();
  const controls = [...form.querySelectorAll<HTMLElement>('input, summary, textarea, button')];
  for (const control of controls) {
    const box = control.getBoundingClientRect();
    await expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(box.width).toBeGreaterThanOrEqual(44);
    await expect(box.left).toBeGreaterThanOrEqual(form.getBoundingClientRect().left);
    await expect(box.right).toBeLessThanOrEqual(form.getBoundingClientRect().right);
  }
  for (let a = 0; a < controls.length; a++)
    for (let b = a + 1; b < controls.length; b++) {
      const one = controls[a]!.getBoundingClientRect();
      const two = controls[b]!.getBoundingClientRect();
      await expect(
        one.right <= two.left || two.right <= one.left || one.bottom <= two.top || two.bottom <= one.top,
      ).toBe(true);
    }
  for (const element of [
    form,
    ...form.querySelectorAll<HTMLElement>('h2, p, label'),
    canvasElement,
    canvasElement.ownerDocument.documentElement,
  ]) {
    await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
  }
  await expect(fixture.calls).toEqual(before);
}
async function submitted(ui: Awaited<ReturnType<typeof selectAndNote>>) {
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(fixture.posts).toHaveLength(1));
  await expect(fixture.posts[0]!.body).toEqual({ subjectId: original.subjectId, note });
  await expect(fixture.posts[0]!.authorization).toBe('Bearer recorded-story-token');
  await expect(fixture.posts[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
}
async function closed(canvasElement: HTMLElement) {
  await waitFor(() =>
    expect(within(canvasElement).queryByRole('form', { name: m.library_collection_add_items() })).toBeNull(),
  );
  await expect(fixture.posts).toHaveLength(1);
  await expect(fixture.reloads).toBe(1);
}

export const OwnerAddsOccurrence: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const ui = await selectAndNote(canvasElement);
    await submitted(ui);
    await closed(canvasElement);
    // Existing and added occurrences share a subject while retaining their own supplied identity/note.
    await expect(await within(canvasElement).findByRole('link', { name: title })).toBeVisible();
  },
};
export const LongSubjectAndNote: Story = {
  render: () => renderEditor(true),
  play: async ({ canvasElement }) => {
    await selectAndNote(canvasElement);
  },
};
export const OwnerCancelsOccurrence: Story = {
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const ui = await selectAndNote(canvasElement);
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(ui.canvas.queryByRole('form', { name: m.library_collection_add_items() })).toBeNull());
    await expect(fixture.posts).toHaveLength(0);
    await expect(fixture.reloads).toBe(0);
  },
};
export const PendingOccurrence: Story = {
  parameters: { addMembersOutcome: 'pending' },
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const ui = await selectAndNote(canvasElement);
    await submitted(ui);
    await expect(ui.submit).toHaveAttribute('aria-busy', 'true');
    for (const control of [ui.submit, ui.cancel, ui.input, ui.textarea]) await expect(control).toBeDisabled();
    await layout(canvasElement, ui.form);
    await expect(fixture.reloads).toBe(0);
  },
};
export const CorrectableRefusal: Story = {
  parameters: { addMembersOutcome: 'refused' },
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const ui = await selectAndNote(canvasElement);
    await submitted(ui);
    await expect(await ui.fields.findByRole('alert')).toHaveTextContent(m.library_collection_full());
    await expect(ui.submit).toHaveAccessibleDescription(m.library_collection_full());
    await expect(ui.textarea).toBeEnabled();
    await layout(canvasElement, ui.form);
    await userEvent.clear(ui.textarea);
    await userEvent.type(ui.textarea, 'Corrected note 0');
    await userEvent.click(ui.submit);
    await waitFor(() => expect(fixture.posts).toHaveLength(2));
    await expect(fixture.posts[1]!.body).toEqual({ subjectId: original.subjectId, note: 'Corrected note 0' });
    await expect(fixture.posts[1]!.key).not.toBe(fixture.posts[0]!.key);
    await waitFor(() => expect(ui.canvas.queryByRole('form', { name: m.library_collection_add_items() })).toBeNull());
    await expect(fixture.reloads).toBe(1);
  },
};
async function recoverUncertain(canvasElement: HTMLElement) {
  const ui = await selectAndNote(canvasElement);
  await submitted(ui);
  await expect(await ui.fields.findByRole('alert')).toHaveTextContent(m.error_message());
  for (const control of [ui.input, ui.textarea]) await expect(control).toBeDisabled();
  await expect(ui.submit).toBeEnabled();
  await expect(ui.cancel).toBeEnabled();
  await expect(ui.textarea).toHaveValue(note);
  await layout(canvasElement, ui.form);
  await expect(fixture.reloads).toBe(0);
  await userEvent.click(ui.submit);
  await waitFor(() => expect(fixture.posts).toHaveLength(2));
  await expect(fixture.posts[1]).toEqual(fixture.posts[0]);
  await waitFor(() => expect(ui.canvas.queryByRole('form', { name: m.library_collection_add_items() })).toBeNull());
  await expect(fixture.reloads).toBe(1);
}
export const UncertainOccurrenceRecovery: Story = {
  parameters: { addMembersOutcome: 'uncertain' },
  render: () => renderEditor(),
  play: async ({ canvasElement }) => recoverUncertain(canvasElement),
};
export const LostResponseRecovery: Story = {
  parameters: { addMembersOutcome: 'lost' },
  render: () => renderEditor(),
  play: async ({ canvasElement }) => recoverUncertain(canvasElement),
};
export const AcceptedReloadRecovery: Story = {
  parameters: { addMembersOutcome: 'reload' },
  render: () => renderEditor(),
  play: async ({ canvasElement }) => {
    const ui = await selectAndNote(canvasElement);
    await submitted(ui);
    await expect(await ui.fields.findByRole('alert')).toHaveTextContent(m.error_message());
    const reload = ui.fields.getByRole('button', { name: m.library_collection_reload() });
    await expect(ui.input).toBeDisabled();
    await expect(ui.textarea).toBeDisabled();
    await expect(ui.textarea).toHaveValue(note);
    await layout(canvasElement, ui.form);
    reload.focus();
    await userEvent.tab();
    await userEvent.tab({ shift: true });
    await focused(reload);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(ui.canvas.queryByRole('form', { name: m.library_collection_add_items() })).toBeNull());
    await expect(fixture.posts).toHaveLength(1);
    await expect(fixture.reloads).toBe(2);
  },
};
