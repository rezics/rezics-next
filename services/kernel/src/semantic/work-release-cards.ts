import type { Release } from '@rezics/definitions';
import { partitionReadClient } from '../database/read-snapshot.ts';
import type { CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { currentRelationFacts, currentRelationKey, type CurrentRelationCandidate } from './current-relations.ts';
import { readSubjectSummaries, type SubjectSummary } from './summaries.ts';
import { effectiveSlotFacts } from './slots.ts';
import listOutboundLinks from './list-outbound-links-by-property.sql';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from './contract/subject-values.ts';
import { factDataTypes, isRelationProperty, resolveItem, type FactRow, type Statement } from './item.ts';
import { withReadTransaction } from './read.ts';
import { waitForSubjectLinks } from './link-freshness.ts';
import type { WorkReleaseCardMembershipLink, WorkReleaseCardsInput } from './copy-work-reader-port.ts';
import {
  workReleaseCardFieldLimit,
  workReleaseCardLimit,
  workReleaseCardProperties,
  workReleaseCardQualifierLimit,
  workReleaseCardReferenceLimit,
  workReleaseCardReferencePartLimit,
  workReleaseCardResponseBytes,
  workReleaseCardStatementBytes,
} from './copy-work-reader-port.ts';

export {
  workReleaseCardFieldLimit,
  workReleaseCardLimit,
  workReleaseCardProperties,
  workReleaseCardQualifierLimit,
  workReleaseCardReferenceLimit,
  workReleaseCardReferencePartLimit,
  workReleaseCardResponseBytes,
  workReleaseCardStatementBytes,
} from './copy-work-reader-port.ts';

export type WorkReleaseCardField =
  | { state: 'unsupported' | 'withheld' | 'missing' | 'unavailable' }
  | { state: 'available'; statements: Statement[]; related: Record<string, SubjectSummary> };

export type WorkReleaseCard = {
  subject: string;
  type: string;
  summary: SubjectSummary;
  membership: Statement;
  related: Record<string, SubjectSummary>;
  fields: Record<(typeof workReleaseCardProperties)[number], WorkReleaseCardField>;
};

export type WorkReleaseCards = { state: 'unavailable' } | { state: 'available'; cards: WorkReleaseCard[] };

type MembershipLink = WorkReleaseCardMembershipLink;

type SelectedField = { facts: FactRow[]; withheld: boolean; unavailable?: boolean };
type CardSource = {
  id: string;
  type: string;
  summary: SubjectSummary;
  membership: Statement;
  related: Record<string, SubjectSummary>;
};
type RelationKey = { id: string; property: string; candidate: CurrentRelationCandidate };
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function statementBytes(statement: Statement): number {
  return new TextEncoder().encode(JSON.stringify(statement)).byteLength;
}

function statementsWithinBudget(statements: readonly Statement[]): boolean {
  return (
    statements.length <= workReleaseCardFieldLimit &&
    statements.every((statement) => {
      return (
        statement.qualifiers.length <= workReleaseCardQualifierLimit &&
        statement.references.length <= workReleaseCardReferenceLimit &&
        statement.references.every((reference) => reference.parts.length <= workReleaseCardReferencePartLimit) &&
        statementBytes(statement) <= workReleaseCardStatementBytes
      );
    })
  );
}

export type WorkReleaseCardFactProjection = { statements: Statement[]; unavailable: boolean };

/** Project one selected native batch through the canonical item resolver without filling missing row evidence. */
export function projectWorkReleaseCardFacts(
  subject: string,
  type: string,
  release: Release,
  context: string,
  fields: ReadonlyMap<string, readonly FactRow[] | null>,
): Map<string, WorkReleaseCardFactProjection> {
  const projected = new Map<string, WorkReleaseCardFactProjection>();
  const projectable = new Map<string, readonly FactRow[]>();
  const rows: FactRow[] = [];
  for (const [property, facts] of fields) {
    if (
      facts === null ||
      facts.some(
        (fact) =>
          fact.kind !== 'statement' ||
          fact.property !== property ||
          !fact.statement_id ||
          fact.fact_revision === null ||
          fact.fact_revision === undefined ||
          typeof fact.fact_release !== 'string' ||
          fact.fact_release.length === 0,
      )
    ) {
      projected.set(property, { statements: [], unavailable: true });
      continue;
    }
    projectable.set(property, facts);
    rows.push(...facts);
    projected.set(property, { statements: [], unavailable: false });
  }
  if (!rows.length) return projected;

  // Every row in this batch has its own stored evidence. The first row supplies only the
  // resolver's required subject-level fallback, which is unused for these complete rows.
  const evidence = rows[0]!;
  const item = resolveItem(subject, rows, type, factDataTypes(release, rows), {
    revision: evidence.fact_revision!,
    release: evidence.fact_release!,
    context,
  });
  for (const property of projectable.keys()) {
    const statements = item.statements[property] ?? [];
    projected.set(property, {
      statements,
      unavailable: !statementsWithinBudget(statements),
    });
  }
  return projected;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Read only the finite selected facts used by public release comparison cards for the supplied page. */
export async function readNativeWorkReleaseCards(input: WorkReleaseCardsInput): Promise<WorkReleaseCards> {
  const context = input.context ?? GLOBAL_CONTEXT;
  const defaults = input.defaults ?? {};
  if (!input.caughtUp || input.links.length > workReleaseCardLimit) return { state: 'unavailable' };
  const memberships: CardSource[] = [];
  const selected = new Map<string, Map<string, SelectedField>>();
  const routeById = new Map<string, number>();
  for (const link of input.links.slice(0, workReleaseCardLimit)) {
    const assertion = link.assertion;
    const summary = link.summary;
    if (
      link.property !== 'schema:exampleOfWork' ||
      !assertion ||
      !summary ||
      assertion.id !== link.statement ||
      assertion.property.id !== 'schema:exampleOfWork' ||
      assertion.value.type !== 'value' ||
      assertion.value.content !== input.subject
    )
      continue;
    const route = routeOf(link.subject);
    if (route === null) continue;
    routeById.set(link.subject, partitionOf(route));
    memberships.push({
      id: link.subject,
      type: summary.type,
      summary,
      membership: assertion,
      related: link.related ?? {},
    });
  }
  if (!memberships.length) return { state: 'available', cards: [] };

  try {
    const ids = [...new Set(memberships.map(({ id }) => id))];
    const ready = await Promise.all(ids.map((id) => waitForSubjectLinks(input.pool, input.seen, id, input.deadline)));
    if (ready.some((caughtUp) => !caughtUp)) return { state: 'unavailable' };
    const requested = new Map<string, string[]>();
    for (const { id, type } of memberships) {
      const admitted = input.release.types[type]?.properties ?? [];
      requested.set(
        id,
        workReleaseCardProperties.filter(
          (property) => admitted.includes(property) && input.release.properties[property],
        ),
      );
    }

    const relationCandidatesByPartition = new Map<number, RelationKey[]>();
    const relationFacts = new Map<string, FactRow>();
    const typeById = new Map(memberships.map(({ id, type }) => [id, type]));
    await withReadTransaction(input.pool, async (client) => {
      const homes = new Map<number, string[]>();
      for (const id of ids) {
        const home = routeById.get(id)!;
        const batch = homes.get(home) ?? [];
        batch.push(id);
        homes.set(home, batch);
      }
      for (const [home, batch] of homes) {
        const local = (await partitionReadClient(client, home)) as CommandTransaction;
        for (const id of batch) {
          const fields = new Map<string, SelectedField>();
          for (const property of requested.get(id) ?? []) {
            if (isRelationProperty(input.release, property)) {
              const rows = (await listOutboundLinks.run(local, {
                context_id: context,
                route: routeOf(id)!,
                subject_id: id,
                property,
                filter_value: NIL_UUID,
                after_order: '',
                after_target: NIL_UUID,
                after_statement: NIL_UUID,
                page_limit: workReleaseCardFieldLimit + 1,
              })) as {
                statement: string;
                slot: string;
                target: string | null;
                external: string | null;
                value: CurrentRelationCandidate['value'];
              }[];
              if (rows.length > workReleaseCardFieldLimit) {
                fields.set(property, { facts: [], withheld: false, unavailable: true });
                continue;
              }
              fields.set(property, { facts: [], withheld: false });
              const relationFilter = input.release.properties[property]?.relation?.filter;
              const candidates = relationCandidatesByPartition.get(home) ?? [];
              for (const row of rows) {
                if (row.value === undefined) {
                  fields.set(property, { facts: [], withheld: false, unavailable: true });
                  continue;
                }
                candidates.push({
                  id,
                  property,
                  candidate: {
                    subject: id,
                    property,
                    candidate: row.statement,
                    target: row.target,
                    external: row.external,
                    value: row.value,
                    context,
                    defaults,
                    slot: row.slot,
                    ...(relationFilter === undefined
                      ? {}
                      : { filterProperties: Array.isArray(relationFilter) ? relationFilter : [relationFilter] }),
                    requireRelation: true,
                  },
                });
              }
              relationCandidatesByPartition.set(home, candidates);
              continue;
            }
            const view = await effectiveSlotFacts(local, id, property, context, defaults);
            const facts = view.facts.filter((fact) => fact.kind === 'statement');
            fields.set(property, { facts: [...facts], withheld: !!view.resolution });
          }
          selected.set(id, fields);
        }
      }

      for (const [home, candidates] of relationCandidatesByPartition) {
        const local = (await partitionReadClient(client, home)) as CommandTransaction;
        for (let offset = 0; offset < candidates.length; offset += 500) {
          const batch = candidates.slice(offset, offset + 500);
          const current = await currentRelationFacts(
            local,
            input.routeKey,
            batch.map(({ candidate }) => candidate),
          );
          for (const [key, fact] of current) relationFacts.set(key, fact);
        }
      }
    });

    for (const candidates of relationCandidatesByPartition.values()) {
      for (const { id, property, candidate } of candidates) {
        const fields = selected.get(id);
        const field = fields?.get(property);
        if (!fields || !field || field.unavailable) continue;
        const current = relationFacts.get(currentRelationKey(candidate));
        fields.set(property, {
          facts: current ? [...field.facts, current] : field.facts,
          withheld: field.withheld || !current,
        });
      }
    }

    const projected = new Map<string, Map<string, WorkReleaseCardFactProjection>>();
    for (const [id, fields] of selected) {
      const batch = new Map<string, readonly FactRow[] | null>();
      for (const [property, field] of fields) batch.set(property, field.unavailable ? null : field.facts);
      projected.set(id, projectWorkReleaseCardFacts(id, typeById.get(id)!, input.release, context, batch));
    }

    const targetIds = new Set<string>();
    for (const fields of projected.values()) {
      for (const field of fields.values()) {
        if (field.unavailable) continue;
        for (const statement of field.statements) {
          if (
            statement.property.data_type === 'wikibase-item' &&
            statement.value.type === 'value' &&
            typeof statement.value.content === 'string' &&
            routeOf(statement.value.content) !== null
          )
            targetIds.add(statement.value.content);
        }
      }
    }

    const summaries = new Map<string, SubjectSummary | null>();
    const targets = [...targetIds];
    for (let offset = 0; offset < targets.length; offset += 256) {
      const batch = targets.slice(offset, offset + 256);
      const response = await readSubjectSummaries(
        {
          client: { query: input.pool.query.bind(input.pool) },
          pool: input.pool,
          routeKey: input.routeKey,
          deadline: input.deadline,
          release: input.release,
          authorize: input.authorizeSummary ?? (async () => false),
        },
        batch,
        { languages: input.languages },
      );
      for (const [id, summary] of response) summaries.set(id, summary);
    }

    const cards: WorkReleaseCard[] = memberships.map(({ id, type, summary, membership, related }) => {
      const fields = {} as Record<(typeof workReleaseCardProperties)[number], WorkReleaseCardField>;
      const selectedFields = selected.get(id) ?? new Map<string, SelectedField>();
      const projectedFields = projected.get(id) ?? new Map<string, WorkReleaseCardFactProjection>();
      const cardRelated: Record<string, SubjectSummary> = { ...related };
      for (const property of workReleaseCardProperties) {
        if (!(requested.get(id) ?? []).includes(property)) {
          fields[property] = { state: 'unsupported' };
          continue;
        }
        const field = selectedFields.get(property);
        if (!field || (!field.facts.length && field.withheld)) {
          fields[property] = { state: 'withheld' };
          continue;
        }
        if (field.unavailable) {
          fields[property] = { state: 'unavailable' };
          continue;
        }
        const projection = projectedFields.get(property);
        if (!projection || projection.unavailable) {
          fields[property] = { state: 'unavailable' };
          continue;
        }
        if (!projection.statements.length) {
          fields[property] = { state: 'missing' };
          continue;
        }
        if (field.withheld) {
          fields[property] = { state: 'withheld' };
          continue;
        }
        const statements: Statement[] = [];
        const fieldRelated: Record<string, SubjectSummary> = {};
        let withheld = false;
        for (const statement of projection.statements) {
          if (statement.property.data_type === 'wikibase-item' && statement.value.type === 'value') {
            if (typeof statement.value.content !== 'string' || routeOf(statement.value.content) === null) {
              withheld = true;
              break;
            }
            const relatedSummary = summaries.get(statement.value.content);
            if (!relatedSummary) {
              withheld = true;
              break;
            }
            fieldRelated[statement.value.content] = relatedSummary;
            cardRelated[statement.value.content] = relatedSummary;
          }
          statements.push(statement);
        }
        fields[property] = withheld
          ? { state: 'withheld' }
          : statements.length
            ? { state: 'available', statements, related: fieldRelated }
            : { state: 'missing' };
      }
      return { subject: id, type, summary, membership, related: cardRelated, fields };
    });
    const result: WorkReleaseCards = { state: 'available', cards };
    return jsonBytes(result) <= workReleaseCardResponseBytes ? result : { state: 'unavailable' };
  } catch {
    return { state: 'unavailable' };
  }
}

export { readWorkReleaseCards } from './copy-work-application.ts';
