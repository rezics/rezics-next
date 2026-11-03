import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { bundledRelease } from '@rezics/definitions/bundled';

mock.module('cloudflare:workers', () => ({ env: {} }));

import {
  appearanceWorkA,
  appearanceWorkB,
  characterRelationshipsFixture,
  characterRelationshipsId,
  relatedCharacterId,
} from '../src/kernel/fake/character-relationships';
import { associationCorrection } from '../src/features/catalogue/character-relationships/correction';
import {
  appearanceProperty,
  characterAssociationStreams,
  unavailableConfigurations,
} from '../src/features/catalogue/character-relationships/reading';
import { characterType } from '../src/features/catalogue/character-profile';

async function withHost(run: (host: HTMLElement, render: (node: ReactNode) => Promise<void>) => Promise<void>) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLSelectElement',
    'Element',
    'Node',
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
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const render = async (node: ReactNode) => {
    await act(async () => root.render(h(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, node)));
  };
  try {
    await run(host, render);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('bundled Character Type names unreleased age, main-character linkage and relationship properties', () => {
  const unavailable = unavailableConfigurations(bundledRelease).map((item) => item.id);
  expect(unavailable).toContain('age-at-appearance');
  expect(unavailable).toContain('main-character-linkage');
  expect(unavailable).toContain('character-relationship');
  const streams = characterAssociationStreams(bundledRelease, characterType, 'en', characterRelationshipsId);
  expect(streams.some((stream) => stream.kind === 'appearance' && stream.property === appearanceProperty)).toBe(true);
  expect(streams.some((stream) => stream.kind === 'voice')).toBe(true);
  expect(streams.some((stream) => stream.kind === 'relationship')).toBe(false);
});

test('directed relationship, age-by-work, role, spoiler, vanished, unreadable and correction stay on the selected slot', async () => {
  const related = characterRelationshipsFixture('relationship');
  const relatedRead = await related.transport.read(`forward:${related.relationshipProperty}`);
  if (!relatedRead.ok || !relatedRead.stream) throw new Error('Expected relationship stream');
  expect(relatedRead.stream.kind).toBe('relationship');
  expect(relatedRead.stream.direction).toBe('forward');
  expect(relatedRead.rows[0]?.summary?.id).toBe(relatedCharacterId);
  expect(relatedRead.unavailable.map((item) => item.id)).not.toContain('character-relationship');
  const correction = associationCorrection(relatedRead.rows[0]!, relatedRead.stream);
  expect(correction).toMatchObject({
    id: characterRelationshipsId,
    slot: { property: related.relationshipProperty, target: relatedCharacterId },
    kind: 'relationship',
  });
  expect(correction?.statement.value).toEqual({ type: 'value', content: relatedCharacterId });

  const ages = characterRelationshipsFixture('age');
  const ageRead = await ages.transport.read();
  if (!ageRead.ok) throw new Error('Expected appearances');
  const amounts = ageRead.rows.map((row) => {
    const qualifier = row.statement?.qualifiers.find((part) => part.property.id === ages.ageProperty);
    return [row.holder, qualifier?.value.type === 'value' ? qualifier.value.content : undefined] as const;
  });
  expect(amounts).toEqual([
    [appearanceWorkA, { amount: '+16', unit: '1' }],
    [appearanceWorkB, { amount: '+18', unit: '1' }],
  ]);
  expect(ageRead.public.subject.statements[ages.ageProperty]).toBeUndefined();

  const roles = characterRelationshipsFixture('appearances');
  const roleRead = await roles.transport.read();
  if (!roleRead.ok) throw new Error('Expected role appearances');
  expect(roleRead.rows.every((row) => row.statement?.qualifiers.some((part) => part.property.id === 'wdt:P3831'))).toBe(
    true,
  );
  const roleCorrection = associationCorrection(roleRead.rows[0]!, roleRead.stream!);
  expect(roleCorrection?.id).toBe(appearanceWorkA);
  expect(roleCorrection?.returnWork).toBe(appearanceWorkA);
  expect(roleCorrection?.statement.qualifiers.some((part) => part.property.id === 'wdt:P3831')).toBe(true);

  const spoilers = characterRelationshipsFixture('spoiler');
  const spoilerRead = await spoilers.transport.read();
  if (!spoilerRead.ok) throw new Error('Expected spoiler appearance');
  expect(
    spoilerRead.rows[0]?.statement?.qualifiers.some(
      (part) =>
        part.property.id === 'rezics:spoilerLevel' &&
        part.value.type === 'value' &&
        typeof part.value.content === 'object' &&
        part.value.content &&
        'amount' in part.value.content &&
        part.value.content.amount === '+2',
    ),
  ).toBe(true);

  const vanished = characterRelationshipsFixture('vanished');
  const vanishedRead = await vanished.transport.read();
  if (!vanishedRead.ok) throw new Error('Expected vanished endpoint');
  expect(vanishedRead.rows[0]?.summary).toBeNull();
  expect(associationCorrection(vanishedRead.rows[0]!, vanishedRead.stream!)).toBeDefined();

  const unreadable = characterRelationshipsFixture('unreadable');
  const unreadableRead = await unreadable.transport.read();
  if (!unreadableRead.ok) throw new Error('Expected character identity with unreadable stream');
  expect(unreadableRead.public.subject.id).toBe(characterRelationshipsId);
  expect(unreadableRead.independentlyUnreadable?.key).toBe(`inverse:${appearanceProperty}`);
  expect(unreadableRead.rows).toEqual([]);

  const { m } = await import('../src/paraglide/messages.js');
  const { CharacterRelationshipsView } = await import('../src/features/catalogue/character-relationships/view');
  await withHost(async (host, render) => {
    await render(
      h(CharacterRelationshipsView, {
        id: ages.id,
        locale: 'en',
        transport: ages.transport,
        search: ages.search,
        initial: ageRead,
      }),
    );
    expect(host.textContent).toContain('Spring work');
    expect(host.textContent).toContain('Autumn work');
    expect(host.textContent).toContain('+16');
    expect(host.textContent).toContain('+18');
    expect(host.textContent).toContain(m.character_relationships_kind_appearance());
    const spring = [...host.querySelectorAll('[data-slot=list-row]')].find((row) => row.textContent?.includes('Spring work'))!;
    expect(spring.querySelector('[data-appearance-age=true]')?.textContent).toContain('+16');
    expect(spring.textContent).not.toContain('+18');
    const isolate = [...spring.querySelectorAll('button')].find(
      (button) => button.textContent === m.character_relationships_switch(),
    );
    await act(async () => isolate?.click());
    const autumn = [...host.querySelectorAll('[data-slot=list-row]')].find((row) => row.textContent?.includes('Autumn work'))!;
    expect(autumn.querySelector('[data-content-item-slot=preview]')?.hasAttribute('hidden')).toBe(true);

    await render(
      h(CharacterRelationshipsView, {
        id: spoilers.id,
        locale: 'en',
        transport: spoilers.transport,
        search: spoilers.search,
        initial: spoilerRead,
      }),
    );
    expect(host.querySelector('[data-slot=collapsible-trigger]')?.textContent).toContain(
      m.character_relationships_spoiler_show(),
    );

    await render(
      h(CharacterRelationshipsView, {
        id: vanished.id,
        locale: 'en',
        transport: vanished.transport,
        search: vanished.search,
        initial: vanishedRead,
      }),
    );
    expect(host.textContent).toContain(m.character_relationships_vanished());
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === m.character_relationships_correct())).toBe(
      true,
    );

    await render(
      h(CharacterRelationshipsView, {
        id: unreadable.id,
        locale: 'en',
        transport: unreadable.transport,
        search: unreadable.search,
        initial: unreadableRead,
      }),
    );
    expect(host.textContent).toContain(
      m.character_relationships_endpoint_unreadable({ stream: `inverse:${appearanceProperty}` }),
    );

    await render(
      h(CharacterRelationshipsView, {
        id: related.id,
        locale: 'en',
        transport: related.transport,
        search: related.search,
        initial: relatedRead,
      }),
    );
    expect(host.textContent).toContain(m.character_relationships_kind_relationship());
    expect(host.textContent).toContain('The companion');
    expect(host.textContent).toContain(m.character_relationships_direction_forward());
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === m.character_relationships_correct())).toBe(
      true,
    );
  });
});
