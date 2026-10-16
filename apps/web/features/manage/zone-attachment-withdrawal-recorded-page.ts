import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { readMainSessionAgent } from '../auth/session.ts';
import { recordedManagementAgent } from '../realm/realm-membership-recorded-page.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';

export type WithdrawalSurface = 'realm' | 'delegated-realm' | 'zone';

/** Select one visit's exact answers; repeated cached/session reads retain their recorded order. */
export function withdrawalReplay(record: AnswerRecord, persona: AnswerPersona, surface: WithdrawalSurface, loading = false) {
  const samples = record.personas[persona].filter(sample => sample.label.startsWith(`${surface}-`)
    || surface === 'zone' && sample.label.startsWith('attachment-'));
  const held = surface === 'zone' ? 'zone-configuration' : `${surface}-attachments`;
  const replay = recordedFetch(record, persona, samples.map(sample => ({ label: sample.label,
    state: loading && sample.label === held ? 'loading' : sample.status >= 400 ? 'error' : 'populated',
  })), { pathPrefix: BFF_PREFIX, sequence: true });
  const coordinate = samples.find(sample => sample.label === (surface === 'zone' ? 'zone-configuration' : `${surface}-attachments`));
  if (!coordinate) throw new Error('Recorded withdrawal route has no coordinate');
  const url = new URL(coordinate.path, 'https://recorded.invalid');
  const main = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
  return { ...replay, coordinate: url.pathname.split('/')[3]!,
    main,
    anonymous: browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher }),
    session: async () => {
      // The server's host client caches language selection/preferences before session discovery.
      await readMainSessionAgent('recorded', '00000000-0000-4000-8000-000000000001', replay.fetcher);
      await main.v1.me['person-preferences'].get({ query: { actingSubject: url.searchParams.get('actingSubject')! } });
      return recordedManagementAgent(replay.fetcher, 'en');
    } };
}
