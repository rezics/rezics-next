import { expect, test } from 'bun:test';
import { messages } from './messages.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';
import { memberFacingText, parseBanReading, type BanReading } from './reading.ts';
import { appealPresentation, banSchedule, offersAnotherAppeal, shownReading, statementProblem } from './view.ts';

const receipt = '00000000-0000-4000-8000-0000000000aa';
const caseId = '00000000-0000-4000-8000-0000000000bb';
const moderator = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000cc';
const now = Date.parse('2026-10-09T00:00:00.000Z');

function ban(appeal: Record<string, unknown>, extra: Record<string, unknown> = {}): BanReading {
  const reading = parseBanReading({
    realm: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
    receiptId: receipt, action: 'ban', reason: 'Posted the same chapter five times.',
    bannedUntil: null, permanent: true, happenedAt: '2026-10-01T12:00:00.000Z',
    decider: moderator, actingSubject: moderator, appeal, ...extra,
  });
  if (!reading) throw new Error('fixture did not parse');
  return reading;
}

test('a ban reading drops the decider and keeps the recorded reason', () => {
  const reading = ban({ state: 'none' });
  expect(reading.reason).toBe('Posted the same chapter five times.');
  expect(reading.permanent).toBe(true);
  expect(JSON.stringify(reading)).not.toContain(moderator);
  expect(JSON.stringify(reading)).not.toContain('decider');
  expect(memberFacingText(reading)).not.toContain(moderator);
  expect(memberFacingText(reading)).not.toContain(receipt);
});

test('a timed ban says until when, and a past end says it ended', () => {
  const until = ban({ state: 'none' }, { bannedUntil: '2026-11-01T00:00:00.000Z', permanent: false });
  const ended = ban({ state: 'none' }, { bannedUntil: '2026-09-01T00:00:00.000Z', permanent: false });
  expect(banSchedule(until, now)).toBe('until');
  expect(banSchedule(ended, now)).toBe('ended');
  expect(banSchedule(ban({ state: 'none' }), now)).toBe('permanent');
});

test('one receipt offers one appeal, then the outcome and not another form', () => {
  const open = ban({ state: 'open', caseId, statement: 'I posted it once.' });
  const upheld = ban({
    state: 'decided', caseId, statement: 'I posted it once.', outcome: 'dismiss',
    rationale: 'The posts were the same chapter.', decidedAt: '2026-10-02T08:00:00.000Z',
    acting_subject: moderator,
  });
  const reversed = ban({
    state: 'decided', caseId, statement: 'I posted it once.', outcome: 'restore', rationale: null,
  });
  expect(offersAnotherAppeal(ban({ state: 'none' }))).toBe(true);
  expect(appealPresentation(open)).toEqual({ kind: 'received', statement: 'I posted it once.' });
  expect(offersAnotherAppeal(open)).toBe(false);
  expect(appealPresentation(upheld)).toMatchObject({
    kind: 'upheld', decidedAt: '2026-10-02T08:00:00.000Z', rationale: 'The posts were the same chapter.',
  });
  expect(appealPresentation(reversed)).toMatchObject({ kind: 'reversed', rationale: null, decidedAt: null });
  expect(memberFacingText(upheld)).not.toContain(moderator);
  expect(memberFacingText(reversed)).not.toContain('acting_subject');
});

test('a private rationale and a bad reading stay off the page', () => {
  expect(parseBanReading({
    realm: 'https://rezics.com/id/1', receiptId: receipt, action: 'ban', reason: 'Because',
    bannedUntil: null, permanent: true, happenedAt: '2026-10-01T12:00:00.000Z',
    appeal: { state: 'decided', caseId, statement: 'Please', outcome: 'dismiss', rationale: null },
  })?.appeal).toMatchObject({ rationale: null });
  expect(parseBanReading({ action: 'warn', reason: 'Because' })).toBeNull();
  expect(parseBanReading(null)).toBeNull();
});

test('the statement must be a trimmed appeal the command will accept', () => {
  expect(statementProblem('  ')).toBe('empty');
  expect(statementProblem('a'.repeat(2001))).toBe('long');
  expect(statementProblem('  I posted it once.  ')).toBeNull();
});

test('an open appeal stays until the server reports the resolution', () => {
  const none = ban({ state: 'none' });
  const open = ban({ state: 'open', caseId, statement: 'I posted it once.' });
  const decided = ban({
    state: 'decided', caseId, statement: 'I posted it once.', outcome: 'dismiss', rationale: null,
  });
  expect(shownReading(none, open).appeal.state).toBe('open');
  expect(shownReading(decided, open).appeal.state).toBe('decided');
  expect(shownReading(open, { ...open, receiptId: caseId }).appeal.state).toBe('open');
});

test('every locale translates every appeal string', () => {
  const english = Object.keys(messages).sort();
  for (const translated of [de, es, fr, ja, ko, zhHans, zhHant])
    expect(Object.keys(translated).sort()).toEqual(english);
});
