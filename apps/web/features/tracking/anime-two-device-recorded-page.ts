import type {
  AnswerPersona,
  AnswerRecord,
  AnswerSample,
} from '../../../../scripts/api/answer-record.ts';
import record from '../../../../tests/qa/fixtures/outcomes/anime/continue-progress-across-devices-two-device-progress.json';
import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { booksEditionReads } from '../work-page/books-edition-page.read.ts';
import { mainEpisodeApi } from './episode-api.ts';

// The Work page frame and episode controls, with the client supplied where the
// server reader otherwise builds one for itself.

const answers = record as AnswerRecord;
const signedIn = [
  'stranger',
  'member',
  'owner',
  'moderator',
  'operator',
] as const satisfies readonly AnswerPersona[];

export type AnimeDevice = 'first' | 'second';
export type SignedInPersona = (typeof signedIn)[number];

export function recordedSample(persona: AnswerPersona, label: string): AnswerSample {
  const found = answers.personas[persona].find((item) => item.label === label);
  if (!found) throw new Error(`Missing recorded sample ${answers.row}/${persona}/${label}`);
  return found;
}

export function recordedWorkId(persona: AnswerPersona): string {
  const id = new URL(
    recordedSample(persona, 'work-header').path,
    'https://recorded.invalid',
  ).pathname
    .split('/')
    .at(-1);
  if (!id) throw new Error(`Recorded work header has no id for ${persona}`);
  return id;
}

/** The production acting Person. A visitor has none. */
export function recordedActingSubject(persona: AnswerPersona): string | undefined {
  if (persona === 'visitor') return undefined;
  return (
    new URL(
      recordedSample(persona, 'work-header').path,
      'https://recorded.invalid',
    ).searchParams.get('actingSubject') ?? undefined
  );
}

export function isSignedInPersona(persona: AnswerPersona): persona is SignedInPersona {
  return (signedIn as readonly AnswerPersona[]).includes(persona);
}

/**
 * Header, credits, anonymous Facets, classifications, Also enjoyed and work adoptions.
 * One client replays the opening. Facets stay anonymous even when the other reads name a Person.
 */
export function animeTwoDeviceHeaderSelections(): RecordedSelection[] {
  return [
    { label: 'work-header', state: 'populated' },
    { label: 'agent-credits', state: 'populated' },
    { label: 'work-credits-template', state: 'populated' },
    { label: 'classification-facets', state: 'populated' },
    { label: 'classifications-empty', state: 'populated' },
    { label: 'also-enjoyed-empty', state: 'populated' },
    { label: 'work-adoptions-template', state: 'populated' },
  ];
}

/**
 * The two own-device grants share one acting Person. The first device's resume is the
 * positions window recorded before a saved place, and its progress read is the empty
 * version the watched button writes. The second device reopens the watched place.
 * Holding its resume leaves that panel unanswered.
 */
export function animeTwoDeviceSelections(
  persona: SignedInPersona,
  device: AnimeDevice,
  holdResume = false,
): RecordedSelection[] {
  const structure: RecordedSelection[] = [
    { label: 'episode-structure-discovery', state: 'populated' },
    { label: 'episode-structure', state: 'populated' },
  ];
  if (device === 'first') {
    return [
      ...structure,
      { label: 'episode-resume', state: 'populated' },
      { label: 'episode-progress-empty', state: 'populated' },
      { label: 'first-device-watched', state: 'populated' },
    ];
  }
  const race = recordedSample(persona, 'first-device-race');
  return [
    ...structure,
    { label: 'second-device-resume', state: holdResume ? 'loading' : 'populated' },
    { label: 'second-device-watched', state: 'populated' },
    { label: 'own-unwatched-episode', state: 'populated' },
    { label: 'first-device-race', state: race.status >= 400 ? 'error' : 'populated' },
  ];
}

export function animeTwoDeviceClient(fetcher: typeof fetch, anonymous: boolean, origin: string) {
  return browserMainApi(origin, { anonymous, fetcher });
}

export function readAnimeTwoDeviceHeader(main: MainClient, id: string, actingSubject?: string) {
  return booksEditionReads({ main, actingSubject }).readWorkHeader(id);
}

/** The Work page credit reads (`readAgentCredits` and `readCredits`) for a supplied client. */
export function readAnimeTwoDeviceCredits(main: MainClient, id: string, actingSubject?: string) {
  const reads = booksEditionReads({ main, actingSubject });
  return Promise.all([reads.readAgentCredits(id), reads.readCredits(id)]);
}

/** Header, credits and the opening regions the Work page reads for every persona. */
export function readAnimeTwoDeviceFrame(main: MainClient, id: string, actingSubject?: string) {
  const reads = booksEditionReads({ main, actingSubject });
  return Promise.all([
    reads.readWorkHeader(id),
    reads.readAgentCredits(id),
    reads.readCredits(id),
    reads.readClassifications(id, { kind: 'global' }),
    reads.readFacets(),
    reads.readAlsoEnjoyed(id),
    reads.readAdoptions(id),
  ]);
}

export function animeTwoDeviceEpisodes(actingSubject: string, main: MainClient) {
  return mainEpisodeApi(actingSubject, () => main);
}
