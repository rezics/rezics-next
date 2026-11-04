import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import { partitionReadClient } from '../database/read-snapshot.ts';
import type { CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { currentRelationFacts, currentRelationKey, type CurrentRelationCandidate } from './current-relations.ts';
import { readSubjectSummaries, type SubjectSummary, type SummaryDependencies } from './summaries.ts';
import { slotView } from './slots.ts';
import listOutboundLinks from './list-outbound-links-by-property.sql';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { isRelationProperty, type FactRow, type Statement } from './item.ts';
import { withReadTransaction } from './read.ts';
import { waitForSubjectLinks } from './link-freshness.ts';
import type { SessionComponent } from '../tokens/session.ts';

export const workReleaseCardLimit = 20;
export const workReleaseCardFieldLimit = 32;
export const workReleaseCardProperties = [
  'schema:gamePlatform',
  'schema:inLanguage',
  'schema:datePublished',
  'schema:creativeWorkStatus',
  'wdt:P5804',
  'rezics:releaseStatus',
  'schema:contentRating',
  'schema:publisher',
  'schema:producer',
  'wdt:P178',
  'wdt:P162',
  'wdt:P2899',
] as const;
export const workReleaseCardQualifierLimit = 64;
export const workReleaseCardReferenceLimit = 32;
export const workReleaseCardReferencePartLimit = 64;
export const workReleaseCardStatementBytes = 64 * 1024;
export const workReleaseCardResponseBytes = 2 * 1024 * 1024;

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

type MembershipLink = {
  subject: string;
  property: string;
  statement: string;
  assertion?: Statement;
  related?: Record<string, SubjectSummary>;
  summary?: SubjectSummary | null;
};

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

function statementOf(fact: FactRow): Statement | undefined {
  if (fact.kind !== 'statement' || !fact.statement_id || !fact.body || typeof fact.body !== 'object') return undefined;
  const statement = fact.body as Statement;
  return statement.id === fact.statement_id && statement.property?.id === fact.property ? statement : undefined;
}

function statementBytes(statement: Statement): number {
  return new TextEncoder().encode(JSON.stringify(statement)).byteLength;
}

function fieldFactsWithinBudget(facts: readonly FactRow[]): facts is readonly (FactRow & { body: Statement })[] {
  return (
    facts.length <= workReleaseCardFieldLimit &&
    facts.every((fact) => {
      const statement = statementOf(fact);
      return (
        statement !== undefined &&
        statement.qualifiers.length <= workReleaseCardQualifierLimit &&
        statement.references.length <= workReleaseCardReferenceLimit &&
        statement.references.every((reference) => reference.parts.length <= workReleaseCardReferencePartLimit) &&
        statementBytes(statement) <= workReleaseCardStatementBytes
      );
    })
  );
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Read only the finite selected facts used by public release comparison cards for the supplied page. */
export async function readWorkReleaseCards(input: {
  pool: Pool;
  routeKey: Uint8Array;
  subject: string;
  context?: string;
  defaults?: Readonly<Record<string, 'inherit' | 'suppress'>>;
  links: readonly MembershipLink[];
  caughtUp: boolean;
  release: Release;
  languages: readonly string[];
  deadline: number;
  seen: readonly SessionComponent[];
  authorizeSummary?: SummaryDependencies['authorize'];
}): Promise<WorkReleaseCards> {
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
            const view = await slotView(local, id, property, context, defaults);
            const facts = view.facts.filter((fact) => fact.kind === 'statement');
            if (!fieldFactsWithinBudget(facts)) {
              fields.set(property, { facts: [], withheld: false, unavailable: true });
              continue;
            }
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

    const targetIds = new Set<string>();
    for (const fields of selected.values()) {
      for (const field of fields.values()) {
        for (const fact of field.facts) {
          const statement = statementOf(fact);
          if (
            statement?.property.data_type === 'wikibase-item' &&
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
        if (!fieldFactsWithinBudget(field.facts)) {
          fields[property] = { state: 'unavailable' };
          continue;
        }
        if (!field.facts.length) {
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
        for (const fact of field.facts) {
          const statement = statementOf(fact);
          if (!statement) {
            withheld = true;
            break;
          }
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
