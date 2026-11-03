import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { workPartId, workPartsFixture, workPartsSecondId } from '../../src/kernel/fake/work-parts';
import {
  applyOrderingPosition,
  orderingKey,
  recordOrderingResult,
  replacePosition,
  sealOrdering,
  sendOrdering,
  stageOrderingSelection,
} from '../../src/features/catalogue/work-parts-ordering';
import type { RelationProposal, RelationProposalResult } from '../../src/subject/relation-candidates';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('two existing holders keep native-string positions, citations and independent uncertain custody', async () => {
  const fixture = workPartsFixture('positions');
  const page = await fixture.transport.read();
  if (!page.ok || !page.stream) throw new Error('Expected the current membership page');
  expect(page.rows).toHaveLength(2);
  expect(page.stream.positionEditable).toBe(true);
  const first = page.rows[0]!;
  const second = page.rows[1]!;
  expect(first.holder).toBe(workPartId);
  expect(second.holder).toBe(workPartsSecondId);
  const extra = {
    property: { id: 'rezics:firstPart', data_type: 'string' as const },
    value: { type: 'value' as const, content: 'A' },
  };
  expect(
    replacePosition({ ...first.statement!, qualifiers: [...first.statement!.qualifiers, extra] }, '10').qualifiers,
  ).toEqual([
    { property: { id: 'schema:position', data_type: 'string' }, value: { type: 'value', content: '10' } },
    extra,
  ]);
  let drafts = stageOrderingSelection([], page.rows, page.stream, new Set(page.rows.map(orderingKey)));
  expect(drafts.map((draft) => draft.currentPosition)).toEqual(['2', 'S2.5']);
  drafts = drafts.map((draft) => applyOrderingPosition(draft, draft.holder === workPartId ? '10' : 'OVA'));
  expect(drafts[1]!.statement.references).toEqual(second.statement!.references.map(({ parts }) => ({ parts })));
  expect(drafts[0]!.statement.references).toEqual(first.statement!.references.map(({ parts }) => ({ parts })));
  let live = sealOrdering(drafts);
  expect(live.every((draft) => draft.command?.id === draft.holder)).toBe(true);
  expect(live[0]!.command?.statement.qualifiers).toEqual(replacePosition(drafts[0]!.original, '10').qualifiers);
  const calls: RelationProposal[] = [];
  let failSecond = true;
  const propose = async (input: RelationProposal): Promise<RelationProposalResult> => {
    calls.push(input);
    if (failSecond && input.id === workPartsSecondId) {
      failSecond = false;
      return { ok: false, reason: 'unavailable', retry: true };
    }
    return fixture.transport.relation(input.id).propose(input);
  };
  await sendOrdering(live, propose, (key, result) => {
    live = live.map((draft) => (draft.key === key ? recordOrderingResult(draft, result) : draft));
  });
  expect(calls.map((call) => call.id).sort()).toEqual([workPartId, workPartsSecondId].sort());
  const firstKey = live.find((draft) => draft.holder === workPartId)!.command!.key;
  const secondCommand = live.find((draft) => draft.holder === workPartsSecondId)!.command!;
  expect(live.find((draft) => draft.holder === workPartId)?.result?.ok).toBe(true);
  expect(live.find((draft) => draft.holder === workPartsSecondId)?.result).toMatchObject({
    ok: false,
    reason: 'unavailable',
    retry: true,
  });
  expect(secondCommand.key).toBeTruthy();
  const retryFrom = calls.length;
  await sendOrdering(live, propose, (key, result) => {
    live = live.map((draft) => (draft.key === key ? recordOrderingResult(draft, result) : draft));
  });
  const retryCalls = calls.slice(retryFrom);
  expect(retryCalls).toHaveLength(1);
  expect(retryCalls[0]!.id).toBe(workPartsSecondId);
  expect(retryCalls[0]!.key).toBe(secondCommand.key);
  expect(retryCalls[0]!.retry).toBe(true);
  expect(live.find((draft) => draft.holder === workPartId)?.command?.key).toBe(firstKey);
  expect(live.find((draft) => draft.holder === workPartsSecondId)?.result?.ok).toBe(true);
  expect(fixture.holder.subject.statements['wdt:P179']![0]!.qualifiers[0]!.value).toEqual({
    type: 'value',
    content: '2',
  });
  expect(second.statement!.qualifiers[0]!.value).toEqual({ type: 'value', content: 'S2.5' });
});

test('Work Parts stages a bounded page, reviews changed positions and submits independent proposals', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/book/title' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
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
  const { setLocale } = await import('../../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const click = async (name: string, scope: ParentNode = host) => {
    const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === name,
    )!;
    expect(button).toBeDefined();
    await act(async () => button.click());
    return button;
  };
  const until = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(predicate()).toBe(true);
  };
  try {
    const { WorkPartsPage } = await import('../../src/features/catalogue/work-parts-page');
    const { m } = await import('../../src/paraglide/messages.js');
    const fixture = workPartsFixture('positions');
    const initial = fixture.snapshot();
    if (!initial.ok || !initial.stream) throw new Error('Expected the current membership page');
    let failSecond = true;
    const relation = fixture.transport.relation;
    const transport = {
      ...fixture.transport,
      relation: (id: string) => {
        const inner = relation(id);
        return {
          ...inner,
          propose: async (input: RelationProposal): Promise<RelationProposalResult> => {
            if (failSecond && input.id === workPartsSecondId) {
              failSecond = false;
              return { ok: false, reason: 'unavailable', retry: true };
            }
            return inner.propose(input);
          },
        };
      },
    };
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(WorkPartsPage, { id: fixture.id, locale: 'en', initial, search: fixture.search, transport }),
        ),
      ),
    );
    const rows = [...host.querySelectorAll('article ul > li')];
    expect(rows).toHaveLength(2);
    for (const row of rows) await act(async () => row.querySelector<HTMLElement>('[data-slot="checkbox"]')!.click());
    await until(() => !!host.querySelector('[data-ordering-board]'));
    const inputs = [...host.querySelector('[data-ordering-board]')!.querySelectorAll<HTMLInputElement>('input')];
    expect(inputs.map((input) => input.value)).toEqual(['2', 'S2.5']);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(inputs[0], '10');
      inputs[0]!.dispatchEvent(new window.Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(inputs[1], 'OVA');
      inputs[1]!.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await click(m.work_parts_order_exclude(), host.querySelector('[data-ordering-board]')!);
    expect(host.querySelector('[data-ordering-review]')!.textContent).toContain('Volume Special');
    expect(host.querySelector('[data-ordering-review]')!.textContent).not.toContain('Volume Two');
    await act(async () => host.querySelector<HTMLElement>('[data-slot="checkbox"]')!.click());
    await until(() => host.querySelector('[data-ordering-review]')!.textContent!.includes('Volume Two'));
    await click(m.work_parts_order_review());
    await click(m.work_parts_order_submit());
    await until(
      () => !!host.querySelector('[data-ordering-results]')?.textContent?.includes('Proposed, awaiting review'),
    );
    expect(host.querySelector('[data-ordering-results]')!.textContent).toContain('Uncertain');
    const posts = fixture.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    await click(m.work_parts_order_submit());
    await until(() => fixture.calls.filter((call) => call.method === 'POST').length === 2);
    expect(
      fixture.calls
        .filter((call) => call.method === 'POST')
        .map((call) => call.path)
        .sort(),
    ).toEqual([`/v1/subjects/${workPartId}/candidates`, `/v1/subjects/${workPartsSecondId}/candidates`].sort());
    expect(posts[0]!.key).toBe(fixture.calls.filter((call) => call.method === 'POST')[0]!.key);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
