import { describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { browserMainApi } from '../features/api/browser.ts';
import { browserMaintainers } from '../features/work-maintainers/api.ts';
import { copyOf } from '../features/work-maintainers/messages.ts';
import { MaintainerPanel, WorkMaintainers } from '../features/work-maintainers/panel.tsx';
import { maintainerChangeKey, maintainerProblem, maintainerRows, maintainerTarget, showAdd, showRemove } from '../features/work-maintainers/rules.ts';

const owner = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a1';
const maren = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a2';
const lin = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a3';
const names = {
  [owner]: { displayName: 'Ada Lovelace', handle: 'ada' },
  [maren]: { displayName: 'Maren Osei', handle: 'maren' },
  [lin]: { displayName: '林晓', handle: null },
};
const t = copyOf('en');

test('WorkMaintainers server renders its loading state without a browser or a request', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const send = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
    throw new Error('Server rendering must not request maintainers');
  }, { preconnect: fetch.preconnect }));
  try {
    Reflect.deleteProperty(globalThis, 'window');
    expect(typeof window).toBe('undefined');
    const html = renderToStaticMarkup(createElement(WorkMaintainers, {
      work: owner, actingSubject: owner, locale: 'en',
    }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(t.loading);
    expect(send).not.toHaveBeenCalled();
  } finally {
    send.mockRestore();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  }
});

test('an injected maintainer client keeps its actor, profile retry and command wire without a browser', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: { url: URL; init: RequestInit }[] = [];
  const roster = { work: owner, generation: '7', owner, maintainers: [owner, maren] };
  let profiles = 0;
  const fetcher = Object.assign(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    if (url.pathname.endsWith('/maintainers')) return Response.json(roster);
    if (url.pathname.includes('/agents/')) {
      if (++profiles === 1) return Response.json({ code: 'read_basis_changed' }, { status: 409 });
      return Response.json(names[maren]);
    }
    if (url.pathname.includes('/handles/')) return Response.json({ id: lin, ...names[lin] });
    return Response.json({ ...roster, replayed: true });
  }, { preconnect: fetch.preconnect });
  try {
    Reflect.deleteProperty(globalThis, 'window');
    const source = browserMaintainers(owner, browserMainApi('https://rezics.com', { fetcher }));
    expect(await source.read(owner)).toEqual(roster);
    expect(await source.names([maren])).toEqual({ [maren]: names[maren] });
    expect(await source.resolve('@lin_mei')).toEqual({ id: lin, name: names[lin] });
    expect(await source.resolve(maren)).toEqual({ id: maren, name: names[maren] });
    expect(await source.change({ work: owner, actingSubject: owner, target: lin, action: 'add',
      expectedGeneration: '7', key: 'same-generation-change' })).toEqual({
      status: 200, code: null, title: null, roster, replayed: true,
    });
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      `/api/main/v1/works/${owner.slice(-36)}/maintainers`,
      `/api/main/v1/agents/${maren.slice(-36)}`, `/api/main/v1/agents/${maren.slice(-36)}`,
      '/api/main/v1/handles/lin_mei', `/api/main/v1/agents/${maren.slice(-36)}`,
      '/api/main/v1/work-maintainer-changes',
    ]);
    for (const { init } of calls) expect(init.credentials).toBe('same-origin');
    for (const { url } of calls.slice(1, -1)) expect(url.searchParams.get('actingSubject')).toBe(owner);
    expect(calls[2]!.url.href).toBe(calls[1]!.url.href);
    const command = calls.at(-1)!.init;
    expect(command.method).toBe('POST');
    expect(new Headers(command.headers).get('idempotency-key')).toBe('same-generation-change');
    expect(JSON.parse(String(command.body))).toEqual({
      profile: 'work-maintainer-change-v1', work: owner, actingSubject: owner, target: lin,
      action: 'add', expectedGeneration: '7',
    });
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  }
});

function markup(viewer: string, maintainers: readonly string[]) {
  const rows = maintainerRows({ viewer, owner, maintainers, names });
  return renderToStaticMarkup(createElement(MaintainerPanel, {
    rows, canAdd: showAdd(viewer, maintainers), draft: '', fieldError: null, notice: null, pending: null,
    confirming: null, reloading: false, t, onDraft() {}, onAdd() {}, onAskRemove() {}, onConfirmRemove() {},
    onCancelRemove() {}, onReload() {},
  }));
}

describe('maintainer panel visibility', () => {
  test('the owner sees Remove on co-maintainers, not on their own row', () => {
    const html = markup(owner, [owner, maren, lin]);
    expect(html).toContain('aria-label="Remove Maren Osei"');
    expect(html).toContain('aria-label="Remove 林晓"');
    expect(html).not.toContain('aria-label="Remove Ada Lovelace"');
    expect(html).toContain('>Owner<');
    expect(showRemove(owner, owner, maren, 3)).toBe(true);
    expect(showRemove(owner, owner, owner, 3)).toBe(false);
  });

  test('a co-maintainer sees Add and no Remove', () => {
    const html = markup(maren, [owner, maren]);
    expect(html).not.toContain('aria-label="Remove');
    expect(html).toContain('>Add<');
    expect(showAdd(maren, [owner, maren])).toBe(true);
    expect(showRemove(maren, owner, owner, 2)).toBe(false);
  });

  test('the last maintainer has no Remove', () => {
    const html = markup(owner, [owner]);
    expect(html).not.toContain('aria-label="Remove');
    expect(html).toContain('>Owner<');
    expect(html).toContain('>Add<');
    expect(showRemove(owner, owner, owner, 1)).toBe(false);
  });

  test('someone who does not maintain the Work sees the list without Add or Remove', () => {
    const outsider = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a9';
    const html = markup(outsider, [owner, maren]);
    expect(html).not.toContain('aria-label="Remove');
    expect(html).not.toContain('>Add<');
    expect(showAdd(outsider, [owner, maren])).toBe(false);
  });
});

describe('maintainer changes', () => {
  test('a generation conflict is a stale list; the last maintainer is not', () => {
    expect(maintainerProblem(409, 'idempotency_conflict')).toBe('stale');
    expect(maintainerProblem(409, null)).toBe('stale');
    expect(maintainerProblem(409, 'controller_continuity')).toBe('continuity');
    expect(maintainerProblem(403, 'authority_denied')).toBe('denied');
    expect(maintainerProblem(401, null)).toBe('sign-in');
    expect(maintainerProblem(503, 'dependency_unavailable')).toBe('unavailable');
  });

  test('a conflict alert keeps the typed handle and offers the latest list', () => {
    const html = renderToStaticMarkup(createElement(MaintainerPanel, {
      rows: maintainerRows({ viewer: owner, owner, maintainers: [owner, maren], names }),
      canAdd: true, draft: '@lin_mei', fieldError: null, notice: { kind: 'stale' }, pending: null,
      confirming: null, reloading: false, t, onDraft() {}, onAdd() {}, onAskRemove() {}, onConfirmRemove() {},
      onCancelRemove() {}, onReload() {},
    }));
    expect(html).toContain('This list changed since you opened it');
    expect(html).toContain('Reload latest');
    expect(html).toContain('@lin_mei');
    expect(html).not.toContain('Idempotency key conflicts');
  });

  test('the same change against the same generation reuses its key', async () => {
    const first = await maintainerChangeKey([owner, owner, maren, 'remove', '1']);
    const again = await maintainerChangeKey([owner, owner, maren, 'remove', '1']);
    const moved = await maintainerChangeKey([owner, owner, maren, 'remove', '2']);
    expect(first).toBe(again);
    expect(moved).not.toBe(first);
  });

  test('a handle, an address and a blank field stay distinct', () => {
    expect(maintainerTarget(' @lin_mei ')).toEqual({ kind: 'handle', handle: 'lin_mei' });
    expect(maintainerTarget(maren)).toEqual({ kind: 'iri', iri: maren });
    expect(maintainerTarget(maren.slice(-36).toUpperCase())).toEqual({ kind: 'iri', iri: maren });
    expect(maintainerTarget('')).toEqual({ kind: 'invalid' });
    expect(maintainerTarget('not a handle')).toEqual({ kind: 'invalid' });
  });
});
