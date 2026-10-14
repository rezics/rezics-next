import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import record from '../../../../tests/qa/fixtures/outcomes/anime/continue-progress-across-devices-two-device-progress.json';
import { BFF_PREFIX } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { mainRelationships } from '../relationships/api.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { markPosition, standingOf } from './episodes.ts';
import {
  animeTwoDeviceChainSelections,
  animeTwoDeviceClient,
  animeTwoDeviceEpisodes,
  animeTwoDeviceFrameSelections,
  animeTwoDeviceHeaderSelections,
  animeTwoDeviceSelections,
  readAnimeTwoDeviceFrame,
  recordedActingSubject,
  recordedSample,
  recordedWorkId,
  sequencedRecordedFetch,
  type AnimeChain,
  type AnimeDevice,
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
  scope?: string;
  complete?: boolean;
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

function openChain(persona: AnswerPersona, device: AnimeDevice, chain: AnimeChain): {
  main: MainClient;
  missed: () => unknown;
} {
  const transport = sequencedRecordedFetch(
    persona,
    animeTwoDeviceChainSelections(device, chain),
    { pathPrefix: BFF_PREFIX },
  );
  disposals.push(transport.dispose);
  let missed: unknown;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await transport.fetcher(input, init);
    } catch (error) {
      missed = error;
      throw error;
    }
  }) as typeof fetch;
  return { main: animeTwoDeviceClient(fetcher, false, origin), missed: () => missed };
}

function episodeOf(path: string) {
  const parts = new URL(path, origin).pathname.split('/');
  return { structure: parts[3]!, occurrence: parts[5]! };
}

test('visitor header and author are the recorded public Work', async () => {
  const main = open('visitor', animeTwoDeviceHeaderSelections(), true);
  const id = recordedWorkId('visitor');
  const [header, agentCredits, , classifications, facets, alsoEnjoyed, adoptions] =
    await readAnimeTwoDeviceFrame(main, id);
  const titled = recordedSample('visitor', 'work-header').answer as Titled;
  expect(header.ok && header.data.title.value).toBe(titled.title.value);
  const author = recordedSample('visitor', 'agent-credits').answer as Credits;
  expect(agentCredits.ok && agentCredits.data.items[0]).toMatchObject({
    role: author.items[0]!.role,
    displayName: author.items[0]!.displayName,
    agent: author.items[0]!.agent,
  });
  expect(recordedActingSubject('visitor')).toBeUndefined();
  expect(new URL(recordedSample('visitor', 'classification-facets').path, origin).search).toBe('');
  expect(classifications.ok && classifications.data.items).toEqual([]);
  expect(facets.ok).toBe(true);
  expect(alsoEnjoyed.ok && alsoEnjoyed.data.items).toEqual([]);
  expect(adoptions.ok && adoptions.data.items).toEqual([]);
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

test('a watched write records a null position', () => {
  const body = recordedSample('stranger', 'first-device-watched').body as WriteBody;
  const replay = recordedSample('stranger', 'second-device-watched-replay').body as WriteBody;
  expect(body.position).toBeNull();
  expect(replay.position).toBeNull();
  expect(body.completed).toBe(true);
  expect(body.expectedVersion).toBe(0);
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
    const [header, agentCredits, , classifications, facets, alsoEnjoyed, adoptions] =
      await readAnimeTwoDeviceFrame(headerMain, id, actingSubject);
    const titled = recordedSample(persona, 'work-header').answer as Titled;
    expect(header.ok && header.data.title.value).toBe(titled.title.value);
    const author = (recordedSample(persona, 'agent-credits').answer as Credits).items[0]!;
    expect(agentCredits.ok && agentCredits.data.items[0]).toMatchObject({
      role: author.role,
      displayName: author.displayName,
      agent: author.agent,
    });
    expect(new URL(recordedSample(persona, 'classification-facets').path, origin).search).toBe('');
    expect(classifications.ok && classifications.data.items).toEqual([]);
    expect(facets.ok).toBe(true);
    expect(alsoEnjoyed.ok && alsoEnjoyed.data.items).toEqual([]);
    expect(adoptions.ok && adoptions.data.items).toEqual([]);

    const labels = (
      recordedSample(persona, 'episode-structure').answer as StructureAnswer
    ).occurrences.map((item) => {
      const label = item.qualifier?.displayLabel;
      if (!label) throw new Error(`Recorded episode has no display label for ${persona}`);
      return label;
    });
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
    const empty = await firstApi.progress(episode!);
    const emptyAnswer = recordedSample(persona, 'episode-progress-empty').answer as ProgressAnswer;
    expect(empty.ok && empty.data).toMatchObject({
      completed: emptyAnswer.completed,
      position: emptyAnswer.position,
      version: emptyAnswer.version,
    });
    const laterMain = open(persona, [{ label: 'first-device-next-version', state: 'populated' }]);
    const later = await animeTwoDeviceEpisodes(actingSubject, laterMain).progress(episode!);
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
    const resumeItem = resume.items?.[0];
    if (!resumeItem?.occurrence || !resumeItem.displayLabel) {
      throw new Error(`Recorded resume has no place for ${persona}`);
    }
    expect(secondStanding.ok && secondStanding.data?.furthest).toEqual({
      occurrence: resumeItem.occurrence,
      label: resumeItem.displayLabel,
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
      const stale = await secondApi.mark(
        episode!,
        { completed: false, position: null },
        { conflict: true },
      );
      expect(stale).toMatchObject({
        ok: false,
        failure: 'stale',
        submitted: { completed: false, position: null },
        current: { completed: true, version: 1, position: null },
      });
    }
  });

  test(`${persona} follows the Work and both devices recover each recorded chain`, async () => {
    const actingSubject = recordedActingSubject(persona)!;
    const id = recordedWorkId(persona);
    const frame = open(persona, animeTwoDeviceFrameSelections(persona));
    const [header] = await readAnimeTwoDeviceFrame(frame, id, actingSubject);
    if (!header.ok) throw new Error(`Work header: ${header.failure}`);
    const followed = recordedSample(persona, 'work-follow-state').answer as { following: boolean };
    const follow = recordedFetch(record as AnswerRecord, persona, animeTwoDeviceFrameSelections(persona), {
      pathPrefix: BFF_PREFIX,
    });
    disposals.push(follow.dispose);
    const state = await mainRelationships(actingSubject, { origin, fetch: follow.fetcher }).state(header.data.id);
    expect(state.following).toBe(followed.following);
    expect(new URL(recordedSample(persona, 'work-follow-state').path, origin).searchParams.get('target'))
      .toBe(header.data.id);

    for (const chain of ['mark', 'clear'] as const) {
      for (const device of ['first', 'second'] as const) {
        const opened = openChain(persona, device, chain);
        const api = animeTwoDeviceEpisodes(actingSubject, opened.main);
        const standing = await standingOf(api, id);
        if (!standing.ok || !standing.data) throw opened.missed() ?? new Error(`${chain} ${device} standing`);
        const write = recordedSample(persona, `reachable-${chain}-${device}-device-write-1`);
        const episodeId = new URL(write.path, origin).pathname.split('/')[5]!;
        const episode = standing.data.mains.items.find((item) => item.occurrence.endsWith(episodeId));
        if (!episode) throw new Error(`Recorded ${chain} episode is not on the page`);
        const beforeLabel = chain === 'mark' ? 'episode-resume' : `reachable-mark-${device}-device-resume-1`;
        const before = recordedSample(persona, beforeLabel).answer as ResumeAnswer;
        if (before.scope === 'resume' && before.complete === true) {
          expect(standing.data.furthest?.label).toBe(before.items?.[0]?.displayLabel);
        } else expect(standing.data.furthest).toBeNull();
        const progress = recordedSample(persona, `reachable-${chain}-${device}-device-progress-1`).answer as ProgressAnswer;
        const read = await api.progress(episode);
        expect(read.ok && read.data).toMatchObject({
          completed: progress.completed,
          position: progress.position,
          version: progress.version,
        });
        const body = write.body as WriteBody;
        const change = body.completed
          ? { completed: true as const, position: markPosition(episode) }
          : { completed: false as const };
        expect(body.position).toBe(body.completed ? markPosition(episode) : progress.position);
        const written = await api.mark(episode, change, { conflict: true });
        if (!('ok' in written) || (!written.ok && written.failure === 'unavailable')) throw opened.missed() ?? written;
        if (device === 'first') {
          const answer = write.answer as ProgressAnswer;
          expect(written.ok && written.data).toMatchObject({
            completed: answer.completed,
            position: answer.position,
            version: answer.version,
            replayed: false,
          });
        } else {
          const current = recordedSample(persona, `reachable-${chain}-second-device-progress-3`).answer as ProgressAnswer;
          expect(written).toMatchObject({
            ok: false,
            failure: 'stale',
            submitted: { completed: body.completed, position: body.position },
            current: { completed: current.completed, version: current.version, position: current.position },
          });
          const again = await api.mark(episode, change, { conflict: true });
          if (!again.ok && again.failure === 'unavailable') throw opened.missed() ?? again;
          const saved = recordedSample(persona, `reachable-${chain}-second-device-write-2`).answer as ProgressAnswer;
          expect(again.ok && again.data).toMatchObject({
            completed: saved.completed,
            position: saved.position,
            version: saved.version,
            replayed: false,
          });
        }
        const refreshed = await standingOf(api, id);
        if (!refreshed.ok || !refreshed.data) throw opened.missed() ?? new Error(`${chain} ${device} refresh`);
        const after = recordedSample(persona, `reachable-${chain}-${device}-device-resume-1`).answer as ResumeAnswer;
        if (after.scope === 'resume' && after.complete === true) {
          expect(refreshed.data.furthest?.label).toBe(after.items?.[0]?.displayLabel);
        } else expect(refreshed.data.furthest).toBeNull();
      }
    }
  });
}
