import { resourceHref } from '../features/address/path.ts';
import { describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { allowedActionsOf, EDIT_ACTION, mayEdit } from '../features/work-levels-edit/allowed.ts';
import { isRelationKind, relationKinds, viaOf } from '../features/work-levels-edit/kinds.ts';
import { copyOf, englishMessages, messages } from '../features/work-levels-edit/messages.ts';
import { editHref, workIdFrom, workIri } from '../features/work-levels-edit/route.ts';
import {
  idFrom,
  isPending,
  problemOf,
  receiptOf,
  valuesOf,
  writeKey,
} from '../features/work-levels-edit/write.ts';
import { uiLocales } from '../i18n/define.ts';

// The editors keep their submit state in React hooks and refresh through the App Router.
void mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh() {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
const { PartsEditor } = await import('../features/work-levels-edit/parts-editor.tsx');
const { RelationEditor } = await import('../features/work-levels-edit/relation-editor.tsx');
const { RealizationEditor, ReleaseEditor } =
  await import('../features/work-levels-edit/editions-editor.tsx');
const { NoAuthority } = await import('../features/work-levels-edit/edit-frame.tsx');
const { WriteStatus, hintFor } = await import('../features/work-levels-edit/write-status.tsx');

const id = '01944100-0000-7000-8000-000000000123';
const t = copyOf('en');
const action = async () => ({ status: 'idle' as const });

describe('G-839 addresses and Work names', () => {
  test('edit pages live beside the hub, not in it', () => {
    expect(editHref('sao', 'parts')).toBe(`${resourceHref('/w/', 'sao')}/edit/parts`);
    expect(editHref('a b', 'editions')).toBe(`${resourceHref('/w/', 'a b')}/edit/editions`);
  });

  test('a Work is named by its address, IRI or ID, and nothing else', () => {
    expect(workIdFrom(id)).toBe(id);
    expect(workIdFrom(`https://rezics.com/id/${id.toUpperCase()}`)).toBe(id);
    expect(workIdFrom(`  https://rezics.com/en/w/${id}?x=1 `)).toBe(id);
    expect(workIdFrom('sword-art-online')).toBeNull();
    expect(workIdFrom('')).toBeNull();
    expect(workIri(id)).toBe(`https://rezics.com/id/${id}`);
  });
});

describe('G-839 what Main answered', () => {
  test('a refusal is classed by Main’s status and keeps Main’s reason', () => {
    expect(
      problemOf({
        status: 409,
        value: { code: 'stale_composition_head', detail: 'Expected head is stale' },
      }),
    ).toEqual({ problem: 'stale', detail: 'Expected head is stale' });
    expect(problemOf({ status: 401 }).problem).toBe('sign-in');
    expect(problemOf({ status: 403 }).problem).toBe('denied');
    expect(problemOf({ status: 404 }).problem).toBe('denied');
    for (const status of [400, 413, 422])
      expect(problemOf({ status, value: { title: 'Bad' } })).toEqual({
        problem: 'invalid',
        detail: 'Bad',
      });
    for (const status of [500, 503]) expect(problemOf({ status }).problem).toBe('unavailable');
  });

  test('only a moved head or basis offers a reload; any other 409 is a refusal with its own reason', () => {
    for (const code of [
      'stale_head',
      'stale_composition_head',
      'realization_basis_changed',
      'release_basis_changed',
      'read_basis_changed',
    ]) {
      expect(problemOf({ status: 409, value: { code } }).problem).toBe('stale');
    }
    for (const code of [
      'composition_conflict',
      'idempotency_conflict',
      'structure_stage_conflict',
      'generation_changed',
    ]) {
      expect(problemOf({ status: 409, value: { code, title: 'Nope' } })).toEqual({
        problem: 'conflict',
        detail: 'Nope',
      });
    }
    expect(problemOf({ status: 409 }).problem).toBe('conflict');
  });

  test('a receipt, a replay and a pending operation are told apart', () => {
    expect(receiptOf({ receipt: 'r-1', replayed: true })).toEqual({
      receipt: 'r-1',
      replayed: true,
    });
    expect(receiptOf({ receipt: 'r-2' })).toEqual({ receipt: 'r-2', replayed: false });
    expect(receiptOf({ operationId: 'o' })).toBeNull();
    expect(isPending({ operationId: 'o', status: 'reconciling' })).toBe(true);
    expect(isPending({ receipt: 'r' })).toBe(false);
  });

  test('a write’s key repeats for the same write and differs for any change, including the head it expects', async () => {
    const a = await writeKey(['parts', 'add', id, 'head-1', '22 Reverse']);
    expect(await writeKey(['parts', 'add', id, 'head-1', '22 Reverse'])).toBe(a);
    expect(await writeKey(['parts', 'add', id, 'head-2', '22 Reverse'])).not.toBe(a);
    expect(await writeKey(['parts', 'add', id, 'head-1', '22'])).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9:_./-]{1,128}$/);
  });

  test('a record created by a retried write keeps its ID', async () => {
    const key = await writeKey(['release', id]);
    const first = await idFrom(key, 'release');
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await idFrom(key, 'release')).toBe(first);
    expect(await idFrom(key, 'realization')).not.toBe(first);
  });

  test('submitted values are kept for the form to show again, repeated fields together', () => {
    const form = new FormData();
    form.append('label', '22 Reverse');
    form.append('coverage', 'a b');
    form.append('coverage', 'c d');
    form.append('$ACTION_ID_x', 'skip');
    expect(valuesOf(form)).toEqual({ label: '22 Reverse', coverage: 'a b\nc d' });
  });
});

describe('G-839 authority is Main’s answer', () => {
  test('work.edit anywhere in the page’s sections means the viewer may edit', () => {
    expect(
      allowedActionsOf({
        sections: [{ actions: [] }, { actions: [EDIT_ACTION] }, { actions: [EDIT_ACTION, 'x'] }],
      }),
    ).toEqual([EDIT_ACTION, 'x']);
    expect(allowedActionsOf(null)).toEqual([]);
    expect(mayEdit([EDIT_ACTION])).toBe(true);
    expect(mayEdit([])).toBe(false);
    expect(mayEdit(['work.read', 'work.edit.other'])).toBe(false);
  });

  test('the relation kinds are a fixed list of definition keys with their write route; only the labels come from the lexicon', () => {
    expect(relationKinds.map((kind) => kind.key)).toEqual([
      'rewrite',
      'reboot',
      'adaptation',
      'sequel',
      'spin-off',
      'correspondence-equivalent',
      'correspondence-partial',
      'correspondence-revised',
    ]);
    expect(viaOf('reboot')).toBe('derivation');
    expect(viaOf('sequel')).toBe('relation');
    expect(isRelationKind('rewrite')).toBe(true);
    expect(isRelationKind('friend')).toBe(false);
  });
});

// The class guard: no edit control renders for a viewer whose allowed actions do not include editing.
const parts = [
  {
    occurrence: `https://rezics.com/id/${id}`,
    label: '22',
    name: 'New Testament 22',
    inclusion: 'required' as const,
    role: 'part' as const,
  },
  {
    occurrence: 'https://rezics.com/id/01944100-0000-7000-8000-000000000124',
    label: '1',
    name: 'New Testament 1',
    inclusion: 'optional' as const,
    role: 'part' as const,
  },
];
const realization = {
  id: `https://rezics.com/id/${id}`,
  revision: 'https://rezics.com/id/01944100-0000-7000-8000-000000000125',
  work: `https://rezics.com/id/${id}`,
  language: 'ja',
};
const kinds = [
  { key: 'sequel' as const, label: 'Sequel to', language: 'en' },
  { key: 'reboot' as const, label: 'Reboot of', language: 'en' },
];
const surfaces: Record<string, (allowed: readonly string[]) => string> = {
  parts: (allowed) =>
    renderToStaticMarkup(
      createElement(PartsEditor, {
        work: id,
        structure: 'https://rezics.com/id/s',
        head: 'https://rezics.com/id/h',
        parts,
        allowed,
        locale: 'en',
        action,
        messages: messages.en,
      }),
    ),
  'parts without a list': (allowed) =>
    renderToStaticMarkup(
      createElement(PartsEditor, {
        work: id,
        structure: null,
        head: null,
        parts: [],
        allowed,
        locale: 'en',
        action,
        messages: messages.en,
      }),
    ),
  relations: (allowed) =>
    renderToStaticMarkup(
      createElement(RelationEditor, {
        work: id,
        mainVersion: 'https://rezics.com/id/m',
        head: 'https://rezics.com/id/h',
        kinds,
        allowed,
        locale: 'en',
        action,
        messages: messages.en,
      }),
    ),
  realization: (allowed) =>
    renderToStaticMarkup(
      createElement(RealizationEditor, {
        work: id,
        mainVersion: 'https://rezics.com/id/m',
        mainRevision: 'https://rezics.com/id/h',
        existing: [realization],
        allowed,
        locale: 'en',
        action,
        messages: messages.en,
      }),
    ),
  release: (allowed) =>
    renderToStaticMarkup(
      createElement(ReleaseEditor, {
        work: id,
        own: [realization],
        allowed,
        locale: 'en',
        action,
        messages: messages.en,
      }),
    ),
};
const control = /<(form|button|input|select|textarea|details)\b/;

describe('G-839 class guard: edit controls only for a viewer Main lets edit', () => {
  for (const [name, render] of Object.entries(surfaces)) {
    test(`${name}: nothing renders without work.edit`, () => {
      for (const allowed of [[], ['work.read'], ['work.edit.other'], ['collection.edit']])
        expect(render(allowed)).toBe('');
    });
    test(`${name}: the controls render with work.edit`, () => {
      expect(render([EDIT_ACTION])).toMatch(/<form\b/);
    });
  }

  test('the no-authority page offers no form control', () => {
    for (const signedIn of [true, false]) {
      const html = renderToStaticMarkup(
        createElement(NoAuthority, { workRef: 'sao', signedIn, signInHref: '/auth/start', t }),
      );
      expect(html).not.toMatch(control);
    }
  });

  test('every source file that draws a control checks the allowed actions, or is only drawn inside a file that does', () => {
    const directory = join(import.meta.dir, '../features/work-levels-edit');
    // Drawn only by the gated editors: the submit result and the Work picker.
    const inside = new Set(['write-status.tsx', 'work-picker.tsx']);
    const drawing = /<(form|Button|button|input|Input|NativeSelect|Textarea)\b/;
    const ungated = readdirSync(directory)
      .filter((file) => file.endsWith('.tsx') && !file.includes('.stories.'))
      .filter(
        (file) =>
          drawing.test(readFileSync(join(directory, file), 'utf8')) &&
          !/mayEdit\(/.test(readFileSync(join(directory, file), 'utf8')),
      )
      .filter((file) => !inside.has(file));
    expect(ungated).toEqual([]);
  });
});

describe('G-839 server pages and client editors', () => {
  test('a page hands an editor the raw catalog: materialized copy holds functions, which cannot cross to a client component', () => {
    const source = readFileSync(
      join(import.meta.dir, '../features/work-levels-edit/edit-pages.tsx'),
      'utf8',
    );
    const editors = [
      ...source.matchAll(
        /<(PartsEditor|RelationEditor|RealizationEditor|ReleaseEditor)\b[^>]*?\/>/gs,
      ),
    ];
    expect(editors).toHaveLength(4);
    for (const [markup] of editors) {
      expect(markup).toMatch(/\bmessages=\{messages\[locale\]\}/);
      expect(markup).not.toMatch(/\bt=\{/);
    }
  });
});

describe('G-839 what Main refused is shown with its own reason', () => {
  test('a moved head offers to reload and keeps the input; Main’s reason is quoted', () => {
    const html = renderToStaticMarkup(
      createElement(WriteStatus, {
        t,
        onReload() {},
        state: {
          status: 'error',
          problem: 'stale',
          detail: 'Expected composition head is stale',
          field: null,
          values: { label: '22 Reverse' },
        },
      }),
    );
    expect(html).toContain(t.problemStale);
    expect(html).toContain('Expected composition head is stale');
    expect(html).toContain(t.reload);
  });

  test('a recorded change shows Main’s receipt', () => {
    const html = renderToStaticMarkup(
      createElement(WriteStatus, {
        t,
        onReload() {},
        state: { status: 'done', receipt: 'rcpt-7', replayed: false, nonce: 'n' },
      }),
    );
    expect(html).toContain('rcpt-7');
  });

  test('a malformed field is explained with that field, not in the alert', () => {
    const state = {
      status: 'error' as const,
      problem: 'invalid' as const,
      detail: null,
      field: 'evidence',
      values: {},
    };
    expect(hintFor(state, 'evidence', t)).toBe(t.badEvidence);
    expect(hintFor(state, 'label', t)).toBeNull();
    expect(renderToStaticMarkup(createElement(WriteStatus, { t, onReload() {}, state }))).toBe('');
    // A code with no control of its own is the alert's to report.
    expect(
      renderToStaticMarkup(
        createElement(WriteStatus, { t, onReload() {}, state: { ...state, field: 'intent' } }),
      ),
    ).toContain(t.badIntent);
  });
});

describe('G-839 catalogs', () => {
  test('every locale supplies every key English does, with the same placeholders', () => {
    const english = Object.keys(englishMessages);
    for (const locale of uiLocales) {
      expect(Object.keys(messages[locale]).sort()).toEqual([...english].sort());
    }
  });

  test('no copy names the service: "Main" appears only in the domain term Main Version', () => {
    const domain =
      /Main Version|メインバージョン|主版本|Hauptversion|Version principale|Versión principal|메인 버전/g;
    const offending = uiLocales.flatMap((locale) =>
      Object.entries(messages[locale]).flatMap(([key, value]) => {
        // Native-i18n nodes keep their pattern in `pattern`; strings are the value itself.
        const text =
          typeof value === 'string' ? value : ((value as { pattern?: string }).pattern ?? '');
        return /Main/.test(text.replace(domain, '')) ? [`${locale}.${key}`] : [];
      }),
    );
    expect(offending).toEqual([]);
  });

  test('no English copy names a relation; Main words them', () => {
    const words = /\b(sequel|spin-?off|reboot|rewrite|adaptation)\b/i;
    const offending = Object.entries(englishMessages).filter(
      ([, value]) => typeof value === 'string' && words.test(value),
    );
    expect(offending).toEqual([]);
  });
});
