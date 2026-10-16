import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import recordJson from '../../../../tests/qa/fixtures/outcomes/books/continue-progress-across-devices-two-device-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { parseLibraryState } from './state.ts';

export const twoDeviceRecord = recordJson as AnswerRecord;
const capturePrefix = 'library-device-';
const captured = (persona: AnswerPersona) => twoDeviceRecord.personas[persona].filter(item => item.label.startsWith(capturePrefix));

export type DevicePhase = 'winning' | 'recovered';
export const twoDeviceState = parseLibraryState({ shelf: 'read', view: 'grid' });

export function deviceSample(persona: AnswerPersona, label: string): AnswerSample {
  const sample = captured(persona).find(item => item.label === capturePrefix + label);
  if (!sample) throw new Error(`Missing two-device record: ${persona}/${label}`);
  return sample;
}

const url = (sample: AnswerSample) => new URL(sample.path, 'https://recorded.invalid');
export const deviceOwner = () => url(deviceSample('owner', 'device-two-resumed-chapter')).searchParams.get('actingSubject')!;
export const deviceBook = () => url(deviceSample('owner', 'book-type')).pathname.split('/').at(-1)!;
export const deviceYear = (phase: DevicePhase) => {
  const sample = captured('owner').find(item => item.label.startsWith(`${capturePrefix}${phase}-personal-`)
    && url(item).pathname === '/v1/me/reading-goal');
  if (!sample) throw new Error(`Missing ${phase} reading goal`);
  return Number(url(sample).searchParams.get('year'));
};

/** Only transport is replaced: the route's loader, Library controls and tracking adapter remain production code. */
export function twoDeviceReplay(persona: AnswerPersona, phase: DevicePhase, loading = false) {
  const prefix = persona === 'owner' ? phase : 'refused';
  const selections = (lane: 'personal' | 'anonymous'): RecordedSelection[] =>
    captured(persona).filter(item => item.label.startsWith(`${capturePrefix}${prefix}-${lane}-`)).map(item => ({
      label: item.label, state: loading && url(item).pathname === '/v1/me/shelves'
        ? 'loading' : item.status >= 400 ? 'error' : 'populated',
    }));
  const personal = recordedFetch(twoDeviceRecord, persona, selections('personal'), { pathPrefix: BFF_PREFIX, sequence: true });
  const publicReads = recordedFetch(twoDeviceRecord, persona, selections('anonymous'), { pathPrefix: BFF_PREFIX, sequence: true });
  const main = browserMainApi('https://recorded.invalid', { fetcher: personal.fetcher });
  const anonymous = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: publicReads.fetcher });
  return { main, anonymous, reader: persona === 'visitor' ? null : { main, anonymous, actingSubject: deviceOwner() },
    dispose() { personal.dispose(); publicReads.dispose(); } };
}
