import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnClassificationsWorkspace } from '../src/ratings/own-classifications/page';
import { admitOwnClassificationsPage } from '../src/ratings/own-classifications/admission';
import { classificationFrontier, indexOwnClassifications } from '../src/ratings/own-classifications/inventory';
import {
  accountId,
  classificationRow,
  classificationsPage,
  frontier,
  subjectId,
} from './own-classification-assessments-fixture';

test('native order, 20 raw slots plus one exact selected promotion, and concealed shape remain native', () => {
  for (const size of [1, 10, 20, 21]) {
    const rows = Array.from({ length: size }, (_, index) => classificationRow(index));
    const address = {
      ...frontier,
      selected: size === 21 ? { subjectId, associationId: rows[20]!.associationId } : null,
    };
    const page = classificationsPage(rows, ' raw +/=%opaque ');
    expect(admitOwnClassificationsPage(page, accountId, address)).toBe(page);
    expect([...indexOwnClassifications(page, address).values()]).toEqual(rows);
    if (size === 21) expect(admitOwnClassificationsPage(page, accountId, frontier)).toBeNull();
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
  expect(admitOwnClassificationsPage(classificationsPage([withheld]), accountId, frontier)).not.toBeNull();
  expect(
    admitOwnClassificationsPage(classificationsPage([{ ...withheld, subject: row.subject }]), accountId, frontier),
  ).toBeNull();
  expect(admitOwnClassificationsPage(classificationsPage([row, row]), accountId, frontier)).toBeNull();
  expect(admitOwnClassificationsPage(classificationsPage(), 'another-account', frontier)).toBeNull();
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
