import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { readRealmSpacePage } from '../address/space-page.ts';
import type { MainSessionAgentState } from '../auth/session.ts';
import { realmFrameReads } from './zone-presentation-read.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';

/** Replay reaches the production resolver and private-page reader; it never supplies a Persona's authority. */
export function recordedRealmEntry(record: AnswerRecord, persona: AnswerPersona, selections: readonly RecordedSelection[],
  addressLabel: string, sessionLabel?: string, locale: UiLocale = 'en') {
  const sample = (label: string) => {
    const found = record.personas[persona].find(item => item.label === label);
    if (!found) throw new Error(`Missing recorded Realm entry: ${persona}/${label}`);
    return found;
  };
  const key = new URL(sample(addressLabel).path, 'https://recorded.invalid').searchParams.get('key');
  if (!key) throw new Error('Recorded Realm entry has no address key');
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX, locale });
  const raw = (path: string) => replay.fetcher(new URL(`${BFF_PREFIX}${path}`, 'https://recorded.invalid'));
  const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher });
  const personal = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
  return { key, personal, dispose: replay.dispose,
    async read(locale: UiLocale) {
      const session = sessionLabel ? await raw(sample(sessionLabel).path).then(response => response.json() as Promise<MainSessionAgentState>) : null;
      const actingSubject = session?.sessionAgent.eligible ? session.sessionAgent.actingSubject ?? undefined : undefined;
      const reads = realmFrameReads({ main, personal, actingSubject, resolution: {
        readPrivateRealm: (ref, _locale, address) => readRealmSpacePage(ref, {
          address, actingSubject, ...(sessionLabel ? { token: 'recorded' } : {}),
        }, raw),
      } });
      return { resolved: await reads.resolveRealm(key, locale), actingSubject };
    },
  };
}
