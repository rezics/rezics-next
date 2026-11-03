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
