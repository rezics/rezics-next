import { preparationFixture } from './realm-publication-preparation-fixture';
import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { PublicationChange, PublicationOutcome } from '../src/community/publication-controls';
import type { PublicationTarget } from '../src/community/publication-subject-picker';
import type { PublishedSubject } from '../src/community/space';
import subjectsRecording from '../src/kernel/recorded/realm-subjects.json';
import publicationsRecording from '../src/kernel/recorded/realm-publications.json';
import * as start from '../.storybook/react-start';

// UNRUN: mounted presentation regression. Controlled outcomes below are not native publication proof.
test('Realm publication selection and outcomes use installed shared family with independent controls and unchanged native current-source retry and continuation semantics', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/spaces/atlas-member' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
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
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  mock.module('cloudflare:workers', () => ({ env: {} }));

  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { PublicationControls, ShelfContinuation, usePublicationControls } =
    await import('../src/community/publication-controls-view');
  const { publicationSubjectSearch } = await import('../src/community/publication-subject-picker');
  const { sessionQuery } = await import('../src/session/query');
  const { coverSrc } = await import('../src/media/cover-src');
  const { entityPickerMessages } = await import('../../../packages/ui/src/components/entity-picker-messages');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');

  const publication = publicationsRecording.items[0]!;
  const read = subjectsRecording.subjects[publication.subjectId as keyof typeof subjectsRecording.subjects]!;
  const supplied: PublicationTarget = {
    id: read.subject.id,
    title: read.summary.label.value,
    label: read.summary.label.value,
    labels: read.subject.labels,
    types: read.summary.types,
    typeName: 'Book', // The existing publication-subject-picker test's disclosed type fixture.
    cover: read.summary.cover
      ? {
          ...read.summary.cover,
          variants: read.summary.cover.variants.map(({ format, width }) => {
            if (format !== 'avif' && format !== 'webp') throw new Error('Unsupported fixture cover format');
            return { format, width };
          }),
        }
      : null,
  };
  // Deliberately constructed long text from supplied fixture labels, never represented as a new native fact.
  const long: PublicationTarget = {
    ...supplied,
    title: Array(16).fill(supplied.title).join(' · '),
    typeName: Array(12).fill(supplied.typeName).join(' / '),
  };
  const viewer = { state: 'signed-in', subject: 'fixture-curator', csrfToken: 'fixture-csrf' };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, viewer);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const writes: { input: PublicationChange; resolve: (outcome: PublicationOutcome) => void }[] = [];
  const saved: PublicationChange[] = [];
  let currentSubjects: PublishedSubject[] = [{ ...supplied, publicationId: publication.publicationId }];
  let control!: ReturnType<typeof usePublicationControls>;
  let restarts = 0;
  const loads: (boolean | undefined | 'retry')[] = [];
  let continuation: { next: string | null; busy: boolean; failure: 'denied' | 'unavailable' | 'stale' | null } = {
    next: null,
    busy: false,
    failure: null,
  };
  let searchUnavailable = false;
  const search = publicationSubjectSearch('en', async () => {
    if (searchUnavailable) throw new Error('Constructed Search failure');
    return {
      subjects: [{ id: supplied.id, type: read.subject.type, labels: { en: long.title }, summary: read.summary }],
      types: { [read.subject.type]: { en: long.typeName! } },
      as_of: publication.publishedAt,
    };
  });
  const prepare = preparationFixture(viewer.subject, () => currentSubjects[0]?.publicationId ?? null);
  const send = (input: PublicationChange) =>
    new Promise<PublicationOutcome>((resolve) => writes.push({ input, resolve }));
  function Harness() {
    control = usePublicationControls(
      publication.realmId,
      send,
      (input) => saved.push(input),
      currentSubjects,
      true,
      viewer.subject,
      prepare,
    );
    return (
      <section>
        <h2>{m.realm_published_heading()}</h2>
        <PublicationControls
          control={control}
          search={search}
          refresh={async () => {
            restarts++;
          }}
        />
        <aside aria-label="Publication continuation">
          <ShelfContinuation
            {...continuation}
            label={m.realm_publications_more()}
            load={async (restart) => {
              loads.push(restart);
            }}
            retry={async () => {
              loads.push('retry');
            }}
          />
        </aside>
      </section>
    );
  }
  const paint = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      ),
    );
  const click = (node: HTMLElement) => act(async () => node.click());
  const buttons = (scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>('button')];
  const button = (name: string, scope: ParentNode = host) => {
    const found = buttons(scope).filter((node) => node.textContent?.trim() === name);
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  const selected = () =>
    host.querySelector<HTMLElement>(`[role="group"][aria-label="${m.realm_publication_selected()}"]`);
  const picker = () => host.querySelector<HTMLInputElement>(`input[aria-label="${m.realm_publication_choose()}"]`);
  const status = () => [...host.querySelectorAll('[role="status"]')].map((node) => node.textContent).join(' ');
  const noFalseResult = () => {
    expect(status()).not.toContain(m.realm_publication_saved());
    expect(status()).not.toContain(m.realm_publication_removed());
    expect(status()).not.toContain(m.realm_publication_rejected());
    expect(host.textContent).not.toContain(m.realm_published_empty());
  };
  const choose = (target: PublicationTarget = supplied) => act(async () => control.choose(target));
  const startChange = (action: PublicationChange['action']) =>
    act(async () => {
      void control.change(action);
    });
  const settle = (outcome: PublicationOutcome) =>
    act(async () => {
      writes.at(-1)!.resolve(outcome);
    });
  const searchFor = async (query: string) => {
    const input = picker()!;
    expect(input).not.toBeNull();
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, query);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
  };
  try {
    await paint();
    expect(picker()).toBeNull();
    await click(button(m.realm_publication_curate()));
    expect(host.querySelector('h2')?.textContent).toBe(m.realm_published_heading());
    expect(host.querySelector('h3[data-content-item-slot="title"]')?.textContent).toBe(m.realm_publication_curate());
    expect(host.textContent).toContain(m.realm_publication_scope());
    expect(button(m.realm_publication_publish()).disabled).toBe(true);
    expect(picker()).not.toBeNull();
    expect(writes).toHaveLength(0);

    await searchFor(supplied.title);
    const option = document.querySelector<HTMLElement>('[role="option"]')!;
    expect(option.textContent).toContain(long.title);
    await click(option);
    const group = selected()!;
    expect(control.target).toMatchObject({
      id: supplied.id,
      title: long.title,
      types: supplied.types,
      cover: supplied.cover,
      typeName: long.typeName,
    });
    expect(group.querySelector('h4[data-content-item-slot="title"]')?.textContent).toBe(long.title);
    expect(group.querySelector('[data-content-item-slot="metadata"]')?.textContent).toBe(long.typeName);
    expect(group.textContent).toContain(m.realm_publication_confirm());
    expect(group.className).toContain('has-[:focus-visible]');
    expect(group.querySelector('img')?.getAttribute('src')).toContain(`/media/${supplied.cover!.media}/`);
    expect(group.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(group.querySelector('source')?.getAttribute('srcset')).toContain(
      coverSrc(supplied.cover!.media, 'avif', 320),
    );
    expect(picker()).toBeNull();
    expect(host.querySelector('a')).toBeNull();
    expect(group.querySelector('button button, button a')).toBeNull();
    const clear = button(m.realm_publication_clear());
    const publish = button(m.realm_publication_publish());
    expect(group.contains(clear)).toBe(true);
    expect(group.contains(publish)).toBe(false);
    for (const node of [clear, publish]) {
      expect(node.className).toContain('min-h-11');
      expect(node.className).toContain('min-w-11');
      expect(node.closest('[data-slot="list-row-control"]')).not.toBeNull();
      await act(async () => node.focus());
      expect(document.activeElement).toBe(node);
    }
    // Mounted direction and width changes retain complete supplied text and independent targets.
    for (const width of [390, 1280])
      for (const direction of ['ltr', 'rtl']) {
        host.style.width = `${width}px`;
        host.dir = direction;
        await paint();
        expect(selected()!.querySelector('h4')?.textContent).toBe(long.title);
        expect(selected()!.querySelector('[data-content-item-slot="metadata"]')?.textContent).toBe(long.typeName);
        expect(button(m.realm_publication_publish()).disabled).toBe(false);
      }
    noFalseResult();
    await click(button(m.realm_publication_curate()));
    expect(selected()).toBeNull();
    await click(button(m.realm_publication_curate()));
    expect(selected()!.querySelector('h4')?.textContent).toBe(long.title);
    await click(button(m.realm_publication_clear()));
    expect(picker()!.value).toBe('');
    expect(button(m.realm_publication_publish()).disabled).toBe(true);
    expect(writes).toHaveLength(0);
    noFalseResult();

    searchUnavailable = true;
    await searchFor('unavailable');
    expect(document.body.textContent).toContain(entityPickerMessages.en.failed);
    expect(document.body.textContent).not.toContain(entityPickerMessages.en.empty.replace('{query}', 'unavailable'));
    expect(button(m.realm_publication_publish()).disabled).toBe(true);
    noFalseResult();

    for (const action of ['publish', 'withdraw', 'reject'] as const) {
      await choose();
      if (action === 'publish') await click(button(m.realm_publication_publish()));
      else await startChange(action);
      expect(status()).toBe(m.realm_publication_saving());
      expect(host.querySelector('fieldset')?.disabled).toBe(true);
      expect(button(m.realm_publication_publish()).disabled).toBe(true);
      await settle({ kind: 'saved', head: publicationsRecording.items[1]!.publicationId });
      expect(status()).toBe(
        action === 'publish'
          ? m.realm_publication_saved()
          : action === 'reject'
            ? m.realm_publication_rejected()
            : m.realm_publication_removed(),
      );
      expect(saved.at(-1)!.action).toBe(action);
    }
    await choose();
    await startChange('publish');
    await settle({ kind: 'invalid' });
    expect(status()).toBe(m.realm_publication_invalid());
    noFalseResult();
    await choose();
    await startChange('publish');
    await settle({ kind: 'denied' });
    expect(status()).toBe(m.realm_publication_denied());
    expect(selected()).toBeNull();
    expect(picker()).not.toBeNull();
    noFalseResult();

    for (const action of ['publish', 'withdraw', 'reject'] as const) {
      await choose();
      await startChange(action);
      const original = structuredClone(writes.at(-1)!.input);
      expect(original).toMatchObject({
        realmId: publication.realmId,
        subjectId: supplied.id,
        action,
        expectedHead: currentSubjects[0]!.publicationId,
      });
      expect(Object.isFrozen(writes.at(-1)!.input)).toBe(true);
      await settle({ kind: 'unavailable' });
      expect(status()).toContain(m.realm_publication_uncertain());
      expect(host.querySelector('fieldset')?.disabled).toBe(true);
      noFalseResult();
      currentSubjects = [{ ...supplied, publicationId: publicationsRecording.items[2]!.publicationId }];
      await paint();
      await act(async () => control.choose(null));
      expect(control.target?.id).toBe(original.subjectId);
      await click(button(m.realm_publication_retry()));
      expect(writes.at(-1)!.input).toEqual(original);
      const head = publicationsRecording.items[3]!.publicationId;
      await settle({ kind: 'conflict', currentHead: head });
      expect(status()).toContain(m.realm_publication_conflict());
      expect(buttons().some((node) => node.textContent === m.realm_publication_retry())).toBe(false);
      noFalseResult();
      currentSubjects = [{ ...supplied, publicationId: head }];
      await click(button(m.realm_publication_review()));
      await startChange(action);
      expect(writes.at(-1)!.input).toMatchObject({
        ...original,
        expectedHead: head,
        ifMatch: JSON.stringify(head),
        idempotencyKey: expect.any(String),
      });
      expect(writes.at(-1)!.input.idempotencyKey).not.toBe(original.idempotencyKey);
      await settle({ kind: 'saved', head });
    }

    await choose();
    await startChange('publish');
    await settle({ kind: 'conflict', currentHead: null });
    expect(status()).toContain(m.realm_publication_conflict());
    expect(selected()).not.toBeNull();
    expect(picker()).toBeNull();
    noFalseResult();
    await click(button(m.realm_shelf_restart()));
    expect(restarts).toBe(1);

    await choose();
    const retained = control;
    await startChange('publish');
    const count = writes.length;
    const savedCount = saved.length;
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
      void retained.retry();
      void retained.review();
      void retained.change('publish', supplied);
    });
    await settle({ kind: 'saved', head: publicationsRecording.items[4]!.publicationId });
    expect(writes).toHaveLength(count);
    expect(saved).toHaveLength(savedCount);
    expect(selected()).toBeNull();
    expect(host.querySelector('fieldset')?.disabled).toBe(true);
    noFalseResult();

    const aside = host.querySelector('aside')!;
    for (const failure of [null, 'unavailable', 'stale', 'denied'] as const) {
      for (const next of [null, 'supplied-next'])
        for (const busy of [false, true]) {
          continuation = { failure, next, busy };
          await paint();
          expect(aside.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe(String(busy));
          expect(aside.querySelector('[role="status"]')?.textContent ?? null).toBe(
            failure === 'denied'
              ? m.realm_shelf_denied()
              : failure === 'stale'
                ? m.realm_shelf_stale()
                : failure === 'unavailable'
                  ? m.realm_shelf_unavailable()
                  : null,
          );
          const restart = failure === 'stale' || failure === 'denied';
          const idleLabel = failure ? m.realm_shelf_retry() : m.realm_publications_more();
          expect(buttons(aside)).toHaveLength(failure || next ? 1 : 0);
          if (failure || next) {
            const node = button(restart ? m.realm_shelf_restart() : busy ? m.realm_shelf_loading() : idleLabel, aside);
            expect(node.disabled).toBe(busy);
            expect(node.className).toContain('min-h-11');
            if (!busy) {
              await click(node);
              expect(loads.at(-1)).toBe(restart ? true : failure ? 'retry' : undefined);
            }
          }
          expect(aside.textContent).not.toContain(m.realm_published_empty());
        }
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    overwriteGetLocale(previousLocale);
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
