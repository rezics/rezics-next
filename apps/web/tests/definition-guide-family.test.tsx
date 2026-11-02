import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import type { ReactNode } from 'react';
import type { GuideAddress, GuideRead } from '../src/features/catalogue/definition-guide';

mock.module('cloudflare:workers', () => ({ env: {} }));

// UNRUN: mounted composition and request-bound witnesses. Browser stories own native keyboard and geometry proof.
async function mounted(run: (mountedSurface: Awaited<ReturnType<typeof surface>>) => Promise<void>) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://guide.test/en/catalogue/definitions' });
  const names = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLSelectElement',
    'Element',
    'Node',
    'DocumentFragment',
    'MutationObserver',
    'getComputedStyle',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === 'window' ? window : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[name],
    });
  }
  const current = await surface();
  try {
    await run(current);
  } finally {
    await current.act(async () => current.root.unmount());
    current.client.clear();
    current.restoreLocale();
    await window.happyDOM.abort();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

async function surface() {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { DefinitionGuide, DefinitionGuideContent, DefinitionGuideLink } =
    await import('../src/features/catalogue/definition-guide-view');
  const { definitionGuideFixture, historicalGuideDigest } = await import('../src/kernel/fake/definition-guide');
  const { definitionText, guideTypes } = await import('../src/features/catalogue/definition-guide');
  const { m } = await import('../src/paraglide/messages.js');
  const { languageName } = await import('../src/subject/language');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = async (children: ReactNode) => {
    await act(async () => root.render(<QueryClientProvider client={client}>{children}</QueryClientProvider>));
    // React Query's notification scheduler runs after the native-shaped response settles.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };
  const change = async (select: HTMLSelectElement, value: string) => {
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };
  return {
    act,
    root,
    client,
    host,
    render,
    change,
    DefinitionGuide,
    DefinitionGuideContent,
    DefinitionGuideLink,
    definitionGuideFixture,
    historicalGuideDigest,
    definitionText,
    guideTypes,
    m,
    languageName,
    restoreLocale: () => overwriteGetLocale(previousLocale),
  };
}

test('same-address mounted guides associate labels with unique stable native selects and select independently without extra reads', async () => {
  await mounted(
    async ({ host, render, change, act, client, DefinitionGuide, definitionGuideFixture, guideTypes, m }) => {
      const fixture = definitionGuideFixture();
      await render(
        <>
          <DefinitionGuide {...fixture} locale="en" />
          <DefinitionGuide {...fixture} locale="en" />
        </>,
      );
      const guides = [...host.querySelectorAll('article')];
      expect(guides).toHaveLength(2);
      const selects = [...host.querySelectorAll<HTMLSelectElement>('select')];
      expect(selects).toHaveLength(2);
      expect(selects[0]!.id).not.toBe(selects[1]!.id);
      const ids = selects.map((select) => select.id);
      for (const [index, guide] of guides.entries()) {
        const label = guide.querySelector('label')!;
        expect(label.textContent).toBe(m.catalogue_create_type());
        expect(label.htmlFor).toBe(selects[index]!.id);
        expect(label.control).toBe(selects[index]);
        expect(document.getElementById(label.htmlFor)).toBe(selects[index]);
      }
      const read = client.getQueryData<GuideRead>(['definition-guide', fixture.address, 'en']);
      if (!read?.ok) throw new Error('Expected active definitions');
      expect([...selects[0]!.options].slice(1).map((option) => option.value)).toEqual(
        guideTypes(read.release, 'en').map((entry) => entry.id),
      );
      // Both mounted consumers share the existing query and its single active/release lookup.
      expect(fixture.calls.map((call) => call.path)).toEqual([
        '/v1/definitions/active',
        `/v1/definitions/releases/${read.release.digest}`,
      ]);
      const calls = structuredClone(fixture.calls);
      await act(async () => guides[1]!.querySelector('label')!.click());
      await change(selects[1]!, 'schema:Recipe');
      expect(selects.map((select) => select.value)).toEqual(['schema:Book', 'schema:Recipe']);
      expect(guides[0]!.querySelector('h2')!.textContent).toBe('book');
      expect(guides[1]!.querySelector('h2')!.textContent).toBe('recipe');
      expect(selects.map((select) => select.id)).toEqual(ids);
      for (const guide of guides) {
        const disclosure = guide.querySelector('details')!;
        await act(async () => disclosure.querySelector('summary')!.click());
      }
      expect(fixture.calls).toEqual(calls);
      expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
      const { readGuide, fetchGuideRelease } = await import('../src/features/catalogue/definition-guide');
      for (const address of [
        { type: 'schema:Recipe', property: 'schema:cookTime' },
        { type: 'schema:Book', property: 'schema:author' },
        { type: 'schema:Book', property: 'schema:datePublished' },
        fixture.address,
        definitionGuideFixture('pinned').address,
        {},
        { type: 'missing:type' },
        { type: 'schema:Book', property: 'missing:field' },
      ]) {
        const initial = await readGuide(address, (digest) => fetchGuideRelease(fixture.client, digest));
        const props = { address, initial, locale: 'en', transport: { read: async () => initial } };
        await render(<DefinitionGuide {...props} />);
        expect(host.querySelector('select')?.value).toBe(initial.ok ? (address.type ?? '') : undefined);
        expect(host.querySelector('code')?.textContent).toBe(initial.ok ? initial.release.digest : undefined);
        if (initial.ok && address.property) expect(host.textContent).toContain(address.property);
      }
    },
  );
});

test('supplied field rows retain native list order, exact links, missing meaning and language fallback in the shared frame', async () => {
  await mounted(async ({ host, render, DefinitionGuideContent, definitionGuideFixture, m, languageName }) => {
    const fixture = definitionGuideFixture();
    const read = await fixture.transport.read();
    if (!read.ok) throw new Error('Expected active definitions');
    const release = structuredClone(read.release);
    release.properties['schema:author']!.labels = { fr: 'Auteur de cette œuvre dans son édition originale' };
    release.properties['schema:wordCount']!.labels = {};
    delete release.properties['schema:datePublished'];
    const back = '/en/subjects/00000000-0000-4000-8000-000000000001/a-book/edit?statement=selected#value';
    await render(
      <DefinitionGuideContent
        address={{ type: 'schema:Book', returnTo: back }}
        locale="en"
        read={{ ...read, release }}
        retry={() => {
          throw new Error('Unexpected retry');
        }}
      />,
    );
    const list = host.querySelector('ul')!;
    const rows = [...list.children];
    const order = read.release.types['schema:Book']!.properties;
    expect(rows).toHaveLength(order.length);
    for (const [index, id] of order.entries()) {
      const row = rows[index]!;
      expect(row.tagName).toBe('LI');
      expect(row.querySelector('li')).toBeNull();
      expect(row.firstElementChild!.classList.contains('isolate')).toBe(true);
      const link = row.querySelector('a');
      if (id === 'schema:datePublished') {
        expect(link).toBeNull();
        expect(row.textContent).toBe(m.guide_missing());
      } else {
        expect(link?.getAttribute('href')).toBe(
          `/en/catalogue/definitions?type=schema%3ABook&property=${encodeURIComponent(id)}&returnTo=${encodeURIComponent(back)}`,
        );
        expect(link!.querySelector('a, button, summary')).toBeNull();
      }
    }
    const author = rows[order.indexOf('schema:author')]!.querySelector('a')!;
    expect(author.querySelector('[lang="fr"]')!.textContent).toBe(release.properties['schema:author']!.labels.fr!);
    expect(author.querySelector('[lang="en"]')!.textContent).toBe(
      m.guide_fallback({ language: languageName('fr', 'en') ?? 'fr' }),
    );
    expect(rows[order.indexOf('schema:wordCount')]!.querySelector('[lang="en"]')!.textContent).toBe(m.guide_missing());
    expect(host.querySelector('h3')!.textContent).toBe(m.guide_fields());
    expect(host.querySelector('h4')).toBeNull();
    expect(fixture.calls).toHaveLength(2);
  });
});

test('active and immutable pinned field constraints, ordered qualifiers, consent and exact references survive the family composition', async () => {
  await mounted(
    async ({
      host,
      render,
      DefinitionGuideContent,
      definitionGuideFixture,
      historicalGuideDigest,
      definitionText,
      m,
    }) => {
      for (const scenario of ['active', 'pinned'] as const) {
        const fixture = definitionGuideFixture(scenario);
        const read = await fixture.transport.read();
        if (!read.ok) throw new Error('Expected released definitions');
        const address: GuideAddress = {
          type: 'schema:Recipe',
          property: 'schema:cookTime',
          ...(scenario === 'pinned' ? { release: historicalGuideDigest } : {}),
        };
        await render(
          <DefinitionGuideContent
            key={`${scenario}:quantity`}
            address={address}
            locale="en"
            read={read}
            retry={() => {}}
          />,
        );
        expect(host.querySelector('summary')!.textContent).toBe(
          scenario === 'active' ? m.guide_active() : m.guide_pinned(),
        );
        expect(host.querySelector('code')!.textContent).toBe(read.release.digest);
        for (const meaning of [
          m.guide_quantity(),
          m.correction_single(),
          m.guide_integer(),
          m.guide_bounds(),
          'min',
          m.guide_no_qualifiers(),
        ])
          expect(host.textContent).toContain(meaning);
        expect([...host.querySelectorAll('dt')].map((node) => node.textContent)).toContain(m.guide_minimum());
        expect([...host.querySelectorAll('code')].map((node) => node.textContent)).toContain(
          'http://www.wikidata.org/entity/Q7727',
        );
        if (scenario === 'pinned') {
          const current = [...host.querySelectorAll('a')].find((link) => link.textContent === m.guide_active())!;
          expect(current.getAttribute('href')).toBe(
            '/en/catalogue/definitions?type=schema%3ARecipe&property=schema%3AcookTime',
          );
        }
        await render(
          <DefinitionGuideContent
            key={`${scenario}:author`}
            address={{ ...address, type: 'schema:Book', property: 'schema:author' }}
            locale="en"
            read={read}
            retry={() => {}}
          />,
        );
        const section = [...host.querySelectorAll('h3')]
          .find((heading) => heading.textContent === m.guide_qualifiers())!
          .closest('section')!;
        const summaries = [...section.querySelectorAll('summary')];
        const qualifiers = read.release.properties['schema:author']!.qualifiers;
        expect(summaries.map((summary) => summary.textContent)).toEqual(
          qualifiers.map((id) => definitionText(read.release.properties[id]?.labels, 'en').text ?? m.guide_missing()),
        );
        for (const summary of summaries) {
          expect(summary.parentElement!.tagName).toBe('DETAILS');
          expect(summary.parentElement!.firstElementChild).toBe(summary);
          expect(summary.getAttribute('role')).toBeNull();
        }
        expect(host.textContent).toContain('person');
        expect([...host.querySelectorAll('code')].map((code) => code.textContent)).toContain('^[1-9][0-9]{0,3}$');
        await render(
          <DefinitionGuideContent
            key={`${scenario}:time`}
            address={{ ...address, type: 'schema:Book', property: 'schema:datePublished' }}
            locale="en"
            read={read}
            retry={() => {}}
          />,
        );
        for (const meaning of [m.correction_year(), m.correction_month(), m.correction_day(), m.correction_calendar()])
          expect(host.textContent).toContain(meaning);
        await render(
          <DefinitionGuideContent
            key={`${scenario}:consent`}
            address={{ ...address, type: 'schema:Person', property: 'rezics:penNameOf' }}
            locale="en"
            read={read}
            retry={() => {}}
          />,
        );
        expect(host.textContent).toContain(m.guide_consent());
        expect(fixture.calls.map((call) => call.path)).toEqual(
          scenario === 'active'
            ? ['/v1/definitions/active', `/v1/definitions/releases/${read.release.digest}`]
            : [`/v1/definitions/releases/${historicalGuideDigest}`],
        );
      }
    },
  );
});

test('long supplied names and exact regex, target, unit and field references remain complete with missing qualifiers distinct', async () => {
  await mounted(async ({ host, render, DefinitionGuideContent, definitionGuideFixture, m }) => {
    const fixture = definitionGuideFixture();
    const read = await fixture.transport.read();
    if (!read.ok) throw new Error('Expected active definitions');
    const release = structuredClone(read.release);
    const longName = 'Full localized field meaning — '.repeat(16);
    const exact = `https://example.test/${'original-reference-'.repeat(24)}?language=ja#unchanged`;
    const pattern = `^(?:${'original-format|'.repeat(24)}exact)$`;
    const fieldId = `schema:${'exact-field-'.repeat(24)}`;
    release.types['schema:Book']!.properties = [fieldId];
    release.types['schema:Book']!.labels = { en: longName };
    release.properties[fieldId] = {
      ...release.properties['schema:author']!,
      labels: { en: longName },
      targets: [exact],
      value: { type: 'string', pattern },
      qualifiers: ['schema:cookTime', 'missing:qualifier'],
    };
    release.properties['schema:cookTime'] = {
      ...release.properties['schema:cookTime']!,
      labels: { en: longName },
      units: [exact],
      maximum: 999,
    };
    await render(
      <DefinitionGuideContent
        address={{ type: 'schema:Book', property: fieldId }}
        locale="en"
        read={{ ...read, release }}
        retry={() => {}}
      />,
    );
    expect(host.querySelector('h2')!.textContent).toBe(longName);
    expect(host.querySelector('h3')!.textContent).toBe(longName);
    const codes = [...host.querySelectorAll('code')].map((code) => code.textContent);
    expect(codes).toContain(pattern);
    expect(codes).toContain(fieldId);
    expect(codes.filter((value) => value === exact)).toHaveLength(2);
    expect(host.textContent).toContain(m.guide_maximum());
    expect(host.textContent).toContain('999');
    expect([...host.querySelectorAll('summary')].some((summary) => summary.textContent === m.guide_missing())).toBe(
      true,
    );
    expect(host.querySelector('[title]')).toBeNull();
    expect(fixture.calls).toHaveLength(2);
  });
});

test('loading, failure eligibility, empty and missing meaning stay distinct and DOM identity survives recovery', async () => {
  await mounted(
    async ({ host, render, act, DefinitionGuideContent, DefinitionGuideLink, definitionGuideFixture, m }) => {
      const fixture = definitionGuideFixture();
      const read = await fixture.transport.read();
      if (!read.ok) throw new Error('Expected active definitions');
      const address = fixture.address;
      let retries = 0;
      const show = (next?: GuideRead) =>
        render(
          <DefinitionGuideContent
            address={address}
            locale="en"
            read={next}
            retry={() => {
              retries++;
            }}
          />,
        );
      await show(read);
      const id = host.querySelector('select')!.id;
      await show();
      expect(host.querySelector('[role="status"]')!.textContent).toBe(m.guide_loading());
      expect(host.querySelector('[role="alert"], select, button')).toBeNull();
      for (const [reason, meaning, eligible] of [
        ['denied', m.guide_denied(), true],
        ['concealed', m.guide_concealed(), false],
        ['invalid', m.guide_invalid(), false],
        ['unavailable', m.guide_unavailable(), true],
      ] as const) {
        await show({ ok: false, reason });
        expect(host.querySelector('[role="alert"]')!.textContent).toBe(meaning);
        expect(host.querySelector('[role="status"], select')).toBeNull();
        expect(host.querySelector('button') !== null).toBe(eligible);
        if (eligible) await act(async () => host.querySelector('button')!.click());
      }
      expect(retries).toBe(2);
      await show({ ...read, release: { digest: read.release.digest, types: {}, properties: {} } });
      expect(host.querySelector('[role="status"]')!.textContent).toBe(m.guide_empty());
      expect(host.querySelector('[role="alert"], select, button')).toBeNull();
      await show(read);
      expect(host.querySelector('select')!.id).toBe(id);
      const back =
        '/en/subjects/00000000-0000-4000-8000-000000000001/a-book/edit?property=schema%3Aauthor&statement=uncertain#value';
      await render(<DefinitionGuideLink locale="en" address={{ ...address, returnTo: back }} field />);
      const link = host.querySelector('a')!;
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
      expect(new URL(link.href).searchParams.get('returnTo')).toBe(back);
      expect(link.textContent).toBe(`${m.guide_field_help()} · ${m.guide_new_tab()}`);
      expect(fixture.calls).toHaveLength(2);
    },
  );
});

test('actual query consumers retry only on explicit eligible actions with unchanged native read counts', async () => {
  for (const scenario of ['unavailable', 'denied'] as const) {
    await mounted(async ({ host, render, act, client, DefinitionGuide, definitionGuideFixture, m }) => {
      const fixture = definitionGuideFixture(scenario);
      const component = <DefinitionGuide locale="en" address={fixture.address} transport={fixture.transport} />;
      await render(component);
      expect(host.querySelector('[role="alert"]')!.textContent).toBe(
        scenario === 'unavailable' ? m.guide_unavailable() : m.guide_denied(),
      );
      expect(fixture.calls.map((call) => call.path)).toEqual(['/v1/definitions/active']);
      const retry = host.querySelector('button')!;
      expect(retry.textContent).toBe(m.guide_retry());
      await act(async () => retry.click());
      await render(component);
      if (scenario === 'unavailable') {
        expect(host.querySelector('[role="alert"]')).toBeNull();
        expect(host.querySelector('select')).not.toBeNull();
        const read = client.getQueryData<GuideRead>(['definition-guide', fixture.address, 'en']);
        if (!read?.ok) throw new Error('Expected recovered active definitions');
        expect(fixture.calls.map((call) => call.path)).toEqual([
          '/v1/definitions/active',
          '/v1/definitions/active',
          `/v1/definitions/releases/${read.release.digest}`,
        ]);
        expect(host.querySelectorAll('button')).toHaveLength(0);
      } else {
        expect(host.querySelector('[role="alert"]')!.textContent).toBe(m.guide_denied());
        expect(host.querySelector('select')).toBeNull();
        expect(fixture.calls.map((call) => call.path)).toEqual(['/v1/definitions/active', '/v1/definitions/active']);
      }
      expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
    });
  }
});

test('deliberate pinned retries lock one read and focus returned guidance or the truthful empty/denied boundary', async () => {
  for (const ending of ['field', 'empty', 'denied'] as const) {
    await mounted(async ({ host, render, act, DefinitionGuide, definitionGuideFixture, definitionText, m }) => {
      const fixture = definitionGuideFixture('pinned');
      const read = await fixture.transport.read();
      if (!read.ok) throw new Error('Expected pinned definitions');
      const back = '/en/subjects/00000000-0000-4000-8000-000000000001/a-book/edit?statement=uncertain#value';
      const address = { ...fixture.address, returnTo: back };
      let reads = 0;
      let settle!: (read: GuideRead) => void;
      const transport = {
        read: () => {
          reads++;
          return new Promise<GuideRead>((resolve) => {
            settle = resolve;
          });
        },
      };
      const component = (
        <DefinitionGuide
          address={address}
          locale="en"
          transport={transport}
          initial={{ ok: false, reason: 'unavailable' }}
        />
      );
      await render(component);
      expect(reads).toBe(0);
      expect(document.activeElement).toBe(document.body);
      const retry = host.querySelector('button')!;
      retry.focus();
      await act(async () => {
        retry.click();
        retry.click();
      });
      await render(component);
      expect(reads).toBe(1);
      expect(retry.disabled).toBe(true);
      expect(retry.getAttribute('aria-busy')).toBe('true');
      expect(host.querySelector('[role="status"]')!.textContent).toBe(m.guide_loading());
      expect(host.querySelector('[role="alert"]')).toBeNull();
      await act(async () =>
        settle(
          ending === 'denied'
            ? { ok: false, reason: 'denied' }
            : ending === 'empty'
              ? { ...read, release: { digest: read.release.digest, types: {}, properties: {} } }
              : read,
        ),
      );
      await render(component);
      const target = host.querySelector(
        ending === 'field' ? 'h3' : ending === 'empty' ? '[role="status"]' : '[role="alert"]',
      )!;
      expect(document.activeElement).toBe(target);
      expect(target.getAttribute('tabindex')).toBe('-1');
      expect(target.className).toContain('focus:outline-2');
      expect(target.textContent).toBe(
        ending === 'field'
          ? definitionText(read.release.properties[address.property!]!.labels, 'en').text
          : ending === 'empty'
            ? m.guide_empty()
            : m.guide_denied(),
      );
      expect(host.querySelector('[aria-live]')).toBeNull();
      expect(reads).toBe(1);
      expect(host.querySelector('a')!.getAttribute('href')).toBe(back);
      if (ending === 'field') expect(host.querySelector('code')!.textContent).toBe(fixture.address.release!);
      if (ending === 'denied') expect(host.querySelector('button')!.disabled).toBe(false);
      expect(fixture.calls.map((call) => call.path)).toEqual([`/v1/definitions/releases/${fixture.address.release}`]);
    });
  }
});

test('initial and retired-address completions stay silent across departure and return to the same pin', async () => {
  await mounted(async ({ host, render, act, DefinitionGuide, definitionGuideFixture }) => {
    const fixture = definitionGuideFixture('pinned');
    const read = await fixture.transport.read();
    let settle!: (read: GuideRead) => void;
    let reads = 0;
    const transport = {
      read: () => {
        reads++;
        return new Promise<GuideRead>((resolve) => {
          settle = resolve;
        });
      },
    };
    const show = (address: GuideAddress, initial?: GuideRead) =>
      render(<DefinitionGuide address={address} locale="en" transport={transport} initial={initial} />);
    await show(fixture.address);
    const back = host.querySelector('a')!;
    back.focus();
    await act(async () => settle({ ok: false, reason: 'denied' }));
    await show(fixture.address);
    expect(document.activeElement).toBe(back);
    await act(async () => host.querySelector('button')!.click());
    const oldCompletion = settle;
    await show({}, read);
    await show(fixture.address, read);
    back.focus();
    await act(async () => oldCompletion({ ok: false, reason: 'unavailable' }));
    await show(fixture.address, read);
    expect(document.activeElement).toBe(back);
    expect(reads).toBe(2);
  });
});
