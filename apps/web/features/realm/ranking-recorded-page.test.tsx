import { expect, test } from 'bun:test';
import '../../tests/support/official-package-fixture.ts';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { answerPersonas } from '../../../../scripts/api/answer-record.ts';
import rankingRecord from '../../../../tests/qa/fixtures/outcomes/realm/ranking.json';
import { isUiLocale } from '../../i18n/define.ts';
import { rankingRecording } from './ranking-recorded-page.tsx';

const record = rankingRecord as AnswerRecord;

test.each(['opaque:+/%?=&雪', '0'])('recorded request URLs preserve opaque continuation bytes: %s', cursor => {
  const thread = record.personas.visitor.find(sample => sample.label.startsWith('visit-')
    && new URL(sample.path, 'https://recorded.invalid').pathname.endsWith('/threads'));
  if (!thread) throw new Error('Expected a captured visitor thread request');
  const url = new URL(thread.path, 'https://recorded.invalid');
  url.searchParams.set('cursor', cursor);
  // Only vary the request URL; every captured answer stays untouched.
  const changed = { ...record, personas: { ...record.personas,
    visitor: record.personas.visitor.map(sample => sample === thread ? { ...sample, path: url.pathname + url.search } : sample),
  } };
  const transport = rankingRecording(changed, 'visitor', thread.label.replace(/-\d+$/, ''));
  try { expect(transport.query.cursor).toBe(cursor); }
  finally { transport.dispose(); }
});

for (const persona of answerPersonas) {
  const visits = record.personas[persona].filter(sample => /^visit-.+-1$/.test(sample.label))
    .map(sample => sample.label.slice(0, -2));
  test(`${persona}: every captured production ranking visit replays with zero missed requests`, async () => {
    expect(visits.length).toBeGreaterThan(0);
    for (const visit of visits) {
      const language = visit.split('@')[1] ?? 'en';
      if (!isUiLocale(language)) throw new Error(`Unrecognized captured locale: ${language}`);
      const transport = rankingRecording(record, persona, visit);
      try {
        expect(await transport.read(language)).not.toBeNull();
        transport.assertMatched();
        const thread = transport.samples.find(sample => new URL(sample.path, 'https://recorded.invalid').pathname.endsWith('/threads'));
        if (thread) {
          const query = new URL(thread.path, 'https://recorded.invalid').searchParams;
          expect(transport.query.cursor).toBe(query.get('cursor') ?? undefined);
          expect<string | null>(transport.query.sort).toBe(query.get('sort'));
          expect<string | null>(transport.query.window).toBe(query.get('window'));
        }
      } finally { transport.dispose(); }
    }
  });
}
