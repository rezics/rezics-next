import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, type ChangeEvent } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CreateResult } from '../src/features/catalogue/create-subject';
import type { PeopleCommand } from '../src/features/catalogue/people-profile';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('People removal retains scalar, citation and sibling correction identities until confirmation and obeys current locks', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/catalogue/people' });
  const globals: Record<string, unknown> = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of [
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'Document',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
  ])
    globals[key] = Reflect.get(window, key);
  for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
    globals[key] = Reflect.get(window, key).bind(window);
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { PeopleProfileEditor } = await import('../src/features/catalogue/people-profile-view');
  const { peopleProfileFixture } = await import('../src/kernel/fake/catalogue-people-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document, delay: null });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host),
    fixture = peopleProfileFixture('invalid');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let metadata = true,
    unsupported = false,
    pending = false;
  let finish: (result: CreateResult) => void = () => {};
  const commands: PeopleCommand[] = [];
  const transport = {
    ...fixture.transport,
    load: async () => {
      const read = await fixture.transport.load();
      if (!metadata) return { ok: false as const, reason: 'unavailable' as const };
      if (read.ok && unsupported)
        read.profiles.forEach((profile) => {
          profile.fields = profile.fields.filter((property) => property !== 'schema:url');
        });
      return read;
    },
    create: async (command: PeopleCommand) => {
      commands.push(command);
      return pending
        ? new Promise<CreateResult>((resolve) => {
            finish = resolve;
          })
        : fixture.transport.create(command);
    },
  };
  const canvas = () => within(host);
  const row = (property: string) => host.querySelector<HTMLElement>(`fieldset[id="people-fact-${property}"]`)!;
  const remove = (property: string) =>
    within(row(property)).getByRole('button', { name: m.people_profile_remove_fact() });
  const click = (element: HTMLElement) => act(async () => user.click(element));
  const add = (property: string) =>
    click(
      canvas().getByRole('button', {
        name: m.people_profile_add_fact({ field: fixture.release.properties[property]!.labels.en! }),
      }),
    );
  const refresh = () =>
    act(async () => {
      await client.invalidateQueries({ queryKey: ['people-profile'] });
    });
  const submit = () => click(canvas().getByRole('button', { name: m.catalogue_create_submit() }));
  // Retain the handlers actually delivered to mounted controls, including their captured row.
  const props = (node: HTMLElement) =>
    Reflect.get(node, Object.keys(node).find((key) => key.startsWith('__reactProps$'))!);
  const retain = (input: HTMLInputElement) => {
    const change = props(input).onChange as (event: ChangeEvent<HTMLInputElement>) => void;
    return (value: string) => change({ target: { value } } as ChangeEvent<HTMLInputElement>);
  };
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            observed={{ state: 'signed-in', subject: 'person', csrfToken: 'token' }}
            address="removal"
          >
            <PeopleProfileEditor
              locale="en"
              session="signed-in"
              transport={transport}
              propose={fixture.propose}
              review={fixture.review}
              onNavigate={() => {}}
            />
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
    await waitFor(() => expect(canvas().getByRole('combobox', { name: m.catalogue_create_type() })).toBeDefined());
    await act(async () =>
      user.selectOptions(canvas().getByRole('combobox', { name: m.catalogue_create_type() }), 'schema:Person'),
    );
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Person'));
    for (const property of ['schema:sameAs', 'schema:url']) {
      await add(property);
      await act(async () => {
        await user.type(
          within(row(property)).getByRole('textbox', { name: m.correction_url() }),
          `https://example.org/${property}`,
        );
        await user.type(
          within(row(property)).getByRole('textbox', { name: m.relation_citation() }),
          'https://example.org/source',
        );
      });
    }
    await submit();
    const sibling = row('schema:url');
    const inputs = [...sibling.querySelectorAll<HTMLInputElement>('input')];
    const snapshot = inputs.map((input) => [input.id, input.value]);
    const correction = () => host.querySelector<HTMLAnchorElement>(`a[href="#${inputs[0]!.id}"]`)!;
    expect(correction()).not.toBeNull();
    const selected = row('schema:sameAs');
    const selectedInputs = [...selected.querySelectorAll<HTMLInputElement>('input')];
    const retiredEdits = selectedInputs.map(retain);
    for (const cancel of ['button', 'escape']) {
      await click(remove('schema:sameAs'));
      const button = within(selected).getByRole('button', { name: m.candidate_cancel() });
      expect(window.document.activeElement).toBe(button);
      if (cancel === 'button') await click(button);
      else await act(async () => user.keyboard('{Escape}'));
      expect(window.document.activeElement).toBe(remove('schema:sameAs'));
      expect([...selected.querySelectorAll('input')]).toEqual(selectedInputs);
      expect(selectedInputs.map((input) => input.value)).toEqual([
        'https://example.org/schema:sameAs',
        'https://example.org/source',
      ]);
      expect(inputs.map((input) => [input.id, input.value])).toEqual(snapshot);
      expect(correction()).not.toBeNull();
    }
    await click(remove('schema:sameAs'));
    await click(remove('schema:sameAs'));
    expect(row('schema:sameAs')).toBeNull();
    expect(row('schema:url')).toBe(sibling);
    expect(sibling.contains(window.document.activeElement as Node)).toBe(true);
    const deliverRetired = () => act(async () => retiredEdits.forEach((edit) => edit('https://retired.test/')));
    await deliverRetired();
    expect(row('schema:sameAs')).toBeNull();
    expect(inputs[0]!.getAttribute('aria-invalid')).toBe('true');
    await add('schema:sameAs');
    const replacement = [...row('schema:sameAs').querySelectorAll<HTMLInputElement>('input')];
    expect(replacement[0]!.id).not.toBe(selectedInputs[0]!.id);
    await deliverRetired();
    expect(replacement.map((input) => input.value)).toEqual(['', '']);
    const [editValue, editCitation] = replacement.map(retain);
    await act(async () => {
      editValue!('https://current.test/');
      editCitation!('https://current.test/source');
    });
    expect(replacement.map((input) => input.value)).toEqual(['https://current.test/', 'https://current.test/source']);
    await act(async () =>
      user.selectOptions(canvas().getByRole('combobox', { name: m.catalogue_create_type() }), 'schema:Organization'),
    );
    await act(async () => editValue!('https://wrong-type.test/'));
    await act(async () =>
      user.selectOptions(canvas().getByRole('combobox', { name: m.catalogue_create_type() }), 'schema:Person'),
    );
    expect([...row('schema:sameAs').querySelectorAll<HTMLInputElement>('input')].map((input) => input.value))
      .toEqual(['https://current.test/', 'https://current.test/source']);
    await act(async () => editCitation!('https://retired-type.test/'));
    expect(within(row('schema:sameAs')).getByRole('textbox', { name: m.relation_citation() }).value)
      .toBe('https://current.test/source');
    await click(remove('schema:sameAs'));
    await click(remove('schema:sameAs'));
    expect(inputs.map((input) => [input.id, input.value])).toEqual(snapshot);
    await submit();
    expect(correction()).not.toBeNull();
    await click(correction());
    expect(window.document.activeElement).toBe(inputs[0]);
    // A citation alone is populated, even after its main value has been cleared.
    await act(async () => user.clear(inputs[0]!));
    await click(remove('schema:url'));
    await click(within(sibling).getByRole('button', { name: m.candidate_cancel() }));
    expect(inputs[1]!.value).toBe('https://example.org/source');
    await click(remove('schema:url'));
    const unavailableEdits = inputs.map(retain);
    metadata = false;
    await refresh();
    await act(async () => unavailableEdits.forEach((edit) => edit('https://unavailable.test/')));
    expect(inputs.map((input) => input.value)).toEqual(['', 'https://example.org/source']);
    expect(remove('schema:url').disabled).toBe(true);
    await act(async () => remove('schema:url').dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(row('schema:url')).toBe(sibling);
    metadata = true;
    await refresh();
    unsupported = true;
    await refresh();
    await click(remove('schema:url'));
    expect(row('schema:url')).toBeNull();
    await add('schema:sameAs');
    await click(remove('schema:sameAs'));
    expect(row('schema:sameAs')).toBeNull();
    expect(window.document.activeElement?.textContent).toBe(
      m.people_profile_add_fact({
        field: fixture.release.properties['wdt:P648']!.labels.en!,
      }),
    );
    unsupported = false;
    await refresh();
    await add('schema:url');
    await act(async () => {
      await user.type(
        within(row('schema:url')).getByRole('textbox', { name: m.correction_url() }),
        'https://example.org/restored',
      );
      await user.type(
        within(row('schema:url')).getByRole('textbox', { name: m.relation_citation() }),
        'https://example.org/source',
      );
    });
    await click(remove('schema:url'));
    const sealed = row('schema:url');
    const sealedInputs = [...sealed.querySelectorAll<HTMLInputElement>('input')];
    const lockedEdits = sealedInputs.map(retain);
    const sealedDraft = sealedInputs.map((input) => input.value);
    const staleAdd = props(canvas().getByRole('button', {
      name: m.people_profile_add_fact({ field: fixture.release.properties['schema:sameAs']!.labels.en! }),
    })).onClick;
    const deliverLocked = () => act(async () => {
      lockedEdits.forEach((edit) => edit('https://locked.test/'));
      staleAdd();
    });
    pending = true;
    await submit();
    const command = structuredClone(commands.at(-1));
    await deliverLocked();
    expect(sealedInputs.map((input) => input.value)).toEqual(sealedDraft);
    expect(row('schema:sameAs')).toBeNull();
    expect(remove('schema:url').disabled).toBe(true);
    await act(async () => finish({ ok: false, reason: 'unavailable' }));
    await deliverLocked();
    expect(sealedInputs.map((input) => input.value)).toEqual(sealedDraft);
    expect(row('schema:sameAs')).toBeNull();
    expect(remove('schema:url').disabled).toBe(true);
    await act(async () => remove('schema:url').dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(row('schema:url')).toBe(sealed);
    await click(canvas().getByRole('button', { name: m.catalogue_create_retry() }));
    expect(commands.at(-1)).toEqual(command);
    await act(async () => finish({ ok: false, reason: 'unavailable' }));
    await act(async () => root.render(null));
    await deliverLocked();
    expect(commands.at(-1)).toEqual(command);
    expect(host.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    mock.restore();
  }
});
