import { GRAPHS, iri } from '../work/activate.ts';
import { fenceWorkBasis, readWorkBasis } from '../work/read-header.ts';
import { WorkReadLimit, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

const revisionPrefix = 'urn:rezics:content:revision:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function bounded<T extends { content: string }>(page: T): T {
  if (Buffer.byteLength(page.content) > 65_536 || Buffer.byteLength(JSON.stringify(page)) > 1_048_576) {
    throw new WorkReadLimit('Published Hub page exceeds its byte budget');
  }
  return page;
}

/** Current public publication and up to ten graph-proven published versions. */
export async function readHubWorkPage(session: WorkReadSession, work: string) {
  const basis = await readWorkBasis(session, work);
  const store = session.deps.hub;
  if (!store) throw new WorkReadUnavailable('Hub owner is unavailable');
  const rows = await session.query(`SELECT ?variant ?revision ?digest ?kind WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a ?kind .
      VALUES ?kind { rv:PromptTemplate rv:SkillPackage }
      ?variant a rv:ContentVariant ; rv:resource ${iri(work)} ;
        rv:contentPublicationHead ?publication ; rv:publicSearchEligibilityHead ?eligibility . }
    GRAPH ${iri(GRAPHS.revisions)} { ?publication a rv:ContentPublicationDecision ;
      rv:component ?variant ; rv:resource ${iri(work)} ; rv:contentRevision ?revision ;
      rv:byteDigest ?digest .
      ?eligibility a rv:ContentSearchEligibilityDecision ; rv:variant ?variant ;
        rv:resource ${iri(work)} ; rv:publicationDecision ?publication ; rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
  } LIMIT 2`, 2);
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0]?.variant || !rows[0]?.revision || !rows[0]?.kind
    || !rows[0]?.digest) {
    throw new WorkReadUnavailable('Hub Work publication is ambiguous');
  }
  const row = rows[0]!;
  const revision = row.revision!.value.slice(revisionPrefix.length);
  if (!row.revision!.value.startsWith(revisionPrefix) || !uuid.test(revision)) {
    throw new WorkReadUnavailable('Hub revision identity is invalid');
  }
  const exact = (await session.deps.content?.readExactBatch([revision], async ids => new Set(ids)))?.[0];
  if (exact?.status !== 'available' || exact.reference.resourceId !== work
    || exact.reference.variantId !== row.variant!.value
    || exact.reference.byteDigest !== row.digest!.value) {
    throw new WorkReadUnavailable('Published Hub bytes differ from the graph');
  }
  const kind = row.kind!.value.endsWith('PromptTemplate') ? 'prompt'
    : row.kind!.value.endsWith('SkillPackage') ? 'skill' : null;
  if (!kind) throw new WorkReadUnavailable('Hub Work type is unavailable');
  if (exact.reference.model !== (kind === 'prompt' ? 'rezics-prompt-v1' : 'rezics-skill-package-v1')) {
    throw new WorkReadUnavailable('Published Hub model differs from the Work type');
  }
  const resource = kind === 'prompt' ? await store.promptResource(revision)
    : await store.skillResource(revision);
  if (resource !== work) throw new WorkReadUnavailable('Hub revision belongs to another Work');
  const current = kind === 'prompt' ? await store.readPrompt(revision)
    : await store.readSkillRevision(revision);
  if (!current || current.variant !== row.variant!.value) {
    throw new WorkReadUnavailable('Published Hub revision is unavailable');
  }
  const historyRows = await session.query(`SELECT ?revision ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ?decision a rv:ContentPublicationDecision ;
      rv:component ${iri(row.variant!.value)} ; rv:resource ${iri(work)} ;
      rv:contentRevision ?revision ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
  } ORDER BY DESC(?sequence) LIMIT 11`, 11);
  const history = historyRows.slice(0, 10).map(entry => entry.revision?.value ?? '')
    .filter(value => value.startsWith(revisionPrefix)).map(value => value.slice(revisionPrefix.length))
    .filter(value => uuid.test(value));
  const dates = await store.revisionDates(history);
  const versions = history.map(id => ({ revision: id, createdAt: dates.get(id) ?? null }));
  await fenceWorkBasis(session, basis);
  if (kind === 'prompt') {
    if (!('content' in current)) throw new WorkReadUnavailable('Prompt revision has the wrong kind');
    if (!('content' in exact.body) || exact.body.content !== current.content) {
      throw new WorkReadUnavailable('Prompt subtype text differs from published Content');
    }
    return bounded({ profile: 'hub-work-page-v1' as const, kind, revision,
      content: current.content, parameterSchema: current.parameterSchema,
      examples: current.examples, declaredModels: current.applicability.models,
      testedModels: [] as string[], versions, moreVersions: historyRows.length > 10,
      createdAt: current.createdAt });
  }
  if (!('files' in current)) throw new WorkReadUnavailable('Skill revision has the wrong kind');
  const manifest = current.files.find(file => file.path === 'SKILL.md');
  if (!manifest) throw new WorkReadUnavailable('Published Skill lacks SKILL.md');
  const content = Buffer.from(manifest.bytesBase64, 'base64').toString('utf8');
  return bounded({ profile: 'hub-work-page-v1' as const, kind, revision, content,
    parameterSchema: {} as Record<string, unknown>, examples: [] as Array<{ parameters: Record<string, unknown>;
      output: string }>, declaredModels: [] as string[], testedModels: [] as string[], versions,
    moreVersions: historyRows.length > 10, createdAt: current.createdAt });
}
