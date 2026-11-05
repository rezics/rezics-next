import type { Meta, StoryObj } from '@storybook/react-vite';
import { createKernelClient } from '@rezics/client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { createRecordedKernelFetch } from '../kernel/fake';
import { selectEntryUndoOutcome } from '../kernel/fake/library-entry-undo';
import entriesRecording from '../kernel/recorded/library-entries.json';
import { libraryEntryFormResponse } from '../library/entry-form';
import { EntryFormPage, EntryRemoveForm } from '../library/entry-undo';
import type { LibraryRestoreResult, ReloadedLibraryEntry } from '../library/entries-read';
import { m } from '../paraglide/messages.js';
import { getLocale, getServerAsyncLocalStorage, overwriteServerAsyncLocalStorage } from '../paraglide/runtime.js';
import { PatternStory } from './page';

const meta = {
  title: 'Patterns/Library/Entry Removal Journey',
  parameters: {
    layout: 'fullscreen',
    admitted: ['personal_library', 'library_entry.restore'],
    docs: {
      description: {
        component:
          'Actual removal and receipt forms in PatternStory. The local document adapter sends their original POST fields through the unchanged libraryEntryFormResponse handler and existing recorded kernel/admission helpers, then displays the returned body verbatim. A synchronous locale context supports that server renderer in this single-request browser preview. It does not replace mutations with success callbacks. Native transport, script-free navigation and browser acceptance remain UNRUN. Long result examples use local native-shaped supplied data because the committed recordings have short titles; they do not claim recorded long-title mutations. Review the same stories at the global phone390 and desktop1280 viewports; long results also exercise a 320px container.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const incarnationId = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const idempotencyKey = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const subjects = {
  success: 'book-one',
  occupied: '01a17a3b-6bd9-706f-b395-987536454933',
  stale: '01a17a3b-6bc3-764f-8727-7872d197bd93',
  expired: '01a17a3b-6bab-705b-935e-d6dc0cacd82d',
} as const;
const backHref = () => `/${getLocale()}/library?state=planned&cursor=opaque%2Bnext`;
type CapturedRequest = Pick<Request, 'method' | 'url' | 'headers' | 'json'>;
let activeRequests: CapturedRequest[] | undefined;

/** Story-only document host: retain the real form method/action and run the real POST handler. */
function NativeDocumentJourney({ outcome }: { outcome: keyof typeof subjects }) {
  const [body, setBody] = useState<string>();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const [requests] = useState<CapturedRequest[]>([]);
  const [kernel] = useState(() => {
    const recorded = createRecordedKernelFetch({ 'library-entries': entriesRecording });
    return createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return recorded(request);
      }) as typeof fetch,
    });
  });
  useEffect(() => {
    selectEntryUndoOutcome('ok');
    activeRequests = requests;
    // The handler's locale callback renders synchronously; no concurrent server work runs in this preview.
    const previous = getServerAsyncLocalStorage();
    type Store = Parameters<NonNullable<Parameters<typeof overwriteServerAsyncLocalStorage>[0]>['run']>[0];
    let store: Store | undefined;
    overwriteServerAsyncLocalStorage({
      getStore: () => store,
      run: (next, callback) => {
        const before = store;
        store = next;
        try {
          return callback();
        } finally {
          store = before;
        }
      },
    });
    setReady(true);
    return () => {
      overwriteServerAsyncLocalStorage(previous);
      if (activeRequests === requests) activeRequests = undefined;
    };
  }, [requests]);
  const submit = async (event: FormEvent<HTMLDivElement>) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const fields = new URLSearchParams();
      for (const [key, value] of new FormData(form)) fields.append(key, String(value));
      const response = await libraryEntryFormResponse(
        new Request(new URL(form.getAttribute('action')!, 'https://rezics.local'), {
          method: form.method,
          headers: { authorization: 'Bearer reader' },
          body: fields,
        }),
        {},
        kernel,
      );
      if (response.status !== 200) throw new Error(`Native document fixture returned ${response.status}`);
      const document = new DOMParser().parseFromString(await response.text(), 'text/html');
      setBody(document.body.innerHTML);
    } catch (error) {
      setError(String(error));
    } finally {
      inFlight.current = false;
    }
  };
  if (!ready) return null;
  return (
    <div onSubmitCapture={submit}>
      {error ? <pre role="alert">{error}</pre> : null}
      {body === undefined ? (
        <main className="mx-auto min-w-0 max-w-2xl space-y-6 p-6 [overflow-wrap:anywhere]">
          <h1 className="text-2xl font-semibold">{m.library_heading()}</h1>
          <EntryRemoveForm
            locale={getLocale()}
            csrfToken="story-csrf-token"
            returnTo={backHref()}
            subjectId={subjects[outcome]}
            revision={7}
            incarnationId={incarnationId}
            idempotencyKey={idempotencyKey}
          />
        </main>
      ) : (
        <div dangerouslySetInnerHTML={{ __html: body }} />
      )}
    </div>
  );
}

function journey(outcome: keyof typeof subjects): Story {
  return {
    render: () => (
      <PatternStory visitor="Signed In" path="/library">
        <NativeDocumentJourney outcome={outcome} />
      </PatternStory>
    ),
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      const remove = await canvas.findByRole('button', { name: m.library_remove_from_library() });
      expectTarget(remove);
      await keyboardFocus(remove);
      const initialForm = (remove as HTMLButtonElement).form!;
      expect(initialForm.method).toBe('post');
      expect(initialForm.getAttribute('action')).toBe('/library/entry');
      expect(Object.fromEntries(new FormData(initialForm))).toEqual({
        locale: getLocale(),
        csrf_token: 'story-csrf-token',
        returnTo: backHref(),
        intent: 'remove',
        subjectId: subjects[outcome],
        revision: '7',
        incarnationId,
        idempotencyKey,
      });
      expect(activeRequests).toHaveLength(0);
      await userEvent.keyboard('{Enter}');
      const undo = await canvas.findByRole('button', { name: m.editor_undo() });
      const back = canvas.getByRole('link', { name: m.library_menu_back() });
      expectTarget(undo);
      expectTarget(back);
      expectSeparated(undo, back);
      expect(back.closest('form')).toBeNull();
      await expect(back).toHaveAttribute('href', backHref());
      const form = (undo as HTMLButtonElement).form!;
      expect(Object.fromEntries(new FormData(form))).toEqual({
        locale: getLocale(),
        csrf_token: 'story-csrf-token',
        returnTo: backHref(),
        intent: 'restore',
        subjectId: subjects[outcome],
        deletionId: `undo-${outcome === 'success' ? 'ok' : outcome}`,
        revision: '12',
      });
      await keyboardFocus(undo);
      await userEvent.tab();
      await expect(back).toHaveFocus();
      await userEvent.tab({ shift: true });
      await expect(undo).toHaveFocus();
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(canvas.queryByRole('button', { name: m.editor_undo() })).toBeNull());
      if (outcome === 'success' || outcome === 'occupied') {
        const article = await canvas.findByRole('article');
        expect(article.tagName).toBe('ARTICLE');
        await expect(article).toHaveAttribute('data-entry-revision', outcome === 'success' ? '7' : '15');
        expectContained(article);
      } else expect(canvas.queryByRole('article')).toBeNull();
      if (outcome !== 'success') {
        const message = {
          occupied: m.library_restore_occupied(),
          stale: m.library_restore_stale(),
          expired: m.library_restore_expired(),
        }[outcome];
        await expect(canvas.getByRole('status')).toHaveTextContent(message);
      } else expect(canvas.queryByRole('status')).toBeNull();
      const returned = canvas.getByRole('link', { name: m.library_menu_back() });
      await expect(returned).toHaveAttribute('href', backHref());
      await keyboardFocus(returned);
      const writes = activeRequests!.filter((request) =>
        new URL(request.url).pathname.startsWith('/v1/libraryEntries'),
      );
      expect(writes.map((request) => request.method)).toEqual(
        outcome === 'occupied' ? ['DELETE', 'POST', 'GET'] : ['DELETE', 'POST'],
      );
      expect(await writes[1]!.json()).toEqual({
        deletionId: `undo-${outcome === 'success' ? 'ok' : outcome}`,
        revision: 12,
      });
      expect(writes.every((request) => request.headers.get('authorization') === 'Bearer reader')).toBe(true);
      expectNoOverflow(canvasElement);
    },
  };
}

function expectContained(element: HTMLElement) {
  expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
  const rect = element.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(-1);
  expect(rect.right).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
}
function expectTarget(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  expect(rect.height).toBeGreaterThanOrEqual(44);
  expect(rect.width).toBeGreaterThanOrEqual(44);
  expect(getComputedStyle(element).whiteSpace).toBe('normal');
  expectContained(element);
  expect(element.scrollHeight).toBeLessThanOrEqual(element.clientHeight + 1);
}
async function keyboardFocus(element: HTMLElement) {
  await userEvent.tab();
  element.focus();
  await expect(element).toHaveFocus();
  const style = getComputedStyle(element);
  expect(element.matches(':focus-visible')).toBe(true);
  expect(parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
  expect(style.outlineStyle).not.toBe('none');
}
function expectSeparated(first: HTMLElement, second: HTMLElement) {
  const a = first.getBoundingClientRect();
  const b = second.getBoundingClientRect();
  expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
}
function expectNoOverflow(canvas: HTMLElement) {
  expectContained(canvas);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
  for (const region of canvas.querySelectorAll<HTMLElement>('main,article,[role="status"]')) expectContained(region);
}

export const RemovalAndUndo = journey('success');
export const OccupiedRecovery = journey('occupied');
export const StaleRecovery = journey('stale');
export const ExpiredRecovery = journey('expired');

// Native-supported, local supplied result data. The actual recordings cannot honestly supply these long strings.
const longTitle = `A supplied title 日本語 — ${'UnbrokenNativeTitle'.repeat(28)}`;
const longState = `0 — ${'Supplied state label '.repeat(25)}`;
const longEntry: ReloadedLibraryEntry = {
  subjectId: 'book-one',
  state: 'native-state',
  stateLabel: longState,
  revision: 7,
  incarnationId,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  subject: { id: 'book-one', type: 'book', types: ['book'], label: { value: longTitle, language: 'ja' }, cover: null },
};
function result(restore?: LibraryRestoreResult): Story {
  return {
    render: () => (
      <PatternStory visitor="Signed In" path="/library/entry">
        <div className="w-full max-w-[320px]">
          <EntryFormPage
            locale={getLocale()}
            csrfToken="story-csrf-token"
            returnTo={backHref()}
            {...(restore ? { restore } : { removed: true })}
          />
        </div>
      </PatternStory>
    ),
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      const back = await canvas.findByRole('link', { name: m.library_menu_back() });
      expectTarget(back);
      await expect(back).toHaveAttribute('href', backHref());
      await keyboardFocus(back);
      expect(canvasElement.querySelector('form,button,[name="deletionId"]')).toBeNull();
      if (restore && (restore.ok || restore.reason === 'occupied') && restore.entry) {
        const article = canvas.getByRole('article');
        await expect(article).toHaveTextContent(longTitle);
        await expect(article).toHaveTextContent(longState);
        expect(article.querySelector('[lang="ja"]')?.textContent).toBe(longTitle);
        expect(article.closest('ul,ol,[role="list"]')).toBeNull();
      }
      if (restore && !restore.ok) {
        const message =
          restore.reason === 'occupied'
            ? m.library_restore_occupied()
            : restore.reason === 'closed'
              ? m.platform_closed_message()
              : m.library_subject_unavailable();
        await expect(canvas.getByRole('status')).toHaveTextContent(message);
      }
      expectNoOverflow(canvasElement);
    },
  };
}
export const RestoredFullText = result({ ok: true, entry: longEntry });
export const OccupiedFullText = result({ ok: false, reason: 'occupied', entry: { ...longEntry, revision: 15 } });
export const OccupiedWithoutEntry = result({ ok: false, reason: 'occupied' });
export const UnavailableResult = result({ ok: false, reason: 'unavailable' });
export const ClosedResult = result({ ok: false, reason: 'closed' });
export const RemovedWithoutReceipt = result();
