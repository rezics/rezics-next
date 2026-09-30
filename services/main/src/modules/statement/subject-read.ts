import type { Static } from 'typebox';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import {
  CLASSIFICATION_INHERIT_POLICY,
  CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT,
} from '../classification/context.ts';
import { subjectStatementPage } from '../entity-page/contract.ts';
import { visibleResourceReferences } from '../entity-page/read.ts';
import { readCurrentComponent } from '../semantic/change.ts';
import { resolveTargets } from '../target/resolve.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import {
  decodeReadCursor,
  encodeReadCursor,
  WorkReadInvalid,
  WorkReadMissing,
  WorkReadUnavailable,
  type ReadRow,
  type WorkReadSession,
} from '../work/read-session.ts';
import { STATEMENT_LIMITS, type StatementValue } from './schema.ts';

/** Bounded candidate/hydration batches fill a page from disclosed items, with one
 * disclosed lookahead. Withheld rows never produce a short continuing page.
 * Scanning shares WorkRead's call/byte/deadline ceilings: exceeding them fails
 * explicitly rather than exposing a truncated page or a hidden-row cursor. */
export const SUBJECT_STATEMENT_COST = {
  pageSize: 20,
  inventoryQueriesPerBatch: 2,
  candidates: 21,
  componentProperties: 256,
  referencesPerCandidate: 25,
  referenceBatch: 64,
  disclosurePasses: 2,
  responseBytes: 512 * 1024,
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
  return rows[0]!.policy!.value === CLASSIFICATION_INHERIT_POLICY;
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
): Promise<Page> {
  await resolveTargets(session, [resource], 'discussion');
  const inherit = await acceptanceScope(session, context);
  const limit = session.options.limit ?? SUBJECT_STATEMENT_COST.pageSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > SUBJECT_STATEMENT_COST.pageSize) {
    throw new WorkReadInvalid('Statement page size is invalid');
  }
  const binding = [
    'subject-statements-v1',
    resource,
    context,
    session.principal,
    session.options.actingSubject ?? null,
  ];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  let after: { phase: 'component' | 'statement'; predicate?: string } = { phase: 'component' };
  if (cursor) {
    try {
      after = JSON.parse(cursor.order) as typeof after;
    } catch {
      throw new WorkReadInvalid('Statement cursor is invalid');
    }
    if (
      !['component', 'statement'].includes(after.phase) ||
      (after.phase === 'statement' && typeof after.predicate !== 'string')
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
  const positions: { phase: 'component' | 'statement'; key: string; predicate?: string }[] = [];
  if (after.phase === 'component') {
    const component = await readCurrentComponent(session.deps.environment, resource, 'resource');
    const properties =
      component?.state.component === 'resource' && component.state.lifecycle === 'active'
        ? component.state.properties
        : [];
    const keyed = properties
      .map((property) => ({ key: JSON.stringify([property.predicate, property.value]), property }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .filter((item) => !cursor || item.key > cursor.after);
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
      for (const { property } of page) {
        if (property.value.kind === 'resource' && !allowed.has(property.value.ref)) continue;
        items.push({
          kind: 'component-property',
          revision: component!.head,
          predicate: property.predicate,
          value: property.value,
          qualifiers: { applicability: [], interpretationDefinitions: [] },
          sources: [],
        });
        positions.push({
          phase: 'component',
          key: JSON.stringify([property.predicate, property.value]),
        });
      }
    }
  }
  if (items.length <= limit) {
    const pattern = acceptedStatementPattern(context, inherit ?? false);
    let statementAfter =
      cursor && after.phase === 'statement'
        ? { predicate: after.predicate!, statement: cursor.after }
        : null;
    while (items.length <= limit) {
      const batchSize = SUBJECT_STATEMENT_COST.candidates;
      const rows =
        inherit === null
          ? []
          : await session.query(
              `SELECT ?predicate ?statement
      (MIN(CONCAT(STR(?decision), "|", ?decisionSource)) AS ?acceptance) WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?statement a rdf:Statement ; rdf:subject ${iri(resource)} ;
        rdf:predicate ?predicate ; rv:statementState rv:Active ; rv:meaningKey ?key . }
      ${pattern}
      ${
        statementAfter
          ? `FILTER(STR(?predicate) > ${lit(statementAfter.predicate)} ||
        STR(?predicate) = ${lit(statementAfter.predicate)} && STR(?statement) > ${lit(statementAfter.statement)})`
          : ''
      }
    } GROUP BY ?predicate ?statement ORDER BY STR(?predicate) STR(?statement) LIMIT ${batchSize}`,
              batchSize,
            );
      const page = rows;
      if (page.some((row) => !row.statement || !row.predicate || !row.acceptance)) {
        throw new WorkReadUnavailable('Statement inventory is incomplete');
      }
      if (page.length) {
        const hydrated = await session.query(
          `SELECT ?statement ?predicate ?object ?relation ?speaker ?key ?head
        ?pin ?ctx ?disclosure ?speakerRealm
        (GROUP_CONCAT(DISTINCT STR(?definition); separator="|") AS ?definitions)
        (GROUP_CONCAT(DISTINCT STR(?applicability); separator="|") AS ?qualifiers)
        (GROUP_CONCAT(DISTINCT STR(?evidence); separator="|") AS ?sources) WHERE {
        VALUES ?statement { ${page.map((row) => iri(row.statement!.value)).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} { ?statement a rdf:Statement ; rdf:subject ${iri(resource)} ;
          rdf:predicate ?predicate ; rdf:object ?object ; rv:relationDefinition ?relation ; rv:speaker ?speaker ;
          rv:meaningKey ?key ; rv:statementState rv:Active ; rv:head ?head .
          OPTIONAL { ?statement rv:interpretationDefinition ?definition }
          OPTIONAL { ?statement rv:applicability ?applicability }
          OPTIONAL { ?statement rv:semanticContextRevision ?pin }
          OPTIONAL { ?speaker a rv:Realm . BIND(?speaker AS ?speakerRealm) } }
        GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:StatementRevision ; rv:component ?statement .
          OPTIONAL { ?head rv:evidence ?evidence } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?statement rv:semanticContextRevision ?pin }
          GRAPH ${iri(GRAPHS.revisions)} { ?pin a rv:ContextSemanticRevision ; rv:component ?ctx }
          GRAPH ${iri(GRAPHS.current)} { ?ctx rv:disclosure ?disclosure } }
      } GROUP BY ?statement ?predicate ?object ?relation ?speaker ?key ?head ?pin ?ctx ?disclosure ?speakerRealm
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
        const allowed = await checkReferences(
          hydrated.flatMap((row) => {
            const value = statementValue(row);
            return [
              ...(value.kind === 'resource' ? [value.iri] : []),
              ...list(row.qualifiers?.value, STATEMENT_LIMITS.applicability),
              ...list(row.sources?.value, STATEMENT_LIMITS.evidence),
            ];
          }),
        );
        for (const candidate of page) {
          const row = byId.get(candidate.statement!.value);
          if (
            !row?.head ||
            !row.relation ||
            !row.speaker ||
            !row.key ||
            row.predicate?.value !== candidate.predicate!.value
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
          };
          const sources = list(row.sources?.value, STATEMENT_LIMITS.evidence);
          if (
            [...qualifiers.applicability, ...sources].some(
              (ref) => nativeReference.test(ref) && !allowed.has(ref),
            )
          )
            continue;
          const [decision, source] = candidate.acceptance!.value.split('|');
          if (!decision || !['local', 'global', 'inherited-global'].includes(source!)) {
            throw new WorkReadUnavailable('Statement acceptance is incomplete');
          }
          items.push({
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
            acceptance: {
              context,
              decision,
              source: source as 'local' | 'global' | 'inherited-global',
            },
          });
          positions.push({
            phase: 'statement',
            key: row.statement!.value,
            predicate: row.predicate!.value,
          });
        }
      }
      if (rows.length < batchSize) break;
      const last = rows.at(-1)!;
      statementAfter = { predicate: last.predicate!.value, statement: last.statement!.value };
    }
  }
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
      }),
    );
    items.splice(limit);
  }
  const fencedReferences = await visibleResourceReferences(session, [...visibleReferences]);
  if ([...visibleReferences].some((ref) => !fencedReferences.has(ref)))
    throw new WorkReadMissing('Reference is unavailable');
  for (const ctx of privateContexts)
    if (!(await canReadPrivate(ctx))) throw new WorkReadMissing('Context is unavailable');
  await resolveTargets(session, [resource], 'discussion');
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
