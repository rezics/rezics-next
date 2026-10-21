import { createHash } from 'node:crypto';
import { readAuthorCredit } from '../work/author-credit.ts';
import {
  readExactDefinition,
  readCurrentOccurrence,
  readDefinitionByKey,
  roleIri,
  type ExactDefinition,
} from './change.ts';
import { readCurrentComponent } from '../semantic/change.ts';
import { relationSubjectWork } from './work-authority.ts';
import { readAttributedOccurrence, validateAttributedOccurrence, validateAttributedOccurrenceIdentity } from './v2-read.ts';
import { relationAttributionVerifier } from './attribution.ts';
import { renderRelation, type RelationBinding, type RelationRendering } from '../lexicon/render.ts';
import { selectedProjection, type RelationProjection } from '../lexicon/render.ts';
import {
  SemanticChangeRejected,
  SemanticTargetUnavailable,
  StaleSemanticHead,
} from '../semantic/command.ts';
import { checkedNativeIri } from '../semantic/schema.ts';
import type { ReferenceCheck } from '../semantic/read.ts';
import type { ReferenceDisclosure } from '../target/disclosed-references.ts';
import { DATASET, GRAPHS, RV, iri, lit, PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { RevisionCorrupt } from '../work/history.ts';
import type { ResourceSummary } from '../media/summary.ts';
import { discloseInventory, DISCLOSURE_COST } from '../disclosure/read.ts';
import { currentDisclosureViewer, namePolicyPrincipal } from '../disclosure/viewer.ts';
import { framePattern, matchFromScore, readContinuityMemberships,
  type ContinuityMembershipCursor } from '../projection/frame-read.ts';
import { CONTINUITY_MEMBERSHIP_COST, type Coordinate } from '../projection/dimension.ts';
import { resolveTargets, targetSummaries } from '../target/resolve.ts';
import { readingBoundary } from '../reading-position/boundary.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readCollectionPurpose, renderCollectionIncidence, type CollectionIncidenceRendering,
  type CollectionPurpose } from '../collection/purpose.ts';

/** One Work target, at most eight 64-row membership batches and one summary batch for up to 64 results.
 * Hidden rows use the scan budget but cannot fail the read; a cursor continues even an empty page. */
export const WORK_CONTINUITIES_COST = { pageLimit: CONTINUITY_MEMBERSHIP_COST.rows,
  membershipBatch: CONTINUITY_MEMBERSHIP_COST.batch, membershipScans: CONTINUITY_MEMBERSHIP_COST.scans,
  targetBatches: 1, resultSummaryBatches: 1 } as const;

export async function readWorkContinuities(session: WorkReadSession, work: string,
  options: { limit?: number; cursor?: string } = {}) {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > WORK_CONTINUITIES_COST.pageLimit) {
    throw new WorkReadInvalid('Continuity page limit is invalid');
  }
  const [target] = await resolveTargets(session, [work], 'report');
  if (target!.base !== 'work') throw new WorkReadInvalid('Continuities belong to a Work');
  const boundary = readingBoundary(session);
  const binding = ['work-continuities-v1', work, limit, session.principal, session.options.actingSubject,
    session.displayLanguages, await boundary.binding()];
  const cursor = decodeReadCursor(options.cursor, binding, session.position);
  const after: ContinuityMembershipCursor | null = cursor ? JSON.parse(cursor.after) : null;
  const page = await readContinuityMemberships(session, work, limit, after);
  const summaries = page.continuities.length ? (await targetSummaries(session, page.continuities)).summaries : [];
  await boundary.fence();
  return { profile: 'work-continuities-v1' as const, work,
    items: summaries.flatMap(summary => summary.status === 'available'
      ? [{ key: summary.reference, iri: summary.reference, label: summary.name }] : []),
    nextCursor: page.after ? encodeReadCursor(binding, session.position, JSON.stringify(page.after)) : null,
    sourcePosition: session.position };
}

export const RELATION_PAGE_COST = {
  pageLimit: 32,
  scanLimit: 100,
  maxScans: 8,
  summaryReferences: 64,
  graphCalls: 512,
  graphBytes: 8 * 1024 * 1024,
  deadlineMs: 10_000,
  // A framed scan orders by specificity: its candidate query evaluates coverage for every relation occurrence
  // incident to the resource before `scanLimit` keeps the top rows, so a scan costs what the resource holds, as a
  // framed Statement page does (SUBJECT_STATEMENT_COST.framedOrderingMsPerThousandStatements, profiled for
  // Statements; relations are not profiled separately).
} as const;
export interface RelationPageEntry {
  relation: string;
  kind: 'occurrence' | 'derivation' | 'collection';
  revision: string | null;
  evidence: string | null;
  sourceVersionStatus?: 'exact' | 'unresolved';
  sourceMainVersion?: string | null;
  sourceMainRevision?: string | null;
  targetMainRevision?: string;
  rendering: RelationRendering | CollectionIncidenceRendering | null;
  counterparts: ResourceSummary[];
  frameMatch?: ReturnType<typeof matchFromScore>;
  collectionPurpose?: CollectionPurpose | null;
}
/** Exact authored occurrence meaning and the role held by the viewed resource. */
export interface RelationSelection { definition: string; viewingRole: string }
interface Candidate {
  key: string;
  score?: number;
  relation: string;
  kind: RelationPageEntry['kind'] | 'author-credit';
}
interface Resolved {
  entry: Omit<RelationPageEntry, 'rendering' | 'counterparts'>;
  references: string[];
  meaning?: ExactDefinition;
  bindings?: RelationBinding[];
  viewingRole?: string;
}
interface Cursor {
  resource: string;
  epoch: string;
  sequence: string;
  after: string;
  binding: string;
  score?: number;
}

async function position(env: WorkActivationEnvironment) {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.epoch || !rows[0].sequence)
    throw new RevisionCorrupt('relation lineage is unavailable');
  return { epoch: rows[0].epoch.value, sequence: rows[0].sequence.value };
}

/** Indexed, bidirectional incidence; Collection containment uses selected placements, never another relation. */
export async function relationCandidates(
  env: WorkActivationEnvironment,
  resource: string,
  after?: string,
  frames?: readonly Coordinate[],
  afterScore = 0,
  selection?: RelationSelection,
): Promise<Candidate[]> {
  const coverage = frames ? framePattern(frames, '?relation', GRAPHS.current) : null;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT DISTINCT ?relation ?kind ?key ${coverage ? '?specificity' : ''} WHERE {
      { GRAPH ${iri(GRAPHS.current)} { ?relation a rv:RelationOccurrence ; rv:occurrenceHead ?head }
        GRAPH ${iri(GRAPHS.revisions)} { ?head rv:lifecycle rv:Active ; rv:participation ?part .
          ?part rv:participant ${iri(resource)} .
          ${selection ? `?head rv:relationDefinition ?selectedDefinitionRevision .
          ?selectedDefinitionRevision a rv:DefinitionRevision ; rv:component ${iri(selection.definition)} .
          ?part rv:role ${iri(roleIri(selection.definition, selection.viewingRole))} .` : ''} }
        BIND("occurrence" AS ?kind) }
      ${selection ? '' : `UNION { GRAPH ${iri(GRAPHS.current)} {
        ?relation a rv:AuthorCredit ; rv:work ${iri(resource)} ; rv:creditRevision ?creditHead .
        FILTER NOT EXISTS { ?relation rv:retiredBy ?retirement }
      } BIND("author-credit" AS ?kind) }
      UNION { GRAPH ${iri(GRAPHS.revisions)} {
        { ?relation rv:targetWork ${iri(resource)} } UNION { ?relation rv:sourceWork ${iri(resource)} }
        ?relation a ?type . FILTER(?type IN (rv:WorkDerivation, rv:UnresolvedWorkDerivation, rv:LexiconWorkDerivation))
        FILTER NOT EXISTS { ?later rv:corrects ?relation }
      } BIND("derivation" AS ?kind) }
      UNION { GRAPH ${iri(GRAPHS.current)} {
        ?relation a rv:Collection ; rv:collectionState rv:Active ; rv:structure ?structure .
        FILTER NOT EXISTS { ?relation rv:protectionHead ?protection }
        ?structure rv:selectedGeneration ?generation .
        ?generation rv:generationState rv:Active .
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; schema:item ${iri(resource)} .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
      } BIND("collection" AS ?kind) }`}
      BIND(CONCAT(?kind, ":", STR(?relation)) AS ?key)
      ${coverage ? `${coverage.filter} BIND((${coverage.score}) AS ?specificity)` : ''}
      ${after ? `FILTER(${coverage ? `?specificity < ${afterScore} || ?specificity = ${afterScore} && ` : ''}?key > ${lit(after)})` : ''}
    } ORDER BY ${coverage ? 'DESC(?specificity)' : ''} ?key LIMIT ${RELATION_PAGE_COST.scanLimit}`);
  return (result.results?.bindings ?? []).map((row) => ({
    relation: row.relation!.value,
    kind: row.kind!.value as Candidate['kind'],
    key: row.key!.value,
    ...(coverage ? { score: Number(row.specificity!.value) } : {}),
  }));
}

const legacyKeys = new Map([
  [`${RV}Adaptation`, 'adaptation'],
  [`${RV}NewRecording`, 'new-recording'],
  [`${RV}SoftwareFork`, 'software-fork'],
]);

async function resolveCandidate(
  env: WorkActivationEnvironment,
  candidate: Candidate,
  resource: string,
  canRead: ReferenceCheck,
  disclose: ReferenceDisclosure,
  canReadOccurrence: ReferenceCheck,
  definition: (key: string, legacy: boolean) => Promise<ExactDefinition | null>,
  publicOccurrences?: ReadonlyMap<string,ReadonlySet<string>>,
  session?: WorkReadSession,
  selection?: RelationSelection,
): Promise<Resolved | null> {
  const base = {
    relation: candidate.relation,
    kind: candidate.kind === 'author-credit' ? ('occurrence' as const) : candidate.kind,
    revision: null,
    evidence: null,
  };
  if (candidate.kind === 'collection') {
    if (!(await canRead(candidate.relation))) return null;
    if (!session) throw new WorkReadUnavailable('Collection purpose read session is unavailable');
    const collectionPurpose = await readCollectionPurpose(session, candidate.relation);
    return { entry: { ...base, collectionPurpose }, references: [candidate.relation] };
  }
  if (candidate.kind === 'author-credit') {
    if (!(await canRead(resource))) return null;
    const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?revision WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(candidate.relation)} rv:creditRevision ?revision .
        FILTER NOT EXISTS { ${iri(candidate.relation)} rv:retiredBy ?retirement } } } LIMIT 2`);
    const rows = result.results?.bindings ?? [];
    if (!rows.length) return null;
    if (rows.length !== 1) throw new RevisionCorrupt('author credit head is ambiguous');
    const credit = await readAuthorCredit(env, candidate.relation, rows[0]!.revision!.value);
    const meaning = await definition('credit-author', true);
    if (!credit || credit.work !== resource || !meaning || !(await canRead(meaning.definition)))
      return null;
    return {
      entry: { ...base, revision: credit.revision },
      references: [],
      meaning,
      viewingRole: 'work',
      bindings: [
        { role: 'work', participant: { kind: 'resource', ref: resource } },
        {
          role: 'contributor',
          position: credit.nativeOrdinal,
          participant: {
            kind: 'external',
            provider: credit.provider,
            namespace: credit.namespace,
            key: credit.sourceKey,
          },
        },
      ],
    };
  }
  if (candidate.kind === 'occurrence') {
    const current = await readCurrentOccurrence(env, candidate.relation);
    if (!current || current.state.lifecycle !== 'active') return null;
    const meaning = await definition(current.state.definition, false);
    if (!meaning || !(await canRead(meaning.definition))) return null;
    if (meaning.workSubjectRole) {
      if (!(await canRead(relationSubjectWork(meaning, current.state)))) return null;
    } else if (!(current.state.evidence && publicOccurrences?.get(candidate.relation)?.has(current.state.evidence))
      && !(await canReadOccurrence(candidate.relation))) return null;
    const refs = current.state.participations.flatMap((item) =>
      item.participant.kind === 'resource' ? [item.participant.ref] : [],
    );
    // Withhold the entire occurrence: no hidden counterpart ID, placeholder, count, label, or cursor.
    const readable = await disclose(refs);
    if (refs.some((ref) => !readable.has(ref))) return null;
    const own = current.state.participations.find(
      (item) => item.participant.kind === 'resource' && item.participant.ref === resource
        && (!selection || item.role === roleIri(selection.definition, selection.viewingRole)),
    );
    if (!own || selection && meaning.definition !== selection.definition) return null;
    const attributedNames = new Set(current.state.participations.filter(item => item.creditedName
      && item.attributionSupports?.some(support => support.fields.includes('creditedName'))).map(item => item.iri));
    let attributionCurrent = false;
    if (attributedNames.size && session) {
      const read = async () => {
        const owned = await readAttributedOccurrence(env, candidate.relation, current.head);
        if (owned.manifest !== current.manifest) throw new RevisionCorrupt('occurrence manifest differs from its exact revision');
        validateAttributedOccurrenceIdentity(owned, meaning);
        try {
          return await validateAttributedOccurrence(env, owned, meaning, relationAttributionVerifier(
            session.deps.relationAttribution, session.principal ?? namePolicyPrincipal(session.viewer), session.options.actingSubject));
        } catch (error) {
          if (!(error instanceof PendingActivation || error instanceof SemanticChangeRejected)) throw error;
          return null;
        }
      };
      const attribution = await read();
      session.observeDependency(`inverse-relation-attribution:${candidate.relation}:${current.head}`, attribution, read);
      attributionCurrent = attribution !== null;
    }
    return {
      entry: { ...base, revision: current.head, evidence: current.state.evidence ?? null },
      references: [...new Set(refs.filter((ref) => ref !== resource))],
      meaning,
      viewingRole: meaning.roleKeys[own.role]!,
      bindings: current.state.participations.map((item) => ({
        role: meaning.roleKeys[item.role]!,
        participant: item.participant,
        ...(item.position === undefined ? {} : { position: item.position }),
        // Source names need their current owner; native allocations and names
        // authored without Source support retain their existing authority.
        ...(item.creditedName && (!attributedNames.has(item.iri) || attributionCurrent) ? { creditedName: item.creditedName } : {}),
      })),
    };
  }
  const result = await env.fuseki
    .query(`PREFIX rv: <${RV}> SELECT ?target ?source ?kind ?evidence ?sourceMain
    ?sourceRevision ?targetRevision ?model WHERE { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(candidate.relation)} rv:targetWork ?target ; rv:sourceWork ?source ; rv:derivationKind ?kind ;
      rv:evidence ?evidence ; rv:targetMainRevision ?targetRevision ; rv:modelRevision ?model .
    OPTIONAL { ${iri(candidate.relation)} rv:sourceMainVersion ?sourceMain }
    OPTIONAL { ${iri(candidate.relation)} rv:sourceMainRevision ?sourceRevision }
  } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1) throw new RevisionCorrupt('derivation is ambiguous');
  const row = rows[0]!;
  const target = row.target!.value,
    source = row.source!.value;
  if (!(await canRead(target)) || !(await canRead(source))) return null;
  const legacy = legacyKeys.get(row.kind!.value);
  const meaning = await definition(legacy ?? row.kind!.value, !!legacy);
  if (!meaning || !(await canRead(meaning.definition))) return null;
  const targetRole = meaning.workSubjectRole;
  if (
    !targetRole ||
    !Object.values(meaning.roleKeys).includes('source') ||
    targetRole === 'source'
  ) {
    throw new RevisionCorrupt('derivation definition lacks its source and target roles');
  }
  return {
    entry: {
      ...base,
      evidence: row.evidence!.value,
      targetMainRevision: row.targetRevision!.value,
      sourceMainVersion: row.sourceMain?.value ?? null,
      sourceMainRevision: row.sourceRevision?.value ?? null,
      sourceVersionStatus: row.sourceRevision ? 'exact' : 'unresolved',
    },
    references: [resource === target ? source : target],
    meaning,
    viewingRole: resource === target ? targetRole : 'source',
    bindings: [
      { role: 'source', participant: { kind: 'resource', ref: source } },
      { role: targetRole, participant: { kind: 'resource', ref: target } },
    ],
  };
}

/** Fixed work budget, O(page participants + selected labels); no full catalogue scan.
 * Unselected cursors require a later visible row; selected cursors may also carry an
 * opaque bounded-scan frontier. Summary references fit one owner batch.
 * Position is rechecked after resolution so concurrent updates yield a stale page, never mixed state. */
export async function readResourceRelations(env: WorkActivationEnvironment,
  input: Parameters<typeof readResourceRelationsAtPosition>[1], session?: WorkReadSession) {
  const read = () => readResourceRelationsAtPosition(env, input, session);
  const page = await read();
  // The selected page includes its visible incidence/order and every delivered
  // definition, rendering and counterpart. Re-read that bounded owner result;
  // dataset movement alone is outside its dependency set.
  const token = (value: Awaited<ReturnType<typeof read>>) => [value.items, value.next !== null];
  session?.observeDependency(`relation-page:${JSON.stringify([input.resource, input.languages,
    input.limit, input.after, input.readingPosition, input.frames, input.definition, input.viewingRole])}`, token(page),
  async () => token(await read()));
  return page;
}

async function readResourceRelationsAtPosition(
  env: WorkActivationEnvironment,
  input: {
    resource: string;
    languages: readonly string[];
    limit: number;
    after?: string;
    definition?: string;
    viewingRole?: string;
    canRead: ReferenceCheck;
    /** The caller's reference rule: a participant or role member may be a Concept the semantic reader alone hides. */
    disclose: ReferenceDisclosure;
    canReadOccurrence: ReferenceCheck;
    publicOccurrences?: (occurrences: readonly string[]) => Promise<ReadonlyMap<string,ReadonlySet<string>>>;
    canReadDraftPresentations?: ReferenceCheck;
    summarize: (references: string[]) => Promise<ResourceSummary[]>;
    visibleRecords?: (records: readonly string[]) => Promise<ReadonlySet<string>>;
    readingPosition?: string;
    frames?: readonly Coordinate[];
  },
  session?: WorkReadSession,
) {
  checkedNativeIri(input.resource);
  let selection: RelationSelection | undefined;
  if (input.definition !== undefined || input.viewingRole !== undefined) {
    if (input.definition === undefined || typeof input.viewingRole !== 'string'
      || !/^[a-z][a-z0-9-]{0,31}$/.test(input.viewingRole)) {
      throw new SemanticChangeRejected('invalid', 'relation selection requires a Definition and viewing role');
    }
    checkedNativeIri(input.definition);
    selection = { definition: input.definition, viewingRole: input.viewingRole };
  }
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > RELATION_PAGE_COST.pageLimit
  ) {
    throw new SemanticChangeRejected('invalid', 'relation page limit is invalid');
  }
  if (!(await input.canRead(input.resource)))
    throw new SemanticTargetUnavailable('resource is unavailable');
  if (
    (
      await discloseInventory(
        env,
        [{ owner: 'graph', resource: input.resource, component: 'record' }],
        currentDisclosureViewer(),
        'read',
      )
    )[0] !== 'visible'
  )
    throw new SemanticTargetUnavailable('resource is unavailable');
  if (input.visibleRecords && !(await input.visibleRecords([input.resource])).has(input.resource)) {
    throw new SemanticTargetUnavailable('resource is unavailable');
  }
  const readSelection = async () => {
    if (!selection) return null;
    // Audience admission precedes retained meaning/role diagnostics. Selection
    // grants no access to the Definition, occurrence or any participant.
    if (!await input.canRead(selection.definition)
      || !(await input.disclose([selection.definition])).has(selection.definition)
      || (await discloseInventory(env, [{ owner: 'graph', resource: selection.definition,
        component: 'record' }], currentDisclosureViewer(), 'read'))[0] !== 'visible') {
      throw new SemanticTargetUnavailable('relation Definition is unavailable');
    }
    return readCurrentComponent(env, selection.definition, 'definition');
  };
  const selectedDefinition = await readSelection();
  if (selection) {
    if (!selectedDefinition) throw new SemanticTargetUnavailable('relation Definition is unavailable');
    if (selectedDefinition.state.component !== 'definition' || selectedDefinition.state.kind !== 'relation'
      || !selectedDefinition.state.roles.some(role => role.key === selection.viewingRole)) {
      throw new SemanticChangeRejected('invalid', 'relation selection requires an authored relation role');
    }
    session?.observeDependency(`relation-selection:${selection.definition}`, selectedDefinition.head,
      async () => (await readSelection())?.head);
  }
  const snapshot = session?.fencesSelectedUnits
    ? { epoch: session.position.dataEpoch, sequence: session.position.sequence } : await position(env);
  // Bind the complete effective query without making the returned cursor grow with reader or frame metadata.
  const effectiveQuery = [input.resource, input.limit, input.languages, input.frames, input.readingPosition];
  // Keep the original unselected binding and cursor bytes meaningful for existing clients.
  const binding = createHash('sha256').update(JSON.stringify(selection
    ? [...effectiveQuery, selection, selectedDefinition!.head, 'specificity-key-v1'] : effectiveQuery)).digest('hex');
  let cursor: Cursor | undefined;
  if (input.after) {
    const selectedCursor = selection ? decodeReadCursor(input.after, binding,
      { dataEpoch: snapshot.epoch, sequence: snapshot.sequence }) : null;
    try {
      cursor = JSON.parse(selectedCursor?.after ?? Buffer.from(input.after, 'base64url').toString()) as Cursor;
      if (
        !cursor ||
        cursor.resource !== input.resource ||
        cursor.binding !== binding ||
        input.frames && (!Number.isInteger(cursor.score) || cursor.score! < 0 || cursor.score! > 136) ||
        typeof cursor.after !== 'string' ||
        !/^(occurrence|derivation|collection|author-credit):https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(
          cursor.after,
        )
      )
        throw new Error('invalid');
    } catch {
      throw new SemanticChangeRejected('invalid', 'relation cursor is invalid');
    }
    if (cursor.epoch !== snapshot.epoch || cursor.sequence !== snapshot.sequence)
      throw new StaleSemanticHead('relation page changed');
  }
  // Every occurrence names the page's own resource and often the same Concepts: decide each reference once per page.
  // The closing availability check below asks the caller again, since a read revoked meanwhile must fail the page.
  const decided = new Map<string, boolean>();
  const disclose: ReferenceDisclosure = async (references) => {
    const distinct = [...new Set(references)];
    const unknown = distinct.filter((ref) => !decided.has(ref));
    if (unknown.length) {
      const readable = await input.disclose(unknown);
      for (const ref of unknown) decided.set(ref, readable.has(ref));
    }
    return new Set(distinct.filter((ref) => decided.get(ref)));
  };
  const cache = new Map<string, Promise<ExactDefinition | null>>();
  const definition = (key: string, legacy: boolean) => {
    const id = `${legacy}:${key}`;
    if (!cache.has(id))
      cache.set(
        id,
        legacy
          ? readDefinitionByKey(env, key, disclose, input.canRead)
          : readExactDefinition(env, key, disclose, input.canRead),
      );
    return cache.get(id)!;
  };
  const selected: { candidate: Candidate; resolved: Resolved }[] = [];
  const publiclyDisclosed = new Set<string>();
  const references = new Set<string>([input.resource]);
  let after = cursor?.after,
    afterScore = cursor?.score ?? 0,
    hasNext = false,
    exhausted = false;
  for (let scan = 0; scan < RELATION_PAGE_COST.maxScans; scan++) {
    const candidates = await relationCandidates(env, input.resource, after, input.frames, afterScore, selection);
    for (let offset = 0; offset < candidates.length && !hasNext; offset += DISCLOSURE_COST.batch) {
      const disclosed: { candidate: Candidate; resolved: Resolved }[] = [];
      const batch = candidates.slice(offset, offset + DISCLOSURE_COST.batch);
      const decisions = await discloseInventory(
        env,
        batch.map((candidate) => ({
          owner: 'graph',
          resource: candidate.relation,
          component: 'record',
        })),
        currentDisclosureViewer(),
        'read',
      );
      const publicOccurrences = await input.publicOccurrences?.(batch.filter((candidate,index) =>
        decisions[index] === 'visible' && candidate.kind === 'occurrence').map(candidate => candidate.relation));
      for (const [index, candidate] of batch.entries()) {
        after = candidate.key;
        afterScore = candidate.score ?? 0;
        if (decisions[index] !== 'visible') continue;
        const resolved = await resolveCandidate(
          env,
          candidate,
          input.resource,
          input.canRead,
          disclose,
          input.canReadOccurrence,
          definition,
          publicOccurrences,
          session,
          selection,
        );
        if (resolved) {
          if (resolved.entry.evidence && publicOccurrences?.get(candidate.relation)?.has(resolved.entry.evidence)) {
            publiclyDisclosed.add(candidate.relation);
          }
          disclosed.push({ candidate, resolved });
        }
      }
      const revealed = input.visibleRecords
        ? await input.visibleRecords(disclosed.map((item) => item.candidate.relation))
        : null;
      for (const { candidate, resolved } of disclosed) {
        if (revealed && !revealed.has(candidate.relation)) continue;
        const added = resolved.references.filter((ref) => !references.has(ref));
        if (
          selected.length >= input.limit ||
          references.size + added.length > RELATION_PAGE_COST.summaryReferences
        ) {
          hasNext = true;
          break;
        }
        selected.push({ candidate, resolved });
        added.forEach((ref) => references.add(ref));
      }
    }
    if (hasNext) break;
    if (candidates.length < RELATION_PAGE_COST.scanLimit) {
      exhausted = true;
      break;
    }
  }
  const pending = !hasNext && !exhausted;
  if (pending && !selection) throw new RevisionCorrupt('relation page scan budget exceeded');
  const summaries = references.size ? await input.summarize([...references]) : [];
  // A revoked read during summary resolution invalidates the page instead of exposing a placeholder.
  if (summaries.find((item) => item.reference === input.resource)?.status !== 'available') {
    throw new SemanticTargetUnavailable('resource is unavailable');
  }
  if (
    summaries.length !== references.size ||
    summaries.some((item) => item.status !== 'available')
  ) {
    throw new StaleSemanticHead('relation availability changed');
  }
  const items: RelationPageEntry[] = [];
  const renderings = new Map<string, RelationRendering>();
  for (const { candidate, resolved } of selected) {
    let rendering: RelationRendering | CollectionIncidenceRendering | null = resolved.entry.kind === 'collection'
      ? renderCollectionIncidence(resolved.entry.relation, input.resource, resolved.entry.collectionPurpose ?? null, input.languages)
      : null;
    if (resolved.meaning && resolved.viewingRole && resolved.bindings) {
      const key = `${resolved.meaning.revision}:${resolved.viewingRole}`;
      if (!renderings.has(key))
        renderings.set(
          key,
          await renderRelation(
            env,
            { meaning: resolved.meaning, bindings: [] },
            resolved.viewingRole,
            input.languages,
            input.canRead,
            (await input.canReadDraftPresentations?.(resolved.meaning.definition)) ?? false,
            disclose,
          ),
        );
      const template = renderings.get(key)!;
      // Select labels once per exact meaning/direction; attach each occurrence's own arguments afterwards.
      const projections: RelationProjection[] = template.projections.map((projection) => ({
        ...projection,
        arguments: selectedProjection(
          [],
          projection.fromRole,
          projection.toRole,
          input.languages,
          resolved.bindings!,
        ).arguments,
      }));
      rendering = {
        ...template,
        bindings: resolved.bindings,
        projections,
        occurrence:
          resolved.entry.kind === 'occurrence'
            ? { component: resolved.entry.relation, revision: resolved.entry.revision! }
            : null,
      };
    }
    items.push({
      ...resolved.entry,
      ...(input.frames ? { frameMatch: matchFromScore(candidate.score!) } : {}),
      rendering,
      counterparts: resolved.references.map((ref) =>
        summaries.find((summary) => summary.reference === ref)!,
      ),
    });
  }
  const stillReadable = await input.disclose([input.resource, ...references]);
  for (const ref of [input.resource, ...references]) {
    if (!stillReadable.has(ref)) throw new StaleSemanticHead('relation availability changed');
  }
  for (const definition of new Set(selected.flatMap(({ resolved }) => (resolved.meaning ? [resolved.meaning.definition] : [])))) {
    if (!(await input.canRead(definition))) throw new StaleSemanticHead('relation availability changed');
  }
  if (selection && (await readSelection())?.head !== selectedDefinition!.head) {
    throw new StaleSemanticHead('relation selection changed');
  }
  if (input.publicOccurrences) {
    const occurrences = selected.filter(item => publiclyDisclosed.has(item.candidate.relation)).map(item => item.candidate.relation);
    const publicOccurrences = await input.publicOccurrences(occurrences);
    for (const occurrence of occurrences) if (!publicOccurrences.get(occurrence)?.has(
      selected.find(item => item.candidate.relation === occurrence)!.resolved.entry.evidence!)
      && !await input.canReadOccurrence(occurrence)) throw new StaleSemanticHead('relation availability changed');
  }
  const end = await position(env);
  if (end.epoch !== snapshot.epoch || !session?.fencesSelectedUnits && end.sequence !== snapshot.sequence)
    throw new StaleSemanticHead('relation page changed');
  return {
    profile: 'resource-relations-v1' as const,
    resource: input.resource,
    items,
    next: hasNext || pending
      ? (() => {
          const continuation = JSON.stringify({
            resource: input.resource,
            ...snapshot,
            after: pending ? after! : selected.at(-1)!.candidate.key,
            binding,
            ...(input.frames ? { score: pending ? afterScore : selected.at(-1)!.candidate.score } : {}),
          });
          // A bounded selected scan may end on a withheld row. Use the existing
          // authenticated opaque cursor so its physical frontier discloses no ID.
          return selection ? encodeReadCursor(binding, { dataEpoch: snapshot.epoch, sequence: snapshot.sequence }, continuation)
            : Buffer.from(continuation).toString('base64url');
        })()
      : null,
    sourcePosition: {
      datasetId: 'product',
      dataEpoch: snapshot.epoch,
      sequence: snapshot.sequence,
    },
  };
}
