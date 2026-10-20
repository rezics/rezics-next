import { sourceChildOccurrence } from '../../../services/main/src/modules/source/child-correspondence.ts';
import { DatasetApiError } from '../auth.ts';
import { canonical, sha256 } from '../store.ts';
import type {
  DatasetCoverageKey,
  DatasetMappingContext,
  DatasetMappingReceipt,
  DatasetRecord,
  DatasetSourceReference,
} from '../types.ts';

type Row = Record<string, unknown>;
export const associationObject = (value: unknown): Row | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;
export const nativeAssociationId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  );
const nativeReceiptId = (value: unknown): value is string =>
  typeof value === 'string' && /^urn:rezics:receipt:[0-9a-f]{64}$/.test(value);
const pointerToken = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');

export interface DatasetAssociationParticipant {
  /** Source role, not an invented native role IRI. */
  role: string;
  sourceKey: string;
  target: string | null;
}

export interface DatasetAssociationCandidate {
  /** Evidence identity only. Native occurrences/participations are allocated by their owner. */
  key: string;
  coverage: DatasetCoverageKey;
  source: DatasetSourceReference;
  valueDigest: string;
  value: unknown;
  kind: string;
  participants: DatasetAssociationParticipant[];
  /** All source columns, including false, zero, scores, lie and unrecognised qualifiers. */
  qualifiers: Row;
  native: {
    owner: 'relation' | 'statement' | 'structure' | 'work-native-child';
    operation: string;
    grain: string;
    /** No label, source role code or moving definition head supplies an exact DefinitionRef. */
    missing: string[];
  };
}

export function associationParticipant(
  context: DatasetMappingContext,
  role: string,
  sourceKey: string,
): DatasetAssociationParticipant {
  const target = context.native.get(sourceKey)?.id;
  return { role, sourceKey, target: nativeAssociationId(target) ? target : null };
}

export function associationCandidate(
  context: DatasetMappingContext,
  coverage: DatasetCoverageKey,
  value: unknown,
  input: Pick<DatasetAssociationCandidate, 'kind' | 'participants' | 'native'>,
  qualifiers = associationObject(value) ?? {},
): DatasetAssociationCandidate {
  const source = context.source(coverage.record),
    valueDigest = sha256(canonical(value));
  return structuredClone({
    key: sha256(
      canonical([
        source.provider,
        source.namespace,
        source.externalId,
        source.snapshotDigest,
        source.recordDigest,
        coverage.kind,
        coverage.path,
        valueDigest,
      ]),
    ),
    coverage,
    source,
    valueDigest,
    value,
    ...input,
    qualifiers,
  });
}

/** Every owned nonempty column remains pending unless that exact column has a support receipt.
 * In particular, adopting a tag name cannot adopt its count, score, ID or qualifiers. */
export function disposeAssociation(
  context: DatasetMappingContext,
  candidate: DatasetAssociationCandidate,
  mapped: ReadonlyMap<string, DatasetMappingReceipt> = new Map(),
): void {
  const walk = (path: string, value: unknown) => {
    const receipt = mapped.get(path);
    const empty =
      value === null ||
      value === '' ||
      (Array.isArray(value) && !value.length) ||
      (associationObject(value) !== null && !Object.keys(value as Row).length);
    context.disposition(
      { ...candidate.coverage, path },
      receipt
        ? { status: 'mapped', reason: 'acknowledged-source-native-child-support', mapping: receipt }
        : empty
          ? { status: 'absent', reason: 'source-empty-association-value' }
          : { status: 'unmapped', reason: candidate.native.missing.join('; ') },
    );
    if (candidate.coverage.kind === 'field' && value !== null && typeof value === 'object')
      for (const [name, child] of Object.entries(value))
        walk(`${path}/${pointerToken(name)}`, child);
  };
  walk(candidate.coverage.path, candidate.value);
}

export const CLASSIFICATION_EDGE_KINDS = new Set([
  'tag-vote',
  'tag',
  'meta-tag',
  'trait',
  'trait-group',
]);

export function datasetClassificationCandidates(
  context: DatasetMappingContext,
): DatasetAssociationCandidate[] {
  const candidates: DatasetAssociationCandidate[] = [];
  context.snapshot.sources.forEach((source, sourceIndex) =>
    source.edges.forEach((edge, index) => {
      if (!context.selected.has(edge.from) || !CLASSIFICATION_EDGE_KINDS.has(edge.kind)) return;
      candidates.push(
        associationCandidate(
          context,
          { record: edge.from, kind: 'edge', path: `/sources/${sourceIndex}/edges/${index}` },
          edge,
          {
            kind: edge.kind,
            participants: [
              associationParticipant(context, 'subject', edge.from),
              associationParticipant(context, 'concept', edge.to),
            ],
            native: {
              owner: 'statement',
              operation: '/v1/statements',
              grain: 'classification-association',
              missing: [
                'source classification conversion/adoption/support adapter',
                'exact classification and interpretation DefinitionRefs for source score/spoiler/lie/applicability',
              ],
            },
          },
          edge.data,
        ),
      );
    }),
  );
  for (const record of context.records.values()) {
    if (!context.selected.has(record.key)) continue;
    const rows: Array<[Row, string]> = [[record.data, '/data']];
    const api = associationObject(record.data.api_subject);
    if (api) rows.push([api, '/data/api_subject']);
    for (const [row, base] of rows) {
      const names =
        record.provider === 'bangumi'
          ? ['tags', 'meta_tags']
          : record.provider === 'musicbrainz'
            ? ['tags', 'genres']
            : [];
      const tables = associationObject(row.tables);
      if (record.provider === 'vndb' && tables) {
        for (const table of ['tags_vn', 'chars_traits', 'tags_parents', 'traits_parents']) {
          if (!Object.hasOwn(tables, table)) continue;
          addList(record, tables[table], `${base}/tables/${table}`, table, false);
        }
      }
      for (const name of names)
        if (Object.hasOwn(row, name))
          addList(
            record,
            row[name],
            `${base}/${name}`,
            name,
            record.provider === 'bangumi' && record.kind === 'subject' && name === 'tags',
          );
    }
  }
  return candidates;

  function addList(
    record: DatasetRecord,
    value: unknown,
    path: string,
    kind: string,
    tagNames: boolean,
  ) {
    const values = Array.isArray(value) && value.length ? value : [value];
    values.forEach((item, ordinal) => {
      const at = Array.isArray(value) && value.length ? `${path}/${ordinal}` : path;
      const row = associationObject(item);
      const conceptId = row?.tid ?? row?.tag ?? row?.parent;
      const concept =
        record.provider === 'vndb' && typeof conceptId === 'string'
          ? `vndb:${kind.startsWith('traits') || kind === 'chars_traits' ? 'trait' : 'tag'}:${conceptId}`
          : record.provider === 'bangumi' &&
              (typeof item === 'string' || typeof row?.name === 'string')
            ? `bangumi:tag:${sha256(typeof item === 'string' ? item : (row!.name as string))}`
            : null;
      candidates.push(
        associationCandidate(
          context,
          { record: record.key, kind: 'field', path: at },
          item,
          {
            kind,
            participants: [
              associationParticipant(context, 'subject', record.key),
              ...(concept ? [associationParticipant(context, 'concept', concept)] : []),
            ],
            native: {
              owner: tagNames ? 'work-native-child' : 'statement',
              operation: tagNames ? '/v1/works/{id}/source-children' : '/v1/statements',
              grain: tagNames ? 'tag-name-occurrence' : 'classification-association',
              missing: tagNames
                ? [
                    'source-native-work-adoption-v1 binding and exact retained bangumi-subject-map-v1 observation',
                    'classification support adapter for tag IDs/counts and other source qualifiers',
                  ]
                : [
                    'source classification conversion/adoption/support adapter',
                    'exact classification and interpretation DefinitionRefs for source score/spoiler/lie/applicability',
                  ],
            },
          },
          row ?? { value: item },
        ),
      );
    });
  }
}

/** Consume an existing Source binding. This never creates or replaces the importer's Work. */
export async function mapDatasetClassifications(context: DatasetMappingContext): Promise<void> {
  const candidates = datasetClassificationCandidates(context);
  const bases = new Map<string, Promise<TagBasis | null>>();
  const receipts = new Map<string, Promise<Record<string, unknown>>>();
  const children = new Map<string, string>();
  for (const candidate of candidates) {
    let mappings: ReadonlyMap<string, DatasetMappingReceipt> = new Map();
    const row = associationObject(candidate.value),
      record = context.records.get(candidate.coverage.record)!;
    try {
      if (
        candidate.native.owner === 'work-native-child' &&
        row &&
        typeof row.name === 'string' &&
        /\/tags\/[0-9]+$/.test(candidate.coverage.path)
      ) {
        if (!bases.has(record.key)) bases.set(record.key, tagBasis(context, record));
        const basis = await bases.get(record.key)!;
        if (basis) mappings = await adoptTagName(context, candidate, basis, receipts);
      }
      for (const mapping of mappings.values()) {
        const support = associationObject(mapping.receipt.support)!;
        const prior = children.get(mapping.target);
        if (prior && prior !== support.sourceOccurrence)
          throw new Error('Distinct source tag occurrences returned the same native child');
        children.set(mapping.target, support.sourceOccurrence as string);
      }
    } catch (error) {
      const reason = `source-tag-mapping-refused: ${error instanceof Error ? error.message : String(error)}`;
      try {
        disposeAssociation(context, {
          ...candidate,
          native: { ...candidate.native, missing: [reason] },
        });
      } catch (dispositionError) {
        // Coverage owns historical/independent mappings. Never erase one to make
        // a current refusal fit; the caller must retain both through that owner.
        throw new AggregateError(
          [error, dispositionError],
          `${reason}; current-refusal-disposition-rejected: coverage must retain history and current refusal separately`,
        );
      }
      throw error;
    }
    disposeAssociation(context, candidate, mappings);
  }
}

interface TagBasis {
  support: Row;
  conversion: Row;
  raw: Row;
  expectedHead: string;
}

async function readTagOwner(context: DatasetMappingContext, path: string): Promise<Row> {
  try {
    return await context.read(path);
  } catch (error) {
    throw new Error(
      `source-tag-owner-read-refused: GET ${path}; ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function tagBasis(
  context: DatasetMappingContext,
  record: DatasetRecord,
): Promise<TagBasis | null> {
  const native = context.native.get(record.key);
  if (
    !native ||
    native.kind !== 'work' ||
    !nativeAssociationId(native.id) ||
    native.receipt.profile !== 'source-native-work-adoption-v1' ||
    native.receipt.state !== 'adopted' ||
    native.receipt.work !== native.id ||
    !nativeReceiptId(native.receipt.receipt) ||
    !nativeAssociationId(native.receipt.binding) ||
    !nativeAssociationId(native.receipt.workRevision)
  )
    return null;
  const support = await readTagOwner(context, `/v1/works/${native.id.slice(-36)}/source-support`);
  if (support.state === 'withdrawn')
    throw new Error(`source-tag-work-binding-withdrawn: ${String(support.binding)}`);
  if (
    support.profile !== 'native-work-source-support-v1' ||
    support.state !== 'recorded' ||
    support.work !== native.id ||
    support.binding !== native.receipt.binding ||
    support.sourceRecord !== native.receipt.sourceRecord ||
    support.sourceConversion !== native.receipt.sourceConversion ||
    support.sourceProposal !== native.receipt.proposal ||
    support.adoptionReceipt !== native.receipt.receipt ||
    support.adoptedAtRevision !== native.receipt.workRevision ||
    ![
      support.currentHead,
      support.sourceObservation,
      support.sourceConversion,
      support.sourceProposal,
      support.sourceRecord,
    ].every(nativeAssociationId)
  )
    throw new Error(
      'source-tag-work-binding-stale-or-mismatched: Source tag binding differs from the native adoption',
    );
  const intake = context
    .source(record.key)
    .intakes.find((item) => item.observation === support.sourceObservation);
  if (!intake || intake.record !== support.sourceRecord) return null;
  const observation = await readTagOwner(
    context,
    `/v1/sources/observations/${(support.sourceObservation as string).slice(-36)}`,
  );
  const bytes =
    typeof observation.rawBytesBase64 === 'string'
      ? Buffer.from(observation.rawBytesBase64, 'base64')
      : null;
  const coverage = associationObject(observation.coverage);
  if (
    !bytes ||
    observation.observation !== support.sourceObservation ||
    observation.record !== intake.record ||
    observation.provider !== record.provider ||
    observation.namespace !== record.kind ||
    observation.externalId !== record.externalId ||
    observation.retention !== 'retained' ||
    observation.byteDigest !== intake.byteDigest ||
    sha256(bytes) !== intake.byteDigest ||
    coverage?.scope !== 'bangumi-subject-response-v1' ||
    coverage.complete !== true ||
    !Array.isArray(coverage.omittedFields) ||
    coverage.omittedFields.length
  )
    return null;
  let raw: Row | null;
  try {
    raw = associationObject(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
  if (!raw || String(raw.id) !== record.externalId || !Array.isArray(raw.tags)) return null;
  const conversion = await readTagOwner(
    context,
    `/v1/sources/conversions/${(support.sourceConversion as string).slice(-36)}`,
  );
  if (
    conversion.profile !== 'source-mapped-conversion-v1' ||
    conversion.state !== 'staged' ||
    conversion.conversion !== support.sourceConversion ||
    conversion.mappingRevision !== 'bangumi-subject-map-v1' ||
    conversion.observation !== support.sourceObservation ||
    conversion.sourceDigest !== intake.byteDigest
  )
    throw new Error(
      'source-tag-conversion-mismatched: Source tag conversion differs from the retained observation',
    );
  return { support, conversion, raw, expectedHead: native.receipt.workRevision };
}

async function adoptTagName(
  context: DatasetMappingContext,
  candidate: DatasetAssociationCandidate,
  basis: TagBasis,
  receipts: Map<string, Promise<Record<string, unknown>>>,
): Promise<ReadonlyMap<string, DatasetMappingReceipt>> {
  const ordinal = Number(candidate.coverage.path.split('/').at(-1)),
    row = associationObject(candidate.value)!;
  if (ordinal > 127 || canonical((basis.raw.tags as unknown[])[ordinal] ?? null) !== canonical(row))
    return new Map();
  // A name child has no spoiler/lie/applicability envelope. Do not detach a qualified
  // name from its source association even when the backend accepts its bare label.
  if (Object.keys(row).some((key) => !['name', 'count', 'total_count', 'id'].includes(key)))
    return new Map();
  const projection = associationObject(basis.conversion.projection);
  const declaration = Array.isArray(projection?.children)
    ? projection.children
        .map(associationObject)
        .find(
          (child) =>
            child?.field === 'tags' &&
            child.grain === 'subject' &&
            child.slot === 'work-native-child-v1#tags',
        )
    : null;
  const projected = Array.isArray(declaration?.values)
    ? associationObject(declaration.values[ordinal])
    : null;
  if (
    !projected ||
    projected.pointer !== `/tags/${ordinal}/name` ||
    projected.sourceKey !== row.name ||
    projected.value !== row.name ||
    projected.roleKey !== null
  )
    return new Map();
  const support = basis.support;
  const occurrence = sourceChildOccurrence(support.sourceObservation as string, 'tags', ordinal);
  const body = {
    profile: 'source-native-child-adoption-v1',
    field: 'tags',
    proposal: support.sourceProposal,
    conversion: support.sourceConversion,
    occurrence,
    sourceOrdinal: ordinal,
    confirmedSourceKey: row.name,
    nativeOrdinal: ordinal,
    expectedHead: basis.expectedHead,
    actingSubject: context.actingSubject,
    baseSupport: null,
    correspondence: null,
    confirmedUse: 'factual-reference-only',
  };
  // Duplicate archive/API evidence of one source occurrence uses one intent. Pin
  // the CAS head to the immutable adoption receipt: a later Work edit cannot turn
  // a retry into a second native child. An uncommitted stale intent is refused.
  const label = `tag-name:${sha256(canonical([support.work, support.binding, support.sourceConversion, occurrence]))}`;
  if (!receipts.has(label))
    receipts.set(
      label,
      context.command(
        label,
        'POST',
        `/v1/works/${(support.work as string).slice(-36)}/source-children`,
        body,
      ),
    );
  let receipt: Row;
  try {
    receipt = await receipts.get(label)!;
  } catch (error) {
    const refusal = error instanceof DatasetApiError ? 'refused' : 'unconfirmed';
    const cas =
      error instanceof DatasetApiError &&
      error.status === 409 &&
      error.detail.code === 'native_child_changed'
        ? ' (Work-head/protection/child CAS)'
        : '';
    throw new Error(
      `source-tag-child-command-${refusal}${cas}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const acknowledged = associationObject(receipt.support),
    child = associationObject(acknowledged?.child);
  if (
    !acknowledged ||
    acknowledged.profile !== 'source-native-child-support-v1' ||
    acknowledged.state !== 'recorded' ||
    acknowledged.work !== support.work ||
    acknowledged.record !== support.sourceRecord ||
    acknowledged.observation !== support.sourceObservation ||
    acknowledged.conversion !== support.sourceConversion ||
    acknowledged.proposal !== support.sourceProposal ||
    acknowledged.sourceOccurrence !== occurrence ||
    acknowledged.sourceOrdinal !== ordinal ||
    acknowledged.sourceKey !== row.name ||
    acknowledged.field !== 'tags' ||
    acknowledged.baseSupport !== null ||
    acknowledged.correspondence !== null ||
    !nativeAssociationId(acknowledged.support) ||
    !nativeReceiptId(acknowledged.nativeReceipt) ||
    !child ||
    child.profile !== 'work-native-child-v1' ||
    child.work !== support.work ||
    child.field !== 'tags' ||
    child.sourceKey !== row.name ||
    child.nativeOrdinal !== ordinal ||
    child.state !== 'active' ||
    child.actingSubject !== context.actingSubject ||
    child.retiredBy !== null ||
    child.expectedHead !== basis.expectedHead ||
    typeof child.dataEpoch !== 'string' ||
    !child.dataEpoch ||
    typeof child.sequence !== 'string' ||
    !/^[0-9]+$/.test(child.sequence) ||
    !nativeAssociationId(child.child) ||
    !nativeAssociationId(child.revision)
  )
    throw new Error('Source tag adoption has no exact acknowledged child/support receipt');
  const readPath = `/v1/works/${(support.work as string).slice(-36)}/native-children/${child.child.slice(-36)}/revisions/${child.revision.slice(-36)}?actingSubject=${encodeURIComponent(context.actingSubject)}`;
  // A journaled command is historical evidence. Independent Source withdrawal
  // and human retirement do not invalidate the parent Work's source binding.
  // Read these exact identities afresh, even when command() returns its cache.
  const currentSupport = await readTagOwner(
    context,
    `/v1/sources/native-child-supports/${acknowledged.support.slice(-36)}`,
  );
  const currentChild = await readTagOwner(context, readPath);
  const supportChild = associationObject(currentSupport.child);
  const supportKeys = [
    'profile',
    'support',
    'work',
    'field',
    'proposal',
    'conversion',
    'record',
    'observation',
    'sourceOccurrence',
    'sourceOrdinal',
    'sourceKey',
    'baseSupport',
    'correspondence',
    'nativeReceipt',
  ];
  const childKeys = [
    'profile',
    'work',
    'child',
    'revision',
    'field',
    'sourceKey',
    'nativeOrdinal',
    'expectedHead',
    'actingSubject',
    'dataEpoch',
    'sequence',
  ];
  if (
    !supportKeys.every((key) => currentSupport[key] === acknowledged[key]) ||
    !supportChild ||
    !childKeys.every((key) => currentChild[key] === child[key] && supportChild[key] === child[key])
  )
    throw new Error(
      `source-tag-current-support-or-child-mismatched: ${acknowledged.support}; ${readPath}`,
    );
  if (currentSupport.state === 'withdrawn')
    throw new Error(`source-tag-child-support-withdrawn: ${acknowledged.support}`);
  if (
    currentChild.state === 'retired' ||
    supportChild.state === 'retired' ||
    nativeAssociationId(currentChild.retiredBy) ||
    nativeAssociationId(supportChild.retiredBy)
  )
    throw new Error(`source-tag-native-child-retired: ${child.child}; revision ${child.revision}`);
  if (
    currentSupport.state !== 'recorded' ||
    currentSupport.withdrawal !== null ||
    currentChild.state !== 'active' ||
    supportChild.state !== 'active' ||
    currentChild.retiredBy !== null ||
    supportChild.retiredBy !== null
  )
    throw new Error(
      `source-tag-current-support-or-child-unavailable: ${acknowledged.support}; ${readPath}`,
    );
  return new Map([
    [
      `${candidate.coverage.path}/name`,
      {
        target: child.child,
        readPath,
        receipt,
      },
    ],
  ]);
}
