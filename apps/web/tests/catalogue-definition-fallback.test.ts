import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';

test('A contributor recognizes the language of exceptional definition guidance without changing authored subject data', async () => {
  // The same DOM and fixture transports as the existing editor regressions; no browser or native proof.
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/character' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { act, createElement: h } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { CharacterProfile } = await import('../src/features/catalogue/character-profile-view');
  const { characterType } = await import('../src/features/catalogue/character-profile');
  const { characterProfileFixture, characterProfileId } =
    await import('../src/kernel/fake/catalogue-character-profile');
  const { DefinitionGuideContent } = await import('../src/features/catalogue/definition-guide-view');
  const { definitionGuideFixture } = await import('../src/kernel/fake/definition-guide');
  const { GameProfile } = await import('../src/features/catalogue/game-profile-view');
  const { gameDefinitions } = await import('../src/features/catalogue/game-profile');
  const { gameProfileFixture } = await import('../src/kernel/fake/catalogue-game-profile');
  const { CreateSubjectForm } = await import('../src/features/catalogue/create-subject-form');
  const { catalogueCreateFixture } = await import('../src/kernel/fake/catalogue-create');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const o = { locale: 'en' as const };
  const fallback = m.guide_fallback({ language: 'German' }, o);
  const missing = m.guide_missing({}, o);
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  let generation = 0;
  const render = async (element: Parameters<typeof root.render>[0]) => {
    await act(async () => root.render(h(QueryClientProvider, { client, key: ++generation }, element)));
  };
  const textNode = (text: string) => {
    const found = Array.from(host.querySelectorAll('span[lang]')).find((node) => node.textContent === text);
    expect(found).toBeDefined();
    return found!;
  };
  const guidance = (text: string, language: string, exceptional: boolean) => {
    const node = textNode(text);
    expect(node.getAttribute('lang')).toBe(language);
    const notice = node.nextElementSibling;
    if (exceptional) {
      expect(notice?.textContent).toBe(fallback);
      expect(notice?.getAttribute('lang')).toBe('en');
      expect(notice?.closest('[hidden]')).toBeNull();
    } else expect(notice).toBeNull();
  };
  try {
    const character = characterProfileFixture();
    const read = await character.transport.load({ id: characterProfileId });
    if (!read.ok || !read.character) throw new Error('Expected the existing character story read');
    const authored = structuredClone(character.character);
    const source = authored.subject.statements['schema:height']![0]!;
    // Explicit released-metadata variations exercise exceptional and same-language presentation.
    // The English entry and field descriptions below do not claim the installed producer emits them.
    const typeMeanings = { de: read.release.types[characterType]!.descriptions!.de!, en: 'A fictional character.' };
    const fieldMeanings = { de: 'Die Körperhöhe der Figur.', en: 'The height of the character.' };
    for (const language of ['de', 'en'] as const) {
      const release = structuredClone(read.release);
      release.types[characterType]!.descriptions = language === 'de' ? { de: typeMeanings.de } : { ...typeMeanings };
      release.properties['schema:height']!.descriptions =
        language === 'de' ? { de: fieldMeanings.de } : { ...fieldMeanings };
      client.setQueryData(['character-profile', characterProfileId, undefined, 'en'], { ...read, release });
      await render(h(CharacterProfile, { ...character.props, id: characterProfileId, locale: 'en' }));
      guidance(typeMeanings[language], language, language === 'de');
      const field = host.querySelector('section[aria-label="height"]')!;
      const edit = Array.from(field.querySelectorAll('button')).find(
        (button) => button.textContent === m.facts_edit_field({}, o),
      )!;
      await act(async () => edit.click());
      // This opens CharacterProfile -> SubjectFacts -> the default StatementFields controls.
      guidance(fieldMeanings[language], language, language === 'de');
      expect(field.querySelector('input')?.value).toBe('+170');
      expect(field.querySelector('select[aria-label="' + m.correction_unit({}, o) + '"]')?.value).toBe(
        'http://www.wikidata.org/entity/Q174728',
      );
      expect(field.querySelector('a[target="_blank"]')?.getAttribute('href')).toContain(
        encodeURIComponent(source.rezics.release),
      );
      const authoredDescription = Array.from(host.querySelectorAll('p[lang="en"]')).find(
        (node) => node.textContent === authored.subject.descriptions.en,
      );
      expect(authoredDescription).toBeDefined();
      expect(authoredDescription!.querySelector('span')).toBeNull();
      expect(host.textContent).toContain(authored.subject.labels.en!);
      expect(character.character).toEqual(authored);
      expect(character.calls.every((call) => call.method === 'GET')).toBe(true);
      if (language === 'en') expect(host.textContent).not.toContain(fallback);

      const guide = definitionGuideFixture('pinned');
      const guideRead = await guide.transport.read();
      if (!guideRead.ok || guideRead.pin !== 'pinned') throw new Error('Expected the pinned guide transport');
      await render(
        h(DefinitionGuideContent, {
          address: { type: characterType, property: 'schema:height', release: guide.address.release },
          locale: 'en',
          read: {
            ...guideRead,
            release: { ...guideRead.release, types: release.types, properties: release.properties },
          },
          retry: () => {},
        }),
      );
      guidance(typeMeanings[language], language, language === 'de');
      guidance(fieldMeanings[language], language, language === 'de');
      if (language === 'en') expect(host.textContent).not.toContain(fallback);

      const game = gameProfileFixture();
      const gameType = 'wd:Q209163';
      const gameMeanings = game.release.types[gameType]!.descriptions!;
      game.release.types[gameType]!.descriptions = language === 'de' ? { de: gameMeanings.de! } : gameMeanings;
      const gameRead = await game.transport.load();
      if (!gameRead.ok) throw new Error('Expected the canonical game creation transport');
      client.setQueryData(['game-profile', 'new', 'en'], gameRead);
      client.setQueryData(['catalogue-create', 'definitions', 'en', 'game'], {
        ok: true,
        types: gameDefinitions(gameRead.release, 'en'),
      });
      await render(
        h(GameProfile, {
          locale: 'en',
          session: 'signed-in',
          transport: game.transport,
          search: async () => [],
          onNavigate: () => {},
        }),
      );
      const typeChoice = host.querySelector('#create-type')!;
      await act(async () => {
        typeChoice.value = gameType;
        typeChoice.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
      // The real profile callback supplies the language to the shared creation form.
      const help = host.querySelector('#create-type-help')!;
      expect(help.textContent).toContain(gameMeanings[language]!);
      guidance(gameMeanings[language]!, language, language === 'de');
      if (language === 'en') expect(help.textContent).not.toContain(fallback);
    }

    // Generic emitted CreateType has text, but no language metadata. Do not infer German from that text.
    const generic = catalogueCreateFixture();
    const definitions = await generic.transport.definitions();
    if (!definitions.ok) throw new Error('Expected the canonical generic creation transport');
    client.setQueryData(['catalogue-create', 'definitions', 'en'], definitions);
    await render(
      h(CreateSubjectForm, { locale: 'en', session: 'signed-in', transport: generic.transport, onNavigate: () => {} }),
    );
    const select = host.querySelector('#create-type')!;
    await act(async () => {
      select.value = characterType;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const help = host.querySelector('#create-type-help')!;
    const genericDescription = definitions.types.find((type) => type.id === characterType)!.description;
    expect(genericDescription).not.toBe('');
    expect(help.textContent).toBe(genericDescription);
    expect(help.querySelector('[lang]')).toBeNull();
    expect(help.textContent).not.toContain(fallback);

    const guide = definitionGuideFixture();
    const guideRead = await guide.transport.exact('en', characterType);
    if (!guideRead.ok) throw new Error('Expected the exact guide descriptor');
    const descriptor = structuredClone(guideRead.descriptor);
    delete descriptor.definition.descriptions;
    delete descriptor.properties['schema:height']!.descriptions;
    await render(
      h(DefinitionGuideContent, {
        address: { type: characterType, property: 'schema:height', release: guide.address.release },
        locale: 'en',
        read: { ok: true, pin: 'active', descriptor },
        transport: guide.transport,
        retry: () => {},
      }),
    );
    expect(host.textContent).toContain(missing);
    expect(host.textContent).not.toContain(fallback);
    for (const reason of ['denied', 'unavailable'] as const) {
      const failed = await definitionGuideFixture(reason).transport.read();
      expect(failed).toEqual({ ok: false, reason });
      await render(
        h(DefinitionGuideContent, {
          address: { type: characterType },
          locale: 'en',
          read: failed,
          retry: () => {},
        }),
      );
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        reason === 'denied' ? m.guide_denied({}, o) : m.guide_unavailable({}, o),
      );
      expect(host.textContent).not.toContain(typeMeanings.de);
      expect(host.textContent).not.toContain(fallback);
    }
    expect(character.character).toEqual(authored);
    expect(authored.subject.labels.ja).toBe('旅人');
    expect(authored.subject.aliases.ja).toEqual(['旅の人']);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
