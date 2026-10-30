import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { valueExplanationFixture, valueCursor, valueLastCursor } from '../src/kernel/fake/value-explanation';
import { readValueExplanation, type ValueRead } from '../src/features/catalogue/value-explanation';
import { m } from '../src/paraglide/messages.js';
import { readSubjectRevisionDetail } from '../src/features/catalogue/subject-changes-detail';
import type { NativeRevisionDetail } from '../src/features/catalogue/subject-changes';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { ValueExplanationPage } = await import('../src/features/catalogue/value-explanation-page');
const html = (result: ValueRead) => renderToStaticMarkup(createElement(ValueExplanationPage, { result, locale: 'en' }));

test('Explain why a currently selected value is being read through existing current APIs with honest incomplete or denied states', async () => {
  const fixture = valueExplanationFixture();
  const result = await fixture.transport();
  if (result.kind !== 'ready') throw new Error('Expected the current native reading');
  expect(result.page.statement?.id).toBe(fixture.selected.id);
  expect(result.page.statement?.rank).toBe('preferred');
  expect(result.page.statement?.rezics.revision).toBe(2);
  expect(result.page.competition).toMatchObject({ kind: 'returned', decision: 'accepted', revision: 2 });
  expect(result.page.change).toEqual({ kind: 'unavailable' });
  const view = html(result);
  expect(view).toContain('9780156012195');
  expect(view).toContain('Édition originale');
  expect(view).toContain('lang="fr"');
  expect(view).toContain('https://catalogue.example.test/books/prince');
  expect(view).toContain(m.context_global());
  expect(view).toContain('/sources');
  expect(view).toContain('/changes');
  expect(view).toContain('candidateField=schema%3Aisbn');
  expect(view).not.toContain('UNSELECTED PRIVATE ALTERNATIVE');
  expect(JSON.stringify(result)).not.toContain('PRIVATE SOURCE');
  expect(JSON.stringify(result)).not.toContain('head');
  expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
  expect(fixture.calls.filter((call) => call.path.endsWith('/candidates'))).toHaveLength(1);
  expect(fixture.calls.every((call) => call.authorization === 'Bearer value-viewer')).toBe(true);

  const paged = valueExplanationFixture('paged');
  const first = await paged.transport();
  expect(first.kind === 'ready' && first.page.competition).toEqual({ kind: 'not-returned', next: valueCursor });
  expect(html(first)).toContain('9780156012195');
  expect(paged.calls.filter((call) => call.path.endsWith('/candidates'))).toHaveLength(1);
  const middle = await paged.transport(valueCursor, first.kind === 'ready' ? first.session : undefined);
  expect(middle.kind === 'ready' && middle.page.competition).toEqual({ kind: 'not-returned', next: valueLastCursor });
  expect(paged.calls.at(-1)).toMatchObject({ cursor: valueCursor, session: 'value-session' });
  const last = await paged.transport(valueLastCursor, middle.kind === 'ready' ? middle.session : undefined);
  expect(last.kind === 'ready' && last.page.competition?.kind).toBe('returned');
  expect(paged.calls.filter((call) => call.path.endsWith('/candidates'))).toHaveLength(3);

  for (const scenario of ['review-denied', 'review-error'] as const) {
    const denied = await valueExplanationFixture(scenario).transport();
    expect(denied.kind === 'ready' && denied.page.statement?.id).toBe(fixture.selected.id);
    expect(html(denied)).toContain(
      scenario === 'review-denied' ? m.value_metadata_denied() : m.value_metadata_unavailable(),
    );
  }
});

test('a native terms revision cannot masquerade as the origin of a currently selected statement', async () => {
  const fixture = valueExplanationFixture();
  const dto: NativeRevisionDetail = {
    subject: fixture.id,
    revision: { revision: fixture.selected.rezics.revision, kind: 'terms', release: fixture.selected.rezics.release },
    change: { kind: 'terms', fields: [{ field: 'labels', languages: ['en'] }] },
  };
  const calls: Request[] = [];
  const native = createKernelClient('https://native-value.test', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      calls.push(request);
      return Response.json(dto, { headers: { 'rezics-session-token': 'revision-session' } });
    }) as typeof fetch,
  });
  let nativeDetail: Awaited<ReturnType<typeof readSubjectRevisionDetail>> | undefined;
  const result = await readValueExplanation(fixture.client, fixture.address, {
    authorization: 'Bearer value-viewer',
    detail: async (_client, input) => {
      nativeDetail = await readSubjectRevisionDetail(native, input);
      return nativeDetail;
    },
  });
  expect(nativeDetail?.kind === 'ready' && nativeDetail.detail.summary).toEqual(dto.change);
  expect(result.kind === 'ready' && result.page.change).toEqual({ kind: 'unavailable' });
  expect(html(result)).toContain('9780156012195');
  expect(html(result)).toContain(m.value_change_unavailable());
  expect(html(result)).not.toContain(m.changes_terms());
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/subjects/${fixture.id}/revisions/2`);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer value-viewer');
  expect(calls[0]!.headers.get('rezics-session-token')).toBe('value-session');
});

test('current unresolved, concealed, changed and unknown values remain different without private or history fallback', async () => {
  for (const scenario of ['unresolved', 'not-selected', 'somevalue', 'novalue', 'concealed', 'error'] as const) {
    const fixture = valueExplanationFixture(scenario);
    const result = await fixture.transport();
    const view = html(result);
    const message =
      scenario === 'unresolved'
        ? m.context_unresolved()
        : scenario === 'not-selected'
          ? m.value_not_selected()
          : scenario === 'somevalue'
            ? m.subject_value_unknown()
            : scenario === 'novalue'
              ? m.subject_value_none()
              : scenario === 'concealed'
                ? m.value_missing()
                : m.value_error();
    expect(view).toContain(message);
    expect(view).not.toContain('9780156012195');
    if (scenario !== 'somevalue' && scenario !== 'novalue') expect(fixture.calls).toHaveLength(1);
  }
  const fixture = valueExplanationFixture();
  const mismatched = await readValueExplanation(fixture.client, {
    ...fixture.address,
    context: '00000000-0000-8000-8000-000000000099',
  });
  expect(mismatched).toEqual({ kind: 'unavailable' });
  fixture.selected.qualifiers.push({
    property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
    value: { type: 'value', content: { amount: '1', unit: '1' } },
  });
  expect(html(await fixture.transport())).toContain(m.value_withheld());
  const revealed = await readValueExplanation(fixture.client, fixture.address, {
    reader: { spoilerLevel: 1, suitability: 'blur' },
  });
  expect(html(revealed)).toContain('9780156012195');
});

test('documents use only the current authorized representation and the existing renderer; safe details must match the selected origin', async () => {
  const fixture = valueExplanationFixture('document');
  expect(html(await fixture.transport())).toContain(m.candidate_value_unavailable());
  fixture.inlineDocument();
  expect(html(await fixture.transport())).toContain('Authorized original words');
  expect(fixture.calls.some((call) => call.path.includes('/documents/'))).toBe(false);
  const result = await readValueExplanation(fixture.client, fixture.address, {
    detail: async (_client, input) => ({
      kind: 'ready',
      detail: {
        id: input.id,
        revision: input.revision,
        summary: { kind: 'candidate', candidate: fixture.selected.id, property: fixture.property },
      },
    }),
  });
  expect(html(result)).toContain(m.changes_proposal_detail());
  const unrelated = await readValueExplanation(fixture.client, fixture.address, {
    detail: async (_client, input) => ({
      kind: 'ready',
      detail: { id: input.id, revision: 99, summary: { kind: 'limited' } },
    }),
  });
  expect(unrelated.kind === 'ready' && unrelated.page.change).toEqual({ kind: 'unavailable' });
  const revoked = await readValueExplanation(fixture.client, fixture.address, {
    detail: async () => ({ kind: 'denied', scope: 'subject' }),
  });
  expect(revoked).toEqual({ kind: 'denied' });
  expect(html(revoked)).not.toContain('Authorized original words');
});
