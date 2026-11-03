import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnClassificationsWorkspace } from '../src/ratings/own-classifications/page';
import { classificationFrontier, indexOwnClassifications } from '../src/ratings/own-classifications/inventory';
import { classificationRow, classificationsPage, frontier, subjectId } from './own-classification-assessments-fixture';

test('native order, 20 raw slots plus one exact selected promotion, and concealed shape remain native', () => {
  for (const size of [1, 10, 20, 21]) {
    const rows = Array.from({ length: size }, (_, index) => classificationRow(index));
    const address = {
      ...frontier,
      selected: size === 21 ? { subjectId, associationId: rows[20]!.associationId } : null,
    };
    const page = classificationsPage(rows, ' raw +/=%opaque ');
    expect(indexOwnClassifications(page, address).size).toBe(size);
    expect([...indexOwnClassifications(page, address).values()]).toEqual(rows);
    if (size === 21) expect(() => indexOwnClassifications(page, frontier)).toThrow();
  }
  const row = classificationRow();
  const withheld = {
    ...row,
    state: 'withheld' as const,
    subject: null,
    target: null,
    association: null,
    aggregate: null,
    actions: { state: 'withdraw-only' as const, readback: null, set: null, clear: row.actions.clear },
  };
  expect(indexOwnClassifications(classificationsPage([withheld]), frontier).size).toBe(1);
  expect(() =>
    indexOwnClassifications(classificationsPage([{ ...withheld, subject: row.subject }]), frontier),
  ).toThrow();
  expect(() => indexOwnClassifications(classificationsPage([row, row]), frontier)).toThrow();
});

test('withheld rows disclose only own-state and never promise withdrawal before generated binding', () => {
  const row = classificationRow();
  const page = classificationsPage([
    {
      ...row,
      state: 'withheld',
      subject: null,
      target: null,
      association: null,
      aggregate: null,
      actions: { state: 'withdraw-only', readback: null, set: null, clear: row.actions.clear },
    },
  ]);
  const html = renderToStaticMarkup(
    <OwnClassificationsWorkspace
      state="ready"
      page={page}
      frontier={frontier}
      locale="en"
      isCurrent={() => true}
      onRetry={async () => {}}
      onNext={() => {}}
    />,
  );
  expect(html).toContain('Classification context withheld');
  expect(html).toContain('You support this association.');
  for (const concealed of ['Own-page subject', 'Own-page concept', subjectId, 'href=', '<button', 'supportCount'])
    expect(html).not.toContain(concealed);
  expect(classificationFrontier({ selectedSubjectId: subjectId })).toBeNull();
  expect(classificationFrontier({ cursor: '' })).toBeNull();
  expect(classificationFrontier({ cursor: 'x'.repeat(4097) })).toBeNull();
});

test('current summary destinations preserve original association keys and the serialized response stays bounded', () => {
  const row = classificationRow();
  if (row.state !== 'available') throw new Error('Expected disclosed fixture');
  const originalTarget = row.association.targetId;
  row.target = { ...row.target, id: subjectId, label: 'Current destination' };
  const page = classificationsPage([row]);
  expect([...indexOwnClassifications(page, frontier).values()][0]?.associationId).toBe(row.associationId);
  expect(row.association.targetId).toBe(originalTarget);
  row.subject.label = '界'.repeat(350_000);
  expect(() => indexOwnClassifications(page, frontier)).toThrow('Invalid classification frontier');
});

test('the closed native union rejects unknown and malformed private context before rendering any row', () => {
  const invalid: unknown[] = [null, [], { ...classificationsPage(), history: [] }];
  for (const [field, changes] of [
    ['viewer', { extra: 'concealed' }],
    ['inventory', { complete: true }],
    ['own', { pending: 'complete' }],
    ['subject', { label: 'x'.repeat(2001) }],
    ['target', { id: 'not-an-id' }],
    ['association', { qualifiersDigest: 'reconstruct-me' }],
    ['actions', { state: 'allowed' }],
    ['aggregate', { supportCount: 0 }],
  ] as const) {
    const page = classificationsPage();
    const row = page.items[0]!;
    const holder = field === 'viewer' || field === 'inventory' ? page : row;
    const record = holder as unknown as Record<string, object>;
    record[field] = { ...record[field], ...changes };
    invalid.push(page);
  }
  invalid.push(classificationsPage([{ ...classificationRow(), state: 'future' } as never]));
  for (const page of invalid) {
    expect(() => indexOwnClassifications(page, frontier)).toThrow();
    const html = renderToStaticMarkup(
      <OwnClassificationsWorkspace
        state="ready"
        page={page as never}
        frontier={frontier}
        locale="en"
        isCurrent={() => true}
        onRetry={async () => {}}
        onNext={() => {}}
      />,
    );
    expect(html).not.toContain('Own-page subject');
    expect(html).not.toContain('href=');
  }
});

test('native aggregate absence, suppression and published zero remain distinct and keep the original row', () => {
  const row = classificationRow();
  const zero = {
    associationId: row.associationId,
    state: 'published' as const,
    pending: 'unknown' as const,
    supportCount: 0,
    opposeCount: 0,
    falsePositiveCount: 0,
    supportFraction: null,
    asOf: '2026-11-04T00:00:00Z',
    generation: '1',
  };
  for (const aggregate of [null, row.aggregate, zero]) {
    const page = classificationsPage([{ ...row, aggregate }]);
    expect([...indexOwnClassifications(page, frontier).values()][0]).toBe(page.items[0]);
  }
  expect(() =>
    indexOwnClassifications(classificationsPage([{ ...row, aggregate: { ...zero, supportCount: -1 } }]), frontier),
  ).toThrow();
  expect(() =>
    indexOwnClassifications(
      classificationsPage([{ ...row, aggregate: { ...zero, associationId: subjectId } }]),
      frontier,
    ),
  ).toThrow();
});

test('the response cap counts UTF-8 bytes and admits the exact boundary', () => {
  const page = classificationsPage();
  const row = page.items[0]!;
  if (row.state !== 'available') throw new Error('Expected disclosed fixture');
  row.subject.label = '界';
  const bytes = new TextEncoder().encode(JSON.stringify(page)).length;
  page.inventory.generation = '1'.repeat(1_048_576 - bytes + 1);
  expect(indexOwnClassifications(page, frontier).size).toBe(1);
  page.inventory.generation += '1';
  expect(() => indexOwnClassifications(page, frontier)).toThrow('Invalid classification frontier');
});
