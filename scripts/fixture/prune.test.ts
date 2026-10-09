import { expect, test } from 'bun:test';
import { LOAD_FIXTURE_ID } from '../qa/core.ts';
import { PHASE_D_FIXTURE } from '../../tests/qa/load/fixture-phase-d.ts';
import { parseDockerVolumeLines, PINNED_FIXTURE_IDS } from './stack.ts';
import {
  accountedPruneInventory,
  decideFixturePrune,
  formatPruneReport,
  pruneTargets,
  type ListedGeneration,
  type ListedVolume,
  type PruneInventory,
} from './prune.ts';

function generation(id: string, fields: Partial<ListedGeneration> = {}): ListedGeneration {
  return {
    id,
    profile: 'medium',
    seed: 'rezics-background-v1',
    project: `rezics-fixture-${id}`,
    compatible: false,
    manifest: true,
    directory: true,
    volumes: [],
    buildInProgress: false,
    ...fields,
  };
}

function volume(id: string, kind = 'postgres_data'): ListedVolume {
  return { name: `rezics-fixture-${id}_${kind}`, project: `rezics-fixture-${id}` };
}

const current = 'fx-medium-aaaaaaaaaaaa';
const pinned = 'fx-medium-bbbbbbbbbbbb';
const retainedBackground = 'fx-medium-cccccccccccc';
const supersededBackground = 'fx-medium-dddddddddddd';
const mounted = 'fx-medium-eeeeeeeeeeee';
const locked = 'fx-medium-ffffffffffff';
const retainedSmall = 'fx-small-111111111111';
const supersededSmall = 'fx-small-222222222222';
const staleRanked = 'fx-medium-333333333333';
const retainedRanked = 'fx-medium-444444444444';
const tiedLeft = 'fx-medium-555555555555';
const tiedRight = 'fx-medium-666666666666';
const mountedVolume = `rezics-fixture-${mounted}_postgres_data`;
const mountedForeign = 'book-relocation-postgres-18-data';

function inventory(): PruneInventory {
  const generations = [
    generation(current, { completedAt: '2026-09-01T00:00:00.000Z' }),
    generation(pinned, { completedAt: '2026-08-01T00:00:00.000Z' }),
    generation(retainedBackground, { compatible: true, completedAt: '2026-10-09T00:00:00.000Z' }),
    generation(supersededBackground, { compatible: true, completedAt: '2026-10-01T00:00:00.000Z' }),
    generation(mounted, { volumes: [mountedVolume] }),
    generation(locked, { buildInProgress: true, directory: false }),
    generation(retainedSmall, {
      profile: 'small',
      compatible: true,
      completedAt: '2026-10-07T00:00:00.000Z',
    }),
    generation(supersededSmall, {
      profile: 'small',
      compatible: true,
      completedAt: '2026-09-01T00:00:00.000Z',
    }),
    generation(staleRanked, { seed: 'g556-ranked-v1', completedAt: '2026-10-09T20:00:00.000Z' }),
    generation(retainedRanked, {
      seed: 'g556-ranked-v1',
      compatible: true,
      completedAt: '2026-10-08T00:00:00.000Z',
    }),
    generation(tiedLeft, {
      seed: 'tie-seed',
      compatible: true,
      completedAt: '2026-10-02T00:00:00.000Z',
    }),
    generation(tiedRight, {
      seed: 'tie-seed',
      compatible: true,
      completedAt: '2026-10-02T00:00:00.000Z',
    }),
  ];
  const volumes: ListedVolume[] = [
    ...generations.filter((item) => item.id !== locked).map((item) => volume(item.id)),
    { name: 'rezics-dev_postgres_data', project: 'rezics-dev' },
    {
      name: 'rezics-qa-20261009t221849-3b5894-1_postgres_data',
      project: 'rezics-qa-20261009t221849-3b5894-1',
    },
    { name: 'rezics-obs-verify-20260527_clickstack-data', project: 'rezics-obs-verify-20260527' },
    { name: mountedForeign, project: 'book-relocation' },
    { name: '86a580698b875574a16091b58508e29e8f6fff6de0b72e819d9294094da04efa' },
    { name: 'rezics-catalogue-g1038-20261003t230200-7615bd-1-1000_fuseki_data' },
  ];
  return {
    generations,
    volumes,
    currentIds: [current, 'fx-small-999999999999'],
    pins: [pinned],
    mountedVolumes: [mountedVolume, mountedForeign],
    liveQaProjects: ['rezics-qa-20261009t221849-3b5894-1'],
  };
}

test('fixture prune keeps current, pinned, retained and in-use generations', () => {
  const decision = decideFixturePrune(inventory());
  expect(decision.keep).toEqual([
    { id: retainedRanked, reasons: ['retained'] },
    { id: tiedLeft, reasons: ['retained'] },
    { id: tiedRight, reasons: ['retained'] },
    { id: current, reasons: ['current'] },
    { id: pinned, reasons: ['pinned'] },
    { id: retainedBackground, reasons: ['retained'] },
    { id: mounted, reasons: ['in-use'] },
    { id: locked, reasons: ['in-use'] },
    { id: retainedSmall, reasons: ['retained'] },
  ]);
});

test('fixture prune removes superseded generations and abandoned projects, and lists unlabelled volumes', () => {
  const decision = decideFixturePrune(inventory());
  expect(decision.removeGenerations.map((item) => item.id)).toEqual([
    staleRanked,
    supersededBackground,
    supersededSmall,
  ]);
  expect(
    decision.removeGenerations.find((item) => item.id === supersededBackground)?.volumes,
  ).toEqual([volume(supersededBackground).name]);
  expect(decision.removeGenerations.find((item) => item.id === locked)).toBeUndefined();
  expect(decision.abandoned).toEqual([
    {
      project: 'rezics-obs-verify-20260527',
      volumes: ['rezics-obs-verify-20260527_clickstack-data'],
    },
  ]);
  expect(decision.keepProjects).toEqual([
    { project: 'rezics-dev', reason: 'dev', volumes: ['rezics-dev_postgres_data'] },
    { project: 'book-relocation', reason: 'in-use', volumes: [mountedForeign] },
    {
      project: 'rezics-qa-20261009t221849-3b5894-1',
      reason: 'live-qa',
      volumes: ['rezics-qa-20261009t221849-3b5894-1_postgres_data'],
    },
  ]);
  expect(decision.unlabelled).toEqual([
    '86a580698b875574a16091b58508e29e8f6fff6de0b72e819d9294094da04efa',
    'rezics-catalogue-g1038-20261003t230200-7615bd-1-1000_fuseki_data',
  ]);
  const removedVolumes = new Set(decision.removeGenerations.flatMap((item) => item.volumes));
  for (const name of [
    ...decision.unlabelled,
    ...decision.keepProjects.flatMap((item) => item.volumes),
  ]) {
    expect(removedVolumes.has(name)).toBe(false);
  }
  const report = formatPruneReport({
    mode: 'dry-run',
    currentIds: [current],
    pins: [pinned],
    decision,
    failures: [],
  });
  expect(report).toContain(`keep ${current} current`);
  expect(report).toContain(`keep ${pinned} pinned`);
  expect(report).toContain(`keep ${retainedBackground} retained`);
  expect(report).toContain(`keep ${mounted} in-use`);
  expect(report).toContain(`remove ${supersededBackground} superseded directory`);
  expect(report).toContain('abandoned rezics-obs-verify-20260527');
  expect(report).toContain('keep-project rezics-dev dev');
  expect(report).toContain('keep-project rezics-qa-20261009t221849-3b5894-1 live-qa');
  expect(report).toContain(
    'unlabelled rezics-catalogue-g1038-20261003t230200-7615bd-1-1000_fuseki_data',
  );
});

test('a same-size build prune leaves other sizes, the generation just built, and abandoned projects', () => {
  const decision = decideFixturePrune(inventory());
  expect(pruneTargets(decision, { profile: 'small' }).generations.map((item) => item.id)).toEqual([
    supersededSmall,
  ]);
  expect(pruneTargets(decision, { profile: 'small' }).abandoned).toEqual([]);
  expect(
    pruneTargets(decision, {
      profile: 'medium',
      protectIds: [supersededBackground],
    }).generations.map((item) => item.id),
  ).toEqual([staleRanked]);
});

test('one generation can be current, pinned, retained and in use together', () => {
  const id = 'fx-medium-abcabcabcabc';
  const decision = decideFixturePrune({
    generations: [
      generation(id, {
        compatible: true,
        completedAt: '2026-10-09T00:00:00.000Z',
        volumes: [volume(id).name],
      }),
    ],
    volumes: [volume(id)],
    currentIds: [id],
    pins: [id],
    mountedVolumes: [volume(id).name],
    liveQaProjects: [],
  });
  expect(decision.keep).toEqual([{ id, reasons: ['current', 'pinned', 'retained', 'in-use'] }]);
  expect(decision.removeGenerations).toEqual([]);
});

test('an overridden fixture root removes only generations whose manifest is in that root', () => {
  const localSuperseded = 'fx-small-222222222222';
  const foreign = 'fx-small-18451cd1a83d';
  const interrupted = 'fx-small-037e81264d77';
  const listed: PruneInventory = {
    generations: [
      generation(localSuperseded, {
        profile: 'small',
        completedAt: '2026-09-01T00:00:00.000Z',
      }),
      generation(foreign, { profile: 'small', directory: false, manifest: false }),
      generation(interrupted, { profile: 'small', manifest: false }),
    ],
    volumes: [volume(localSuperseded), volume(foreign), volume(interrupted),
      { name: 'rezics-obs-verify-20260527_clickstack-data', project: 'rezics-obs-verify-20260527' }],
    currentIds: [],
    pins: [],
    mountedVolumes: [],
    liveQaProjects: [],
  };
  const shared = decideFixturePrune(accountedPruneInventory(listed, false));
  expect(shared.removeGenerations.map((item) => item.id)).toEqual([
    interrupted,
    foreign,
    localSuperseded,
  ]);
  const decision = decideFixturePrune(accountedPruneInventory(listed, true));
  expect(decision.removeGenerations.map((item) => item.id)).toEqual([localSuperseded]);
  expect(decision.keep).toEqual([]);
  expect(decision.abandoned.map((item) => item.project)).toEqual(['rezics-obs-verify-20260527']);
  const report = formatPruneReport({
    mode: 'dry-run',
    currentIds: [],
    pins: [],
    decision,
    failures: [],
  });
  expect(report).toContain(`remove ${localSuperseded} superseded directory`);
  expect(report).not.toContain(foreign);
  expect(report).not.toContain(interrupted);
});

test('declared pins are the ids load and phase D restore, and a test literal is not a pin', () => {
  const recorded = 'fx-medium-605f041f8150';
  expect(LOAD_FIXTURE_ID).toBe(PINNED_FIXTURE_IDS[0]);
  expect(PHASE_D_FIXTURE).toBe(PINNED_FIXTURE_IDS[0]);
  const decision = decideFixturePrune({
    generations: [generation(PINNED_FIXTURE_IDS[0]), generation(recorded)],
    volumes: [volume(PINNED_FIXTURE_IDS[0]), volume(recorded)],
    currentIds: [],
    pins: [...PINNED_FIXTURE_IDS],
    mountedVolumes: [],
    liveQaProjects: [],
  });
  expect(decision.keep).toEqual([{ id: PINNED_FIXTURE_IDS[0], reasons: ['pinned'] }]);
  expect(decision.removeGenerations.map((item) => item.id)).toEqual([recorded]);
});

test('volume lines without a compose project stay unlabelled', () => {
  expect(
    parseDockerVolumeLines(
      [
        'rezics-dev_postgres_data\trezics-dev',
        'loose-name',
        'anon\t',
        'missing\t<no value>',
        '',
      ].join('\n'),
    ),
  ).toEqual([
    { name: 'rezics-dev_postgres_data', project: 'rezics-dev' },
    { name: 'loose-name' },
    { name: 'anon' },
    { name: 'missing' },
  ]);
});
