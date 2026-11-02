import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopiesFallback } from '../src/library/copies-fallback';
import type { CopiesPageData } from '../src/library/copies-read';

const kinds = [
  {
    id: 'print',
    label: 'Print edition',
    statuses: [
      { id: 'owned', label: 'On shelf' },
      { id: 'lent', label: 'On loan' },
    ],
  },
  { id: 'digital', label: 'Digital edition', statuses: [{ id: 'owned', label: 'Available online' }] },
];
const page: CopiesPageData = {
  signedIn: true,
  subjectId: 'edition',
  copies: [],
  next: null,
  addKey: 'original-key',
  sendKind: true,
  profile: { kinds },
};
const render = (data = page, csrfToken: string | null = 'current-token') =>
  renderToStaticMarkup(<CopiesFallback page={data} csrfToken={csrfToken} />);

test('each ordinary POST keeps its kind context, advertised statuses and original command fields', () => {
  const html = render();
  const forms = [...html.matchAll(/<form\b[^>]*method="post"[^>]*>([\s\S]*?)<\/form>/g)];
  expect(forms).toHaveLength(kinds.length);
  forms.forEach(([form], index) => {
    const kind = kinds[index]!;
    const fields = Object.fromEntries(
      [...form.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map(([, name, value]) => [name, value]),
    );
    expect(fields).toEqual({
      csrf_token: 'current-token',
      idempotencyKey: page.addKey,
      sendKind: 'true',
      subjectId: page.subjectId,
      intent: 'create',
      kind: kind.id,
    });
    expect(form).toContain(`<legend`);
    expect(form).toContain(kind.label);
    const select = form.match(/<select\b([^>]*)>([\s\S]*?)<\/select>/)!;
    expect([...select[2]!.matchAll(/<option[^>]*value="([^"]+)"/g)].map(([, value]) => value)).toEqual(
      kind.statuses.map(({ id }) => id),
    );
    kind.statuses.forEach(({ label }) => expect(select[2]).toContain(label));
    const id = select[1]!.match(/id="([^"]+)"/)![1];
    expect(form).toContain(`for="${id}"`);
    expect(form).toMatch(/<button[^>]*type="submit"[^>]*class="[^"]*min-h-11/);
  });
  const ids = [...html.matchAll(/<select[^>]*id="([^"]+)"/g)].map(([, id]) => id);
  expect(new Set(ids).size).toBe(kinds.length);
  expect(html).toMatch(/<summary[^>]*class="[^"]*min-h-11/);
});

test('single-kind, read-only subject selection and missing profiles keep their native behavior', () => {
  const single = render({ ...page, sendKind: false, profile: { kinds: kinds.slice(1) } }, null);
  expect(single.match(/<form/g)).toHaveLength(1);
  expect(single).toContain('name="kind" value="digital"');
  expect(single).toContain('name="csrf_token" value=""');
  expect(single).toContain('name="sendKind" value="false"');
  for (const profile of [undefined, { kinds: [] }]) {
    expect(render({ ...page, profile })).not.toContain('<form');
    const selector = render({ ...page, profile, subjectId: null });
    expect(selector).toContain('method="get"');
    expect(selector).toContain('id="fallback-copy-subject"');
    expect(selector).toContain('name="subjectId" required');
    expect(selector).not.toContain('method="post"');
  }
});
