import { afterAll, describe, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ReactNode } from 'react';
import { fromPlainText } from '@rezics/document';
import * as start from '../.storybook/react-start';
import { current, id, identity, later, ready, selected } from '../src/stories/exact-revision/fixture';
import type { ExactRevisionState } from '../src/threads/exact-revision';
import type { PageAuthor } from '../src/identity/read';

// Authored UNRUN. Mount the delivered components; only request environment/native transport are controlled.
// This is interface regression coverage, not evidence of native authorization or physical browser layout.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/thread' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const requests: Request[] = [];
const pending: ((response: Response) => void)[] = [];
let exactPost: unknown = selected;
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => new Request('https://site.test/en/thread'),
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createKernelClient } = await import('@rezics/client');
const kernel = createKernelClient('https://kernel.test', {
  fetch: Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === `/v1/posts/${selected.id}/revisions`)
        return new Promise<Response>((resolve) => pending.push(resolve));
      if (path === `/v1/posts/${selected.id}/revisions/${selected.revisionId}`)
        return Response.json({ post: exactPost });
      if (path === `/v1/threads/${selected.threadId}`) return Response.json(current);
      if (path === '/v1/accounts') return Response.json({ accounts: [] });
      if (path === '/v1/media/presentations') return new Response(null, { status: 503 });
      if (path.startsWith('/v1/subjects/')) return new Response(null, { status: 404 });
      throw new Error(`Unexpected historical interface request: ${path}`);
    },
    { preconnect() {} },
  ),
});
mock.module('../src/kernel/client', () => ({ kernelClient: () => kernel }));

const { createRoot } = await import('react-dom/client');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { PostHistory, RevisionEntry } = await import('../src/threads/post-history');
const { ExactRevisionView } = await import('../src/threads/exact-revision-view');
const { loadExactRevision } = await import('../src/threads/exact-revision');
const { threadLocation } = await import('../src/threads/thread-href');

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
function mount() {
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    async render(children: ReactNode) {
      await act(async () => {
        root.render(<StrictMode>{children}</StrictMode>);
        await flush();
      });
    },
    async dispose() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
function button(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label);
  expect(found).toBeDefined();
  return found!;
}
async function click(control: HTMLButtonElement) {
  await act(async () => {
    control.click();
    await flush();
  });
}
async function finish(body: unknown, status = 200) {
  expect(pending).toHaveLength(1);
  await act(async () => {
    pending.shift()!(Response.json(body, { status }));
    await flush();
  });
}
function noDocument(host: HTMLElement) {
  expect(host.querySelector('[data-slot="document-body"], [data-slot="document-image"], picture, img')).toBeNull();
  for (const text of ['Private historical text', 'Private image alternative', '/media/', selected.licence])
    expect(host.innerHTML).not.toContain(text);
}
const longReference = `source-${'immutable-reference-'.repeat(16)}`;
const finalParagraph = 'The final immutable paragraph stays readable.';
const author = {
  id: selected.authorId,
  kind: 'actor',
  state: 'active',
  displayName: 'A complete historical account name '.repeat(8).trim(),
  handle: 'historical_reader_'.repeat(8),
  automated: false,
  operatorId: null,
} satisfies PageAuthor;
const authors = { [author.id]: author };
const longRevision = {
  ...selected,
  subjectIds: [longReference],
  body: fromPlainText(`${'Complete historical text. '.repeat(500)}\n\n${finalParagraph}`, 'blocks'),
};
const entry = (number: number) => (
  <RevisionEntry
    key={number}
    revision={longRevision}
    number={number}
    authors={authors}
    mentions={ready.mentions}
    documentMedia={ready.documentMedia}
    now={ready.now}
    subjects={[]}
    currentVote={undefined}
    review
  />
);

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

describe('Complete accessible immutable historical reading controls', () => {
  test('same immutable RevisionEntries have stable own h4 associations and retain complete documents, direct licences and localized exact destinations', async () => {
    const view = mount();
    try {
      let ids: string[] | undefined;
      for (const locale of ['en', 'zh-Hant'] as const) {
        setLocale(locale, { reload: false });
        await view.render(
          <section dir="rtl">
            <ol>
              {entry(1)}
              {entry(2)}
            </ol>
          </section>,
        );
        const entries = [...view.host.querySelectorAll('section > ol > li > article')];
        expect(entries).toHaveLength(2);
        const headings = entries.map((item) => item.querySelector('h4')!);
        const currentIds = headings.map((heading) => heading.id);
        expect(new Set(currentIds).size).toBe(2);
        if (ids) expect(currentIds).toEqual(ids);
        ids = currentIds;
        for (const [index, item] of entries.entries()) {
          expect(item.getAttribute('aria-labelledby')).toBe(headings[index]!.id);
          expect(item.querySelector('h4 a')?.getAttribute('href')).toBe(
            `/${locale}/posts/${selected.id}/revisions/${selected.revisionId}`,
          );
          expect(item.textContent).toContain(finalParagraph);
          expect(item.textContent).toContain(longReference);
          expect(item.textContent).toContain(author.displayName);
          expect(item.textContent).toContain(author.handle);
          const body = item.querySelector('[data-slot="document-body"]')!;
          const provenance = item.querySelector('aside')!;
          expect(body.compareDocumentPosition(provenance) & 4).toBe(4);
          expect(provenance.querySelector('p')?.textContent).toContain(selected.licence);
          expect(provenance.querySelector('p')?.closest('details')).toBeNull();
          expect(item.querySelector('time')?.getAttribute('datetime')).toBe(selected.createdAt);
          const link = item.querySelector<HTMLAnchorElement>('h4 a')!;
          link.focus();
          expect(document.activeElement).toBe(link);
        }
      }
    } finally {
      await view.dispose();
      setLocale('en', { reload: false });
    }
  });

  test('same-identity exact readers independently disclose authentic references and preserve nested details across outer closure', async () => {
    setLocale('en', { reload: false });
    const view = mount();
    const page = { ...ready, authors, revision: longRevision };
    const tree = (first: ExactRevisionState = page) => (
      <div dir="rtl">
        <ExactRevisionView key="first" identity={identity} page={first} />
        <ExactRevisionView key="second" identity={identity} page={page} />
      </div>
    );
    try {
      await view.render(tree());
      const readers = [...view.host.querySelectorAll<HTMLElement>('article')];
      const controls = readers.map((reader) => button(reader, m.thread_provenance_heading()));
      const ids = controls.map((control) => control.getAttribute('aria-controls')!);
      expect(new Set(ids).size).toBe(2);
      for (const [index, reader] of readers.entries()) {
        const panel = reader.querySelector('[data-slot="collapsible-content"]')!;
        expect(panel.id).toBe(ids[index]!);
        expect(controls[index]!.getAttribute('aria-expanded')).toBe('false');
        expect(panel.textContent).toContain(identity.postId);
        expect(panel.textContent).toContain(identity.revisionId);
        expect([...panel.querySelectorAll('bdi')].map((reference) => [reference.dir, reference.textContent])).toEqual([
          ['ltr', identity.postId],
          ['ltr', identity.revisionId],
        ]);
        expect(reader.querySelector('a')?.getAttribute('href')).toBe(
          `${threadLocation('en', ready.thread)}#post-${selected.id}`,
        );
        expect(reader.querySelector('h1')?.textContent).toBe(m.exact_revision_heading());
        expect(reader.textContent).toContain(m.exact_revision_read_only());
        const licence = reader.querySelector('[data-slot="collapsible"] > p')!;
        expect(licence.textContent).toContain(selected.licence);
        expect(licence.closest('[data-slot="collapsible-content"], details')).toBeNull();
      }
      controls[0]!.focus();
      expect(document.activeElement).toBe(controls[0]!);
      await click(controls[0]!);
      expect(controls.map((control) => control.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
      const details = readers[0]!.querySelector('details')!;
      await act(async () => {
        details.querySelector('summary')!.click();
        await flush();
      });
      expect(details.open).toBe(true);
      await click(controls[1]!);
      await click(controls[0]!);
      expect(controls.map((control) => control.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
      await click(controls[0]!);
      expect(details.open).toBe(true);
      expect(details.textContent).toContain(longReference);
      // A mounted state replacement exercises unconditional hooks and cannot expose prior body/attributes.
      await view.render(tree({ state: 'loading' }));
      noDocument(view.host.querySelector('article')!);
      await view.render(tree());
      const restored = button(view.host.querySelector('article')!, m.thread_provenance_heading());
      expect(restored.getAttribute('aria-controls')).toBe(ids[0]!);
      expect(
        button(view.host.querySelectorAll('article')[1]!, m.thread_provenance_heading()).getAttribute('aria-expanded'),
      ).toBe('true');
    } finally {
      await view.dispose();
    }
  });

  test('loading, problems, unavailable and wrong exact identity remove previous text and attributes; retry is explicit', async () => {
    const view = mount();
    let retries = 0;
    const illustrated = { ...selected, mediaIds: [id(60)], body: fromPlainText('Private historical text', 'blocks') };
    illustrated.body.doc.content!.push({ type: 'image', attrs: { src: id(60), alt: 'Private image alternative' } });
    const show = (page: ExactRevisionState) =>
      view.render(<ExactRevisionView identity={identity} page={page} onRetry={() => retries++} />);
    try {
      for (const page of [
        { state: 'loading' },
        { state: 'problem', status: 503, code: 'dependency_unavailable' },
        { state: 'unavailable', status: 404 },
        { ...ready, revision: { ...illustrated, revisionId: later.revisionId } },
        { ...ready, revision: { ...illustrated, id: id(99) } },
      ] satisfies ExactRevisionState[]) {
        await show({ ...ready, revision: illustrated });
        expect(view.host.innerHTML).toContain('Private image alternative');
        await show(page);
        noDocument(view.host);
        expect(view.host.querySelector('a')).toBeNull();
        if (page.state === 'problem') {
          expect(view.host.querySelector('[role="alert"]')?.textContent).toBe(m.exact_revision_problem());
          const retry = button(view.host, m.exact_revision_retry());
          expect(retries).toBe(0);
          await click(retry);
          expect(retries).toBe(1);
        }
      }
      for (const availability of ['withheld', 'erased'] as const) {
        exactPost = { ...illustrated, availability, body: null, sha256: null, removed: true };
        const page = await loadExactRevision(kernel, identity);
        expect(page).toEqual({ state: 'unavailable', status: 404 });
        await show(page);
        noDocument(view.host);
      }
      await view.render(<ExactRevisionView identity={identity} page={{ state: 'problem', status: 503, code: null }} />);
      expect(view.host.querySelector('button')).toBeNull();
    } finally {
      exactPost = selected;
      await view.dispose();
    }
  });

  test('actual history controls retain native20, raw continuation, pending disablement and manual recovery without automatic resend', async () => {
    setLocale('en', { reload: false });
    requests.length = 0;
    const historyCalls = () => requests.filter((request) => new URL(request.url).pathname.endsWith('/revisions'));
    const view = mount();
    const cursor = 'native-signed/+=continuation';
    try {
      await view.render(<PostHistory postId={selected.id} />);
      expect(historyCalls()).toHaveLength(0);
      const show = button(view.host, m.thread_history_show());
      show.focus();
      expect(document.activeElement).toBe(show);
      const region = view.host.querySelector('section')!;
      expect(show.getAttribute('aria-controls')).toBe(region.id);
      expect(region.hidden).toBe(true);
      await click(show);
      expect(region.hidden).toBe(false);
      expect(show.getAttribute('aria-expanded')).toBe('true');
      expect(view.host.textContent).toContain(m.thread_history_loading());
      await click(button(view.host, m.thread_history_hide()));
      await click(button(view.host, m.thread_history_show()));
      expect(historyCalls()).toHaveLength(1);
      await finish({ code: 'dependency_unavailable' }, 503);
      noDocument(view.host);
      await click(button(view.host, m.thread_history_hide()));
      await click(button(view.host, m.thread_history_show()));
      expect(historyCalls()).toHaveLength(1);
      const retry = button(view.host, m.exact_revision_retry());
      await click(retry);
      expect(retry.disabled).toBe(true);
      await click(retry);
      expect(historyCalls()).toHaveLength(2);
      const withheld = {
        ...selected,
        revisionId: id(88),
        availability: 'withheld',
        body: null,
        sha256: null,
        removed: true,
      };
      const erased = { ...withheld, revisionId: id(89), availability: 'erased' };
      await finish({ revisions: [selected, withheld, erased], next: cursor });
      expect(view.host.querySelectorAll('section > ol > li')).toHaveLength(3);
      for (const entry of [...view.host.querySelectorAll('section > ol > li')].slice(1))
        expect(entry.querySelector('[data-slot="document-body"], [data-slot="document-image"]')).toBeNull();
      await click(button(view.host, m.revision_history_inspect({ number: '1' })));
      expect(view.host.textContent).toContain(selected.revisionId);
      const more = button(view.host, m.thread_history_more());
      await click(more);
      expect(more.disabled).toBe(true);
      expect(view.host.querySelector('[data-history-inspector]')).toBeNull();
      expect(view.host.textContent).not.toContain(selected.revisionId);
      await click(more);
      expect(historyCalls()).toHaveLength(3);
      await finish({ code: 'dependency_unavailable' }, 503);
      expect(view.host.querySelector('section > ol')).toBeNull();
      noDocument(view.host);
      expect(historyCalls()).toHaveLength(3);
      await click(button(view.host, m.exact_revision_retry()));
      await finish({ revisions: [later], next: null });
      expect(view.host.querySelectorAll('section > ol > li')).toHaveLength(1);
      expect([...view.host.querySelectorAll('section > ol h4 a')].at(-1)?.getAttribute('href')).toBe(
        `/en/posts/${later.id}/revisions/${later.revisionId}`,
      );
      expect(
        [...view.host.querySelectorAll('button')].some((control) => control.textContent === m.thread_history_more()),
      ).toBe(false);
      expect(
        historyCalls().map((request) => {
          const url = new URL(request.url);
          return {
            limit: url.searchParams.get('limit'),
            cursor: url.searchParams.get('cursor'),
            authorization: request.headers.get('authorization'),
          };
        }),
      ).toEqual([null, null, cursor, cursor].map((value) => ({ limit: '20', cursor: value, authorization: null })));
    } finally {
      await view.dispose();
    }
  });
});
