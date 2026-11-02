import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import { useCurrentReadingVisible } from '../src/features/catalogue/editor-lifetime';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MangaCorrectionPorts } from '../src/features/catalogue/manga-profile-corrections';
import type { FactCommand } from '../src/features/catalogue/subject-facts';

mock.module('cloudflare:workers', () => ({ env: {} }));

// All assertions authored UNRUN. Actual mounted component coverage is not browser geometry,
// native authorization/lifecycle acceptance, backend growth, or private SSR proof.
async function mounted(
  run: (ui: {
    host: HTMLElement;
    client: QueryClient;
    render: (node: ReactNode) => Promise<void>;
    update: (node: ReactNode) => Promise<void>;
    input: (input: HTMLInputElement, value: string) => Promise<void>;
    click: (button: HTMLElement) => Promise<void>;
    until: (predicate: () => boolean) => Promise<void>;
  }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/subjects/manga/title/manga' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'Element',
    'Node',
    'Text',
    'NodeFilter',
    'DOMParser',
    'Range',
    'DOMRect',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === 'window'
          ? window
          : key === 'IS_REACT_ACT_ENVIRONMENT'
            ? true
            : ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key)
              ? window[key].bind(window)
              : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let generation = 0;
  const update = async (node: ReactNode) => {
    await act(async () => root.render(h(QueryClientProvider, { client }, h('div', { key: generation }, node))));
  };
  try {
    await run({
      host,
      client,
      update,
      render: async (node) => {
        generation++;
        await update(node);
      },
      click: async (button) => {
        await act(async () => button.click());
      },
      input: async (input, value) => {
        await act(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
          input.dispatchEvent(new window.Event('input', { bubbles: true }));
        });
      },
      until: async (predicate) => {
        for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
        }
        expect(predicate()).toBe(true);
      },
    });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
function NativePort({ name }: { name: string }) {
  return useCurrentReadingVisible() ? <button type="button">{name}</button> : null;
}
function button(scope: ParentNode, name: string) {
  const control = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === name,
  );
  expect(control).toBeDefined();
  return control!;
}
function heading(scope: ParentNode, level: number, name: string) {
  const node = [...scope.querySelectorAll<HTMLHeadingElement>(`h${level}`)].find((node) => node.textContent === name);
  expect(node).toBeDefined();
  return node!;
}
function field(scope: ParentNode, name: string) {
  return heading(scope, 3, name).closest('section')!;
}
function amount(scope: ParentNode, name: string) {
  return scope.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('Complete Manga correction groups and deliberate submission family retains whole mounted evidence, actions, bounds and retirement', async () => {
  await mounted(async (ui) => {
    const { MangaCorrections } = await import('../src/features/catalogue/manga-profile-corrections');
    const { MangaProfileEditor } = await import('../src/features/catalogue/manga-profile-view');
    const { mangaFixture, mangaVolumeId, mangaCreatorId, mangaVolumeCitation } =
      await import('../src/kernel/fake/catalogue-manga-profile');
    const { readMangaProfile, mangaGroups } = await import('../src/features/catalogue/manga-profile');
    const { readCandidates } = await import('../src/subject/candidates');
    const { factLimit } = await import('../src/features/catalogue/subject-facts');
    const { m } = await import('../src/paraglide/messages.js');
    const { pickText } = await import('@rezics/composition');
    const fixture = mangaFixture();
    const read = await readMangaProfile(fixture.client, mangaVolumeId);
    if (!read.ok || !read.public) throw new Error('Expected current Manga volume');
    const label = 'Attribution intégrale — ' + 'BibliographieSansAbréviation'.repeat(16);
    const credit = 'Mika Sora — ' + 'CompleteReleasedCreatorName'.repeat(16);
    const qualifier = 'Nom imprimé intégral — ' + 'SignatureOriginale'.repeat(16);
    const citation = 'https://archive.example/volume/' + 'original-record-'.repeat(24) + '?scan=A%2Fb#citation';
    read.release.properties['schema:author']!.labels = { fr: label };
    read.public.related[mangaCreatorId]!.labels = { fr: credit };
    const member = read.public.subject.statements['wdt:P179']![0]!;
    const author = structuredClone(member);
    author.id = '00000000-0000-4000-8000-00000000d191';
    author.property = { id: 'schema:author', data_type: 'wikibase-item' };
    author.value = { type: 'value', content: mangaCreatorId };
    author.qualifiers.push({
      property: { id: 'wdt:P1932', data_type: 'string' },
      value: { type: 'value', content: qualifier },
    });
    author.references = [
      {
        hash: 'citation',
        parts: [
          { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: citation } },
          {
            property: { id: 'schema:name', data_type: 'monolingualtext' },
            value: { type: 'value', content: { text: '原本の完全な書誌', language: 'ja' } },
          },
        ],
      },
    ];
    read.public.subject.statements['schema:author'] = [author];
    read.public.subject.statements['wdt:P179'] = [
      member,
      ...(['somevalue', 'novalue'] as const).map((type, index) => ({
        ...structuredClone(member),
        id: `00000000-0000-4000-8000-00000000d19${index + 2}`,
        value: { type },
      })),
    ];
    const before = structuredClone(read.public);
    const initialCalls = structuredClone(fixture.calls);
    expect(initialCalls).toHaveLength(3);
    expect(initialCalls.map((call) => call.path)).toContain('/v1/definitions/active');
    expect(initialCalls.map((call) => call.path)).toContain(`/v1/subjects/${mangaVolumeId}`);
    expect(initialCalls.some((call) => call.path.startsWith('/v1/definitions/releases/'))).toBe(true);
    const commands: FactCommand[] = [];
    const addresses: unknown[] = [];
    let reloads = 0;
    const ports: MangaCorrectionPorts = {
      facts: {
        read: async () => {
          throw new Error('Unexpected fact read');
        },
        propose: (command) => {
          commands.push(command);
          return fixture.propose(command);
        },
      },
      review: (property, session) => {
        addresses.push([property, session]);
        return {
          reader: 'fixture',
          read: async (selected, cursor, continuity) => {
            addresses.push([selected, cursor, continuity]);
            const result = await readCandidates(
              fixture.client,
              'Bearer fixture',
              mangaVolumeId,
              selected,
              cursor,
              undefined,
              continuity ?? session,
            );
            return result.ok
              ? {
                  ...result,
                  fields: [{ id: property, label: pickText(read.release.properties[property]!.labels, 'en').text }],
                }
              : result;
          },
          confirm: async () => {
            throw new Error('Unexpected automatic confirmation');
          },
        };
      },
      relations: <NativePort name="Native relation port" />,
      authored: <NativePort name="Native authored port" />,
    };
    const pair = (
      <>
        {[0, 1].map((index) => (
          <div key={index} data-mount={index} dir={index ? 'rtl' : 'ltr'}>
            <MangaCorrections
              read={read}
              locale="en"
              disabled={false}
              ports={ports}
              reload={async () => {
                reloads++;
              }}
            />
          </div>
        ))}
      </>
    );
    await ui.render(pair);
    const mounts = [...ui.host.querySelectorAll<HTMLElement>('[data-mount]')];
    const first = mounts[0]!,
      second = mounts[1]!;
    for (const mount of mounts) {
      const groups = mangaGroups(read.release, read.public.subject.type, 'en');
      expect([...mount.querySelectorAll(':scope > div > section > h2')].map((node) => node.textContent)).toEqual([
        m.manga_membership(),
        m.manga_creators(),
        m.manga_publication(),
        m.manga_classification(),
      ]);
      expect(Object.values(groups).flat()).toContain('schema:abstract');
      expect(button(mount, 'Native relation port')).toBeDefined();
      expect(button(mount, 'Native authored port')).toBeDefined();
      const fallback = field(mount, label);
      expect(fallback.querySelector('h3')?.getAttribute('lang')).toBe('fr');
      expect(fallback.querySelector(':scope > div')?.className).toContain('isolate');
      expect(fallback.textContent).toContain(credit);
      expect(fallback.textContent).toContain(qualifier);
      expect(fallback.querySelector('[lang="ja"]')?.textContent).toBe('原本の完全な書誌');
      expect([...fallback.querySelectorAll('dt')].map((node) => node.textContent?.trim().replace(/:$/, ''))).toEqual([
        'position',
        pickText(read.release.properties['wdt:P1932']!.labels, 'en').text,
        'URL',
        'name',
      ]);
      expect([...fallback.querySelectorAll<HTMLAnchorElement>('a')].map((node) => node.getAttribute('href'))).toEqual([
        expect.stringContaining(mangaCreatorId),
        citation,
      ]);
      expect(fallback.querySelector('input, select, button, [data-slot="list-row-link"]')).toBeNull();
      for (const node of fallback.querySelectorAll<HTMLElement>('h3, dt, dd, a'))
        expect(node.className).not.toMatch(/truncate|line-clamp/);
      const membership = field(mount, pickText(read.release.properties['wdt:P179']!.labels, 'en').text);
      expect(membership.textContent).toContain(m.subject_value_unknown());
      expect(membership.textContent).toContain(m.subject_value_none());
      const genre = field(mount, pickText(read.release.properties['schema:genre']!.labels, 'en').text);
      expect(genre.textContent).toContain(m.facts_no_value());
      expect(genre.querySelector('button')).toBeNull();
      const count = heading(mount, 2, m.facts_selection({ count: 0, limit: factLimit }));
      expect(count.getAttribute('data-content-item-slot')).toBe('title');
      const submit = button(mount, m.facts_submit());
      expect(submit.disabled).toBe(true);
      expect(submit.className).toContain('min-h-11');
      expect(submit.className).toContain('whitespace-normal');
      expect(submit.parentElement?.className).toContain('flex-wrap');
      expect(button(mount, m.correction_reload()).disabled).toBe(false);
      const header = mount.querySelector('header')!;
      const identity = header.querySelector('h2')!;
      const reference = [...header.querySelectorAll('summary')].find(
        (node) => node.textContent === m.specialist_identity_reference(),
      )!;
      expect(identity.compareDocumentPosition(reference) & 4).toBeTruthy();
      expect(reference.closest('details')!.open).toBe(false);
      expect([...reference.closest('details')!.querySelectorAll('code')].map((node) => node.textContent)).toEqual([
        mangaVolumeId,
        'schema:PublicationVolume',
      ]);
      expect(mount.querySelector('a a, a button')).toBeNull();
    }
    expect(fixture.calls).toEqual(initialCalls);
    const pages = field(first, 'number of pages');
    const otherPages = field(second, 'number of pages');
    await ui.click(button(pages, m.facts_edit_field()));
    expect(amount(pages, m.correction_amount()).value).toBe('+192');
    expect(pages.querySelector<HTMLSelectElement>(`select[aria-label="${m.correction_unit()}"]`)!.value).toBe('1');
    expect(amount(pages, m.correction_value()).value).toBe(mangaVolumeCitation);
    expect(pages.textContent).toContain(m.facts_unchanged());
    expect(button(first, m.facts_submit()).disabled).toBe(true);
    expect(otherPages.querySelector('input')).toBeNull();
    await ui.click(button(field(first, 'ISBN-13'), m.facts_edit_field()));
    expect(button(first, m.facts_submit()).disabled).toBe(true);
    await ui.input(amount(pages, m.correction_amount()), '+196');
    heading(first, 2, m.facts_selection({ count: 1, limit: factLimit }));
    const include = pages.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const includeLabel = [...pages.querySelectorAll<HTMLLabelElement>('label')].find(
      (node) => node.htmlFor === include.id,
    )!;
    expect(includeLabel).toBeDefined();
    await ui.click(includeLabel);
    heading(first, 2, m.facts_selection({ count: 0, limit: factLimit }));
    expect(button(first, m.facts_submit()).disabled).toBe(true);
    await ui.click(includeLabel);
    await ui.click(button(otherPages, m.facts_edit_field()));
    expect(otherPages.querySelector<HTMLInputElement>('input[type="checkbox"]')!.id).not.toBe(include.id);
    expect(amount(otherPages, m.correction_amount()).value).toBe('+192');
    expect(button(second, m.facts_submit()).disabled).toBe(true);
    expect(commands).toEqual([]);
    expect(fixture.calls).toEqual(initialCalls);
    await ui.click(button(first, m.facts_submit()));
    expect(commands).toHaveLength(1);
    expect(commands[0]!.statement.value).toEqual({ type: 'value', content: { amount: '+196', unit: '1' } });
    expect(commands[0]!.statement.references[0]!.parts[0]!.value).toEqual({
      type: 'value',
      content: mangaVolumeCitation,
    });
    expect(pages.textContent).toContain(m.correction_proposed());
    expect(pages.querySelector('h4')?.textContent).toBe(m.candidate_current());
    heading(first, 2, m.facts_selection({ count: 0, limit: factLimit }));
    expect(button(first, m.facts_submit()).disabled).toBe(true);
    const write = fixture.calls.filter((call) => call.method === 'POST');
    expect(write).toHaveLength(1);
    expect(write[0]).toMatchObject({
      path: `/v1/subjects/${mangaVolumeId}/candidates`,
      authorization: 'Bearer fixture',
      key: commands[0]!.key,
      body: { statement: commands[0]!.statement },
    });
    expect(fixture.calls.filter((call) => call.method === 'GET')).toEqual(initialCalls);
    const review = [...pages.querySelectorAll<HTMLAnchorElement>('a')].find(
      (node) => node.textContent === m.correction_review(),
    )!;
    const candidate = [...fixture.candidates.keys()][0]!;
    expect(review.getAttribute('href')).toContain(
      new URLSearchParams({ reviewProperty: 'schema:numberOfPages', candidate }).toString(),
    );
    expect(addresses).toEqual([]);
    await ui.click(review);
    await ui.until(() => !!ui.host.querySelector('#candidate-review h4'));
    expect(addresses).toEqual([
      ['schema:numberOfPages', 'manga-session'],
      ['schema:numberOfPages', undefined, undefined],
    ]);
    const exact = first.querySelector('#candidate-review')!;
    expect(exact.querySelector<HTMLSelectElement>('select')!.disabled).toBe(true);
    expect(exact.textContent).toContain('196');
    expect(exact.textContent).toContain(mangaVolumeCitation);
    expect(fixture.calls.filter((call) => call.method === 'GET')).toHaveLength(initialCalls.length + 2);
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(fixture.candidates.get(candidate)!.decision).toBeNull();
    await ui.click(button(first, m.correction_reload()));
    expect(reloads).toBe(1);
    expect(read.public).toEqual(before);

    // Genuine failed/uncertain proposal states use the existing fake/native-shaped command seam.
    for (const scenario of ['denied', 'stale', 'invalid', 'conflict', 'uncertain'] as const) {
      const failed = mangaFixture(scenario);
      const current = await readMangaProfile(failed.client, mangaVolumeId);
      if (!current.ok || !current.public) throw new Error('Expected current failed-write fixture');
      const baseline = structuredClone(current.public);
      const attempts: FactCommand[] = [];
      await ui.render(
        <MangaCorrections
          read={current}
          locale="en"
          disabled={false}
          ports={{
            ...ports,
            facts: {
              read: ports.facts.read,
              propose: (command) => {
                attempts.push(command);
                return failed.propose(command);
              },
            },
          }}
          reload={async () => {
            reloads++;
          }}
        />,
      );
      const region = field(ui.host, 'number of pages');
      await ui.click(button(region, m.facts_edit_field()));
      await ui.input(amount(region, m.correction_amount()), '+196');
      await ui.click(button(ui.host, m.facts_submit()));
      const message =
        scenario === 'denied'
          ? m.correction_denied()
          : scenario === 'invalid'
            ? m.correction_invalid()
            : scenario === 'uncertain'
              ? m.facts_uncertain()
              : m.correction_stale();
      expect(region.textContent).toContain(message);
      expect(amount(region, m.correction_amount()).value).toBe('+196');
      expect(button(ui.host, m.correction_reload()).disabled).toBe(false);
      heading(ui.host, 2, m.facts_selection({ count: 1, limit: factLimit }));
      const original = structuredClone(attempts[0]!);
      if (scenario === 'uncertain') {
        expect(amount(region, m.correction_amount()).disabled).toBe(true);
        expect(region.querySelector('a[href*="candidate="]')).toBeNull();
        await ui.click(button(ui.host, m.facts_submit()));
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toBe(attempts[0]);
        expect(attempts[1]).toEqual(original);
        const writes = failed.calls.filter((call) => call.method === 'POST');
        expect(writes).toHaveLength(2);
        expect(writes[1]).toEqual(writes[0]);
        expect(region.textContent).toContain(m.correction_proposed());
      } else {
        expect(amount(region, m.correction_amount()).disabled).toBe(false);
        await ui.input(amount(region, m.correction_amount()), '+200');
        failed.setScenario('ready');
        await ui.click(button(ui.host, m.facts_submit()));
        expect(attempts[1]!.key).not.toBe(original.key);
        expect(attempts[1]!.statement.value).toEqual({ type: 'value', content: { amount: '+200', unit: '1' } });
        expect(region.textContent).toContain(m.correction_proposed());
      }
      expect(failed.calls.filter((call) => call.method === 'GET')).toHaveLength(3);
      expect(current.public).toEqual(baseline);
    }

    // While deliberate submission is in flight, controls and reload stay disabled, and a
    // duplicate activation cannot begin a second native attempt. Separate outcomes remain visible.
    const partial = mangaFixture();
    const partialRead = await readMangaProfile(partial.client, mangaVolumeId);
    if (!partialRead.ok || !partialRead.public) throw new Error('Expected partial-result fixture');
    const pending = deferred<Awaited<ReturnType<typeof partial.propose>>>();
    const partialCommands: FactCommand[] = [];
    await ui.render(
      <MangaCorrections
        read={partialRead}
        locale="en"
        disabled={false}
        ports={{
          ...ports,
          facts: {
            read: ports.facts.read,
            propose: (command) => {
              partialCommands.push(command);
              return command.statement.property.id === 'schema:numberOfPages'
                ? pending.promise
                : Promise.resolve({ ok: false as const, reason: 'denied' as const });
            },
          },
        }}
        reload={async () => {
          reloads++;
        }}
      />,
    );
    const partialPages = field(ui.host, 'number of pages');
    const languageName = pickText(partialRead.release.properties['schema:inLanguage']!.labels, 'en').text;
    const partialLanguage = field(ui.host, languageName);
    await ui.click(button(partialPages, m.facts_edit_field()));
    await ui.input(amount(partialPages, m.correction_amount()), '+196');
    await ui.click(button(partialLanguage, m.facts_edit_field()));
    await ui.input(amount(partialLanguage, m.correction_value()), 'ja');
    heading(ui.host, 2, m.facts_selection({ count: 2, limit: factLimit }));
    const submit = button(ui.host, m.facts_submit());
    await ui.click(submit);
    expect(partialCommands).toHaveLength(2);
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe(m.correction_saving());
    expect(button(ui.host, m.correction_reload()).disabled).toBe(true);
    expect(amount(partialPages, m.correction_amount()).disabled).toBe(true);
    await ui.click(submit);
    expect(partialCommands).toHaveLength(2);
    const success = await partial.propose(
      partialCommands.find((command) => command.statement.property.id === 'schema:numberOfPages')!,
    );
    await act(async () => pending.resolve(success));
    expect(partialPages.textContent).toContain(m.correction_proposed());
    expect(partialLanguage.textContent).toContain(m.correction_denied());
    heading(ui.host, 2, m.facts_selection({ count: 1, limit: factLimit }));
    expect(button(ui.host, m.facts_submit()).disabled).toBe(false);
    expect(button(ui.host, m.correction_reload()).disabled).toBe(false);
    expect(partial.calls.filter((call) => call.method === 'GET')).toHaveLength(3);
    expect(partial.calls.filter((call) => call.method === 'POST')).toHaveLength(1);

    // Truthful missing/disabled inputs: no supplied subject means no fallback fact or action panel.
    await ui.render(
      <MangaCorrections
        read={undefined}
        locale="en"
        disabled={true}
        ports={ports}
        reload={async () => {
          reloads++;
        }}
      />,
    );
    expect(ui.host.querySelector('header')).toBeNull();
    expect(ui.host.textContent).not.toContain(m.facts_submit());
    expect(ui.host.textContent).not.toContain('Native relation port');
    for (const disabled of [true, false]) {
      await ui.render(
        <MangaCorrections
          read={read}
          locale="en"
          disabled={disabled}
          {...(disabled ? { ports } : {})}
          reload={async () => {
            reloads++;
          }}
        />,
      );
      if (disabled) {
        expect(ui.host.querySelector('header')).toBeNull();
        continue;
      }
      expect(button(field(ui.host, 'number of pages'), m.facts_edit_field()).disabled).toBe(true);
      expect(button(ui.host, m.facts_submit()).disabled).toBe(true);
      expect(button(ui.host, m.correction_reload()).disabled).toBe(false);
    }

    const empty = mangaFixture('empty');
    await ui.render(
      <MangaCorrections
        read={{ ok: true, release: empty.release, public: empty.reads.get(mangaVolumeId)! }}
        locale="en"
        disabled={false}
        ports={ports}
        reload={async () => undefined}
      />,
    );
    expect(ui.host.querySelector('header')).not.toBeNull();
    expect(ui.host.querySelector('h3')).toBeNull();
    heading(ui.host, 2, m.facts_selection({ count: 0, limit: factLimit }));
    expect(button(ui.host, m.facts_submit()).disabled).toBe(true);
    expect(ui.host.textContent).not.toContain('Native authored port');

    // Supplied-data growth only: distinct relation targets are admitted per-target slots, below
    // the 512-fact subject bound. No simulated backend scan or 64-command submission is claimed.
    for (const size of [1, 8, 64]) {
      const growth = mangaFixture();
      const current = await readMangaProfile(growth.client, mangaVolumeId);
      if (!current.ok || !current.public) throw new Error('Expected supplied growth DTO');
      const source = current.public.subject.statements['wdt:P179']![0]!;
      current.public.subject.statements['wdt:P179'] = Array.from({ length: size }, (_, index) => {
        const id = `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`;
        current.public!.related[id] = { type: 'schema:ComicSeries', labels: { en: `Supplied series ${index}` } };
        return { ...structuredClone(source), id, value: { type: 'value' as const, content: id } };
      });
      const snapshot = structuredClone(current.public);
      const calls = structuredClone(growth.calls);
      await ui.render(
        <MangaCorrections read={current} locale="en" disabled={false} ports={ports} reload={async () => undefined} />,
      );
      const membership = field(ui.host, 'part of the series');
      expect(membership.querySelectorAll('a')).toHaveLength(size);
      expect(membership.querySelectorAll('dd')).toHaveLength(size);
      expect(membership.querySelectorAll('[data-slot="list-row-link"]')).toHaveLength(0);
      expect(growth.calls).toEqual(calls);
      expect(current.public).toEqual(snapshot);
    }

    // The actual caller fences retired load/reload callbacks. It resets the private correction
    // workspace by address; a late original read cannot replace the newly mounted subject.
    const retired = mangaFixture();
    const held = deferred<Awaited<ReturnType<typeof readMangaProfile>>>();
    let loads = 0;
    const transport = {
      ...retired.transport,
      load: () => {
        loads++;
        return held.promise;
      },
    };
    const search = async () => [];
    const caller = (id: string) => (
      <MangaProfileEditor
        id={id}
        locale="en"
        session="signed-in"
        transport={transport}
        search={search}
        correction={ports}
      />
    );
    await ui.render(caller(mangaVolumeId));
    await ui.until(() => loads === 1);
    await ui.update(caller('00000000-0000-4000-8000-00000000d101'));
    await ui.until(() => loads === 2);
    await act(async () => held.resolve({ ok: false, reason: 'unavailable' }));
    await ui.until(() => !!ui.host.querySelector('[role="alert"]'));
    const retiredReload = button(ui.host, m.correction_reload());
    const reactKey = Object.keys(retiredReload).find((key) => key.startsWith('__reactProps$'))!;
    const queued = (Reflect.get(retiredReload, reactKey) as { onClick: (event: unknown) => unknown }).onClick;
    await ui.render(<p>Replacement workspace</p>);
    const count = loads;
    await act(async () => {
      void queued({ currentTarget: retiredReload, preventDefault() {} });
    });
    expect(loads).toBe(count);
    expect(ui.host.textContent).toBe('Replacement workspace');
  });
});

test('Manga refusal retires nested readings, retains exact commands and drafts, and requires deliberate matching recovery', async () => {
  await mounted(async (ui) => {
    const { MangaProfileEditor } = await import('../src/features/catalogue/manga-profile-view');
    const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
    const { RelationEditor } = await import('../src/features/catalogue/relation-editor');
    const { AuthoredField } = await import('../src/features/catalogue/authored-field-view');
    const { mangaFixture, mangaVolumeId } = await import('../src/kernel/fake/catalogue-manga-profile');
    const { relationFixture } = await import('../src/kernel/fake/catalogue-relations');
    const { authoredFixture } = await import('../src/kernel/fake/authored-field');
    const { m } = await import('../src/paraglide/messages.js');
    const callback = (node: Element, name: string) =>
      Reflect.get(
        node,
        Object.keys(node).find((key) => key.startsWith('__reactProps$'))!,
      )[name];
    for (const refusal of ['concealed', 'throw'] as const) {
      const manga = mangaFixture();
      const { readMangaProfile } = await import('../src/features/catalogue/manga-profile');
      const current = await readMangaProfile(manga.client, mangaVolumeId);
      if (!current.ok || !current.public) throw new Error('Missing Manga reading');
      const relation = relationFixture();
      const authored = authoredFixture();
      const relationRead = mock(relation.transport.read);
      const authoredRead = mock(authored.transport.read);
      const relationInitial = await relation.transport.read(relation.slot);
      const authoredInitial = await authored.transport.read();
      const late = deferred<Awaited<ReturnType<typeof authored.transport.propose>>>();
      const authoredPropose = mock((_: Parameters<typeof authored.transport.propose>[0]) =>
        authoredPropose.mock.calls.length === 1
          ? late.promise
          : Promise.resolve({ ok: false as const, reason: 'unavailable' as const }),
      );
      const relationPropose = mock(async (_: Parameters<typeof relation.transport.propose>[0]) => ({
        ok: false as const,
        reason: 'unavailable' as const,
      }));
      const propose = mock(async (_: FactCommand) => ({ ok: false as const, reason: 'uncertain' as const }));
      const ports: MangaCorrectionPorts = {
        facts: {
          read: async () => {
            throw new Error('Unexpected scalar read');
          },
          propose,
        },
        review: () => {
          throw new Error('Unexpected review');
        },
        relations: (
          <RelationEditor
            id={relation.id}
            locale="en"
            initial={relationInitial}
            search={async () => []}
            composition={{ statement: relation.draft, slot: relation.slot, positionEditable: true }}
            transport={{ ...relation.transport, read: relationRead, propose: relationPropose }}
          />
        ),
        authored: (
          <AuthoredField
            initial={authoredInitial}
            locale="en"
            confirm={authored.confirm}
            transport={{ ...authored.transport, read: authoredRead, propose: authoredPropose }}
          />
        ),
      };
      let next = current;
      let fail = false;
      let csrfToken = 'first-session';
      const load = async () => {
        if (fail) {
          if (refusal === 'throw') throw new Error('Current reading unavailable');
          return { ok: false as const, reason: 'concealed' as const };
        }
        return next;
      };
      const page = () => (
        <CandidateReaderBoundary address="manga" observed={{ state: 'signed-in', subject: 'viewer', csrfToken }}>
          <MangaProfileEditor
            id={mangaVolumeId}
            locale="en"
            session="signed-in"
            search={async () => []}
            transport={{ ...manga.transport, load }}
            correction={ports}
          />
        </CandidateReaderBoundary>
      );
      const refresh = () =>
        act(async () => {
          await ui.client.refetchQueries({ queryKey: ['manga-profile', mangaVolumeId, 'en'] });
        });
      await ui.render(page());
      await ui.until(() => !!ui.host.querySelector('form'));
      const pages = field(ui.host, 'number of pages');
      await ui.click(button(pages, m.facts_edit_field()));
      await ui.input(amount(pages, m.correction_amount()), '+196');
      const scalarSubmit = button(ui.host, m.facts_submit());
      const staleScalarSubmit = callback(scalarSubmit, 'onClick');
      await ui.click(scalarSubmit);
      const relations = ui.host.querySelector(`[aria-label="${m.relation_title()}"]`)!;
      await ui.click(button(relations, m.relation_propose()));
      const confirmationSelector = `[role="group"][aria-label="${m.candidate_confirm_title({ action: m.relation_propose() })}"]`;
      const confirmation = relations.querySelector(confirmationSelector)!;
      const relationSubmit = button(confirmation, m.relation_propose());
      const staleRelationSubmit = callback(relationSubmit, 'onClick');
      await ui.click(relationSubmit);
      const form = ui.host.querySelector('form')!;
      const input = (name: string) =>
        form.querySelector<HTMLInputElement>(
          `[id="${[...form.querySelectorAll('label')].find((label) => label.textContent === name)!.htmlFor}"]`,
        )!;
      const editor = form.querySelector('[contenteditable="true"]')!;
      await act(async () => {
        editor.innerHTML = '<p>Private original Manga prose.</p>';
        editor.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        await new Promise((resolve) => setTimeout(resolve, 180));
        editor.dispatchEvent(new window.FocusEvent('blur'));
      });
      await ui.input(input(m.authored_language()), 'en');
      await ui.input(input(m.authored_licence()), 'CC-BY-4.0');
      await ui.input(input(m.authored_citation()), 'https://example.org/private-notes');
      await ui.click(form.querySelector('[role="checkbox"]')!);
      const staleAuthoredSubmit = callback(form, 'onSubmit');
      await ui.click(button(form, m.correction_submit()));
      expect(authoredPropose).toHaveBeenCalledTimes(1);
      const original = structuredClone([
        propose.mock.calls[0]![0],
        relationPropose.mock.calls[0]![0],
        authoredPropose.mock.calls[0]![0],
      ]);
      fail = true;
      await refresh();
      expect(ui.host.querySelector('header, a, input, form, [contenteditable]')).toBeNull();
      expect(ui.host.innerHTML).not.toContain('Aoi Yuki');
      expect(ui.host.innerHTML).not.toContain('An aviator');
      await act(async () => late.resolve({ ok: true, candidate: 'retired-candidate', revision: 2 }));
      fail = false;
      next = structuredClone(current);
      next.public!.subject.id = '00000000-0000-4000-8000-00000000d999';
      await refresh();
      expect(ui.host.querySelector('header, a, input, form')).toBeNull();
      next = structuredClone(current);
      next.public!.subject.type = 'schema:ComicSeries';
      await refresh();
      expect(ui.host.querySelector('header, a, input, form')).toBeNull();
      next = current;
      await refresh();
      await ui.until(() => !!ui.host.querySelector('form'));
      expect(relationRead.mock.calls).toEqual([[relation.slot, undefined, undefined]]);
      expect(authoredRead.mock.calls).toEqual([
        [authoredInitial.ok ? authoredInitial.property : '', authoredInitial.ok ? authoredInitial.session : undefined],
      ]);
      expect(ui.host.innerHTML).not.toContain('retired-candidate');
      expect(ui.host.querySelector('[contenteditable]')!.textContent).toContain('Private original Manga prose.');
      expect(amount(field(ui.host, 'number of pages'), m.correction_amount()).value).toBe('+196');
      await act(async () => {
        staleScalarSubmit();
        await staleRelationSubmit();
        await staleAuthoredSubmit({ preventDefault() {} });
      });
      expect([propose.mock.calls.length, relationPropose.mock.calls.length, authoredPropose.mock.calls.length]).toEqual(
        [1, 1, 1],
      );
      await ui.click(button(ui.host, m.facts_submit()));
      await ui.click(button(ui.host.querySelector(confirmationSelector)!, m.relation_propose()));
      await ui.click(button(ui.host, m.correction_retry()));
      expect([propose.mock.calls[1]![0], relationPropose.mock.calls[1]![0], authoredPropose.mock.calls[1]![0]]).toEqual(
        original,
      );
      csrfToken = 'replacement-session';
      await ui.update(page());
      await ui.until(() => !!ui.host.querySelector('form'));
      expect(ui.host.querySelector('[contenteditable]')!.textContent).not.toContain('Private original Manga prose.');
      expect(ui.host.textContent).not.toContain(m.facts_selection({ count: 1, limit: 12 }));
    }
  });
}, 20_000);

test('initial Manga recovery is single-flight, focuses its matching result, and retires old origins', async () => {
  await mounted(async (ui) => {
    const { MangaProfileEditor } = await import('../src/features/catalogue/manga-profile-view');
    const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
    const { mangaFixture, mangaVolumeId, mangaSeriesId } = await import('../src/kernel/fake/catalogue-manga-profile');
    const { readMangaProfile } = await import('../src/features/catalogue/manga-profile');
    const { m } = await import('../src/paraglide/messages.js');
    const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
    const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
    const user = userEvent.setup({ document });
    const fixture = mangaFixture();
    const ready = await readMangaProfile(fixture.client, mangaVolumeId);
    const outside = document.createElement('button');
    document.body.append(outside);
    const callback = (node: Element) =>
      Reflect.get(
        node,
        Object.keys(node).find((key) => key.startsWith('__reactProps$'))!,
      ).onClick;
    for (const outcome of ['ready', 'concealed', 'wrong-subject', 'address', 'reader'] as const) {
      let held = deferred<typeof ready>();
      let session = 'unavailable';
      const load = mock(() => held.promise);
      const page = (id = mangaVolumeId, csrfToken = 'original') => (
        <>
          <MangaProfileEditor locale="en" session="signed-in" transport={fixture.transport} search={async () => []} />
          <CandidateReaderBoundary address="manga" observed={{ state: 'signed-in', subject: 'viewer', csrfToken }}>
            <MangaProfileEditor
              id={id}
              locale="en"
              session={session}
              retrySession={async () => {}}
              transport={{ ...fixture.transport, load }}
              search={async () => []}
            />
          </CandidateReaderBoundary>
        </>
      );
      outside.focus();
      await ui.render(page());
      await ui.until(() => load.mock.calls.length === 1 && !!ui.host.querySelector('form'));
      const sibling = ui.host.querySelector('form')!;
      const draft = sibling.querySelector<HTMLInputElement>('input')!;
      await ui.input(draft, 'Private sibling draft');
      expect(document.activeElement).toBe(outside);
      await act(async () => {
        if (outcome === 'ready') held.reject(new Error('Initial Manga read failed'));
        else held.resolve({ ok: false, reason: 'unavailable' });
      });
      await ui.until(() => !!ui.host.querySelectorAll('article')[1]!.querySelector('[role="alert"]'));
      const target = ui.host.querySelectorAll('article')[1]!;
      const reload = button(target, m.correction_reload());
      const oldReload = callback(reload);
      await ui.click(button(target, m.erasure_retry_session()));
      expect(load).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(outside);
      session = 'signed-in';
      await ui.update(page());
      held = deferred<typeof ready>();
      const retry = button(target, m.correction_reload());
      const queued = callback(retry);
      retry.focus();
      await act(async () => user.keyboard('{Enter}'));
      await act(async () => {
        queued();
        queued();
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(retry.disabled).toBe(true);
      expect(target.querySelector('[aria-busy="true"]')).not.toBeNull();
      expect(target.querySelector('[role="status"]')!.textContent).toContain(m.candidate_loading());
      expect(document.activeElement).not.toBe(target.querySelector('[tabindex="-1"]'));
      const retired = outcome === 'address' || outcome === 'reader';
      if (retired) {
        await ui.update(page(outcome === 'address' ? mangaSeriesId : mangaVolumeId, 'replacement'));
        await ui.until(() => load.mock.calls.length === 3);
      }
      outside.focus();
      const result = structuredClone(ready);
      if (outcome === 'wrong-subject' && result.ok && result.public) result.public.subject.id = mangaSeriesId;
      await act(async () => held.resolve(outcome === 'concealed' ? { ok: false, reason: 'concealed' } : result));
      await ui.until(() => retired || !target.querySelector('[aria-busy="true"]'));
      if (retired) expect(document.activeElement).toBe(outside);
      else {
        expect(document.activeElement).toBe(target.querySelector('[tabindex="-1"]'));
        expect(!!target.querySelector('header')).toBe(outcome === 'ready');
        expect(!!target.querySelector('[role="alert"]')).toBe(outcome !== 'ready');
      }
      await act(async () => {
        oldReload();
        queued();
      });
      expect(load).toHaveBeenCalledTimes(retired ? 3 : 2);
      expect(ui.host.querySelector('form')).toBe(sibling);
      expect(draft.value).toBe('Private sibling draft');
    }
    outside.remove();
  });
});


test('Manga withdrawn correction recovery preserves siblings, captured discard and exact uncertain commands', async () => {
  await mounted(async (ui) => {
    const { MangaCorrections } = await import('../src/features/catalogue/manga-profile-corrections');
    const { mangaFixture, mangaVolumeId } = await import('../src/kernel/fake/catalogue-manga-profile');
    const { readMangaProfile } = await import('../src/features/catalogue/manga-profile');
    const { m } = await import('../src/paraglide/messages.js');
    const property = 'schema:numberOfPages';
    const callback = (node: Element) => Reflect.get(node,
      Object.keys(node).find((key) => key.startsWith('__reactProps$'))!).onClick as () => void;
    for (const state of ['unsent', 'uncertain', 'pending', 'confirmed'] as const) {
      const read = await readMangaProfile(mangaFixture().client, mangaVolumeId);
      if (!read.ok || !read.public) throw new Error('Expected current Manga volume');
      const withdrawn = structuredClone(read);
      withdrawn.release.types[read.public.subject.type]!.properties =
        withdrawn.release.types[read.public.subject.type]!.properties.filter((id) => id !== property);
      const commands: FactCommand[] = [];
      const late = deferred<import('../src/features/catalogue/subject-facts').FactResult>();
      const ports: MangaCorrectionPorts = {
        facts: { read: async () => ({ ...read, public: read.public!, source: null }), propose: async (command) => {
          commands.push(command);
          if (state === 'pending' && commands.length === 1) return late.promise;
          return state === 'confirmed'
            ? { ok: true, candidate: 'confirmed', revision: 2 }
            : { ok: false, reason: commands.length === 1 ? 'uncertain' : 'invalid' };
        } },
        review: () => { throw new Error('Recovery must not invent a review'); },
        relations: null, authored: null,
      };
      const page = (current = read) => <MangaCorrections read={current} locale="en" disabled={false}
        ports={ports} reload={async () => {}} />;
      await ui.render(page());
      await ui.click(button(field(ui.host, 'number of pages'), m.facts_edit_field()));
      await ui.input(amount(field(ui.host, 'number of pages'), m.correction_amount()), '+241');
      if (state !== 'unsent') await ui.click(button(ui.host, m.facts_submit()));
      // The valid sibling stays private and excluded from the next batch by its explicit choice.
      await ui.update(page(withdrawn));
      await ui.click(button(field(ui.host, 'ISBN-13'), m.facts_edit_field()));
      await ui.input(amount(field(ui.host, 'ISBN-13'), m.correction_value()), 'private-sibling');
      const sibling = field(ui.host, 'ISBN-13');
      await ui.click(sibling.querySelector('[role="checkbox"]')!);
      const recovery = () => ui.host.querySelector<HTMLElement>('section[aria-label="number of pages"]')!;
      expect(recovery().querySelector('pre')!.textContent).toContain('+241');
      expect(recovery().textContent).toContain(m.facts_private());
      expect(recovery().querySelector('input, select, a')).toBeNull();
      const remove = m.album_remove_draft({ field: 'number of pages' });
      if (state === 'unsent') {
        expect(button(ui.host, m.facts_submit()).disabled).toBe(true);
        await ui.click(button(recovery(), remove));
        await ui.click(button(recovery(), m.candidate_cancel()));
        const original = recovery().querySelector('pre')!.textContent;
        await ui.click(button(recovery(), remove));
        const retiredConfirm = callback(button(recovery(), remove));
        await ui.update(page());
        expect(amount(field(ui.host, 'number of pages'), m.correction_amount()).value).toBe('+241');
        await ui.update(page(withdrawn));
        await act(async () => retiredConfirm());
        expect(recovery().querySelector('pre')!.textContent).toBe(original);
        await ui.click(button(recovery(), remove));
        await ui.click(button(recovery(), remove));
        expect(recovery()).toBeNull();
        expect(commands).toEqual([]);
      } else {
        expect(button(recovery(), remove).disabled).toBe(true);
        if (state === 'pending') {
          await act(async () => late.resolve({ ok: true, candidate: 'retired-success', revision: 2 }));
          expect(ui.host.textContent).not.toContain(m.correction_proposed());
        }
        if (state === 'confirmed') {
          expect(recovery().textContent).toContain(m.correction_proposed());
          expect(button(ui.host, m.facts_submit()).disabled).toBe(true);
        } else {
          const original = structuredClone(commands[0]!);
          await ui.click(button(ui.host, m.facts_submit()));
          expect(commands).toHaveLength(2);
          expect(commands[1]).toBe(commands[0]);
          expect(commands[1]).toEqual(original);
          expect(recovery().textContent).toContain(m.correction_invalid());
          expect(button(recovery(), remove).disabled).toBe(true);
        }
      }
      expect(amount(field(ui.host, 'ISBN-13'), m.correction_value()).value).toBe('private-sibling');
      expect(field(ui.host, 'ISBN-13').querySelector('[role="checkbox"]')!.getAttribute('aria-checked')).toBe('false');
    }
  });
});
