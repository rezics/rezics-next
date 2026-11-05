import { describe, expect, test } from 'bun:test';
import {
  acceptsProfileDecimal,
  parseRecord,
  parseSessionCreate,
  parseProgressSessionJournalPatch,
  parseJournalDateText,
  formatJournalDate,
  buildJournalDraftPatch,
  emptyJournalDraft,
  applyJournalPatch,
  recordedProgressValues,
  clearedProgressValues,
  changeIntent,
  nextUnitCount,
  transition,
} from '@rezics/progress';

const journal = {
  sessionId: 'occurrence',
  revision: 2,
  startDate: { year: 2024 },
  finishDate: null,
  reflection: ' private\ntext ',
  assessment: { meaningRevision: 1 as const, units: 0 },
};
const values = {
  mode: 'scalar_amount' as const,
  unit: 'segment',
  amount: '2.50',
  locator: null,
  position: null,
  completedUnitCount: 0,
  state: 'active' as const,
  completedAt: null,
  measures: [{ unit: 'volume', total: '8', amount: '1.00' }],
};

describe('shared progress and journal rules', () => {
  test('Gregorian partial dates keep precision and reject invalid shapes without Date coercion', () => {
    for (const text of ['0001', '0100-02', '2000-02-29', '2024-02-29', '9999-12-31']) {
      const date = parseJournalDateText(text);
      expect(date).not.toBeNull();
      expect(formatJournalDate(date)).toBe(text);
    }
    for (const text of [
      '',
      '2024\n',
      '0000',
      '0100-02-29',
      '1900-02-29',
      '2023-02-29',
      '2024-04-31',
      '2024-13',
      '24-01',
      '2024-1',
      '2024-01-00',
    ])
      expect(parseJournalDateText(text), text).toBeNull();
    for (const startDate of [
      { year: 2024, day: 1 },
      { year: 2024, month: null },
      { year: 2024, era: 'CE' },
    ])
      expect(parseProgressSessionJournalPatch({ revision: 0, startDate }).ok).toBe(false);
  });

  test('untouched, explicit clear and empty reflection remain distinct through review and patch', () => {
    const draft = {
      ...emptyJournalDraft(),
      startDate: { kind: 'set' as const, text: '2024-02' },
      reflection: { kind: 'set' as const, text: '' },
    };
    const result = buildJournalDraftPatch(2, draft);
    expect(result).toEqual({
      ok: true,
      patch: { revision: 2, startDate: { year: 2024, month: 2 }, reflection: '' },
      changedFields: ['startDate', 'reflection'],
    });
    if (!result.ok) throw new Error('Expected patch');
    expect(applyJournalPatch(journal, result.patch)).toEqual({
      ...journal,
      startDate: { year: 2024, month: 2 },
      reflection: '',
    });
    expect(buildJournalDraftPatch(2, { ...emptyJournalDraft(), startDate: { kind: 'set', text: '' } })).toEqual({
      ok: false,
      field: 'startDate',
    });
    expect(buildJournalDraftPatch(2, { ...emptyJournalDraft(), assessment: { kind: 'set', text: '0' } })).toMatchObject(
      { ok: true, patch: { assessment: { units: 0 } } },
    );
    expect(buildJournalDraftPatch(2, { ...emptyJournalDraft(), finishDate: { kind: 'clear' } })).toMatchObject({
      ok: true,
      patch: { finishDate: null },
    });
    expect(parseProgressSessionJournalPatch({ revision: 2, reflection: '😀'.repeat(1025) })).toEqual({
      ok: false,
      field: 'reflection',
    });
    expect(parseProgressSessionJournalPatch({ revision: 2, reflection: '\ud800' })).toEqual({
      ok: false,
      field: 'reflection',
    });
    expect(parseProgressSessionJournalPatch({ revision: 2, reflection: '\0' })).toEqual({
      ok: false,
      field: 'reflection',
    });
  });

  test('profiled decimals stay exact; independent measures and totals never imply completion', () => {
    const rules = { minimum: '0.001', maximum: '999999999999.999999', precision: 6 };
    expect(acceptsProfileDecimal(rules, '999999999999.999999')).toBe(true);
    for (const value of ['1e3', '01', '0.000999', '1.0000000', '1\n', 1])
      expect(acceptsProfileDecimal(rules, value)).toBe(false);
    expect(
      parseSessionCreate(
        { subjectId: 'subject', mode: 'scalar_amount', unit: 'segment', total: '3.750000' },
        { ...rules, totalPolicy: 'required' },
      ),
    ).toMatchObject({ ok: true, value: { total: '3.750000' } });
    const record = parseRecord('scalar_amount', { amount: '3.750000' }, values, rules);
    expect(record).toEqual({ ok: true, value: { amount: '3.750000' } });
    if (!record.ok) throw new Error('Expected record');
    expect(recordedProgressValues(values, record.value, 'volume')).toMatchObject({
      ok: true,
      value: { amount: '2.50', state: 'active', measures: [{ unit: 'volume', total: '8', amount: '3.750000' }] },
    });
    expect(clearedProgressValues(values, 'volume')).toMatchObject({
      ok: true,
      value: { amount: '2.50', state: 'active', measures: [{ unit: 'volume', total: '8', amount: null }] },
    });
    expect(parseRecord('scalar_amount', { amount: '1' }, { ...values, state: 'completed' }, rules)).toEqual({
      ok: false,
      field: 'state',
    });
    expect(transition('active', 'complete')).toEqual({ ok: true, value: 'completed' });
    expect(changeIntent({ add: ['7', '1', '3'] })).toEqual({ add: ['1', '3', '7'] });
    expect(nextUnitCount(2, 1, 0)).toEqual({ ok: true, value: 3 });
    expect(parseRecord('completed_units', { add: ['1'], remove: ['1'] }, { unit: 'episode', state: 'active' })).toEqual(
      { ok: false, field: 'remove' },
    );
  });
});
