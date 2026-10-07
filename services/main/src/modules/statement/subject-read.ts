import type { Static } from 'typebox';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import {
  CLASSIFICATION_INHERIT_POLICY,
  CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT,
} from '../classification/context.ts';
import { subjectStatementPage } from '../entity-page/contract.ts';
import { isStructuralProperty } from '../entity-page/structural-properties.ts';
import { visibleResourceReferences } from '../entity-page/read.ts';
import { readCurrentComponent } from '../semantic/change.ts';
import { resolveTargets } from '../target/resolve.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import {
  decodeReadCursor,
  encodeReadCursor,
  WorkReadInvalid,
  WorkReadMissing,
  WorkReadUnavailable,
  type ReadRow,
  type WorkReadSession,
} from '../work/read-session.ts';
import { resolveStatementAcceptancesAt, statementValueFromManifest } from './read.ts';
import type { StatementSeekOrder } from './seek.ts';
import { STATEMENT_LIMITS, type StatementValue } from './schema.ts';
import { readingBoundary } from '../reading-position/boundary.ts';
import { propertyRevelationRecord } from '../reading-position/store.ts';
import { readWikiClaimEvidence, projectWikiEvidence } from '../wiki/evidence-read.ts';
import type { WikiEvidenceRow } from '../wiki/evidence.ts';
import { framePattern, matchFromScore } from '../projection/frame-read.ts';
import type { Coordinate } from '../projection/dimension.ts';
import { ContextCommandUnavailable } from '../context/command.ts';
import { statementQualificationFromBindings } from './qualification.ts';

/** Bounded candidate/hydration batches fill a page from disclosed items, with one
 * disclosed lookahead. Withheld rows never produce a short continuing page.
 * Scanning shares WorkRead's call/byte/deadline ceilings: exceeding them fails
 * explicitly rather than exposing a truncated page or a hidden-row cursor. */
export const SUBJECT_STATEMENT_COST = {
  pageSize: 20,
  coverageQueries: 1,
  inventoryQueriesPerBatch: 2,
  candidates: 20,
  componentProperties: 256,
  referencesPerCandidate: 27,
  referenceBatch: 64,
  disclosurePasses: 2,
  wikiEvidenceQueriesPerBatch: 1,
  responseBytes: 512 * 1024,
  acceptanceQueriesPerBatch: 6,
} as const;
type Page = Static<typeof subjectStatementPage>;
type Item = Page['groups'][number]['items'][number];
const nativeReference =
  /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function reference(value: string) {
  if (!/^https?:\/\/[^\s<>"{}|\\^`]+$/u.test(value) && value !== GLOBAL_CLASSIFICATION_CONTEXT)
    throw new WorkReadUnavailable('Statement reference is invalid');
  return `<${value}>`;
}

/** A matching exact Statement or qualified-fact decision accepts the claim.
 * Missing/corrupt local heads never become absence; only a real withdrawal or
 * absent slot may inherit the same target from Global. */
export function acceptedStatementPattern(context: string, inherit: boolean): string {
  // Bind aliases from each slot's own graph pattern. BIND of an outer variable
  // inside a UNION branch is unbound in SPARQL and would accept unrelated claims.
  const slot = (prefix: string, scope: string) => `{ GRAPH ${iri(GRAPHS.current)} {
      ?${prefix}Slot rv:decisionTarget ?statement ; rv:targetKind rv:StatementTarget . }
      BIND(?statement AS ?decisionTarget) BIND(rv:StatementTarget AS ?targetKind) }
    UNION { GRAPH ${iri(GRAPHS.current)} {
      ?${prefix}Slot rv:decisionTarget ?key ; rv:targetKind rv:QualifiedFactTarget . }
      BIND(?key AS ?decisionTarget) BIND(rv:QualifiedFactTarget AS ?targetKind) }
    GRAPH ${iri(GRAPHS.current)} {
    ?${prefix}Slot a rv:DecisionSlot ; rv:acceptanceContext ${reference(scope)} ; rv:decisionHead ?${prefix}Decision . }
    GRAPH ${iri(GRAPHS.revisions)} { ?${prefix}Decision a rv:StatementDecision ;
      rv:component ?${prefix}Slot ; rv:outcome rv:Accepted . }
    FILTER(?targetKind = rv:StatementTarget || EXISTS {
      GRAPH ${iri(GRAPHS.revisions)} { ?${prefix}Decision rv:support ?support }
      GRAPH ${iri(GRAPHS.current)} { ?support a rdf:Statement ; rv:statementState rv:Active ; rv:meaningKey ?key } })`;
  if (context === GLOBAL_CLASSIFICATION_CONTEXT)
    return `${slot('global', context)}
    BIND(?globalDecision AS ?decision) BIND("global" AS ?decisionSource)`;
  return `{ ${slot('local', context)}
    BIND(?localDecision AS ?decision) BIND("local" AS ?decisionSource) }
    ${
      inherit
        ? `UNION { ${slot('global', GLOBAL_CLASSIFICATION_CONTEXT)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ?blockingSlot a rv:DecisionSlot ; rv:decisionTarget ?decisionTarget ; rv:targetKind ?targetKind ;
          rv:acceptanceContext ${reference(context)} .
        FILTER NOT EXISTS { ?blockingSlot rv:decisionHead ?withdrawnDecision .
          GRAPH ${iri(GRAPHS.revisions)} { ?withdrawnDecision a rv:StatementDecision ;
            rv:component ?blockingSlot ; rv:outcome rv:Withdrawn } } } }
      BIND(?globalDecision AS ?decision) BIND("inherited-global" AS ?decisionSource) }`
        : ''
    }`;
}

async function acceptanceScope(session: WorkReadSession, context: string) {
  const rows = await session.query(
    `SELECT ?policy ?realm WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${reference(context)} a rv:ClassificationContext ; rv:contextState rv:Active ; rv:inheritancePolicy ?policy .
    OPTIONAL { ${reference(context)} rv:realm ?realm }
  } } LIMIT 2`,
    2,
  );
  if (!rows.length) {
    if (context === GLOBAL_CLASSIFICATION_CONTEXT) return null;
    throw new WorkReadMissing('Acceptance Context is unavailable');
  }
  if (
    rows.length !== 1 ||
    ![CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY].includes(
      rows[0]!.policy?.value ?? '',
    )
  ) {
    throw new WorkReadUnavailable('Acceptance Context is ambiguous');
  }
  if (context !== GLOBAL_CLASSIFICATION_CONTEXT) {
    if (!rows[0]!.realm) throw new WorkReadMissing('Acceptance Context is unavailable');
    await session.realm(rows[0]!.realm!.value);
  }
  return { inherit: rows[0]!.policy!.value === CLASSIFICATION_INHERIT_POLICY,
    realm: rows[0]!.realm?.value ?? null,
  };
}

function statementValue(row: ReadRow): StatementValue {
  const object = row.object;
  if (!object) throw new WorkReadUnavailable('Statement value is missing');
  if (object.type === 'uri')
    return object.value === `${RV}SomeValue`
      ? { kind: 'some-value' }
      : object.value === `${RV}NoValue`
        ? { kind: 'no-value' }
        : { kind: 'resource', iri: object.value };
  return {
    kind: 'literal',
    lexical: object.value,
    language: object['xml:lang'] ?? null,
    datatype:
      object.datatype ??
      (object['xml:lang']
        ? 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString'
        : 'http://www.w3.org/2001/XMLSchema#string'),
  };
}

function list(value: string | undefined, maximum: number): string[] {
  const values = value ? [...new Set(value.split('|'))].sort() : [];
  if (values.length > maximum)
    throw new WorkReadUnavailable('Statement qualifier inventory exceeds its bound');
  values.forEach(reference);
  return values;
}

export async function readSubjectStatements(
  session: WorkReadSession,
  resource: string,
  context = GLOBAL_CLASSIFICATION_CONTEXT,
  frames?: readonly Coordinate[],
): Promise<Page> {
  await resolveTargets(session, [resource], 'discussion');
  const boundary = readingBoundary(session);
  await boundary.require(resource);
  const scope = await acceptanceScope(session, context);
  const seek = session.deps.statementSeek;
  if (!seek) throw new WorkReadUnavailable('Statement seek owner is unavailable');
  const indexed = await seek.coverage();
  if (!indexed?.complete || indexed.through_sequence !== session.position.sequence)
    throw new WorkReadUnavailable('Statement seek coverage is unavailable');
  const limit = session.options.limit ?? SUBJECT_STATEMENT_COST.pageSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > SUBJECT_STATEMENT_COST.pageSize) {
    throw new WorkReadInvalid('Statement page size is invalid');
  }
  const binding = [
    'subject-statements-seek-v2',
    resource,
    context,
    session.principal,
    session.options.actingSubject ?? null,
    await boundary.binding(),
    ...(frames ? [frames] : []),
  ];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  let after: { phase: 'component' | 'statement'; predicate?: string; meaningKey?: string; score?: number;
  } = { phase: frames ? 'statement' : 'component' };
  if (cursor) {
    try {
      after = JSON.parse(cursor.order) as typeof after;
    } catch {
      throw new WorkReadInvalid('Statement cursor is invalid');
    }
    if (
      !['component', 'statement'].includes(after.phase) ||
      (after.phase === 'statement' && (typeof after.predicate !== 'string' || typeof after.meaningKey !== 'string'
        ||
          (frames && (!Number.isInteger(after.score) || after.score! < 0 || after.score! > 136))))
    ) {
      throw new WorkReadInvalid('Statement cursor is invalid');
    }
  }
  const visibleReferences = new Set<string>();
  const checkReferences = async (refs: string[]) => {
    const native = refs.filter((ref) => nativeReference.test(ref));
    const allowed = await visibleResourceReferences(session, native);
    for (const ref of allowed) visibleReferences.add(ref);
    return allowed;
  };
  const privateContexts = new Set<string>();
  const canReadPrivate = async (ctx: string) => {
    if (!session.principal || !session.options.actingSubject || !session.deps.contextSelections)
      return false;
    let principal;
    try {
      principal = await session.deps.account.verify(session.request, ['context:read']);
    } catch (error) {
      if (error instanceof AccountAssertionDenied) return false;
      throw error;
    }
    const allowed = await session.deps.contextSelections.canReadPrivate(
      principal,
      session.options.actingSubject,
      ctx,
    );
    if (allowed) privateContexts.add(ctx);
    return allowed;
  };
  const items: Item[] = [];
  const publishedEvidence = new Map<string,WikiEvidenceRow[]>();
  const positions: { phase: 'component' | 'statement'; key: string; predicate?: string; meaningKey?: string; score?: number;
  }[] = [];
  const appendProperties = async () => {
    const component = await readCurrentComponent(session.deps.environment, resource, 'resource');
    const properties =
      component?.state.component === 'resource' && component.state.lifecycle === 'active'
        ? component.state.properties
        : [];
    const keyed = properties
      .filter((property) => !isStructuralProperty(property.predicate))
      .map((property) => ({ key: JSON.stringify([property.predicate, property.value]), property }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .filter((item) => !cursor || after.phase !== 'component' || item.key > cursor.after);
    for (
      let offset = 0;
      offset < keyed.length && items.length <= limit;
      offset += SUBJECT_STATEMENT_COST.candidates
    ) {
      const page = keyed.slice(offset, offset + SUBJECT_STATEMENT_COST.candidates);
      const allowed = await checkReferences(
        page.flatMap(({ property }) =>
          property.value.kind === 'resource' ? [property.value.ref] : [],
        ),
      );
      const disclosedProperties = await boundary.visible(page.filter(({ property }) =>
        property.value.kind !== 'resource' || allowed.has(property.value.ref),
          ).map(({ property }) =>
        propertyRevelationRecord(resource, property.predicate, property.value),
          ),
      );
      for (const { property } of page) {
        if (!disclosedProperties.has(propertyRevelationRecord(resource, property.predicate, property.value),
          )) continue;
        if (property.value.kind === 'resource' && !allowed.has(property.value.ref)) continue;
        items.push({
          kind: 'component-property',
          revision: component!.head,
          predicate: property.predicate,
          value: property.value,
          qualifiers: { applicability: [], interpretationDefinitions: [] },
          sources: [],
          ...(frames ? { frameMatch: matchFromScore(0) } : {}),
        });
        positions.push({
          phase: 'component',
          key: JSON.stringify([property.predicate, property.value]),
        });
      }
    }
  };
  if (!frames && after.phase === 'component') await appendProperties();
  if (items.length <= limit && (!frames || after.phase === 'statement')) {
    const coverage = frames ? framePattern(frames, '?statement', GRAPHS.current) : null;
    let statementAfter: StatementSeekOrder | null =
      cursor && after.phase === 'statement'
        ? { predicate: after.predicate!, meaningKey: after.meaningKey!, statementId: cursor.after, score: after.score ?? 0,
          }
        : null;
    while (items.length <= limit) {
      session.checkDeadline();
      const batchSize = SUBJECT_STATEMENT_COST.candidates;
      const sought = await seek.seek(session.position,resource,statementAfter,frames);
      const rows: ReadRow[] = sought.candidates.map((row) => ({
        statement: {type: 'uri',value: row.statementId},predicate: {type: 'uri',value: row.predicate},
        key: {type: 'uri',value: row.meaningKey},specificity: {type: 'literal',value: String(row.score)},
      }));
      if (scope && rows.length) {
        const acceptance = scope.realm ? {kind: 'realm' as const,realm: scope.realm} : {kind: 'global' as const};
        const exact = await resolveStatementAcceptancesAt(session.deps.environment,
          rows.map((row) => ({kind: 'statement',statement: row.statement!.value})),acceptance,session.position,
        );
        const qualified = await resolveStatementAcceptancesAt(session.deps.environment,
          [...new Set(rows.map((row) => row.key!.value))].map((meaningKey) => ({kind: 'qualified-fact',meaningKey,
          })),
          acceptance,session.position,
        );
        for (const row of rows) {
          const results = [exact.get(row.statement!.value)!.result,qualified.get(row.key!.value)!.result,
          ];
          if (results.some((result) => result.state === 'unavailable')) throw new WorkReadUnavailable('Statement acceptance is unavailable');
          const result = results.find((result) => result.state === 'accepted');
          if (result?.state === 'accepted') row.acceptance = {type: 'literal',value: result.decision+'|'+result.source};
        }
      }
      const page = rows;
      if (page.some((row) => !row.statement || !row.predicate)) {
        throw new WorkReadUnavailable('Statement inventory is incomplete');
      }
      if (page.length) {
        const hydrated = await session.query(
          `SELECT ?statement ?predicate ?object ?relation ?speaker ?key ?head ?manifest
        ?pin ?ctx ?disclosure ?speakerRealm ?frameScore
        ?qualificationDefinition ?qualificationContext ?precision ?validFrom ?validUntil ?edition
        (GROUP_CONCAT(DISTINCT STR(?definition); separator="|") AS ?definitions)
        (GROUP_CONCAT(DISTINCT STR(?applicability); separator="|") AS ?qualifiers)
        (GROUP_CONCAT(DISTINCT STR(?qualifier); separator="|") AS ?valueQualifiers)
        (GROUP_CONCAT(DISTINCT STR(?evidence); separator="|") AS ?sources) WHERE {
        VALUES ?statement { ${page.map((row) => iri(row.statement!.value)).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} { ?statement a rdf:Statement ; rdf:subject ${iri(resource)} ;
          rdf:predicate ?predicate ; rdf:object ?object ; rv:relationDefinition ?relation ; rv:speaker ?speaker ;
          rv:meaningKey ?key ; rv:statementState rv:Active ; rv:head ?head .
          OPTIONAL { ?statement rv:interpretationDefinition ?definition }
          OPTIONAL { ?statement rv:applicability ?applicability }
          OPTIONAL { ?statement rv:semanticContextRevision ?pin }
          OPTIONAL { ?statement rv:qualificationDefinition ?qualificationDefinition }
          OPTIONAL { ?statement rv:interpretationContext ?qualificationContext }
          OPTIONAL { ?statement rv:valuePrecision ?precision }
          OPTIONAL { ?statement rv:valueQualifier ?qualifier }
          OPTIONAL { ?statement rv:validFrom ?validFrom }
          OPTIONAL { ?statement rv:validUntil ?validUntil }
          OPTIONAL { ?statement rv:editionScope ?edition }
          OPTIONAL { ?speaker a rv:Realm . BIND(?speaker AS ?speakerRealm) } }
        GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:StatementRevision ; rv:component ?statement .
          OPTIONAL { ?head rv:manifest ?manifest }
          OPTIONAL { ?head rv:evidence ?evidence } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?statement rv:semanticContextRevision ?pin }
          GRAPH ${iri(GRAPHS.revisions)} { ?pin a rv:ContextSemanticRevision ; rv:component ?ctx }
          GRAPH ${iri(GRAPHS.current)} { ?ctx rv:disclosure ?disclosure } }
        ${coverage ? `${coverage.filter}\nBIND(${coverage.score} AS ?frameScore)` : ''}
      } GROUP BY ?statement ?predicate ?object ?relation ?speaker ?key ?head ?manifest ?pin ?ctx ?disclosure ?speakerRealm ?frameScore
        ?qualificationDefinition ?qualificationContext ?precision ?validFrom ?validUntil ?edition
      LIMIT ${page.length + 1}`,
          page.length,
        );
        if (
          hydrated.length !== page.length ||
          new Set(hydrated.map((row) => row.statement?.value)).size !== page.length
        ) {
          throw new WorkReadUnavailable('Statement hydration is incomplete or ambiguous');
        }
        const byId = new Map(hydrated.map((row) => [row.statement!.value, row]));
        const qualifications = new Map(
          hydrated.map((row) => {
            try {
              return [row.statement!.value, statementQualificationFromBindings([row])] as const;
            } catch (error) {
              if (error instanceof ContextCommandUnavailable)
                throw new WorkReadUnavailable('Statement qualification is unavailable');
              throw error;
            }
          }),
        );
        const wikiClaims = await readWikiClaimEvidence(session,page.map((row) => row.statement!.value),'statement',
        );
        const allowed = await checkReferences(
          hydrated.flatMap((row) => {
            const value = statementValue(row);
            const qualification = qualifications.get(row.statement!.value);
            return [
              ...(value.kind === 'resource' ? [value.iri] : []),
              ...list(row.qualifiers?.value, STATEMENT_LIMITS.applicability),
              ...list(row.sources?.value, STATEMENT_LIMITS.evidence).filter(
                (source) =>
                !wikiClaims.get(row.statement!.value)?.some((evidence) => evidence.id === source),
              ),
              ...(qualification
                ? [
                    qualification.interpretationContext,
                    ...(qualification.editionScope === null ? [] : [qualification.editionScope]),
                  ]
                : []),
            ];
          }),
        );
        const batchItems: Item[] = [];
        const batchPositions: typeof positions = [];
        for (const candidate of page) {
          const row = byId.get(candidate.statement!.value);
          if (
            !row?.head ||
            !row.relation ||
            !row.speaker ||
            !row.key ||
            row.predicate?.value !== candidate.predicate!.value || row.key?.value !== candidate.key!.value
            ||
            (coverage && Number(row.frameScore?.value) !== Number(candidate.specificity?.value))
          ) {
            throw new WorkReadUnavailable('Statement hydration differs from its candidate');
          }
          if (
            row.pin &&
            row.disclosure?.value !== `${RV}Public` &&
            !(
              row.disclosure?.value === `${RV}Private` &&
              row.ctx &&
              (await canReadPrivate(row.ctx.value))
            )
          )
            continue;
          if (row.speakerRealm) {
            try {
              await session.realm(row.speakerRealm.value);
            } catch (error) {
              if (error instanceof WorkReadMissing) continue;
              throw error;
            }
          }
          const value = statementValue(row);
          const qualification = qualifications.get(row.statement!.value);
          const qualificationReferences = qualification
            ? [
                qualification.interpretationContext,
                ...(qualification.editionScope === null ? [] : [qualification.editionScope]),
              ]
            : [];
          if (
            value.kind === 'resource' &&
            nativeReference.test(value.iri) &&
            !allowed.has(value.iri)
          )
            continue;
          const qualifiers = {
            applicability: list(row.qualifiers?.value, STATEMENT_LIMITS.applicability),
            interpretationDefinitions: list(
              row.definitions?.value,
              STATEMENT_LIMITS.interpretationDefinitions,
            ),
            ...(qualification ? { qualification } : {}),
          };
          const sources = list(row.sources?.value, STATEMENT_LIMITS.evidence);
          const evidence = (wikiClaims.get(row.statement!.value) ?? []).filter((row) => sources.includes(row.id),
          );
          if (!candidate.acceptance?.value && !evidence.length) continue;
          if (
            [...qualifiers.applicability, ...sources].some(
              (ref) => nativeReference.test(ref) && !allowed.has(ref) && !evidence.some((row) => row.id === ref),
            ) ||
            qualificationReferences.some((ref) => nativeReference.test(ref) && !allowed.has(ref))
          )
            continue;
          const [decision, source] = candidate.acceptance?.value.split('|') ?? [];
          if (candidate.acceptance?.value && (!decision || !['local', 'global', 'inherited-global'].includes(source!))) {
            throw new WorkReadUnavailable('Statement acceptance is incomplete');
          }
          if (evidence.length) publishedEvidence.set(row.statement!.value,evidence);
          batchItems.push({
            kind: 'statement',
            statement: row.statement!.value,
            revision: row.head.value,
            predicate: row.predicate!.value,
            value,
            relationDefinition: row.relation.value,
            speaker: row.speaker.value,
            meaningKey: row.key.value,
            qualifiers,
            sources,
            ...(frames ? { frameMatch: matchFromScore(Number(candidate.specificity?.value)) } : {}),
            ...(evidence.length ? {
              publication: { kind: 'wiki-bundle' as const,works: [...new Set(evidence.map((row) => row.sourceWork))],
                  },
                } : {}),
            acceptance: decision ? {
              context,
              decision,
              source: source as 'local' | 'global' | 'inherited-global',
            } : null,
          });
          batchPositions.push({
            phase: 'statement',
            key: row.statement!.value,
            predicate: row.predicate!.value,
            meaningKey: row.key!.value,
            ...(frames ? { score: Number(candidate.specificity?.value) } : {}),
          });
        }
        const disclosedStatements = await boundary.visible(batchPositions.map((position) => position.key),
        );
        for (const [index, item] of batchItems.entries()) {
          if (!disclosedStatements.has(batchPositions[index]!.key)) continue;
          if (item.kind === 'statement') {
            try {
              item.value = await statementValueFromManifest(
                session.deps.environment,
                item.statement,
                byId.get(item.statement)?.manifest?.value,
                item.meaningKey,
                item.value,
                item.qualifiers.qualification,
              );
            } catch (error) {
              if (error instanceof ContextCommandUnavailable)
                throw new WorkReadUnavailable('Statement literal is unavailable');
              throw error;
            }
          }
          items.push(item);
          positions.push(batchPositions[index]!);
        }
      }
      if (rows.length < batchSize) break;
      const last = rows.at(-1)!;
      statementAfter = { predicate: last.predicate!.value, meaningKey: last.key!.value, statementId: last.statement!.value,
        score: Number(last.specificity?.value ?? 0),
      };
    }
  }
  if (frames && items.length <= limit) await appendProperties();
  let nextCursor: string | null = null;
  if (items.length > limit) {
    const last = positions[limit - 1]!;
    nextCursor = encodeReadCursor(
      binding,
      session.position,
      last.key,
      JSON.stringify({
        phase: last.phase,
        ...(last.predicate ? { predicate: last.predicate } : {}),
        ...(last.meaningKey ? { meaningKey: last.meaningKey } : {}),
        ...(last.score !== undefined ? { score: last.score } : {}),
      }),
    );
    items.splice(limit);
  }
  const published = items.filter((item): item is Extract<Item,{ kind: 'statement' }> =>
    item.kind === 'statement' && publishedEvidence.has(item.statement),
  );
  if (published.length) {
    const fenced = await readWikiClaimEvidence(session,published.map((item) => item.statement),'statement',
    );
    const evidence = published.flatMap((item) => publishedEvidence.get(item.statement)!);
    if (evidence.some((row) => !fenced.get(row.claim!)?.some((current) => current.id === row.id))) {
      throw new WorkReadMissing('Wiki claim is unavailable');
    }
    const projected = await projectWikiEvidence(session,evidence);
    for (const item of published) item.evidence = projected.filter((row) =>
      publishedEvidence.get(item.statement)!.some((source) => source.id === row.id),
      );
  }
  const fencedReferences = await visibleResourceReferences(session, [...visibleReferences]);
  if ([...visibleReferences].some((ref) => !fencedReferences.has(ref)))
    throw new WorkReadMissing('Reference is unavailable');
  for (const ctx of privateContexts)
    if (!(await canReadPrivate(ctx))) throw new WorkReadMissing('Context is unavailable');
  await resolveTargets(session, [resource], 'discussion');
  await boundary.fence();
  const groups = new Map<string, Item[]>();
  for (const item of items)
    groups.set(item.predicate, [...(groups.get(item.predicate) ?? []), item]);
  return {
    profile: 'subject-statements-v1',
    resource,
    acceptanceContext: context,
    groups: [...groups].map(([predicate, grouped]) => ({ predicate, items: grouped })),
    nextCursor,
    sourcePosition: session.position,
    count: { value: items.length, kind: 'exact-page', total: null },
  };
}
