/** Exact VNDB row orientation for the released native release-replacement relation. */
export const VNDB_RELEASE_SUPERSESSION_BINDING = Object.freeze({
  source: 'vndb',
  sourceSnapshot: 'https://dl.vndb.org/dump/vndb-db-2026-10-25.tar.zst',
  schemaFile: 'schema_vndbid.sql',
  schemaSha256: 'd608ec4022029bdb65a5c780bbf8ca46e3348f16eaa7b88290efde35e2dd4758',
  table: 'releases_supersedes',
  currentReleaseColumn: 'id',
  supersededReleaseColumn: 'rid',
  currentReleaseRole: 'superseding-release',
  supersededReleaseRole: 'superseded-release',
  currentReleaseType: 'wd:Q20631656',
  supersededReleaseType: 'wd:Q20631656',
  property: 'rezics:releaseSupersedes',
  inversePresentation: 'rezics:releaseSupersededBy',
  direction: 'id-supersedes-rid',
} as const);

export type VndbReleaseSupersessionRow = Readonly<{ id: string; rid: string }>;
export type ResolvedReleaseEndpoint = Readonly<{
  id: string;
  type: typeof VNDB_RELEASE_SUPERSESSION_BINDING.currentReleaseType;
  sourceCode: string;
}>;
export type ReleaseSupersessionAdmission = Readonly<{
  subject: string;
  property: typeof VNDB_RELEASE_SUPERSESSION_BINDING.property;
  target: string;
  context: string;
  release: string;
  statement: Readonly<{
    property: Readonly<{ id: typeof VNDB_RELEASE_SUPERSESSION_BINDING.property }>;
    value: Readonly<{ type: 'value'; content: string }>;
    qualifiers: readonly [];
    references: readonly Readonly<{
      parts: readonly Readonly<{
        property: Readonly<{ id: 'schema:url' }>;
        value: Readonly<{ type: 'value'; content: string }>;
      }>[];
    }>[];
  }>;
  source: Readonly<{
    id: typeof VNDB_RELEASE_SUPERSESSION_BINDING.source;
    snapshot: typeof VNDB_RELEASE_SUPERSESSION_BINDING.sourceSnapshot;
    schemaSha256: typeof VNDB_RELEASE_SUPERSESSION_BINDING.schemaSha256;
    table: typeof VNDB_RELEASE_SUPERSESSION_BINDING.table;
    currentRelease: Readonly<{ role: 'superseding-release'; code: string }>;
    supersededRelease: Readonly<{ role: 'superseded-release'; code: string }>;
  }>;
}>;

const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[0-9a-f]{64}$/;
const vndbReleaseCode = /^\d+$/;

/**
 * Bind only already-resolved native Release identities. Provider row codes and the pinned source assertion remain
 * alongside the typed proposal for the Importer; this does not create, accept or adopt a native candidate.
 */
export function bindVndbReleaseSupersession(input: Readonly<{
  row: VndbReleaseSupersessionRow;
  current: ResolvedReleaseEndpoint;
  superseded: ResolvedReleaseEndpoint;
  context: string;
  release: string;
  sourceRecordUrl: string;
}>): ReleaseSupersessionAdmission | undefined {
  const { row, current, superseded } = input;
  if (
    !row ||
    typeof row.id !== 'string' ||
    !vndbReleaseCode.test(row.id) ||
    typeof row.rid !== 'string' ||
    !vndbReleaseCode.test(row.rid) ||
    current.type !== VNDB_RELEASE_SUPERSESSION_BINDING.currentReleaseType ||
    superseded.type !== VNDB_RELEASE_SUPERSESSION_BINDING.supersededReleaseType ||
    current.sourceCode !== row.id ||
    superseded.sourceCode !== row.rid ||
    !subjectId.test(current.id) ||
    !subjectId.test(superseded.id) ||
    current.id === superseded.id ||
    !subjectId.test(input.context) ||
    !digest.test(input.release) ||
    input.sourceRecordUrl !== `https://vndb.org/r${row.id}`
  )
    return;

  const statement = {
    property: { id: VNDB_RELEASE_SUPERSESSION_BINDING.property },
    value: { type: 'value' as const, content: superseded.id },
    qualifiers: [] as const,
    references: [{ parts: [{ property: { id: 'schema:url' as const }, value: { type: 'value' as const, content: input.sourceRecordUrl } }] }],
  };
  return {
    subject: current.id,
    property: VNDB_RELEASE_SUPERSESSION_BINDING.property,
    target: superseded.id,
    context: input.context,
    release: input.release,
    statement,
    source: {
      id: VNDB_RELEASE_SUPERSESSION_BINDING.source,
      snapshot: VNDB_RELEASE_SUPERSESSION_BINDING.sourceSnapshot,
      schemaSha256: VNDB_RELEASE_SUPERSESSION_BINDING.schemaSha256,
      table: VNDB_RELEASE_SUPERSESSION_BINDING.table,
      currentRelease: { role: VNDB_RELEASE_SUPERSESSION_BINDING.currentReleaseRole, code: row.id },
      supersededRelease: { role: VNDB_RELEASE_SUPERSESSION_BINDING.supersededReleaseRole, code: row.rid },
    },
  };
}
