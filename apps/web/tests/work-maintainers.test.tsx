import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyOf } from '../features/work-maintainers/messages.ts';
import { MaintainerPanel } from '../features/work-maintainers/panel.tsx';
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
