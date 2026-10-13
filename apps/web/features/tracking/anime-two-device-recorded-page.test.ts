import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import record from '../../../../tests/qa/fixtures/outcomes/anime/continue-progress-across-devices-two-device-progress.json';
import { BFF_PREFIX } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { markPosition, standingOf } from './episodes.ts';
import {
  animeTwoDeviceClient,
  animeTwoDeviceEpisodes,
  animeTwoDeviceHeaderSelections,
  animeTwoDeviceSelections,
  readAnimeTwoDeviceCredits,
  readAnimeTwoDeviceHeader,
  recordedActingSubject,
  recordedSample,
  recordedWorkId,
} from './anime-two-device-recorded-page.ts';

const origin = 'https://recorded.invalid';
const signedIn = [
  'stranger',
  'member',
  'owner',
  'moderator',
  'operator',
] as const satisfies readonly AnswerPersona[];
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

interface Titled {
  title: { value: string };
}
interface CreditItem {
  role: string;
  displayName: string;
  agent: string;
}
interface Credits {
  items: CreditItem[];
}
interface StructureAnswer {
  occurrences: { qualifier?: { displayLabel?: string } }[];
}
interface ResumeAnswer {
  items?: { occurrence?: string; displayLabel?: string }[];
}
interface ProgressAnswer {
  completed: boolean;
  position: string | null;
  version: number;
  occurrence: string;
  replayed?: boolean;
}
interface ProblemAnswer {
  title: string;
  code: string;
  status: number;
}
interface WriteBody {
  completed: boolean;
  expectedVersion: number;
  position: string | null;
}

function open(
  persona: AnswerPersona,
  selections: readonly RecordedSelection[],
  anonymous = false,
): MainClient {
  const transport = recordedFetch(record as AnswerRecord, persona, selections, {
    pathPrefix: BFF_PREFIX,
  });
  disposals.push(transport.dispose);
  return animeTwoDeviceClient(transport.fetcher, anonymous, origin);
}

function episodeOf(path: string) {
  const parts = new URL(path, origin).pathname.split('/');
  return { structure: parts[3]!, occurrence: parts[5]! };
}

test('visitor header and author are the recorded public Work', async () => {
  const main = open('visitor', animeTwoDeviceHeaderSelections(), true);
  const id = recordedWorkId('visitor');
  const header = await readAnimeTwoDeviceHeader(main, id);
  const titled = recordedSample('visitor', 'work-header').answer as Titled;
  expect(header.ok && header.data.title.value).toBe(titled.title.value);
  const [agentCredits] = await readAnimeTwoDeviceCredits(main, id);
  const author = recordedSample('visitor', 'agent-credits').answer as Credits;
  expect(agentCredits.ok && agentCredits.data.items[0]).toMatchObject({
    role: author.items[0]!.role,
    displayName: author.items[0]!.displayName,
    agent: author.items[0]!.agent,
  });
  expect(recordedActingSubject('visitor')).toBeUndefined();
});

test('visitor private progress stays the recorded sign-in refusal', async () => {
  const refused = recordedSample('visitor', 'episode-progress-sign-in-required');
  const problem = refused.answer as ProblemAnswer;
  const actingSubject = new URL(refused.path, origin).searchParams.get('actingSubject');
  expect(typeof actingSubject).toBe('string');
  const main = open(
    'visitor',
    [{ label: 'episode-progress-sign-in-required', state: 'error' }],
    true,
  );
  const progress = await animeTwoDeviceEpisodes(actingSubject!, main).progress(
    episodeOf(refused.path),
  );
  expect(progress).toEqual({ ok: false, failure: 'sign-in' });
  expect(refused.status).toBe(401);
  expect(problem).toMatchObject({ status: 401, code: 'account_assertion_denied' });
  const write = recordedSample('visitor', 'episode-write-sign-in-required');
  expect(write.status).toBe(401);
  expect(write.answer).toMatchObject({ status: 401, code: 'account_assertion_denied' });
});

test('a watched write records a null position and the episode control names episode 1', () => {
  const body = recordedSample('stranger', 'first-device-watched').body as WriteBody;
  const replay = recordedSample('stranger', 'second-device-watched-replay').body as WriteBody;
  expect(body.position).toBeNull();
  expect(replay.position).toBeNull();
  expect(body.completed).toBe(true);
  expect(body.expectedVersion).toBe(0);
  expect(markPosition({ number: 1, special: false })).toBe('episode:1');
});

test('second-device replay keeps the recorded watched progress when the position is null', async () => {
  const main = open('stranger', [
    { label: 'second-device-progress-empty', state: 'populated' },
    { label: 'second-device-watched-replay', state: 'populated' },
  ]);
  const watched = recordedSample('stranger', 'second-device-watched-replay');
  const actingSubject = recordedActingSubject('stranger')!;
  const written = await animeTwoDeviceEpisodes(actingSubject, main).mark(episodeOf(watched.path), {
    completed: true,
    position: null,
  });
  const answer = watched.answer as ProgressAnswer;
  expect(written.ok && written.data).toMatchObject({
    completed: answer.completed,
    position: answer.position,
    version: answer.version,
    occurrence: answer.occurrence,
    replayed: true,
  });
});

test('foreign episode progress stays the recorded authority refusal', async () => {
  const refused = recordedSample('stranger', 'foreign-episode-progress-refused');
  const problem = refused.answer as ProblemAnswer;
  const actingSubject = new URL(refused.path, origin).searchParams.get('actingSubject')!;
  expect(actingSubject).not.toBe(recordedActingSubject('stranger'));
  const main = open('stranger', [{ label: 'foreign-episode-progress-refused', state: 'error' }]);
  const progress = await animeTwoDeviceEpisodes(actingSubject, main).progress(
    episodeOf(refused.path),
  );
  expect(progress).toEqual({ ok: false, failure: 'sign-in' });
  expect(refused.status).toBe(403);
  expect(problem).toMatchObject({
    status: 403,
    code: 'authority_denied',
    title: 'Authority is not admitted',
  });
});

for (const persona of signedIn) {
  test(`${persona} reopens the second device and reads the first device's later progress`, async () => {
    const actingSubject = recordedActingSubject(persona)!;
    const firstSubject = new URL(
      recordedSample(persona, 'episode-resume').path,
      origin,
    ).searchParams.get('actingSubject');
    const secondSubject = new URL(
      recordedSample(persona, 'second-device-resume').path,
      origin,
    ).searchParams.get('actingSubject');
    expect(firstSubject).toBe(actingSubject);
    expect(secondSubject).toBe(actingSubject);

    const id = recordedWorkId(persona);
    const headerMain = open(persona, animeTwoDeviceHeaderSelections());
    const header = await readAnimeTwoDeviceHeader(headerMain, id, actingSubject);
    const titled = recordedSample(persona, 'work-header').answer as Titled;
    expect(header.ok && header.data.title.value).toBe(titled.title.value);
    const [agentCredits] = await readAnimeTwoDeviceCredits(headerMain, id, actingSubject);
    const author = (recordedSample(persona, 'agent-credits').answer as Credits).items[0]!;
    expect(agentCredits.ok && agentCredits.data.items[0]).toMatchObject({
      role: author.role,
      displayName: author.displayName,
      agent: author.agent,
    });

    const labels = (
      recordedSample(persona, 'episode-structure').answer as StructureAnswer
    ).occurrences.map((item) => item.qualifier?.displayLabel);
    const first = open(persona, animeTwoDeviceSelections(persona, 'first'));
    const firstApi = animeTwoDeviceEpisodes(actingSubject, first);
    const firstStanding = await standingOf(firstApi, id);
    expect(firstStanding.ok && firstStanding.data?.furthest).toBeNull();
    expect(firstStanding.ok && firstStanding.data?.mains.items.map((item) => item.label)).toEqual(
      labels,
    );
    const episode =
      firstStanding.ok && firstStanding.data ? firstStanding.data.mains.items[0] : null;
    expect(episode).not.toBeNull();
    const later = await firstApi.progress(episode!);
    const laterAnswer = recordedSample(persona, 'first-device-next-version')
      .answer as ProgressAnswer;
    expect(later.ok && later.data).toMatchObject({
      completed: laterAnswer.completed,
      position: laterAnswer.position,
      version: laterAnswer.version,
      occurrence: laterAnswer.occurrence,
    });

    const second = open(persona, animeTwoDeviceSelections(persona, 'second'));
    const secondApi = animeTwoDeviceEpisodes(actingSubject, second);
    const secondStanding = await standingOf(secondApi, id);
    const resume = recordedSample(persona, 'second-device-resume').answer as ResumeAnswer;
    expect(secondStanding.ok && secondStanding.data?.furthest).toEqual({
      occurrence: resume.items?.[0]?.occurrence,
      label: resume.items?.[0]?.displayLabel,
    });
    const watched = await secondApi.progress(episode!);
    const watchedAnswer = recordedSample(persona, 'second-device-watched').answer as ProgressAnswer;
    expect(watched.ok && watched.data).toMatchObject({
      completed: watchedAnswer.completed,
      position: watchedAnswer.position,
      version: watchedAnswer.version,
    });
    const unwatched =
      secondStanding.ok && secondStanding.data ? secondStanding.data.mains.items[2] : null;
    const own = await secondApi.progress(unwatched!);
    const ownAnswer = recordedSample(persona, 'own-unwatched-episode').answer as ProgressAnswer;
    expect(own.ok && own.data).toMatchObject({
      completed: ownAnswer.completed,
      position: ownAnswer.position,
      version: ownAnswer.version,
      occurrence: ownAnswer.occurrence,
    });

    const written = await secondApi.mark(episode!, { completed: false });
    const race = recordedSample(persona, 'first-device-race');
    if (race.status === 200) {
      const answer = race.answer as ProgressAnswer;
      expect(written.ok && written.data).toMatchObject({
        completed: answer.completed,
        position: answer.position,
        version: answer.version,
        replayed: false,
      });
    } else {
      expect(written).toEqual({ ok: false, failure: 'moved' });
      expect(race.status).toBe(409);
      expect(race.answer).toMatchObject({
        code: 'stale_progress',
        title: 'progress version changed',
      });
    }
  });
}
