import { readAuthorCredit } from '../work/author-credit.ts';
import {
  readExactDefinition,
  readCurrentOccurrence,
  readDefinitionByKey,
  type ExactDefinition,
} from './change.ts';
import { relationSubjectWork } from './work-authority.ts';
import { renderRelation, type RelationBinding, type RelationRendering } from '../lexicon/render.ts';
import { selectedProjection, type RelationProjection } from '../lexicon/render.ts';
import {
  SemanticChangeRejected,
  SemanticTargetUnavailable,
  StaleSemanticHead,
} from '../semantic/command.ts';
import { checkedNativeIri } from '../semantic/schema.ts';
import type { ReferenceCheck } from '../semantic/read.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { RevisionCorrupt } from '../work/history.ts';
import type { ResourceSummary } from '../media/summary.ts';
import { discloseInventory, DISCLOSURE_COST } from '../disclosure/read.ts';
import { currentDisclosureViewer } from '../disclosure/viewer.ts';

export const RELATION_PAGE_COST = {
  pageLimit: 32,
  scanLimit: 100,
  maxScans: 8,
  summaryReferences: 64,
  graphCalls: 512,
  graphBytes: 8 * 1024 * 1024,
  deadlineMs: 10_000,
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
  rendering: RelationRendering | null;
  counterparts: ResourceSummary[];
}
interface Candidate {
  key: string;
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
  readingPosition?: string;
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
): Promise<Candidate[]> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT DISTINCT ?relation ?kind ?key WHERE {
      { GRAPH ${iri(GRAPHS.current)} { ?relation a rv:RelationOccurrence ; rv:occurrenceHead ?head }
        GRAPH ${iri(GRAPHS.revisions)} { ?head rv:lifecycle rv:Active ; rv:participation ?part .
          ?part rv:participant ${iri(resource)} }
        BIND("occurrence" AS ?kind) }
      UNION { GRAPH ${iri(GRAPHS.current)} {
        ?relation a rv:AuthorCredit ; rv:work ${iri(resource)} ; rv:creditRevision ?creditHead .
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
      } BIND("collection" AS ?kind) }
      BIND(CONCAT(?kind, ":", STR(?relation)) AS ?key)
      ${after ? `FILTER(?key > ${lit(after)})` : ''}
    } ORDER BY ?key LIMIT ${RELATION_PAGE_COST.scanLimit}`);
  return (result.results?.bindings ?? []).map((row) => ({
    relation: row.relation!.value,
    kind: row.kind!.value as Candidate['kind'],
    key: row.key!.value,
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
  canReadOccurrence: ReferenceCheck,
  definition: (key: string, legacy: boolean) => Promise<ExactDefinition | null>,
  publicOccurrences?: ReadonlyMap<string,ReadonlySet<string>>,
): Promise<Resolved | null> {
  const base = {
    relation: candidate.relation,
    kind: candidate.kind === 'author-credit' ? ('occurrence' as const) : candidate.kind,
    revision: null,
    evidence: null,
  };
  if (candidate.kind === 'collection') {
    if (!(await canRead(candidate.relation))) return null;
    return { entry: base, references: [candidate.relation] };
  }
  if (candidate.kind === 'author-credit') {
    if (!(await canRead(resource))) return null;
    const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?revision WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(candidate.relation)} rv:creditRevision ?revision } } LIMIT 2`);
    const rows = result.results?.bindings ?? [];
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
    for (const ref of refs) if (!(await canRead(ref))) return null;
    const own = current.state.participations.find(
      (item) => item.participant.kind === 'resource' && item.participant.ref === resource,
    );
    if (!own) return null;
    return {
      entry: { ...base, revision: current.head, evidence: current.state.evidence ?? null },
      references: [...new Set(refs.filter((ref) => ref !== resource))],
      meaning,
      viewingRole: meaning.roleKeys[own.role]!,
      bindings: current.state.participations.map((item) => ({
        role: meaning.roleKeys[item.role]!,
        participant: item.participant,
        ...(item.position === undefined ? {} : { position: item.position }),
        ...(item.creditedName ? { creditedName: item.creditedName } : {}),
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
 * A cursor exists only after finding a later visible row. Summary references fit one owner batch.
 * Position is rechecked after resolution so concurrent updates yield a stale page, never mixed state. */
export async function readResourceRelations(
  env: WorkActivationEnvironment,
  input: {
    resource: string;
    languages: readonly string[];
    limit: number;
    after?: string;
    canRead: ReferenceCheck;
    canReadOccurrence: ReferenceCheck;
    publicOccurrences?: (occurrences: readonly string[]) => Promise<ReadonlyMap<string,ReadonlySet<string>>>;
    canReadDraftPresentations?: ReferenceCheck;
    summarize: (references: string[]) => Promise<ResourceSummary[]>;
    visibleRecords?: (records: readonly string[]) => Promise<ReadonlySet<string>>;
    readingPosition?: string;
  },
) {
  checkedNativeIri(input.resource);
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
  const snapshot = await position(env);
  let cursor: Cursor | undefined;
  if (input.after) {
    try {
      cursor = JSON.parse(Buffer.from(input.after, 'base64url').toString()) as Cursor;
      if (
        !cursor ||
        cursor.resource !== input.resource ||
        cursor.readingPosition !== input.readingPosition ||
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
  const cache = new Map<string, Promise<ExactDefinition | null>>();
  const definition = (key: string, legacy: boolean) => {
    const id = `${legacy}:${key}`;
    if (!cache.has(id))
      cache.set(
        id,
        legacy
          ? readDefinitionByKey(env, key, input.canRead)
          : readExactDefinition(env, key, input.canRead),
      );
    return cache.get(id)!;
  };
  const selected: { candidate: Candidate; resolved: Resolved }[] = [];
  const publiclyDisclosed = new Set<string>();
  const references = new Set<string>([input.resource]);
  let after = cursor?.after,
    hasNext = false,
    exhausted = false;
  for (let scan = 0; scan < RELATION_PAGE_COST.maxScans; scan++) {
    const candidates = await relationCandidates(env, input.resource, after);
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
        if (decisions[index] !== 'visible') continue;
        const resolved = await resolveCandidate(
          env,
          candidate,
          input.resource,
          input.canRead,
          input.canReadOccurrence,
          definition,
          publicOccurrences,
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
  if (!hasNext && !exhausted) throw new RevisionCorrupt('relation page scan budget exceeded');
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
  for (const { resolved } of selected) {
    let rendering: RelationRendering | null = null;
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
      rendering,
      counterparts: resolved.references.map((ref) =>
        summaries.find((summary) => summary.reference === ref)!,
      ),
    });
  }
  for (const ref of new Set([
    input.resource,
    ...references,
    ...selected.flatMap(({ resolved }) => (resolved.meaning ? [resolved.meaning.definition] : [])),
  ])) {
    if (!(await input.canRead(ref))) throw new StaleSemanticHead('relation availability changed');
  }
  if (input.publicOccurrences) {
    const occurrences = selected.filter(item => publiclyDisclosed.has(item.candidate.relation)).map(item => item.candidate.relation);
    const publicOccurrences = await input.publicOccurrences(occurrences);
    for (const occurrence of occurrences) if (!publicOccurrences.get(occurrence)?.has(
      selected.find(item => item.candidate.relation === occurrence)!.resolved.entry.evidence!)
      && !await input.canReadOccurrence(occurrence)) throw new StaleSemanticHead('relation availability changed');
  }
  const end = await position(env);
  if (end.epoch !== snapshot.epoch || end.sequence !== snapshot.sequence)
    throw new StaleSemanticHead('relation page changed');
  return {
    profile: 'resource-relations-v1' as const,
    resource: input.resource,
    items,
    next: hasNext
      ? Buffer.from(
          JSON.stringify({
            resource: input.resource,
            ...snapshot,
            after: selected.at(-1)!.candidate.key,
            readingPosition: input.readingPosition,
          }),
        ).toString('base64url')
      : null,
    sourcePosition: {
      datasetId: 'product',
      dataEpoch: snapshot.epoch,
      sequence: snapshot.sequence,
    },
  };
}
