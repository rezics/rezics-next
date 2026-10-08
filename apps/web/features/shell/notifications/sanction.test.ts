import { expect, test } from 'bun:test';
import { uiLocales } from '../../../i18n/define.ts';
import { sanctionSentence } from './sanction.ts';

const reason = 'Repeated rule violations';
const realm = 'North Archive';
const moderator = ['Morgan Hale', 'morgan_hale', 'https://rezics.com/id/11111111-1111-4111-8111-111111111111'];

test('every locale states the ban, the reason and the end, and none names a moderator', () => {
  for (const locale of uiLocales) {
    const timed = sanctionSentence(locale, { action: 'ban', realm, reason, until: '2026-11-01T00:00:00.000Z',
      permanent: false });
    const forever = sanctionSentence(locale, { action: 'ban', realm, reason: 'Harassment after a warning',
      until: null, permanent: true });
    const lifted = sanctionSentence(locale, { action: 'unban', realm, reason: 'The report was withdrawn',
      until: null, permanent: false });
    for (const sentence of [timed, forever, lifted]) {
      expect(sentence).toContain(realm);
      for (const token of moderator) expect(sentence.includes(token)).toBe(false);
    }
    expect(timed).toContain(reason);
    expect(forever).toContain('Harassment after a warning');
    expect(lifted).toContain('The report was withdrawn');
    expect(timed).not.toBe(forever);
  }
  const english = sanctionSentence('en', { action: 'ban', realm, reason, until: '2026-11-01T00:00:00.000Z',
    permanent: false });
  expect(english).toContain('until');
  expect(english).toContain('appeal');
  expect(sanctionSentence('en', { action: 'ban', realm, reason, until: null, permanent: true }))
    .toContain('does not end');
  expect(sanctionSentence('en', { action: 'unban', realm, reason, until: null, permanent: false }))
    .toContain('has ended');
});
