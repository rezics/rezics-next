import { describe, expect, test } from 'bun:test';
import {
  datasetCreditMapper,
  projectDatasetCredits,
  type DatasetCreditAdoptionBinding,
  type DatasetCreditCandidate,
} from '../../../scripts/datasets/native/credits.ts';
import {
  datasetSourceIdentity,
  datasetSourceReference,
} from '../../../scripts/datasets/native/context.ts';
import { datasetCoverage, datasetCoverageId } from '../../../scripts/datasets/native/coverage.ts';
import { canonical, sha256 } from '../../../scripts/datasets/store.ts';
import type {
  DatasetEdge,
  DatasetMappingContext,
  DatasetNativeRecord,
  DatasetRecord,
  DatasetSnapshot,
} from '../../../scripts/datasets/types.ts';

const iri = (value: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
type Row = Record<string, unknown>;
const record = (
  provider: DatasetRecord['provider'],
  kind: string,
  externalId: string,
  data: Row = {},
  native: DatasetRecord['native'] = 'source-only',
): DatasetRecord => ({
  key: `${provider}:${kind}:${externalId}`,
  provider,
  kind,
  externalId,
  data,
  native,
  title: externalId,
  language: 'und',
  sourceUrl: `https://${provider === 'bangumi' ? 'bgm.tv' : `${provider}.org`}/${externalId}`,
});

// Scalar rows/spellings from the frozen 2026-10-02 VNDB capture. Extra repeats,
// changed roles and scope below are adversarial variants, not new source claims.
const translator = { aid: '15810', eid: '4', id: 'v50', note: '', role: 'translator' };
const voice = { aid: '10262', cid: 'c41605', id: 'v11', note: 'Realta Nua' };
const translationStaff = () =>
  record(
    'vndb',
    'staff',
    's12507',
    {
      main: '57413',
      tables: {
        staff_alias: [
          { aid: '15810', id: 's12507', latin: null, name: 'Horagema' },
          { aid: '57413', id: 's12507', latin: 'Vitalja Kalikin', name: 'Виталя Каликин' },
        ],
      },
    },
    'person',
  );
const voiceStaff = () =>
  record(
    'vndb',
    'staff',
    's7988',
    {
      tables: {
        staff_alias: [{ aid: '10262', id: 's7988', latin: 'Nakao Eri', name: '中尾 衣里' }],
      },
    },
    'person',
  );

function fixture(records: DatasetRecord[], edges: DatasetEdge[] = [], epoch = 'epoch-a') {
  const snapshot: DatasetSnapshot = {
    format: 'rezics-local-dataset-v1',
    id: 'captured-shapes',
    digest: 'a'.repeat(64),
    createdAt: '2026-10-02T00:00:00Z',
    captures: [],
    images: [],
    sources: [...new Set(records.map((value) => value.provider))].map((provider) => ({
      provider,
      roots: records
        .filter((value) => value.provider === provider && value.native === 'work')
        .map((value) => value.key),
      records: records.filter((value) => value.provider === provider),
      edges: edges.filter(
        (edge) => records.find((value) => value.key === edge.from)?.provider === provider,
      ),
      images: [],
      scope: { retained: true },
    })),
  };
  const selected = new Set(records.map((value) => value.key));
  const coverage = datasetCoverage(snapshot, selected);
  const native = new Map<string, DatasetNativeRecord>();
  records.forEach((value, index) => {
    coverage.retain(value.key);
    if (['work', 'person', 'character'].includes(value.native))
      native.set(value.key, {
        id: iri(100 + index),
        kind: value.native === 'work' ? 'work' : 'resource',
        sourceIdentity: datasetSourceIdentity(value),
        receipt: { dataEpoch: epoch, identityOnly: true },
        urls: [],
      });
  });
  const calls: Array<{ label: string; method: string; path: string; body: Row }> = [];
  const reads: string[] = [];
  const context: DatasetMappingContext = {
    snapshot,
    selected,
    native,
    records: new Map(records.map((value) => [value.key, value])),
    actingSubject: iri(1),
    source(key) {
      const value = context.records.get(key)!;
      const index = records.indexOf(value);
      return datasetSourceReference(
        snapshot,
        value,
        [iri(1000 + index)],
        [
          {
            record: iri(2000 + index),
            observation: iri(1000 + index),
            byteDigest: sha256(canonical(value)),
          },
        ],
      );
    },
    async command(label, method, path, body) {
      calls.push({ label, method, path, body: structuredClone(body) as Row });
      throw new Error('No source-credit adoption binding was installed by this fixture');
    },
    async read(path) {
      reads.push(path);
      throw new Error(`Unexpected owner read: ${path}`);
    },
    disposition: coverage.disposition,
  };
  return { context, coverage, native, snapshot, calls, reads };
}
const staffFixture = (credits: Row[] = [translator]) =>
  fixture([
    record('vndb', 'vn', 'v50', { tables: { vn_staff: credits } }, 'work'),
    translationStaff(),
  ]);
const credited = (candidate: DatasetCreditCandidate) =>
  candidate.participations.find((value) => value.role === 'credited')!;

describe('exact retained credit candidates', () => {
  test('positive admitted roles retain source spelling, alias/eid and notes without changing role meaning', () => {
    const roles = [
      'translator',
      'director',
      'editor',
      'art',
      'scenario',
      'music',
      'songs',
      'chardesign',
      'qa',
      'staff',
    ];
    const f = staffFixture(
      roles.map((role) => ({ ...translator, role, note: role === 'music' ? 'Lead composer' : '' })),
    );
    const before = canonical(f.snapshot),
      identities = canonical([...f.native]);
    const candidates = projectDatasetCredits(f.context).credits;
    expect(candidates.slice(0, 4).map((value) => value.nativeRole)).toEqual([
      'translator',
      'director',
      'editor',
      'artist',
    ]);
    expect(candidates.slice(4).every((value) => value.nativeRole === undefined)).toBe(true);
    const translation = candidates[0]!;
    expect(translation.sourceRoleKey).toBe('translator');
    expect(credited(translation)).toMatchObject({
      participant: { kind: 'resource', ref: f.native.get('vndb:staff:s12507')!.id },
      sourceIdentity: {
        provider: 'vndb',
        namespace: 'staff',
        key: 's12507',
        alias: '15810',
        eid: '4',
        note: '',
      },
      creditedName: 'Horagema',
    });
    expect(credited(translation).evidence[1]).toMatchObject({
      coverage: { record: 'vndb:staff:s12507', path: '/data/tables/staff_alias/0' },
      value: { name: 'Horagema', latin: null },
    });
    expect(candidates[3]!.sourceRole).toBe('art');
    expect(candidates[5]!.reported.note).toBe('Lead composer');
    expect(candidates[5]!.requirements.map((value) => value.contract)).toContain('credit-role');
    expect(translation.requirements.map((value) => value.contract)).not.toContain('credit-role');
    expect(canonical(f.snapshot)).toBe(before);
    expect(canonical([...f.native])).toBe(identities);
    expect(f.calls).toEqual([]);
  });

  test('provider/namespace/key bindings never turn a source name or semantic Person into an Agent', () => {
    const staff = translationStaff(),
      collision = record('bangumi', 'person', 's12507', {}, 'person');
    collision.title = staff.title = 'Same display name';
    const f = fixture([
      record('vndb', 'vn', 'v50', { tables: { vn_staff: [translator] } }, 'work'),
      staff,
      collision,
    ]);
    const bound = f.native.get(staff.key)!;
    bound.sourceIdentity = datasetSourceIdentity(collision);
    bound.kind = 'agent';
    const candidate = projectDatasetCredits(f.context).credits[0]!;
    expect(credited(candidate).participant).toEqual({
      kind: 'external',
      provider: 'vndb',
      namespace: 'staff',
      key: 's12507',
    });
    expect(credited(candidate)).not.toHaveProperty('agent');
    expect(credited(candidate).creditedName).toBe('Horagema');
    bound.kind = 'resource';
    bound.sourceIdentity = datasetSourceIdentity(staff);
    expect(credited(projectDatasetCredits(f.context).credits[0]!).participant).toEqual({
      kind: 'resource',
      ref: bound.id,
    });
  });

  test('VNDB repeated triples retain occurrences while table/work/character mirrors attach exact evidence', () => {
    const other = { ...voice, cid: 'c15', note: 'Separate role' };
    const work = record(
      'vndb',
      'vn',
      'v11',
      { tables: { vn_seiyuu: [voice, voice, other] } },
      'work',
    );
    const character = record('vndb', 'character', 'c41605', {}, 'character');
    const second = record('vndb', 'character', 'c15', {}, 'character');
    const staff = voiceStaff();
    const edges = [voice, voice, other].flatMap((data) => [
      { from: `vndb:character:${data.cid}`, to: staff.key, kind: 'voice-actor', data },
      { from: work.key, to: staff.key, kind: 'voice-actor', data },
    ]);
    const f = fixture([work, character, second, staff], edges);
    const candidates = projectDatasetCredits(f.context).credits;
    expect(candidates).toHaveLength(3);
    expect(new Set(candidates.map((value) => value.id)).size).toBe(3);
    for (const [index, candidate] of candidates.entries()) {
      expect(candidate.evidence).toHaveLength(3);
      expect(candidate.participations.map((value) => value.role)).toEqual([
        'work',
        'credited',
        'character',
      ]);
      expect(
        candidate.participations.find((value) => value.role === 'character')!.sourceIdentity.key,
      ).toBe(index < 2 ? 'c41605' : 'c15');
      expect(credited(candidate).sourceIdentity.note).toBe(
        index < 2 ? 'Realta Nua' : 'Separate role',
      );
      expect(credited(candidate).evidence).toHaveLength(4);
      expect(candidate.nativeRole).toBeUndefined();
      expect(candidate.requirements.map((value) => value.contract)).toContain(
        'qualified-credit-occurrence',
      );
      expect(candidate.participations.some((value) => value.role === 'release')).toBe(false);
    }
    delete (work.data.tables as Row).vn_seiyuu;
    const edgeOnly = projectDatasetCredits(f.context).credits;
    expect(edgeOnly).toHaveLength(3);
    expect(edgeOnly.map((value) => value.evidence.length)).toEqual([2, 2, 2]);
  });

  test('ambiguous or missing staff alias bindings remain evidence, with no main-alias guess', () => {
    const duplicate = record(
      'vndb',
      'staff',
      's9',
      { tables: { staff_alias: [{ id: 's9', aid: '15810', name: 'Another person' }] } },
      'person',
    );
    const f = fixture([
      record('vndb', 'vn', 'v50', { tables: { vn_staff: [translator] } }, 'work'),
      translationStaff(),
      duplicate,
    ]);
    let candidate = projectDatasetCredits(f.context).credits[0]!;
    expect(credited(candidate).participant).toEqual({
      kind: 'external',
      provider: 'vndb',
      namespace: 'staff-alias',
      key: '15810',
    });
    expect(credited(candidate).creditedName).toBeUndefined();
    expect(candidate.requirements.map((value) => value.contract)).toContain('staff-alias-binding');
    f.context.records = new Map(
      [...f.context.records].filter(
        ([key]) => key !== duplicate.key && key !== 'vndb:staff:s12507',
      ),
    );
    candidate = projectDatasetCredits(f.context).credits[0]!;
    expect(credited(candidate).sourceIdentity.alias).toBe('15810');
    expect(candidate.reported).toEqual(translator);
  });

  test('contradictory mirror endpoints never attach to a matching retained triple', () => {
    const work = record('vndb', 'vn', 'v11', { tables: { vn_seiyuu: [voice] } }, 'work');
    const wrongCharacter = record('vndb', 'character', 'c15', {}, 'character');
    const staff = voiceStaff();
    const f = fixture(
      [work, wrongCharacter, staff],
      [
        {
          from: wrongCharacter.key,
          to: staff.key,
          kind: 'voice-actor',
          data: voice,
        },
      ],
    );
    const candidates = projectDatasetCredits(f.context).credits;
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.evidence).toHaveLength(1);
    expect(candidates[1]!.requirements.map((value) => value.contract)).toContain(
      'source-credit-occurrence',
    );
    expect(
      candidates[1]!.participations.find((value) => value.role === 'character')!.sourceIdentity.key,
    ).toBe('c41605');
  });

  test('unselected staff records cannot supply credited spelling without retained alias evidence', () => {
    const f = staffFixture();
    f.context.selected = new Set(['vndb:vn:v50']);
    const candidate = projectDatasetCredits(f.context).credits[0]!;
    expect(credited(candidate).creditedName).toBeUndefined();
    expect(credited(candidate).participant).toEqual({
      kind: 'external',
      provider: 'vndb',
      namespace: 'staff-alias',
      key: '15810',
    });
    expect(candidate.requirements.map((value) => value.contract)).toContain('staff-alias-binding');
    expect(credited(candidate).evidence).toHaveLength(1);
  });

  test('selected voice evidence survives an unselected Work in both VNDB and Bangumi', () => {
    const work = record('vndb', 'vn', 'v11', {}, 'work');
    const character = record('vndb', 'character', 'c41605', {}, 'character');
    const staff = voiceStaff();
    const subject = record('bangumi', 'subject', '311310', {}, 'work');
    const person = record('bangumi', 'person', '4141', {}, 'person');
    const bgmCharacter = record('bangumi', 'character', '100710', {}, 'character');
    const f = fixture(
      [work, character, staff, subject, person, bgmCharacter],
      [
        { from: character.key, to: staff.key, kind: 'voice-actor', data: voice },
        {
          from: person.key,
          to: bgmCharacter.key,
          kind: 'voice',
          data: {
            character_id: 100710,
            person_id: 4141,
            subject_id: 311310,
            summary: '',
            type: 0,
          },
        },
      ],
    );
    f.context.selected = new Set([character.key, staff.key, person.key, bgmCharacter.key]);
    f.native.delete(work.key);
    f.native.delete(subject.key);
    const candidates = projectDatasetCredits(f.context).credits;
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.work).toBeUndefined();
      expect(candidate.participations.map((value) => value.role)).toEqual([
        'work',
        'credited',
        'character',
      ]);
      expect(candidate.participations[0]!.participant.kind).toBe('external');
      expect(candidate.requirements.map((value) => value.contract)).toContain(
        'native-work-binding',
      );
      expect(candidate.evidence[0]!.coverage.kind).toBe('edge');
    }
    expect(candidates[0]!.participations[0]!.sourceIdentity.key).toBe('v11');
    expect(candidates[1]!.participations[0]!.sourceIdentity.key).toBe('311310');
  });

  test('Bangumi voice rows bind their own subject, person and character and retain numeric staff positions', () => {
    // Frozen dump shapes: subject-persons and person-characters. The second
    // subject/repeat, qualification and nonempty episode string are adversarial.
    const subject = record('bangumi', 'subject', '311310', {}, 'work');
    const other = record('bangumi', 'subject', '975', {}, 'work');
    const person = record('bangumi', 'person', '4141', { name: '深見梨加' }, 'person');
    const character = record('bangumi', 'character', '100710', {}, 'character');
    const staff = record('bangumi', 'person', '1000', { name: '高橋陽一' }, 'person');
    const raw = { character_id: 100710, person_id: 4141, subject_id: 311310, summary: '', type: 0 };
    const edges = [
      raw,
      raw,
      { ...raw, subject_id: 975, summary: 'Qualified casting', spoiler: 2, uncertain: false },
    ].map((data) => ({ from: person.key, to: character.key, kind: 'voice', data }));
    const f = fixture(
      [subject, other, person, character, staff],
      [
        ...edges,
        {
          from: other.key,
          to: staff.key,
          kind: 'staff:3',
          data: { appear_eps: '1,3-5', person_id: 1000, position: 3, subject_id: 975 },
        },
      ],
    );
    const candidates = projectDatasetCredits(f.context).credits;
    expect(candidates).toHaveLength(4);
    expect(candidates.slice(0, 3).map((value) => value.work)).toEqual([
      f.native.get(subject.key)!.id,
      f.native.get(subject.key)!.id,
      f.native.get(other.key)!.id,
    ]);
    expect(new Set(candidates.map((value) => value.id)).size).toBe(4);
    expect(candidates[2]!.reported).toMatchObject({
      summary: 'Qualified casting',
      spoiler: 2,
      uncertain: false,
      type: 0,
    });
    expect(candidates[2]!.qualification).toBe('source-reported');
    expect(candidates[3]!.sourceRole).toBe(3);
    expect(candidates[3]!.context).toEqual({ appear_eps: '1,3-5' });
    expect(candidates[3]!.requirements.map((value) => value.contract)).toContain(
      'staff-position-meaning',
    );
    expect(candidates.every((value) => value.nativeRole === undefined)).toBe(true);
  });

  test('Bangumi keeps the row subject identity when the staff edge names another subject', () => {
    const subject = record('bangumi', 'subject', '975', {}, 'work');
    const wrongSubject = record('bangumi', 'subject', '311310', {}, 'work');
    const person = record('bangumi', 'person', '1000', {}, 'person');
    const f = fixture(
      [subject, wrongSubject, person],
      [
        {
          from: wrongSubject.key,
          to: person.key,
          kind: 'staff:3',
          data: { person_id: 1000, subject_id: 975, position: 3, appear_eps: '' },
        },
      ],
    );
    const candidate = projectDatasetCredits(f.context).credits[0]!;
    expect(candidate.work).toBe(f.native.get(subject.key)!.id);
    expect(candidate.work).not.toBe(f.native.get(wrongSubject.key)!.id);
    expect(candidate.requirements.map((value) => value.contract)).toContain(
      'source-credit-occurrence',
    );
  });

  test('MusicBrainz credit order, joinphrase, aliases, recording and release/medium/track grains stay separate', () => {
    const artistId = 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d';
    const artist = record(
      'musicbrainz',
      'artist',
      artistId,
      { name: 'The Beatles', type: 'Group' },
      'organization',
    );
    const credit = {
      artist: { id: artistId, name: 'The Beatles' },
      joinphrase: '',
      name: 'The Beatles',
    };
    const relation = {
      artist: { id: artistId, name: 'The Beatles' },
      'target-type': 'artist',
      type: 'composer',
      'type-id': 'composer-definition',
      direction: 'backward',
      begin: null,
      end: '',
      ended: false,
      attributes: ['guest'],
      'attribute-credits': { guest: 'credited guest' },
    };
    const release = record(
      'musicbrainz',
      'release',
      'release-a',
      {
        'artist-credit': [credit],
        media: [
          {
            position: 1,
            tracks: [
              {
                id: 'track-a',
                position: 1,
                'artist-credit': [{ ...credit, name: 'Credited alias', joinphrase: ' & ' }],
                recording: { id: 'recording-a', 'artist-credit': [credit], relations: [relation] },
              },
              { id: 'track-b', position: 2, 'artist-credit': [credit] },
            ],
          },
        ],
      },
      'release',
    );
    const recording = record(
      'musicbrainz',
      'recording',
      'recording-a',
      { 'artist-credit': [credit, credit], relations: [relation, { ...relation, type: 'editor' }] },
      'work',
    );
    const f = fixture([release, recording, artist]);
    const candidates = projectDatasetCredits(f.context).credits;
    expect(candidates).toHaveLength(9);
    const track = candidates.find(
      (value) => value.evidence[0]!.coverage.path === '/data/media/0/tracks/0/artist-credit/0',
    )!;
    expect(credited(track).creditedName).toBe('Credited alias');
    expect(track.reported.joinphrase).toBe(' & ');
    expect(track.context).toMatchObject({
      medium: { path: '/data/media/0', position: 1 },
      track: { id: 'track-a', position: 1 },
    });
    expect(track.work).toBeUndefined();
    expect(track.participations[0]!.role).toBe('release');
    expect(
      candidates
        .filter((value) => value.kind === 'artist-relation' && value.sourceRole === 'composer')
        .every((value) => !value.nativeRole && canonical(value.reported) === canonical(relation)),
    ).toBe(true);
    expect(candidates.find((value) => value.sourceRole === 'editor')!.nativeRole).toBe('editor');
    const repeated = candidates.filter(
      (value) => value.source.key === recording.key && value.kind === 'artist-credit',
    );
    expect(repeated).toHaveLength(2);
    expect(repeated[0]!.id).not.toBe(repeated[1]!.id);
    expect(credited(repeated[0]!).participant).toEqual({
      kind: 'external',
      provider: 'musicbrainz',
      namespace: 'artist',
      key: artistId,
    });
  });

  test('source hashes and malformed rows cannot silently change evidence pointers', () => {
    const f = staffFixture(),
      source = f.context.source;
    f.context.source = (key) => ({ ...source(key), recordDigest: '0'.repeat(64) });
    expect(() => projectDatasetCredits(f.context)).toThrow('exact retained source record');
    f.context.source = source;
    (f.context.records.get('vndb:vn:v50')!.data.tables as Row).vn_staff = [null, translator];
    expect(() => projectDatasetCredits(f.context)).toThrow('non-object row');
  });
});

// These are transport-contract stubs for the existing source owner, not evidence
// that its currently Open-Library-only verifier admits a VNDB conversion. Actual
// provider admission, dedicated/inverse reads and publication require independent proof.
function admittedContractFixture(scope: Row = {}) {
  // Unscoped transport-contract variant: eid=4 in the frozen example is edition
  // scope and must never be broadened to a Work-wide native credit.
  const f = staffFixture([{ ...translator, eid: null, ...scope }]);
  const candidate = projectDatasetCredits(f.context).credits[0]!;
  const source = candidate.source,
    intake = source.intakes[0]!;
  const binding: DatasetCreditAdoptionBinding = {
    proposal: iri(3000),
    conversion: iri(3001),
    observation: intake.observation,
    sourceOrdinal: 0,
    nativeOrdinal: 2,
    expectedHead: iri(3002),
    baseSupport: null,
    correspondence: null,
  };
  const replies = new Map<string, Row>();
  let mutate: (value: Row) => Row = (value) => value;
  let lost = false;
  f.context.read = async (path) => {
    f.reads.push(path);
    if (path.includes('/observations/'))
      return {
        ...intake,
        provider: source.provider,
        namespace: source.namespace,
        externalId: source.externalId,
        retention: 'retained',
      };
    if (path.includes('/proposals/'))
      return {
        state: 'proposed',
        proposal: binding.proposal,
        conversion: binding.conversion,
        observation: binding.observation,
        record: intake.record,
        sourceDigest: intake.byteDigest,
        graphReceipt: 'urn:fixture:source-graph-receipt',
      };
    if (path.includes('/author-credit-supports/')) {
      const base = [...replies.values()].find(
        (value) => (value.support as Row).support === binding.baseSupport,
      );
      if (base) return structuredClone(base.support as Row);
    }
    throw new Error(`Unexpected owner read: ${path}`);
  };
  f.context.command = async (label, method, path, rawBody) => {
    const body = rawBody as Row;
    f.calls.push({ label, method, path, body: structuredClone(body) });
    const previous = replies.get(label);
    if (previous) return { ...structuredClone(previous), replayed: true };
    const base = [...replies.values()].find(
      (value) => (value.support as Row).support === binding.baseSupport,
    )?.support as Row | undefined;
    const credit = base
      ? structuredClone(base.credit)
      : {
          profile: 'work-author-credit-v1',
          work: candidate.work,
          credit: iri(4000),
          revision: iri(4001),
          expectedHead: binding.expectedHead,
          actingSubject: f.context.actingSubject,
          sourceKey: candidate.sourceKey,
          sourceRoleKey: candidate.sourceRoleKey,
          nativeOrdinal: binding.nativeOrdinal,
          role: candidate.nativeRole,
          participantKind: 'external-reference',
          provider: 'vndb',
          namespace: 'staff',
          control: 'human-confirmed',
          rightsStatus: 'undetermined',
          dataEpoch: 'epoch-a',
          sequence: '17',
        };
    const result = mutate({
      replayed: false,
      support: {
        profile: 'source-author-credit-support-v1',
        state: 'recorded',
        support: iri(4002 + replies.size * 10),
        work: candidate.work,
        credit,
        proposal: binding.proposal,
        conversion: binding.conversion,
        record: intake.record,
        observation: binding.observation,
        sourceOccurrence: body.occurrence,
        sourceOrdinal: body.sourceOrdinal,
        sourceKey: body.confirmedSourceKey,
        sourceRoleKey: body.confirmedRoleKey,
        baseSupport: binding.baseSupport,
        correspondence: binding.correspondence,
        rightsStatus: 'undetermined',
        sourceGraphReceipt: 'urn:fixture:source-graph-receipt',
        nativeReceipt: `urn:rezics:receipt:${'b'.repeat(64)}`,
        headGuarantee: binding.baseSupport ? 'verified-before-commit' : 'transaction-guarded',
        withdrawal: null,
      },
    });
    replies.set(label, structuredClone(result));
    if (lost) {
      lost = false;
      throw new Error('Lost adoption acknowledgement');
    }
    return result;
  };
  const mapper = datasetCreditMapper(new Map([[candidate.id, binding]]));
  const entry = (path: string) =>
    f.coverage.entries.get(datasetCoverageId({ record: 'vndb:vn:v50', kind: 'field', path }))!;
  return {
    ...f,
    candidate,
    binding,
    mapper,
    entry,
    setMutation(value: typeof mutate) {
      mutate = value;
    },
    loseReply() {
      lost = true;
    },
  };
}

describe('source-author-credit context adapter', () => {
  test('without a verified source binding supported candidates remain pending with precise field evidence', async () => {
    const f = staffFixture();
    await datasetCreditMapper().map(f.context);
    const report = f.coverage.report(true, new Set(['credits']));
    expect(report.counts.mapped).toBe(0);
    const role = report.entries.find((value) => value.path === '/data/tables/vn_staff/0/role')!;
    expect(role.disposition.status).toBe('unmapped');
    expect(role.disposition.reason).toContain('source-credit-conversion');
    expect(role.disposition.reason).not.toContain('credit-role:');
    expect(report.entries.find((value) => value.path.endsWith('/note'))!.disposition.status).toBe(
      'absent',
    );
    expect(f.calls).toEqual([]);
    expect(f.reads).toEqual([]);
    expect(report.catalogueReady).toBe(false);
  });

  test('only an exact source/adoption receipt maps the admitted role; alias/eid/note and enclosing rows stay explicit', async () => {
    const f = admittedContractFixture();
    await f.mapper.map(f.context);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({
      method: 'POST',
      path: `/v1/works/${f.candidate.work!.slice(-36)}/source-author-credits`,
      body: {
        profile: 'source-author-credit-adoption-v1',
        confirmedSourceKey: 's12507',
        confirmedRoleKey: 'translator',
        sourceOrdinal: 0,
        nativeOrdinal: 2,
        confirmedUse: 'factual-reference-only',
      },
    });
    expect(f.calls[0]!.label).toMatch(/^credit:[0-9a-f]{64}$/);
    expect(f.entry('/data/tables/vn_staff/0/role').disposition).toMatchObject({
      status: 'mapped',
      mapping: { target: iri(4000), readPath: `/v1/works/${f.candidate.work!.slice(-36)}/credits` },
    });
    expect(f.entry('/data/tables/vn_staff/0').disposition.status).toBe('unmapped');
    expect(f.entry('/data/tables/vn_staff/0/eid').disposition.status).toBe('absent');
    expect(f.entry('/data/tables/vn_staff/0/aid').disposition.status).toBe('unmapped');
    expect(f.entry('/data/tables/vn_staff/0/note').disposition.status).toBe('absent');
    expect(
      f.calls.some((call) => call.path.endsWith('/agent-credits') || call.path === '/v1/relations'),
    ).toBe(false);
  });

  test('lost replies replay the same command, while new independent supports append receipts', async () => {
    const f = admittedContractFixture();
    const before = canonical(f.snapshot),
      native = canonical([...f.native]);
    f.loseReply();
    await expect(f.mapper.map(f.context)).rejects.toThrow('Lost adoption acknowledgement');
    expect(f.entry('/data/tables/vn_staff/0/role').disposition.status).toBe('unmapped');
    await f.mapper.map(f.context);
    await f.mapper.map(f.context);
    expect(new Set(f.calls.map((value) => value.label)).size).toBe(1);
    expect(new Set(f.calls.map((value) => canonical(value.body))).size).toBe(1);
    expect(f.entry('/data/tables/vn_staff/0/role').mappings).toHaveLength(1);
    f.binding.baseSupport = iri(4002);
    f.binding.proposal = iri(5000);
    // A new support uses the current head; its native receipt still describes
    // the original credit's head, actor and epoch rather than a second write.
    f.binding.expectedHead = iri(5001);
    await f.mapper.map(f.context);
    expect(new Set(f.calls.map((value) => value.label)).size).toBe(2);
    expect(f.entry('/data/tables/vn_staff/0/role').mappings).toHaveLength(2);
    expect(canonical(f.snapshot)).toBe(before);
    expect(canonical([...f.native])).toBe(native);
  });

  test('a role receipt leaves meaningful credited notes pending with their exact evidence', async () => {
    const f = admittedContractFixture({ note: 'Credited as Horagema' });
    const bytes = canonical(f.snapshot);
    await f.mapper.map(f.context);
    expect(f.entry('/data/tables/vn_staff/0/role').disposition.status).toBe('mapped');
    expect(f.entry('/data/tables/vn_staff/0/note').disposition).toMatchObject({
      status: 'unmapped',
      reason: expect.stringContaining(
        `credit-evidence:${sha256(canonical('Credited as Horagema'))}`,
      ),
    });
    expect(credited(projectDatasetCredits(f.context).credits[0]!).sourceIdentity.note).toBe(
      'Credited as Horagema',
    );
    expect(canonical(f.snapshot)).toBe(bytes);
  });

  test.each([{ eid: '4' }, { eid: 0 }, { uncertain: false }, { spoiler: 0 }])(
    'scoped source metadata %j cannot be broadened by a bounded role adoption',
    async (scope) => {
      const f = admittedContractFixture(scope);
      await expect(f.mapper.map(f.context)).rejects.toThrow('Contextual credits require');
      expect(f.calls).toEqual([]);
      expect(f.reads).toEqual([]);
      const field = Object.keys(scope)[0]!;
      expect(f.entry(`/data/tables/vn_staff/0/${field}`).disposition.status).toBe('unmapped');
    },
  );

  test.each([
    ['pending operation', (_value: Row) => ({ operation: iri(4000) })],
    ['native creation', (_value: Row) => ({ credit: iri(4000), role: 'translator' })],
    ...[
      'state',
      'observation',
      'record',
      'conversion',
      'proposal',
      'sourceOccurrence',
      'sourceOrdinal',
      'sourceKey',
      'sourceRoleKey',
      'sourceGraphReceipt',
      'nativeReceipt',
      'headGuarantee',
      'withdrawal',
    ].map(
      (field) =>
        [
          field,
          (value: Row) => {
            (value.support as Row)[field] = 'wrong';
            return value;
          },
        ] as const,
    ),
    ...[
      'provider',
      'namespace',
      'sourceKey',
      'sourceRoleKey',
      'role',
      'nativeOrdinal',
      'control',
      'expectedHead',
      'participantKind',
    ].map(
      (field) =>
        [
          `credit.${field}`,
          (value: Row) => {
            ((value.support as Row).credit as Row)[field] = 'wrong';
            return value;
          },
        ] as const,
    ),
  ] as const)('refuses %s as proof of a native mapping', async (_name, mutate) => {
    const f = admittedContractFixture();
    f.setMutation(mutate);
    await expect(f.mapper.map(f.context)).rejects.toThrow('did not acknowledge');
    expect(f.entry('/data/tables/vn_staff/0/role').disposition.status).toBe('unmapped');
  });

  test('split observations and mismatched proposal evidence cannot be adopted', async () => {
    const f = admittedContractFixture(),
      source = f.context.source;
    f.context.source = (key) => {
      const ref = source(key);
      return { ...ref, observations: [...ref.observations, iri(9999)] };
    };
    await expect(f.mapper.map(f.context)).rejects.toThrow(
      'one exact retained convertible observation',
    );
    expect(f.calls).toEqual([]);
    f.context.source = source;
    const read = f.context.read;
    f.context.read = async (path) => ({
      ...(await read(path)),
      ...(path.includes('/proposals/') ? { sourceDigest: 'wrong' } : {}),
    });
    await expect(f.mapper.map(f.context)).rejects.toThrow('proposal differs');
    expect(f.calls).toEqual([]);
  });

  test('immutable source plans leave all 113 caller bindings unchanged in two independent epoch journals', async () => {
    const baseline = staffFixture();
    for (const epoch of ['epoch-a', 'epoch-b']) {
      const f = fixture(structuredClone([...baseline.context.records.values()]), [], epoch);
      for (let index = 0; index < 111; index++)
        f.native.set(`retained-${index}`, {
          id: iri(10_000 + index),
          kind: 'work',
          urls: [],
          receipt: { dataEpoch: epoch, identityOnly: true },
        });
      const before = canonical([...f.native]),
        bytes = canonical(f.snapshot);
      expect(f.native.size).toBe(113);
      await datasetCreditMapper().map(f.context);
      expect(canonical([...f.native])).toBe(before);
      expect(canonical(f.snapshot)).toBe(bytes);
      expect(f.calls).toEqual([]);
    }
  });
});
