import { expect, test, mock } from 'bun:test';
import { act, createElement as h } from 'react';
import { createRequire } from 'node:module';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { CreationRead } from '../src/features/catalogue/creation-host/use-creation-host';
import type { StatementInput } from '../src/features/catalogue/statement-editor';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('all three creation profiles retain populated type drafts through withdrawal, failure, recovery and reader retirement', async () => {
  const { musicContextCreateTypes } = await import('../src/features/catalogue/music-context-create');
  const { catalogueFileCreateTypes } = await import('../src/features/catalogue/catalogue-file-create');
  const { conceptCreateTypes } = await import('../src/features/catalogue/concept-create');
  const { useCreationHost } = await import('../src/features/catalogue/creation-host/use-creation-host');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { StatementSummary } = await import('../src/features/catalogue/statement-summary');
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window();
  const globals = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(window.document.body);
  try {
    for (const types of [musicContextCreateTypes, catalogueFileCreateTypes, conceptCreateTypes]) {
      const type = types(bundledRelease, 'en')[0]!.id;
      const release = structuredClone(bundledRelease);
      delete release.types[type];
      let next: CreationRead = { ok: true, digest: 'withdrawn', release };
      let host!: ReturnType<typeof useCreationHost<StatementInput, string[]>>;
      function Harness() {
        host = useCreationHost<StatementInput, string[]>({
          initial: { ok: true, digest: 'initial', release: bundledRelease },
          scope: 'test',
          locale: 'en',
          types,
          load: async () => next,
          failure: 'Unavailable',
        });
        return h('output', null, host.types.map((entry) => entry.id).join(','));
      }
      const render = (reader: string) =>
        h(CandidateReaderBoundary, {
          observed: { state: 'signed-in', subject: reader, csrfToken: 'original-key' },
          address: type,
          children: h(Harness),
        });
      await act(async () => root.render(render('reader-a')));
      const statement: StatementInput = {
        property: { id: 'schema:name' },
        value: { type: 'value', content: 'Original fact' },
        references: [],
        rank: 'normal',
      };
      await act(async () => {
        host.onTypeDraftChange(type, true);
        host.setFactsByType({ [type]: [statement] });
      });
      const revision = host.reviewRevision;
      await act(async () => host.refreshMetadata());
      expect(host.activeTypeIds.has(type)).toBe(false);
      expect(host.types.some((entry) => entry.id === type)).toBe(true);
      expect(host.reviewRevision).not.toBe(revision);
      next = { ok: false };
      await act(async () => host.refreshMetadata());
      expect(host.metadata.ready).toBe(false);
      expect(host.types.some((entry) => entry.id === type)).toBe(true);
      expect(host.factsByType[type]).toEqual([statement]);
      next = { ok: true, digest: 'initial', release: bundledRelease };
      await act(async () => host.refreshMetadata());
      expect(host.metadata.ready).toBe(true);
      expect(host.types.filter((entry) => entry.id === type)).toHaveLength(1);
      expect(host.factsByType[type]).toEqual([statement]);
      expect(host.retainedTypes.has(type)).toBe(true);
      const old = host;
      await act(async () => root.render(render('reader-b')));
      expect(old.work.active()).toBe(false);
      expect(host.factsByType).toEqual({});
      await act(async () => root.render(null));
    }
    const part = (id: string, text: string) => ({ property: { id }, value: { type: 'value' as const, content: text } });
    for (const rank of ['normal', 'preferred', 'deprecated'] as const) {
      await act(async () =>
        root.render(
          h(StatementSummary, {
            statement: {
              ...part('schema:name', 'Descriptor value'),
              rank,
              qualifiers: [part('schema:name', 'First qualifier'), part('schema:name', 'Second qualifier')],
              references: [{ parts: [part('schema:name', 'First reference')] }, { parts: [] }],
            },
            read: { release: bundledRelease, source: null, public: { subject: { type: 'skos:Concept' }, related: {} } },
            locale: 'en',
          }),
        ),
      );
      const text = window.document.body.textContent!;
      expect(text).toContain(rank[0]!.toUpperCase() + rank.slice(1));
      if (rank !== 'normal') expect(text).not.toContain('Normal');
      expect(text.indexOf('First qualifier')).toBeLessThan(text.indexOf('Second qualifier'));
      expect(text).toContain('First reference');
      expect(text).toContain('Descriptor value');
      expect(window.document.querySelectorAll('ol > li')).toHaveLength(2);
    }
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
