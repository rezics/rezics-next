import { expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import {
  MAX_COMPLETED_UNITS,
  changeIntent,
  nextUnitCount,
  parseRecord,
  parseSessionCreate,
  transition,
  type ProgressMode,
  type ProgressOutcome,
  type ProgressRecordContext,
  type ProgressState,
  type ProgressUnit,
} from '../../src/library/progress.ts';

const subjectId = newId(7);
const versionSubjectId = newId(8);

function accepted<T>(result: ProgressOutcome<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected a valid progress value, got ${result.field}`);
  return result.value;
}

function rejected(result: ProgressOutcome<unknown>, field: string): void {
  expect(result).toEqual({ ok: false, field });
}

function active(unit: ProgressUnit): ProgressRecordContext {
  return { unit, state: 'active' };
}

const modes = ['scalar_amount', 'cursor_position', 'completed_units'] as const satisfies readonly ProgressMode[];
const units = ['page', 'chapter', 'episode', 'volume', 'minute', 'percent'] as const satisfies readonly ProgressUnit[];

test('a session has exactly one mode for one subject and an optional version subject', () => {
  for (const mode of modes) {
    for (const unit of units) {
      expect(accepted(parseSessionCreate({ subjectId, mode, unit }))).toEqual({
        subjectId,
        versionSubjectId: null,
        mode,
        unit,
        total: null,
      });
    }
  }

  expect(accepted(parseSessionCreate({ subjectId, versionSubjectId, mode: 'cursor_position', unit: 'page' }))).toEqual({
    subjectId,
    versionSubjectId,
    mode: 'cursor_position',
    unit: 'page',
    total: null,
  });
  expect(
    accepted(parseSessionCreate({ subjectId, versionSubjectId: null, mode: 'completed_units', unit: 'chapter' })),
  ).toEqual({
    subjectId,
    versionSubjectId: null,
    mode: 'completed_units',
    unit: 'chapter',
    total: null,
  });

  const first = accepted(parseSessionCreate({ subjectId, mode: 'scalar_amount', unit: 'minute', total: '10' }));
  const reread = accepted(parseSessionCreate({ subjectId, mode: 'scalar_amount', unit: 'minute', total: '20' }));
  expect(first.total).toBe('10');
  expect(reread.total).toBe('20');
  expect(first).not.toBe(reread);
  expect(Object.keys(first).sort()).toEqual(['mode', 'subjectId', 'total', 'unit', 'versionSubjectId']);

  rejected(parseSessionCreate(null), 'session');
  rejected(parseSessionCreate([]), 'session');
  rejected(parseSessionCreate('scalar_amount'), 'session');
  rejected(parseSessionCreate({ mode: 'scalar_amount', unit: 'minute' }), 'subjectId');
  rejected(parseSessionCreate({ subjectId: 'subject', mode: 'scalar_amount', unit: 'minute' }), 'subjectId');
  rejected(parseSessionCreate({ subjectId: null, mode: 'scalar_amount', unit: 'minute' }), 'subjectId');
  rejected(
    parseSessionCreate({ subjectId, versionSubjectId: 'edition', mode: 'scalar_amount', unit: 'minute' }),
    'versionSubjectId',
  );
  rejected(
    parseSessionCreate({ subjectId, versionSubjectId: '', mode: 'scalar_amount', unit: 'page' }),
    'versionSubjectId',
  );
  rejected(parseSessionCreate({ subjectId, unit: 'page' }), 'mode');
  rejected(parseSessionCreate({ subjectId, unit: 'page', mode: null }), 'mode');
  rejected(parseSessionCreate({ subjectId, unit: 'page', mode: '' }), 'mode');
  rejected(parseSessionCreate({ subjectId, unit: 'page', mode: ['scalar_amount', 'cursor_position'] }), 'mode');
  rejected(parseSessionCreate({ subjectId, mode: 'scalar_amount' }), 'unit');
  rejected(parseSessionCreate({ subjectId, mode: 'pages', unit: 'page' }), 'mode');
  rejected(parseSessionCreate({ subjectId, mode: 'scalar_amount', unit: 'hour' }), 'unit');
  rejected(parseSessionCreate({ subjectId, mode: 'cursor_position', unit: 'page', total: '10' }), 'total');
  rejected(parseSessionCreate({ subjectId, mode: 'completed_units', unit: 'chapter', total: '3' }), 'total');
  rejected(
    parseSessionCreate({ subjectId, mode: 'scalar_amount', unit: 'minute', amount: '1', locator: 'page' }),
    'amount',
  );
  rejected(parseSessionCreate({ subjectId: 'not-a-subject', unit: 'page', mode: 'cursor_position' }), 'subjectId');
});

test('every record matches the session mode and rejects another mode, two modes, or none', () => {
  const samples = {
    scalar_amount: { amount: '1.5' },
    cursor_position: { locator: 'chapter:three', position: '1.5' },
    completed_units: { add: ['opaque:one'] },
  } as const;
  const expected = {
    scalar_amount: { amount: '1.5' },
    cursor_position: { locator: 'chapter:three', position: '1.5' },
    completed_units: { add: ['opaque:one'] },
  } as const;

  for (const mode of modes) {
    expect(accepted(parseRecord(mode, samples[mode], active('page')))).toEqual(expected[mode]);
    for (const other of modes) {
      if (other === mode) continue;
      expect(parseRecord(mode, samples[other], active('page')).ok).toBe(false);
    }
    rejected(
      parseRecord(mode, {}, active('page')),
      mode === 'scalar_amount' ? 'amount' : mode === 'cursor_position' ? 'locator' : 'add',
    );
    rejected(
      parseRecord(mode, { amount: '1', locator: 'page', position: '1' }, active('page')),
      mode === 'scalar_amount' ? 'locator' : 'amount',
    );
    rejected(
      parseRecord(mode, { add: ['1'], amount: '1' }, active('chapter')),
      mode === 'completed_units' ? 'amount' : 'add',
    );
  }

  rejected(parseRecord('nope' as ProgressMode, { amount: '1' }, { unit: 'minute', state: 'completed' }), 'mode');
  rejected(parseRecord('scalar_amount', null, active('minute')), 'record');
  rejected(parseRecord('scalar_amount', [], active('minute')), 'record');
  rejected(parseRecord('scalar_amount', { locator: 'page', position: '1' }, active('minute')), 'locator');
  rejected(parseRecord('scalar_amount', { amount: '1', note: 'later' }, active('minute')), 'note');
  rejected(parseRecord('cursor_position', { amount: '1' }, active('page')), 'amount');
  rejected(parseRecord('cursor_position', { position: '1' }, active('page')), 'locator');
  rejected(parseRecord('cursor_position', { locator: 'page' }, active('page')), 'position');
  rejected(parseRecord('cursor_position', { locator: '', position: '1' }, active('page')), 'locator');
  rejected(parseRecord('cursor_position', { locator: 'page', position: '-1' }, active('page')), 'position');
  rejected(parseRecord('completed_units', { amount: '1' }, active('chapter')), 'amount');
  rejected(parseRecord('completed_units', { locator: 'page', position: '1' }, active('chapter')), 'locator');
  rejected(parseRecord('completed_units', { add: ['1'], remove: null }, active('chapter')), 'remove');

  expect(
    accepted(parseRecord('cursor_position', { locator: 'chapter:three', position: '90.5' }, active('page'))),
  ).toEqual({
    locator: 'chapter:three',
    position: '90.5',
  });
  const backward = accepted(
    parseRecord('cursor_position', { locator: 'chapter:one', position: '12.25' }, active('page')),
  );
  expect(backward).toEqual({ locator: 'chapter:one', position: '12.25' });
  expect(changeIntent(backward)).toEqual({ locator: 'chapter:one', position: '12.25' });
  expect(accepted(parseRecord('cursor_position', { locator: ' ', position: '0' }, active('page')))).toEqual({
    locator: ' ',
    position: '0',
  });
  const locator = 'p'.repeat(256);
  expect(accepted(parseRecord('cursor_position', { locator, position: '1' }, active('page')))).toEqual({
    locator,
    position: '1',
  });
  rejected(parseRecord('cursor_position', { locator: 'p'.repeat(257), position: '1' }, active('page')), 'locator');

  const kept = { amount: '1.50' };
  expect(changeIntent(accepted(parseRecord('scalar_amount', kept, active('minute'))))).toEqual(kept);
});

test('a completed unit set stays sparse and is never turned into a range', () => {
  const chapter = active('chapter');
  const record = accepted(parseRecord('completed_units', { add: ['7', '1', '3'] }, chapter));
  expect(record).toEqual({ add: ['7', '1', '3'] });
  expect(changeIntent(record)).toEqual({ add: ['1', '3', '7'] });
  expect(record).toEqual({ add: ['7', '1', '3'] });
  expect(JSON.stringify(changeIntent(record))).toBe('{"add":["1","3","7"]}');
  expect(changeIntent(record)).not.toEqual({ add: ['1', '2', '3', '4', '5', '6', '7'] });

  const given = accepted(parseRecord('completed_units', { add: ['1', '3', '7'] }, chapter));
  expect(changeIntent(given)).toEqual({ add: ['1', '3', '7'] });
  expect(changeIntent(accepted(parseRecord('completed_units', { remove: ['3'] }, chapter)))).toEqual({ remove: ['3'] });

  const both = accepted(parseRecord('completed_units', { add: ['b', 'a'], remove: ['d', 'c'] }, chapter));
  expect(both).toEqual({ add: ['b', 'a'], remove: ['d', 'c'] });
  expect(JSON.stringify(changeIntent(both))).toBe('{"add":["a","b"],"remove":["c","d"]}');
  expect(changeIntent(accepted(parseRecord('completed_units', { add: ['10', '2'] }, chapter)))).toEqual({
    add: ['10', '2'],
  });

  rejected(parseRecord('completed_units', { add: { from: 1, to: 7 } }, chapter), 'add');
  rejected(parseRecord('completed_units', { add: [1, 3, 7] }, chapter), 'add');
  rejected(parseRecord('completed_units', { add: ['1', '1'] }, chapter), 'add');
  rejected(parseRecord('completed_units', { add: ['1'], remove: ['3', '3'] }, chapter), 'remove');
  rejected(parseRecord('completed_units', { add: ['1', '3'], remove: ['3', '7'] }, chapter), 'remove');
  rejected(parseRecord('completed_units', { add: [] }, chapter), 'add');
  rejected(parseRecord('completed_units', { add: [], remove: [] }, chapter), 'add');
  rejected(parseRecord('completed_units', { add: [' 1'] }, chapter), 'add');
  rejected(parseRecord('completed_units', { add: ['a/b'] }, chapter), 'add');
  rejected(parseRecord('completed_units', { remove: ['a'.repeat(129)] }, chapter), 'remove');

  for (const id of ['.', '_', ':', '~', '-', 'opaque:one', 'opaque-unit:0', 'volume:A', 'a'.repeat(128)]) {
    expect(changeIntent(accepted(parseRecord('completed_units', { add: [id] }, chapter)))).toEqual({ add: [id] });
  }

  const added = Array.from({ length: 100 }, (_, index) => `add-${index}`);
  const removed = Array.from({ length: 100 }, (_, index) => `remove-${index}`);
  expect(accepted(parseRecord('completed_units', { add: added }, chapter))).toEqual({ add: added });
  expect(accepted(parseRecord('completed_units', { remove: removed }, chapter))).toEqual({ remove: removed });
  rejected(parseRecord('completed_units', { add: added, remove: removed }, chapter), 'remove');
  rejected(parseRecord('completed_units', { add: [...added, 'extra'] }, chapter), 'add');
  rejected(parseRecord('completed_units', { remove: [...removed, 'extra'] }, chapter), 'remove');

  expect(nextUnitCount(0, 3, 0)).toEqual({ ok: true, value: 3 });
  expect(nextUnitCount(2, 1, 0)).toEqual({ ok: true, value: 3 });
  expect(nextUnitCount(3, 0, 1)).toEqual({ ok: true, value: 2 });
});

test('a completed units record whose add and remove lists hold more than one hundred ids together is invalid', () => {
  const chapter = active('chapter');
  const removed = Array.from({ length: 100 }, (_, index) => `remove-${index}`);
  const within = removed.slice(0, 99);
  expect(accepted(parseRecord('completed_units', { add: ['extra'], remove: within }, chapter))).toEqual({
    add: ['extra'],
    remove: within,
  });
  rejected(parseRecord('completed_units', { add: ['extra'], remove: removed }, chapter), 'remove');
});

test('percent stays within 0 to 100 and no amount completes a session by itself', () => {
  for (const total of ['0', '100', '100.0', '100.000000', '0.000000', '99.999999']) {
    expect(accepted(parseSessionCreate({ subjectId, mode: 'scalar_amount', unit: 'percent', total })).total).toBe(
      total,
    );
    expect(accepted(parseRecord('scalar_amount', { amount: total }, active('percent')))).toEqual({ amount: total });
  }
  for (const total of ['100.000001', '101', '100.1', '-0.1', '-0', '100000000000', '100.0000001']) {
    rejected(parseSessionCreate({ subjectId, mode: 'scalar_amount', unit: 'percent', total }), 'total');
    rejected(parseRecord('scalar_amount', { amount: total }, active('percent')), 'amount');
  }

  const minutes = accepted(parseSessionCreate({ subjectId, mode: 'scalar_amount', unit: 'minute', total: '120' }));
  expect(minutes).toMatchObject({ unit: 'minute', total: '120', mode: 'scalar_amount' });
  for (const amount of ['0', '120', '120.0', '121', '100.000001']) {
    const record = accepted(parseRecord('scalar_amount', { amount }, active('minute')));
    expect(record).toEqual({ amount });
    expect(changeIntent(record)).toEqual({ amount });
    expect(record).not.toHaveProperty('state');
    expect(changeIntent(record)).not.toHaveProperty('action');
  }
  const context = active('minute');
  accepted(parseRecord(minutes.mode, { amount: '120' }, context));
  expect(context.state).toBe('active');
  expect(accepted(transition('active', 'complete'))).toBe('completed');

  expect(accepted(parseRecord('scalar_amount', { amount: '90' }, active('percent')))).toEqual({ amount: '90' });
  expect(
    accepted(parseRecord('cursor_position', { locator: 'page', position: '100.000001' }, active('percent'))),
  ).toEqual({ locator: 'page', position: '100.000001' });
  rejected(parseRecord('cursor_position', { locator: 'page', position: '-0.1' }, active('percent')), 'position');
});

test('decimal strings stay exact within 12 integer digits and 6 fractional digits', () => {
  const exact = '999999999999.999999';
  expect(accepted(parseSessionCreate({ subjectId, mode: 'scalar_amount', unit: 'minute', total: exact })).total).toBe(
    exact,
  );
  expect(accepted(parseRecord('scalar_amount', { amount: exact }, active('minute')))).toEqual({ amount: exact });
  expect(accepted(parseRecord('scalar_amount', { amount: '1.50' }, active('minute')))).toEqual({ amount: '1.50' });
  expect(accepted(parseRecord('cursor_position', { locator: 'a', position: '0.000001' }, active('page')))).toEqual({
    locator: 'a',
    position: '0.000001',
  });
  expect(accepted(parseSessionCreate({ subjectId, mode: 'scalar_amount', unit: 'minute', total: null })).total).toBe(
    null,
  );

  for (const amount of [
    '1000000000000',
    '1234567890123.1',
    '1.0000001',
    '01',
    '00.1',
    '-1',
    '+1',
    '1e2',
    ' 1',
    '1 ',
    '1.',
    '.5',
    '',
    'null',
  ]) {
    rejected(parseRecord('scalar_amount', { amount }, active('minute')), 'amount');
    rejected(parseSessionCreate({ subjectId, mode: 'scalar_amount', unit: 'minute', total: amount }), 'total');
    rejected(parseRecord('cursor_position', { locator: 'a', position: amount }, active('page')), 'position');
  }
  rejected(parseRecord('scalar_amount', { amount: 120 }, active('minute')), 'amount');
  rejected(parseRecord('scalar_amount', { amount: 100 }, active('percent')), 'amount');
  rejected(parseSessionCreate({ subjectId, mode: 'scalar_amount', unit: 'percent', total: 100 }), 'total');
  rejected(parseRecord('cursor_position', { locator: 'a', position: 1 }, active('page')), 'position');
  expect(accepted(parseRecord('scalar_amount', { amount: '999999999999' }, active('volume')))).toEqual({
    amount: '999999999999',
  });
});

test('only an active session records, completes, or is abandoned', () => {
  const states = ['active', 'completed', 'abandoned'] as const satisfies readonly ProgressState[];
  for (const state of states) {
    for (const action of ['complete', 'abandon'] as const) {
      if (state === 'active') {
        expect(accepted(transition(state, action))).toBe(action === 'complete' ? 'completed' : 'abandoned');
      } else {
        rejected(transition(state, action), 'state');
      }
    }
  }
  rejected(transition('paused' as ProgressState, 'complete'), 'state');
  rejected(transition('active', 'record' as 'complete'), 'action');

  for (const state of ['completed', 'abandoned'] as const) {
    rejected(parseRecord('scalar_amount', { amount: '120' }, { unit: 'minute', state }), 'state');
    rejected(parseRecord('scalar_amount', { amount: '-1' }, { unit: 'minute', state }), 'state');
    rejected(parseRecord('cursor_position', { locator: 'a', position: '1' }, { unit: 'page', state }), 'state');
    rejected(parseRecord('completed_units', { add: ['1', '3', '7'] }, { unit: 'chapter', state }), 'state');
  }
  rejected(parseRecord('scalar_amount', { amount: '1' }, { unit: 'hour' as ProgressUnit, state: 'active' }), 'unit');
  rejected(
    parseRecord('scalar_amount', { amount: '1' }, { unit: 'minute', state: 'paused' as ProgressState }),
    'state',
  );
});

test('the completed unit count stays at or below 20000', () => {
  expect(MAX_COMPLETED_UNITS).toBe(20_000);
  expect(nextUnitCount(0, 0, 0)).toEqual({ ok: true, value: 0 });
  expect(nextUnitCount(20_000, 0, 0)).toEqual({ ok: true, value: 20_000 });
  expect(nextUnitCount(20_000, 1, 1)).toEqual({ ok: true, value: 20_000 });
  expect(nextUnitCount(19_950, 100, 50)).toEqual({ ok: true, value: 20_000 });
  expect(nextUnitCount(0, 20_000, 0)).toEqual({ ok: true, value: 20_000 });
  expect(nextUnitCount(10, 5, 10)).toEqual({ ok: true, value: 5 });
  rejected(nextUnitCount(20_000, 1, 0), 'completedUnitCount');
  rejected(nextUnitCount(19_950, 101, 50), 'completedUnitCount');
  rejected(nextUnitCount(0, 20_001, 0), 'completedUnitCount');
  rejected(nextUnitCount(20_001, 0, 0), 'completedUnitCount');
  rejected(nextUnitCount(-1, 0, 0), 'current');
  rejected(nextUnitCount(0, -1, 0), 'added');
  rejected(nextUnitCount(0, 0, -1), 'removed');
  rejected(nextUnitCount(1, 0, 2), 'removed');
  rejected(nextUnitCount(1.5, 0, 0), 'current');
  rejected(nextUnitCount(Number.NaN, 0, 0), 'current');
  rejected(nextUnitCount(Number.POSITIVE_INFINITY, 0, 0), 'current');
});
