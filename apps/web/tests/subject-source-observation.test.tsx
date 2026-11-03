import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h } from 'react';
import type {
  SourceObservationInspection,
  SourceObservationInspect,
  SourceObservationItem,
  SourceObservationRequest,
} from '../src/features/catalogue/source-observation/contract';

const subjectId = '00000000-0000-8000-8000-000000000042';
const currentDigest = 'c'.repeat(64);
const selectedDigest = 'a'.repeat(64);
const historyDigest = 'b'.repeat(64);

function item(
  digest: string,
  sourceAlias: string,
  sourceRecordId: string,
  nativeOrder: string,
  asOf: string,
): SourceObservationItem {
  return {
    digest,
    payloadVersion: 1,
    sourceAlias,
    sourceRecordId,
    asOf,
    nativeOrder,
    legacy: false,
    provenance: { kind: 'unversioned', digest },
    payload: {
      sourceAlias,
      sourceRecordId,
      scale: { min: 0, max: 10 },
      mean: 7.4,
      count: 120,
      asOf,
      licence: 'CC-BY-4.0',
      attribution: 'Provider archive',
      figures: {
        schemaVersion: 1,
        distribution: {
          unit: 'ratings',
          completeness: 'partial',
          bins: Array.from({ length: 10 }, (_, index) => ({ score: index + 1, count: index + 1 })),
        },
      },
    },
  };
}

function clearedItem(digest: string): SourceObservationItem {
  return {
    digest,
    payloadVersion: 1,
    sourceAlias: 'vndb',
    sourceRecordId: 'cleared-record',
    asOf: '2026-11-02',
    nativeOrder: '23',
    legacy: false,
    provenance: { kind: 'unversioned', digest },
    payload: { sourceAlias: 'vndb', sourceRecordId: 'cleared-record', count: 0, asOf: '2026-11-02' },
  };
}

const headItem = item(currentDigest, 'bangumi', '248001', '22', '2026-11-01');
const selectedItem = item(selectedDigest, 'bangumi', '248001', '17', '2026-10-20');
const historyItem = item(historyDigest, 'bangumi', '248001', '16', '2026-10-19');
const clearObservation = clearedItem('e'.repeat(64));
const exactInspection: SourceObservationInspection = {
  source: 'bangumi',
  head: { digest: headItem.digest, state: 'published', observation: headItem },
  selectedObservation: selectedItem,
};
const clearedInspection: SourceObservationInspection = {
  source: 'vndb',
  head: { digest: clearObservation.digest, state: 'cleared', observation: clearObservation },
  selectedObservation: clearObservation,
};

function ready(inspection: SourceObservationInspection) {
  return { kind: 'ready' as const, inspection };
}

test('the consumer admits ten supplied bins and one native history row while preserving empty continuation', async () => {
  const { admitSourceObservation, inspectSourceObservation, sourceObservationHref, SOURCE_OBSERVATION_GENERATED_SEAM } =
    await import('../src/features/catalogue/source-observation/contract');
  const request: SourceObservationRequest = { subjectId, source: 'bangumi', history: true };
  const base = {
    source: 'bangumi',
    head: { digest: headItem.digest, state: 'published', observation: headItem },
    resolution: {
      put: { expectedObservation: headItem.digest },
      clear: { expectedObservation: headItem.digest },
    },
  };
  const oneRow = admitSourceObservation(request, {
    ...base,
    history: { items: [historyItem], nextCursor: null },
  });
  expect(oneRow?.history?.items).toHaveLength(1);
  expect(oneRow?.history?.items[0]?.payload.figures?.distribution?.bins).toHaveLength(10);
  const continuing = admitSourceObservation(request, {
    ...base,
    history: { items: [], nextCursor: 'opaque-cursor' },
  });
  expect(continuing?.history).toEqual({ items: [], nextCursor: 'opaque-cursor' });
  expect(
    admitSourceObservation(request, {
      ...base,
      history: { items: [historyItem, historyItem], nextCursor: null },
    }),
  ).toBeNull();
  expect(sourceObservationHref(`/en/subjects/${subjectId}/sources?realm=realm-a`, 'bangumi', selectedDigest)).toBe(
    `/en/subjects/${subjectId}/sources?realm=realm-a&provider=bangumi&digest=${selectedDigest}`,
  );
  expect(sourceObservationHref(`/en/subjects/${subjectId}/sources`, 'other-provider', selectedDigest)).toBeNull();
  expect(await inspectSourceObservation(null, { subjectId, source: 'bangumi', digest: selectedDigest })).toEqual({
    kind: 'unavailable',
    capability: SOURCE_OBSERVATION_GENERATED_SEAM,
  });
  expect(
    await inspectSourceObservation(async () => ({ status: 404 }), {
      subjectId,
      source: 'bangumi',
      digest: selectedDigest,
    }),
  ).toEqual({ kind: 'missing' });
  expect(
    await inspectSourceObservation(async () => ({ status: 404 }), { subjectId, source: 'bangumi', history: true }),
  ).toEqual({ kind: 'missing' });
  expect(
    await inspectSourceObservation(async () => ({ status: 409 }), { subjectId, source: 'bangumi', history: true }),
  ).toEqual({ kind: 'conflict' });
  expect(
    await inspectSourceObservation(async () => ({ status: 503 }), { subjectId, source: 'bangumi', history: true }),
  ).toEqual({ kind: 'unavailable' });
});

test('one selected reading compares with the current head and each explicit history action replaces one bounded page', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en' });
  const keys =
    'window document navigator HTMLElement Element Node MutationObserver getComputedStyle IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale, m } = await import('../src/paraglide/runtime.js').then(async (runtime) => ({
    setLocale: runtime.setLocale,
    m: await import('../src/paraglide/messages.js').then((messages) => messages.m),
  }));
  setLocale('en', { reload: false });
  const { SourceObservationReader } = await import('../src/features/catalogue/source-observation/reader');
  const calls: SourceObservationRequest[] = [];
  const inspect: SourceObservationInspect = async (request) => {
    calls.push(request);
    if (request.source === 'vndb') return ready(clearedInspection);
    if (request.digest) return ready(exactInspection);
    if (request.history)
      return ready({
        source: 'bangumi',
        head: exactInspection.head,
        history: { items: [], nextCursor: 'opaque-native-cursor' },
      });
    return ready({
      source: 'bangumi',
      head: exactInspection.head,
      history: { items: [historyItem], nextCursor: null },
    });
  };
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await act(async () => {
      root.render(
        h(SourceObservationReader, {
          subjectId,
          source: 'bangumi',
          digest: selectedDigest,
          locale: 'en',
          sourcesHref: `/en/subjects/${subjectId}/example/sources`,
          inspect,
        }),
      );
      await tick();
    });
    expect(calls).toEqual([{ subjectId, source: 'bangumi', digest: selectedDigest }]);
    expect(host.textContent).toContain(m.source_observation_current());
    expect(host.textContent).toContain(m.source_observation_selected());
    expect(host.textContent).toContain('248001');
    expect(host.textContent).toContain('bangumi');
    expect(host.textContent).toContain('2026-10-20');
    expect(host.textContent).toContain('0–10');
    expect(host.textContent).toContain('local commit order, not provider date');
    expect(host.textContent).toContain('CC-BY-4.0');
    expect(host.textContent).not.toContain('opaque-native-cursor');
    expect(host.querySelectorAll('[data-slot="source-observation-item"]')).toHaveLength(2);

    const load = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.source_observation_load_history(),
    );
    expect(load).toBeTruthy();
    await act(async () => {
      load!.click();
      await tick();
    });
    expect(calls[1]).toEqual({ subjectId, source: 'bangumi', history: true });
    expect(host.textContent).toContain(m.source_observation_no_visible_item());
    expect(host.textContent).not.toContain(m.source_observation_exhausted());
    expect(host.textContent).toContain(selectedDigest);
    expect(host.textContent).toContain('2026-11-01');
    expect(host.querySelectorAll('[data-slot="source-observation-history-page"] li')).toHaveLength(0);

    const next = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.source_observation_continue(),
    );
    expect(next).toBeTruthy();
    await act(async () => {
      next!.click();
      await tick();
    });
    expect(calls[2]).toEqual({ subjectId, source: 'bangumi', cursor: 'opaque-native-cursor' });
    expect(host.querySelectorAll('[data-slot="source-observation-history-page"] li')).toHaveLength(1);
    expect(host.textContent).toContain(selectedDigest);
    const compare = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('248001') && button.textContent.includes('2026-10-19'),
    );
    expect(compare).toBeTruthy();
    await act(async () => compare!.click());
    expect(host.textContent).toContain(historyDigest);
    expect(host.textContent).toContain('2026-11-01');

    await act(async () => {
      root.render(
        h(SourceObservationReader, {
          key: 'cleared-source',
          subjectId,
          source: 'vndb',
          digest: clearObservation.digest,
          locale: 'en',
          sourcesHref: `/en/subjects/${subjectId}/example/sources`,
          inspect,
        }),
      );
      await tick();
    });
    expect(host.textContent).toContain(m.source_observation_head_cleared());
    expect(host.textContent).toContain(m.source_observation_cleared());
    expect(host.textContent).toContain('cleared-record');
    expect(host.textContent).not.toContain('120');

    await act(async () => {
      root.render(
        h(SourceObservationReader, {
          key: 'concealed-observation',
          subjectId,
          source: 'bangumi',
          digest: selectedDigest,
          locale: 'en',
          sourcesHref: `/en/subjects/${subjectId}/example/sources?realm=realm-a#subject-sources-heading`,
          inspect: async () => ({ kind: 'missing' }),
        }),
      );
      await tick();
    });
    expect(host.textContent).toContain(m.not_found_message());
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === m.sources_retry())).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('a conflict retry replays the exact original cursor and a late retired observation cannot replace its successor', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en' });
  const keys =
    'window document navigator HTMLElement Element Node MutationObserver getComputedStyle IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const { SourceObservationReader } = await import('../src/features/catalogue/source-observation/reader');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const calls: SourceObservationRequest[] = [];
  const cursor = 'retry-the-supplied-cursor';
  let cursorConflict = true;
  let historyUnavailable = true;
  let releaseOld!: (outcome: ReturnType<typeof ready>) => void;
  const retired = new Promise<ReturnType<typeof ready>>((resolve) => {
    releaseOld = resolve;
  });
  const replacement = item('d'.repeat(64), 'vndb', '12345', '5', '2026-11-03');
  const replacementInspection: SourceObservationInspection = {
    source: 'vndb',
    head: { digest: replacement.digest, state: 'published', observation: replacement },
  };
  const inspect: SourceObservationInspect = async (request) => {
    calls.push(request);
    if (request.source === 'bangumi' && request.digest) return ready(exactInspection);
    if (request.source === 'bangumi' && request.history) {
      return ready({
        source: 'bangumi',
        head: exactInspection.head,
        history: { items: [], nextCursor: cursor },
      });
    }
    if (request.source === 'bangumi' && request.cursor && cursorConflict) {
      cursorConflict = false;
      return { kind: 'conflict' };
    }
    if (request.source === 'bangumi' && request.cursor && historyUnavailable) {
      historyUnavailable = false;
      return { kind: 'unavailable' };
    }
    if (request.source === 'bangumi') return retired;
    return ready(replacementInspection);
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await act(async () => {
      root.render(
        h(SourceObservationReader, {
          key: 'old-scope',
          subjectId,
          source: 'bangumi',
          digest: selectedDigest,
          locale: 'en',
          sourcesHref: `/en/subjects/${subjectId}/example/sources`,
          inspect,
        }),
      );
      await tick();
    });
    expect(calls[0]).toEqual({ subjectId, source: 'bangumi', digest: selectedDigest });
    const load = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.source_observation_load_history(),
    );
    expect(load).toBeTruthy();
    await act(async () => {
      load!.click();
      await tick();
    });
    expect(calls[1]).toEqual({ subjectId, source: 'bangumi', history: true });
    const continueHistory = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.source_observation_continue(),
    );
    expect(continueHistory).toBeTruthy();
    await act(async () => {
      continueHistory!.click();
      await tick();
    });
    expect(calls[2]).toEqual({ subjectId, source: 'bangumi', cursor });
    expect(host.textContent).toContain(m.sources_conflict());
    const retryConflict = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.sources_retry(),
    );
    expect(retryConflict).toBeTruthy();
    await act(async () => {
      retryConflict!.click();
      await tick();
    });
    expect(calls[3]).toEqual(calls[2]);
    expect(host.textContent).toContain(m.sources_unavailable());
    const retryUnavailable = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.sources_retry(),
    );
    expect(retryUnavailable).toBeTruthy();
    await act(async () => {
      retryUnavailable!.click();
      await tick();
    });
    expect(calls[4]).toEqual(calls[2]);

    await act(async () => {
      root.render(
        h(SourceObservationReader, {
          key: 'new-scope',
          subjectId,
          source: 'vndb',
          digest: replacement.digest,
          locale: 'en',
          sourcesHref: `/en/subjects/${subjectId}/example/sources`,
          inspect,
        }),
      );
      await tick();
    });
    expect(calls[5]).toEqual({ subjectId, source: 'vndb', digest: replacement.digest });
    releaseOld(ready(exactInspection));
    await act(async () => tick());
    expect(host.textContent).toContain('12345');
    expect(host.textContent).not.toContain('248001');
    expect(host.textContent).not.toContain(selectedDigest);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
