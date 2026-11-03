import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import type { FactCommand, FactsCurrent } from '../src/features/catalogue/subject-facts';
import type { CandidateTransport } from '../src/subject/candidate-review';

mock.module('cloudflare:workers', () => ({ env: {} }));

async function mounted(
  run: (page: { host: HTMLElement; render: (node: ReactNode) => Promise<void>; assigned: string[] }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/catalogue/character', width: 390 });
  const assigned: string[] = [];
  window.location.assign = ((url: string) => {
    assigned.push(String(url));
  }) as typeof window.location.assign;
  const names =
    'window document navigator HTMLElement HTMLButtonElement HTMLFormElement HTMLInputElement HTMLSelectElement Element Node DocumentFragment Document ShadowRoot MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame matchMedia IS_REACT_ACT_ENVIRONMENT sessionStorage'.split(
      ' ',
    );
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value:
        name === 'window'
          ? window
          : name === 'IS_REACT_ACT_ENVIRONMENT'
            ? true
            : name === 'sessionStorage'
              ? window.sessionStorage
              : window[name as keyof typeof window],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    await run({
      host,
      assigned,
      render: async (node) => act(async () => root.render(node)),
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

function button(region: ParentNode, name: string) {
  const found = [...region.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === name);
  expect(found).toBeDefined();
  return found!;
}

test('a missing classification concept returns to the exact unsent holder and requires an explicit choice', async () => {
  await mounted(async ({ host, render, assigned }) => {
    const { CharacterClassifications } = await import('../src/features/catalogue/character-profile-classification');
    const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
    const { m } = await import('../src/paraglide/messages.js');
    const { characterProfileFixture, characterProfileId } =
      await import('../src/kernel/fake/catalogue-character-profile');
    const {
      beginClassificationReturn,
      claimClassificationReturn,
      readClassificationCreateHandoff,
      recordCreatedClassificationIdentity,
    } = await import('../src/features/catalogue/classification-create-return');
    const fixture = characterProfileFixture();
    const read: FactsCurrent = {
      ok: true,
      public: fixture.character,
      release: structuredClone(fixture.release),
      source: null,
    };
    const commands: FactCommand[] = [];
    const transport = {
      ...fixture.props.facts(characterProfileId),
      propose: async (command: FactCommand) => {
        commands.push(command);
        return { ok: true as const, kind: 'proposed-awaiting-review' as const, candidate: 'c1', revision: 2 };
      },
    };
    const review = (): CandidateTransport => fixture.props.review(characterProfileId, 'schema:keywords');
    const editor = (token?: string) =>
      h(
        CatalogueCurrentReading,
        { visible: true, ready: true, revision: token ?? 'current' },
        h(CharacterClassifications, {
          changedSetReview: true,
          properties: ['schema:keywords'],
          read,
          locale: 'en',
          search: async () => [],
          transport,
          review,
          handoffReader: 'reader-classification',
          handoffReaderLive: () => true,
          ...(token ? { handoffToken: token } : {}),
        }),
      );
    await render(editor());
    await act(async () => button(host, m.facts_edit_field()).click());
    expect(button(host, m.classification_create_missing())).toBeTruthy();
    await act(async () => button(host, m.classification_create_missing()).click());
    const created = assigned.at(-1);
    expect(created).toContain('/en/catalogue/concept?classificationHandoff=');
    const token = new URL(created!, 'https://site.invalid').searchParams.get('classificationHandoff');
    expect(token).toBeTruthy();
    const stored = readClassificationCreateHandoff(token!);
    expect(stored?.sourceId).toBe(characterProfileId);
    expect(stored?.propertyId).toBe('schema:keywords');
    expect(stored?.drafts[0]?.statement.rank).toBe('normal');
    const identity = {
      id: '00000000-0000-4000-8000-00000000c101',
      type: 'skos:Concept',
      label: 'Night',
      bases: ['schema:Thing'],
    };
    expect(
      recordCreatedClassificationIdentity(token!, characterProfileId, 'reader-classification', identity.id, identity)
        ?.phase,
    ).toBe('ready');
    expect(beginClassificationReturn(token!, characterProfileId, 'reader-classification')).toBe(true);
    expect(claimClassificationReturn(crypto.randomUUID(), characterProfileId, 'reader-classification')).toBeUndefined();
    await render(editor(token!));
    expect(host.textContent).toContain(identity.id);
    expect(host.textContent).toContain(
      m.classification_create_created_identity({ label: identity.label, type: identity.type }),
    );
    expect(host.querySelector<HTMLInputElement>('[role="combobox"]')?.value ?? '').toBe('');
    await act(async () => button(host, m.classification_create_choose()).click());
    expect(host.querySelector<HTMLInputElement>('[role="combobox"]')?.value ?? '').toBe(m.subject_value_unlabelled());
    expect(
      [...host.querySelectorAll('button')].some((node) => node.textContent === m.classification_create_choose()),
    ).toBe(false);
    expect(commands).toEqual([]);
  });
});

test('independent classification callers keep create-missing off and a cancelled return restores the private draft', async () => {
  await mounted(async ({ host, render, assigned }) => {
    const { CharacterClassifications } = await import('../src/features/catalogue/character-profile-classification');
    const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
    const { m } = await import('../src/paraglide/messages.js');
    const { characterProfileFixture, characterProfileId } =
      await import('../src/kernel/fake/catalogue-character-profile');
    const { beginClassificationDraftReturn, readClassificationCreateHandoff } =
      await import('../src/features/catalogue/classification-create-return');
    const fixture = characterProfileFixture();
    const read: FactsCurrent = {
      ok: true,
      public: fixture.character,
      release: structuredClone(fixture.release),
      source: null,
    };
    const transport = fixture.props.facts(characterProfileId);
    const review = (): CandidateTransport => fixture.props.review(characterProfileId, 'schema:keywords');
    await render(
      h(
        CatalogueCurrentReading,
        { visible: true, ready: true, revision: 'independent' },
        h(CharacterClassifications, {
          properties: ['schema:keywords'],
          read,
          locale: 'en',
          search: async () => [],
          transport,
          review,
          handoffReader: 'reader-classification',
          handoffReaderLive: () => true,
        }),
      ),
    );
    await act(async () => button(host, m.facts_edit_field()).click());
    expect(
      [...host.querySelectorAll('button')].some((node) => node.textContent === m.classification_create_missing()),
    ).toBe(false);
    await render(
      h(
        CatalogueCurrentReading,
        { visible: true, ready: true, revision: 'changed' },
        h(CharacterClassifications, {
          changedSetReview: true,
          properties: ['schema:keywords'],
          read,
          locale: 'en',
          search: async () => [],
          transport,
          review,
          handoffReader: 'reader-classification',
          handoffReaderLive: () => true,
        }),
      ),
    );
    await act(async () => button(host, m.facts_edit_field()).click());
    await act(async () => button(host, m.classification_create_missing()).click());
    const token = new URL(assigned.at(-1)!, 'https://site.invalid').searchParams.get('classificationHandoff')!;
    expect(beginClassificationDraftReturn(token, characterProfileId, 'reader-classification')).toBe(true);
    await render(
      h(
        CatalogueCurrentReading,
        { visible: true, ready: true, revision: token },
        h(CharacterClassifications, {
          changedSetReview: true,
          properties: ['schema:keywords'],
          read,
          locale: 'en',
          search: async () => [],
          transport,
          review,
          handoffReader: 'reader-classification',
          handoffReaderLive: () => true,
          handoffToken: token,
        }),
      ),
    );
    expect(host.textContent).not.toContain(m.classification_create_choose());
    expect(readClassificationCreateHandoff(token)?.phase).toBe('returned');
  });
});
