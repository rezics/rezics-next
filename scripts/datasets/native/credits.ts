import type { AdoptSourceAuthorCreditInput } from '../../../services/main/src/modules/source/author-credit.ts';
import { sourceChildOccurrence } from '../../../services/main/src/modules/source/child-correspondence.ts';
import {
  isNativeCreditRole,
  type NativeCreditRole,
} from '../../../services/main/src/modules/work/credit-roles.ts';
import { canonical, sha256 } from '../store.ts';
import type {
  DatasetCoverageKey,
  DatasetMappingContext,
  DatasetNativeMapper,
  DatasetRecord,
  DatasetSourceReference,
} from '../types.ts';
import { datasetRecordDigest, datasetSourceIdentity } from './context.ts';

export const DATASET_CREDIT_MAPPING_REVISION = 'dataset-credits-v1';
type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : undefined;
const rows = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.map((value) => {
        const object = row(value);
        if (!object) throw new Error('A retained credit collection contains a non-object row');
        return object;
      })
    : [];
const token = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
const nativeId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  );
const short = (value: string) => {
  if (!nativeId(value)) throw new Error('Credit command requires an exact native identity');
  return value.slice(-36);
};
const scalarId = (value: unknown) =>
  typeof value === 'string' && value.length
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : undefined;

export interface DatasetCreditEvidence {
  source: DatasetSourceReference;
  coverage: DatasetCoverageKey;
  /** Exact retained value, including null, empty strings, false and zero. */
  value: unknown;
  valueDigest: string;
}

export interface DatasetCreditParticipation {
  role: 'work' | 'credited' | 'character' | 'release';
  participant:
    | { kind: 'resource'; ref: string }
    | { kind: 'external'; provider: string; namespace: string; key: string };
  sourceIdentity: {
    provider: string;
    namespace: string;
    key: string;
    alias?: unknown;
    eid?: unknown;
    note?: unknown;
  };
  /** A credited spelling is never replaced with the person's current display name. */
  creditedName?: string;
  evidence: DatasetCreditEvidence[];
}

export interface DatasetCreditRequirement {
  contract:
    | 'credit-role'
    | 'staff-position-meaning'
    | 'staff-alias-binding'
    | 'source-credit-conversion'
    | 'source-credit-occurrence'
    | 'source-credit-metadata'
    | 'qualified-credit-occurrence'
    | 'native-work-binding'
    | 'source-credit-adoption';
  reason: string;
}

export interface DatasetCreditCandidate {
  /** Source occurrence identity, independent of mutable names and capture digests. */
  id: string;
  kind: 'staff' | 'voice' | 'artist-credit' | 'artist-relation';
  source: DatasetSourceReference;
  sourceRole: unknown;
  sourceKey: string;
  sourceRoleKey: string | null;
  /** Only an exact admitted role is a candidate for the bounded credit owner. */
  nativeRole?: NativeCreditRole;
  work?: string;
  participations: DatasetCreditParticipation[];
  /** Provider scope stays on this occurrence; prose does not resolve a release. */
  context: Row;
  qualification: 'source-reported';
  reported: Row;
  evidence: DatasetCreditEvidence[];
  requirements: DatasetCreditRequirement[];
  /** These individual fields can be acknowledged by the bounded credit owner.
   * A partial credit receipt never marks the enclosing row/edge or its metadata mapped. */
  nativeCoverage: DatasetCoverageKey[];
}

export interface DatasetCreditPlan {
  revision: typeof DATASET_CREDIT_MAPPING_REVISION;
  credits: DatasetCreditCandidate[];
}

/** Pure projection of retained occurrences. No new Agent, relation definition,
 * source authority, adoption or publication is inferred by this adapter. */
export function projectDatasetCredits(context: DatasetMappingContext): DatasetCreditPlan {
  const credits: DatasetCreditCandidate[] = [];
  const identities = new Map<string, DatasetRecord[]>();
  for (const record of context.records.values()) {
    const identity = datasetSourceIdentity(record);
    identities.set(identity, [...(identities.get(identity) ?? []), record]);
  }
  const find = (provider: DatasetRecord['provider'], namespace: string, id: unknown) => {
    const key = scalarId(id);
    const matches = key ? identities.get(canonical([provider, namespace, key])) : undefined;
    return matches?.length === 1 ? matches[0] : undefined;
  };
  const evidence = (
    record: DatasetRecord,
    coverage: DatasetCoverageKey,
    value: unknown,
  ): DatasetCreditEvidence => {
    const source = context.source(record.key);
    if (
      source.key !== record.key ||
      source.provider !== record.provider ||
      source.namespace !== record.kind ||
      source.externalId !== record.externalId ||
      source.recordDigest !== datasetRecordDigest(record) ||
      source.snapshot !== context.snapshot.id ||
      source.snapshotDigest !== context.snapshot.digest
    )
      throw new Error('Credit projection requires the exact retained source record');
    return {
      source: structuredClone(source),
      coverage,
      value: structuredClone(value),
      valueDigest: sha256(canonical(value)),
    };
  };
  const field = (record: DatasetRecord, path: string, value: unknown) =>
    evidence(record, { record: record.key, kind: 'field', path }, value);
  const participation = (
    role: DatasetCreditParticipation['role'],
    record: DatasetRecord | undefined,
    provider: string,
    namespace: string,
    key: string,
    ownEvidence: DatasetCreditEvidence[],
  ): DatasetCreditParticipation => {
    const binding = record && context.native.get(record.key);
    // A native semantic Person is usable as a relation Resource. It is not an
    // authenticated Agent. Legacy/reused bindings without an explicit tuple stay external.
    const bound =
      binding &&
      nativeId(binding.id) &&
      binding.sourceIdentity === datasetSourceIdentity(record!) &&
      (binding.kind === 'resource' || binding.kind === 'work');
    return {
      role,
      participant: bound
        ? { kind: 'resource', ref: binding.id }
        : { kind: 'external', provider, namespace, key },
      sourceIdentity: { provider, namespace, key },
      evidence: structuredClone(ownEvidence),
    };
  };
  const emit = (
    kind: DatasetCreditCandidate['kind'],
    workRecord: DatasetRecord | undefined,
    person: DatasetRecord | undefined,
    provider: DatasetRecord['provider'],
    namespace: string,
    personKey: string,
    sourceRole: unknown,
    raw: Row,
    ownEvidence: DatasetCreditEvidence[],
    options: {
      character?: DatasetRecord;
      characterId?: string;
      creditedName?: string;
      alias?: unknown;
      aliasEvidence?: DatasetCreditEvidence;
      context?: Row;
      nativeRole?: NativeCreditRole;
    } = {},
  ) => {
    const primary = ownEvidence[0]!;
    const source = primary.source;
    const credited = participation('credited', person, provider, namespace, personKey, ownEvidence);
    for (const name of ['eid', 'note'] as const)
      if (Object.hasOwn(raw, name)) credited.sourceIdentity[name] = structuredClone(raw[name]);
    if (options.alias !== undefined) credited.sourceIdentity.alias = structuredClone(options.alias);
    if (options.creditedName !== undefined) credited.creditedName = options.creditedName;
    if (options.aliasEvidence) credited.evidence.push(options.aliasEvidence);
    const parts = [credited];
    if (workRecord)
      parts.unshift(
        participation(
          workRecord.kind === 'release' ? 'release' : 'work',
          workRecord,
          provider,
          workRecord.kind,
          workRecord.externalId,
          ownEvidence,
        ),
      );
    if (options.characterId)
      parts.push(
        participation(
          'character',
          options.character,
          provider,
          'character',
          options.characterId,
          ownEvidence,
        ),
      );
    const binding = workRecord && context.native.get(workRecord.key);
    const work =
      workRecord?.native === 'work' &&
      binding?.kind === 'work' &&
      nativeId(binding.id) &&
      (binding.sourceIdentity === datasetSourceIdentity(workRecord) ||
        (!binding.sourceIdentity &&
          workRecord.key === `${provider}:${workRecord.kind}:${workRecord.externalId}`))
        ? binding.id
        : undefined;
    const nativeRole = options.nativeRole;
    const requirements: DatasetCreditRequirement[] = [];
    if (!nativeRole)
      requirements.push({
        contract:
          provider === 'bangumi' && kind === 'staff' ? 'staff-position-meaning' : 'credit-role',
        reason: `No exact installed credit role mapping for ${provider} ${canonical(sourceRole)}`,
      });
    if (!work)
      requirements.push({
        contract: 'native-work-binding',
        reason: 'The bounded credit owner requires the exact retained Work grain and binding',
      });
    const scopedFields = [
      'spoiler',
      'lie',
      'uncertain',
      'official',
      'release',
      'release_id',
      'rid',
      'begin',
      'end',
      'ended',
      'direction',
      'attributes',
      'attribute-credits',
      'attribute-values',
    ];
    const qualification = Object.fromEntries(
      scopedFields
        .filter((key) => Object.hasOwn(raw, key))
        .map((key) => [key, structuredClone(raw[key])]),
    );
    const occurrenceContext = { ...options.context, ...qualification };
    if (kind === 'voice' || workRecord?.kind === 'release' || Object.keys(occurrenceContext).length)
      requirements.push({
        contract: 'qualified-credit-occurrence',
        reason:
          'An admitted definition and source-support binding must preserve all performer, character, Work/release and scope in one occurrence',
      });
    if (
      Object.keys(raw).some(
        (key) => !['id', 'role', 'aid', 'person_id', 'subject_id', 'position'].includes(key),
      ) ||
      options.alias !== undefined ||
      options.creditedName !== undefined
    )
      requirements.push({
        contract: 'source-credit-metadata',
        reason:
          'Current bounded credit adoption has no participation slots for credited spelling, alias/eid/note or the remaining exact provider metadata',
      });
    requirements.push({
      contract: 'source-credit-conversion',
      reason: `The source credit owner needs a verified ${provider}/${source.namespace} credit occurrence; its installed verifier currently derives only Open Library authors`,
    });
    requirements.push({
      contract: 'source-credit-adoption',
      reason:
        'Mapped coverage requires an exact acknowledged source-author-credit support, not native creation or a proposed conversion',
    });
    const nativeCoverage: DatasetCoverageKey[] = [];
    if (nativeRole && primary.coverage.kind === 'field') {
      const roleField = Object.hasOwn(raw, 'role')
        ? 'role'
        : Object.hasOwn(raw, 'type')
          ? 'type'
          : undefined;
      if (roleField)
        nativeCoverage.push({ ...primary.coverage, path: `${primary.coverage.path}/${roleField}` });
    }
    const candidate: DatasetCreditCandidate = {
      id: sha256(
        canonical([
          source.provider,
          source.namespace,
          source.externalId,
          primary.coverage.kind,
          primary.coverage.path,
        ]),
      ),
      kind,
      source,
      sourceRole: structuredClone(sourceRole),
      sourceKey: personKey,
      sourceRoleKey: typeof sourceRole === 'string' ? sourceRole : (scalarId(sourceRole) ?? null),
      ...(nativeRole ? { nativeRole } : {}),
      ...(work ? { work } : {}),
      participations: parts,
      context: occurrenceContext,
      qualification: 'source-reported',
      reported: structuredClone(raw),
      evidence: ownEvidence,
      requirements,
      nativeCoverage,
    };
    credits.push(candidate);
    return candidate;
  };

  const aliasIndex = new Map<
    unknown,
    Array<{ record: DatasetRecord; alias: Row; index: number }>
  >();
  for (const record of context.records.values()) {
    if (!context.selected.has(record.key) || record.provider !== 'vndb' || record.kind !== 'staff')
      continue;
    rows(row(record.data.tables)?.staff_alias).forEach((alias, index) => {
      if (alias.id !== record.externalId || !scalarId(alias.aid)) return;
      aliasIndex.set(alias.aid, [...(aliasIndex.get(alias.aid) ?? []), { record, alias, index }]);
    });
  }
  const vndb = (
    work: DatasetRecord | undefined,
    raw: Row,
    ownEvidence: DatasetCreditEvidence[],
    voice: boolean,
    personFromEdge?: DatasetRecord,
  ) => {
    const matches = aliasIndex.get(raw.aid) ?? [];
    const alias = matches.length === 1 ? matches[0] : undefined;
    const person = personFromEdge ?? alias?.record;
    const consistent = !personFromEdge || !alias || personFromEdge.key === alias.record.key;
    const characterId = scalarId(raw.cid);
    const sourceRole = voice ? 'voice-actor' : (raw.role ?? 'unspecified-staff');
    // art is the VNDB artwork credit; scenario, music, songs, chardesign, qa and
    // unspecified staff are deliberately not relabelled as author/artist/etc.
    const nativeRole =
      !voice && sourceRole === 'art'
        ? 'artist'
        : !voice && typeof sourceRole === 'string' && isNativeCreditRole(sourceRole)
          ? sourceRole
          : undefined;
    const candidate = emit(
      voice ? 'voice' : 'staff',
      work,
      consistent ? person : undefined,
      'vndb',
      person && consistent ? 'staff' : 'staff-alias',
      person && consistent ? person.externalId : String(raw.aid ?? ''),
      sourceRole,
      raw,
      ownEvidence,
      {
        alias: raw.aid,
        ...(nativeRole ? { nativeRole } : {}),
        ...(Object.hasOwn(raw, 'eid') && raw.eid !== null
          ? {
              context: {
                edition: { provider: 'vndb', work: raw.id, key: raw.eid },
              },
            }
          : {}),
        ...(characterId ? { characterId, character: find('vndb', 'character', characterId) } : {}),
        ...(alias && consistent
          ? {
              creditedName: typeof alias.alias.name === 'string' ? alias.alias.name : undefined,
              aliasEvidence: field(
                alias.record,
                `/data/tables/staff_alias/${alias.index}`,
                alias.alias,
              ),
            }
          : {}),
      },
    );
    if (!alias || !consistent)
      candidate.requirements.push({
        contract: 'staff-alias-binding',
        reason:
          'The exact aid must bind unambiguously to the retained staff identity and spelling; no name or main-alias substitution is permitted',
      });
    if (!work || work.externalId !== raw.id)
      candidate.requirements.push({
        contract: 'source-credit-occurrence',
        reason: 'The retained Work identity must agree with the complete source credit row',
      });
    return candidate;
  };

  // Canonical dump rows precede their edge projections. Matching copies attach
  // evidence by ordinal, never deduplicate repeated rows into a single credit.
  const copies = new Map<string, DatasetCreditCandidate[]>();
  const signature = (workId: unknown, kind: string, raw: Row) => canonical([workId, kind, raw]);
  for (const record of context.records.values()) {
    if (!context.selected.has(record.key) || record.provider !== 'vndb' || record.kind !== 'vn')
      continue;
    for (const table of ['vn_staff', 'vn_seiyuu'])
      for (const [index, raw] of rows(row(record.data.tables)?.[table]).entries()) {
        const kind = table === 'vn_seiyuu' ? 'voice-actor' : `credit:${String(raw.role)}`;
        const candidate = vndb(
          record,
          raw,
          [field(record, `/data/tables/${table}/${index}`, raw)],
          table === 'vn_seiyuu',
        );
        const key = signature(record.externalId, kind, raw);
        copies.set(key, [...(copies.get(key) ?? []), candidate]);
      }
  }
  const edges = context.snapshot.sources.flatMap((source, sourceIndex) =>
    source.edges.map((edge, index) => ({ edge, path: `/sources/${sourceIndex}/edges/${index}` })),
  );
  const used = new Map<string, number>();
  // Work edges precede Character mirrors even when the source sorted them the other way.
  const vndbEdges = edges.filter(
    ({ edge }) =>
      context.records.get(edge.from)?.provider === 'vndb' &&
      (edge.kind.startsWith('credit:') || edge.kind === 'voice-actor'),
  );
  vndbEdges.sort(
    (a, b) =>
      Number(context.records.get(a.edge.from)?.kind !== 'vn') -
      Number(context.records.get(b.edge.from)?.kind !== 'vn'),
  );
  for (const { edge, path } of vndbEdges) {
    const from = context.records.get(edge.from)!;
    if (!context.selected.has(from.key)) continue;
    const work = from.kind === 'vn' ? from : find('vndb', 'vn', edge.data.id);
    const ownEvidence = evidence(from, { record: from.key, kind: 'edge', path }, edge);
    const key = signature(work?.externalId ?? edge.data.id, edge.kind, edge.data);
    const use = canonical([key, from.key]),
      ordinal = used.get(use) ?? 0;
    used.set(use, ordinal + 1);
    let candidate = copies.get(key)?.[ordinal];
    const target = context.records.get(edge.to);
    const endpointsMatch =
      target?.provider === 'vndb' &&
      target.kind === 'staff' &&
      (from.kind === 'vn' ||
        (edge.kind === 'voice-actor' &&
          from.kind === 'character' &&
          from.externalId === edge.data.cid)) &&
      work?.externalId === edge.data.id &&
      (edge.kind === 'voice-actor'
        ? Boolean(scalarId(edge.data.cid))
        : edge.kind === `credit:${String(edge.data.role)}`);
    const expected = candidate?.participations.find(
      (part) => part.role === 'credited',
    )?.sourceIdentity;
    if (
      candidate &&
      (!endpointsMatch ||
        candidate.requirements.some((value) => value.contract === 'source-credit-occurrence') ||
        expected?.namespace !== 'staff' ||
        expected.key !== target?.externalId)
    )
      candidate = undefined;
    if (candidate) {
      candidate.evidence.push(ownEvidence);
      for (const part of candidate.participations) part.evidence.push(structuredClone(ownEvidence));
    } else {
      candidate = vndb(
        work,
        edge.data,
        [ownEvidence],
        edge.kind === 'voice-actor',
        target?.provider === 'vndb' && target.kind === 'staff' ? target : undefined,
      );
      if (!endpointsMatch)
        candidate.requirements.push({
          contract: 'source-credit-occurrence',
          reason: 'The retained edge endpoints or role contradict its complete source credit row',
        });
      copies.set(key, [...(copies.get(key) ?? []), candidate]);
    }
  }

  for (const { edge, path } of edges) {
    const from = context.records.get(edge.from);
    if (
      !from ||
      !context.selected.has(from.key) ||
      from.provider !== 'bangumi' ||
      !(edge.kind.startsWith('staff:') || edge.kind === 'voice')
    )
      continue;
    const voice = edge.kind === 'voice';
    const work = find('bangumi', 'subject', edge.data.subject_id);
    const person = voice ? from : context.records.get(edge.to);
    const character = voice ? context.records.get(edge.to) : undefined;
    const ownEvidence = evidence(from, { record: from.key, kind: 'edge', path }, edge);
    const characterId = voice ? scalarId(edge.data.character_id) : undefined;
    const exactPerson =
      person?.provider === 'bangumi' &&
      person.kind === 'person' &&
      person.externalId === scalarId(edge.data.person_id)
        ? person
        : undefined;
    const candidate = emit(
      voice ? 'voice' : 'staff',
      work,
      exactPerson,
      'bangumi',
      'person',
      scalarId(edge.data.person_id) ?? '',
      voice ? 'voice' : (edge.data.position ?? edge.kind.slice(6)),
      edge.data,
      [ownEvidence],
      {
        ...(characterId
          ? {
              characterId,
              character:
                character?.provider === 'bangumi' &&
                character.kind === 'character' &&
                character.externalId === characterId
                  ? character
                  : undefined,
            }
          : {}),
        ...(typeof edge.data.appear_eps === 'string' && edge.data.appear_eps.length
          ? { context: { appear_eps: edge.data.appear_eps } }
          : {}),
      },
    );
    if (
      !exactPerson ||
      !work ||
      (voice
        ? character?.provider !== 'bangumi' ||
          character.kind !== 'character' ||
          character.externalId !== characterId
        : from.key !== work.key || edge.kind !== `staff:${String(edge.data.position)}`)
    )
      candidate.requirements.push({
        contract: 'source-credit-occurrence',
        reason: 'The retained edge endpoints or position contradict its complete source credit row',
      });
  }

  // MusicBrainz reference edges are indexes into these values, not new credits.
  // Walk nested track/recording values at their original release/medium/track grain.
  for (const record of context.records.values()) {
    if (
      !context.selected.has(record.key) ||
      record.provider !== 'musicbrainz' ||
      !['release-group', 'release', 'recording', 'work'].includes(record.kind)
    )
      continue;
    const walk = (value: unknown, path: string, scope: Row) => {
      if (Array.isArray(value)) {
        value.forEach((value, index) => walk(value, `${path}/${index}`, scope));
        return;
      }
      const object = row(value);
      if (!object) return;
      let ownScope = scope;
      if (/\/media\/\d+$/.test(path))
        ownScope = { ...scope, medium: { path, position: object.position } };
      if (/\/tracks\/\d+$/.test(path))
        ownScope = { ...scope, track: { path, id: object.id, position: object.position } };
      if (Object.hasOwn(object, 'artist-credit'))
        rows(object['artist-credit']).forEach((credit, index) => {
          const artist = row(credit.artist),
            id = scalarId(artist?.id);
          const at = `${path}/artist-credit/${index}`;
          emit(
            'artist-credit',
            record,
            id ? find('musicbrainz', 'artist', id) : undefined,
            'musicbrainz',
            'artist',
            id ?? '',
            'artist-credit',
            credit,
            [field(record, at, credit)],
            {
              ...(typeof credit.name === 'string' ? { creditedName: credit.name } : {}),
              context: { ...ownScope, ...(path === '/data' ? {} : { sourceObject: path }) },
            },
          );
        });
      rows(object.relations).forEach((relation, index) => {
        if (relation['target-type'] !== 'artist' && !row(relation.artist)) return;
        const artist = row(relation.artist),
          id = scalarId(artist?.id);
        const type = relation.type;
        emit(
          'artist-relation',
          record,
          id ? find('musicbrainz', 'artist', id) : undefined,
          'musicbrainz',
          'artist',
          id ?? '',
          type ?? 'unspecified-artist-relation',
          relation,
          [field(record, `${path}/relations/${index}`, relation)],
          {
            ...(typeof type === 'string' && isNativeCreditRole(type) ? { nativeRole: type } : {}),
            context: { ...ownScope, ...(path === '/data' ? {} : { sourceObject: path }) },
          },
        );
      });
      for (const [name, child] of Object.entries(object))
        if (name !== 'artist-credit' && name !== 'relations')
          walk(child, `${path}/${token(name)}`, ownScope);
    };
    walk(record.data, '/data', {});
  }
  return { revision: DATASET_CREDIT_MAPPING_REVISION, credits };
}

/** Supplied only after the source owner admits an exact conversion/proposal.
 * This adapter cannot manufacture that prerequisite for a missing provider verifier.
 * A pinned expectedHead keeps an acknowledged command's retry byte-for-byte stable. */
export interface DatasetCreditAdoptionBinding {
  proposal: string;
  conversion: string;
  observation: string;
  sourceOrdinal: number;
  nativeOrdinal: number;
  expectedHead: string;
  baseSupport: string | null;
  correspondence: string | null;
}

type DatasetCreditAdoptionRequest = AdoptSourceAuthorCreditInput & {
  profile: 'source-author-credit-adoption-v1';
};

export function datasetCreditCommandLabel(
  candidate: DatasetCreditCandidate,
  body: DatasetCreditAdoptionRequest,
): string {
  return `credit:${sha256(
    canonical([
      DATASET_CREDIT_MAPPING_REVISION,
      candidate.id,
      candidate.source.snapshotDigest,
      candidate.source.recordDigest,
      body,
    ]),
  )}`;
}

/** Executable context adapter. Without a verified source binding it returns
 * precise pending contracts, never a raw native-credit creation fallback. */
export function datasetCreditMapper(
  bindings: ReadonlyMap<string, DatasetCreditAdoptionBinding> = new Map(),
): DatasetNativeMapper {
  return {
    id: 'credits',
    revision: DATASET_CREDIT_MAPPING_REVISION,
    async map(context) {
      const plan = projectDatasetCredits(context);
      const retained = new Map<string, { item: DatasetCreditEvidence; reason: string }>();
      const acknowledgedFields = new Set(
        plan.credits
          .filter((candidate) => bindings.has(candidate.id))
          .flatMap((candidate) => candidate.nativeCoverage.map((key) => canonical(key))),
      );
      for (const candidate of plan.credits)
        for (const item of candidate.evidence)
          retained.set(canonical(item.coverage), {
            item,
            reason: candidate.requirements
              .map((requirement) => `${requirement.contract}: ${requirement.reason}`)
              .join('; '),
          });
      for (const { item, reason } of retained.values()) {
        const retain = (key: DatasetCoverageKey, value: unknown) => {
          if (acknowledgedFields.has(canonical(key))) return;
          const empty =
            value === null ||
            value === '' ||
            (Array.isArray(value) && !value.length) ||
            (row(value) && !Object.keys(value as Row).length);
          context.disposition(key, {
            status: empty ? 'absent' : 'unmapped',
            reason: `credit-evidence:${sha256(canonical(value))}; ${empty ? 'source-empty-or-null' : reason}`,
          });
          if (key.kind === 'field' && value && typeof value === 'object')
            for (const [name, child] of Object.entries(value))
              retain({ ...key, path: `${key.path}/${token(name)}` }, child);
        };
        // Parent rows/edges stay pending while any source meaning has no admitted slot.
        retain(item.coverage, item.value);
      }
      for (const candidate of plan.credits) {
        const binding = bindings.get(candidate.id);
        if (!binding || !candidate.nativeRole || !candidate.work) continue;
        if (
          candidate.requirements.some((value) => value.contract === 'qualified-credit-occurrence')
        )
          throw new Error(
            'Contextual credits require their admitted occurrence/source-support owner',
          );
        if (
          !candidate.sourceKey ||
          candidate.requirements.some((value) =>
            ['staff-alias-binding', 'source-credit-occurrence'].includes(value.contract),
          ) ||
          (candidate.source.provider === 'vndb' &&
            candidate.reported.id !== candidate.source.externalId)
        )
          throw new Error('Credit adoption requires an unambiguous exact source participation');
        const source = candidate.source;
        const intake = source.intakes.find((value) => value.observation === binding.observation);
        if (
          !intake ||
          source.intakes.length !== 1 ||
          source.observations.length !== 1 ||
          source.observations[0] !== binding.observation
        )
          throw new Error('Credit adoption requires one exact retained convertible observation');
        const observation = await context.read(
          `/v1/sources/observations/${short(binding.observation)}`,
        );
        const proposal = await context.read(`/v1/sources/proposals/${short(binding.proposal)}`);
        if (
          observation.observation !== binding.observation ||
          observation.record !== intake.record ||
          observation.provider !== source.provider ||
          observation.namespace !== source.namespace ||
          observation.externalId !== source.externalId ||
          observation.byteDigest !== intake.byteDigest ||
          observation.retention !== 'retained' ||
          proposal.state !== 'proposed' ||
          proposal.proposal !== binding.proposal ||
          proposal.conversion !== binding.conversion ||
          proposal.observation !== binding.observation ||
          proposal.record !== intake.record ||
          proposal.sourceDigest !== intake.byteDigest ||
          typeof proposal.graphReceipt !== 'string' ||
          !proposal.graphReceipt
        )
          throw new Error('Credit proposal differs from the exact retained source observation');
        const base = binding.baseSupport
          ? await context.read(`/v1/sources/author-credit-supports/${short(binding.baseSupport)}`)
          : undefined;
        const baseCredit = row(base?.credit);
        if (
          base &&
          (base.profile !== 'source-author-credit-support-v1' ||
            base.support !== binding.baseSupport ||
            base.state !== 'recorded' ||
            base.baseSupport !== null ||
            base.work !== candidate.work ||
            baseCredit?.work !== candidate.work ||
            baseCredit.sourceKey !== candidate.sourceKey ||
            baseCredit.sourceRoleKey !== candidate.sourceRoleKey ||
            baseCredit.nativeOrdinal !== binding.nativeOrdinal ||
            baseCredit.role !== candidate.nativeRole)
        )
          throw new Error('Credit base support differs from the exact native participation');
        const body: DatasetCreditAdoptionRequest = {
          profile: 'source-author-credit-adoption-v1',
          proposal: binding.proposal,
          conversion: binding.conversion,
          occurrence: sourceChildOccurrence(binding.observation, 'authors', binding.sourceOrdinal),
          sourceOrdinal: binding.sourceOrdinal,
          nativeOrdinal: binding.nativeOrdinal,
          confirmedSourceKey: candidate.sourceKey,
          confirmedRoleKey: candidate.sourceRoleKey,
          expectedHead: binding.expectedHead,
          actingSubject: context.actingSubject,
          baseSupport: binding.baseSupport,
          correspondence: binding.correspondence,
          confirmedUse: 'factual-reference-only',
        };
        const result = await context.command(
          datasetCreditCommandLabel(candidate, body),
          'POST',
          `/v1/works/${short(candidate.work)}/source-author-credits`,
          body,
        );
        const support = row(result.support),
          credit = row(support?.credit);
        const subject = candidate.participations.find(
          (part) => part.role === 'credited',
        )!.sourceIdentity;
        if (
          support?.profile !== 'source-author-credit-support-v1' ||
          support.state !== 'recorded' ||
          !nativeId(support.support) ||
          support.work !== candidate.work ||
          support.proposal !== binding.proposal ||
          support.conversion !== binding.conversion ||
          support.observation !== binding.observation ||
          support.record !== intake.record ||
          support.sourceOccurrence !== body.occurrence ||
          support.sourceOrdinal !== binding.sourceOrdinal ||
          support.sourceKey !== body.confirmedSourceKey ||
          support.sourceRoleKey !== body.confirmedRoleKey ||
          support.baseSupport !== binding.baseSupport ||
          support.correspondence !== binding.correspondence ||
          support.rightsStatus !== 'undetermined' ||
          support.sourceGraphReceipt !== proposal.graphReceipt ||
          typeof support.nativeReceipt !== 'string' ||
          !/^urn:rezics:receipt:[0-9a-f]{64}$/.test(support.nativeReceipt) ||
          support.withdrawal !== null ||
          support.headGuarantee !==
            (binding.baseSupport ? 'verified-before-commit' : 'transaction-guarded') ||
          credit?.profile !== 'work-author-credit-v1' ||
          !nativeId(credit.credit) ||
          !nativeId(credit.revision) ||
          credit.work !== candidate.work ||
          credit.expectedHead !== (baseCredit?.expectedHead ?? binding.expectedHead) ||
          credit.actingSubject !== (baseCredit?.actingSubject ?? context.actingSubject) ||
          credit.role !== candidate.nativeRole ||
          credit.sourceKey !== candidate.sourceKey ||
          credit.sourceRoleKey !== candidate.sourceRoleKey ||
          credit.nativeOrdinal !== binding.nativeOrdinal ||
          credit.participantKind !== 'external-reference' ||
          credit.provider !== subject.provider ||
          credit.namespace !== subject.namespace ||
          credit.control !== 'human-confirmed' ||
          credit.rightsStatus !== 'undetermined' ||
          typeof credit.dataEpoch !== 'string' ||
          !credit.dataEpoch ||
          typeof credit.sequence !== 'string' ||
          !/^\d+$/.test(credit.sequence) ||
          (base &&
            (canonical(credit) !== canonical(base.credit) ||
              support.nativeReceipt !== base.nativeReceipt))
        )
          throw new Error(
            'Credit adoption did not acknowledge the exact source-qualified native participation',
          );
        for (const key of candidate.nativeCoverage)
          context.disposition(key, {
            status: 'mapped',
            reason: 'acknowledged-source-credit-role; other participation metadata remains pending',
            mapping: {
              target: credit.credit,
              readPath: `/v1/works/${short(candidate.work)}/credits`,
              // Replay is transport state, not another independent support.
              receipt: { support },
            },
          });
      }
    },
  };
}
