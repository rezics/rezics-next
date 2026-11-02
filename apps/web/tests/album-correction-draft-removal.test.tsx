import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import {
  albumDraftIdentity,
  albumDraftPopulated,
  changeAlbumSelection as change,
} from '../src/features/catalogue/album-correction-selection';
import type { FactCommand, FactResult } from '../src/features/catalogue/subject-facts';

test('Album removal targets a local draft across revisions, never its replacement or sealed command', async () => {
  const { albumFixture } = await import('../src/kernel/fake/catalogue-album-profile');
  const read = await albumFixture().editors.facts.read();
  if (!read.ok) throw new Error('Expected Album');
  const property = 'schema:datePublished';
  const stage = () => change([], { kind: 'stage', read, property, source: null });
  const original = stage()[0]!;
  expect(albumDraftPopulated(original)).toBe(false);
  const revised = {
    ...original,
    statement: {
      ...original.statement,
      references: [
        {
          parts: [
            { property: { id: 'schema:url' }, value: { type: 'value' as const, content: 'https://example.test' } },
          ],
        },
      ],
    },
  };
  const drafts = change([original], { kind: 'revise', draft: revised });
  expect(albumDraftIdentity(revised)).toBe(albumDraftIdentity(original));
  expect(albumDraftPopulated(revised)).toBe(true);
  const replacement = stage();
  expect(albumDraftIdentity(replacement[0]!)).not.toBe(albumDraftIdentity(original));
  expect(change(replacement, { kind: 'remove', property, target: revised })).toBe(replacement);
  const uncertain = [{ ...drafts[0]!, result: { ok: false as const, reason: 'uncertain' as const } }];
  expect(change(uncertain, { kind: 'remove', property })).toBe(uncertain);
});

test('Album draft Cancel preserves mounted assertions; local confirmation keeps sources and obeys current locks', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/catalogue/album' });
  const globals: Record<string, unknown> = { window, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of 'document navigator HTMLElement HTMLInputElement HTMLSelectElement Element Node MutationObserver ResizeObserver Document DocumentFragment'.split(
    ' ',
  ))
    globals[key] = Reflect.get(window, key);
  globals.getComputedStyle = window.getComputedStyle.bind(window);
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { AlbumProfile } = await import('../src/features/catalogue/album-profile-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { albumFixture, albumId } = await import('../src/kernel/fake/catalogue-album-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const fixture = albumFixture(),
    commands: FactCommand[] = [];
  const property = 'schema:datePublished',
    sibling = 'schema:inLanguage';
  fixture.release.types['schema:MusicAlbum']!.properties.push(sibling);
  const selected = structuredClone(fixture.publicRead.subject.statements);
  let finish!: (result: FactResult) => void;
  let next = await fixture.editors.facts.read();
  const initial = await fixture.loadCorrection();
  const editors = {
    ...fixture.editors,
    facts: {
      read: async () => next,
      propose: async (command: FactCommand): Promise<FactResult> => {
        commands.push(command);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  };
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host),
    client = new QueryClient();
  const click = (scope: HTMLElement, name: string) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const field = (id: string) => within(host).getByRole('region', { name: fixture.release.properties[id]!.labels.en! });
  const row = (id: string) => field(id).parentElement!;
  const remove = (id: string) => m.album_remove_draft({ field: fixture.release.properties[id]!.labels.en! });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            observed={{ state: 'signed-in', subject: 'viewer', csrfToken: 'first' }}
            address={albumId}
          >
            <AlbumProfile
              id={albumId}
              locale="en"
              session="signed-in"
              transport={{ ...fixture.transport, load: async () => initial }}
              search={async () => []}
              editors={editors}
            />
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
    await click(field(property), m.facts_edit_field());
    const year = within(field(property)).getByRole('textbox', { name: m.correction_year() }) as HTMLInputElement;
    await act(async () => {
      await user.clear(year);
      await user.type(year, '2025');
    });
    const citation = within(field(property)).getByRole('textbox', { name: m.correction_url() }) as HTMLInputElement;
    await click(field(sibling), m.facts_edit_field());
    await click(row(sibling), remove(sibling)); // Untouched empty addition releases its slot immediately.
    expect(within(field(sibling)).getByRole('button', { name: m.facts_edit_field() })).toBeTruthy();
    await click(field(sibling), m.facts_edit_field());
    const value = within(field(sibling)).getByRole('textbox', { name: m.correction_value() }) as HTMLInputElement;
    await act(async () => user.type(value, 'fr'));
    await click(row(property), remove(property));
    await click(row(property), m.candidate_cancel());
    expect(window.document.activeElement).toBe(within(row(property)).getByRole('button', { name: remove(property) }));
    expect(within(field(property)).getByRole('textbox', { name: m.correction_year() })).toBe(year);
    expect(year.value).toBe('2025');
    expect(citation.value).toContain('https://');
    await click(row(property), remove(property));
    await act(async () => user.keyboard('{Escape}'));
    expect(window.document.activeElement).toBe(within(row(property)).getByRole('button', { name: remove(property) }));
    await click(row(property), remove(property));
    await click(row(property), remove(property));
    expect(window.document.activeElement).toBe(
      within(field(property)).getByRole('combobox', { name: m.facts_choose_value() }),
    );
    expect((window.document.activeElement as HTMLSelectElement).value).toBe(selected[property]![0]!.id);
    expect(within(field(sibling)).getByRole('textbox', { name: m.correction_value() })).toBe(value);
    expect(value.value).toBe('fr');
    expect(commands).toHaveLength(0);
    expect(fixture.publicRead.subject.statements).toEqual(selected);
    await click(row(sibling), remove(sibling));
    next = { ok: false, reason: 'concealed' };
    await click(host, m.correction_reload());
    expect(
      within(host).queryByRole('group', { name: m.candidate_confirm_title({ action: remove(sibling) }) }),
    ).toBeNull();
    next = await fixture.editors.facts.read();
    await click(host, m.correction_reload());
    expect(
      (within(field(sibling)).getByRole('textbox', { name: m.correction_value() }) as HTMLInputElement).value,
    ).toBe('fr');
    await click(row(sibling), remove(sibling));
    await click(host, m.facts_submit()); // Sealing retires even an already-open confirmation.
    expect(commands).toHaveLength(1);
    expect(within(row(sibling)).queryByRole('button', { name: remove(sibling) })).toBeNull();
    await act(async () => finish({ ok: false, reason: 'uncertain' }));
    expect(within(row(sibling)).queryByRole('button', { name: remove(sibling) })).toBeNull();
    expect(commands[0]!.statement.value).toEqual({ type: 'value', content: 'fr' });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
