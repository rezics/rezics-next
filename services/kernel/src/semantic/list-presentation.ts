import {
  createReleasedRelationDirectionResolver,
  type Release,
  type ReleasedRelationDirectionResolver,
} from '@rezics/definitions';
import type { Source } from '@rezics/definitions/bulk';
import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { requireAccessDeadline, throwAccessUnavailable } from '../access/unavailable.ts';
import { readFences, type SourceFence, type SourceFenceTuple } from '../content/source-fences.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccessClient, type Actor } from '../request/access.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { chooseTexts, pendingFacts, validateHitOptions, type Fact } from '../search/hits.ts';
import {
  listWorkPlan,
  prepareListWorkContext,
  listWorkTargets,
  finishListWorkContext,
  type WorkTarget,
} from './list-presentation-work-context.ts';
import type { WorkContext } from '../search/work-context.ts';
import type { IndexedStatement } from '../search/source.ts';
import { activeRelease } from './definitions.ts';
import { subjectReadEligibility } from './eligibility.ts';
import { fenceKey, sourceTuple } from './fences.ts';
import type { IdentityMapping } from './identity-epoch-contract.ts';
import { readIdentityMappings } from './identity-adapters/identity-epoch-read.ts';
import { isRelationProperty, type FactRow } from './item.ts';
import { indexedStatement } from './search-source.ts';
import { effectiveGlobalSlotFacts } from './slots.ts';
import { withPublicStatementReader } from './statement-disclosure.ts';
import { readLabels } from './subject.ts';
import subjectsSQL from './list-presentation-subjects.sql';
import relationsSQL from './list-presentation-relations.sql';
import provenanceSQL from './list-presentation-provenance.sql';

type Dependencies = { pool: Pool; access: Access; actor: Actor; routeKey: Uint8Array; deadline: number };
type Header = {
  id: string;
  type: string;
  visibility: string;
  security: string;
  release: string | null;
  revision: number | null;
  source_epoch: number | null;
  source_position: string | null;
  redirect: string | null;
  account: string | null;
};
type Origin = {
  id: string;
  candidate: string;
  source: Source | null;
  author: string | null;
  principal_kind: string | null;
  consent_account: string | null;
  disclosed: boolean | null;
  retracted: boolean;
};
type Selected = { id: string; property: string; fact: FactRow; origin: Origin };
type SubjectObservation = {
  header: Header;
  selected: Selected[];
  basis: unknown[];
  withheld: string[];
  labels?: Record<string, string>;
};
type Account = { id: string; state: string; fenced: boolean; epoch: string };

function unready(): never {
  throw new ProblemError('semantic_not_ready');
}
function groups(ids: readonly string[]) {
  const result = new Map<number, string[]>();
  for (const id of new Set(ids)) {
    const route = routeOf(id);
    if (route === null) continue;
    const partition = partitionOf(route),
      list = result.get(partition) ?? [];
    list.push(id);
    result.set(partition, list);
  }
  return result;
}
const json = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry));
const equal = (a: unknown, b: unknown) => json(a) === json(b);
const entries = <T>(map: Map<string, T>) => [...map].sort(([a], [b]) => a.localeCompare(b));

/** Each native home is released before Access preparation or any foreign home. */
async function snapshot<T>(
  deps: Dependencies,
  home: number,
  work: (client: AccessClient, position: bigint, epoch: number) => Promise<T>,
) {
  return within(deps.deadline, () =>
    withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deps.deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partition = await readPartition(client, home);
        if (!partition || partition.writeState !== 'active') unready();
        const value = await work(client, partition.position, partition.epoch);
        requireAccessDeadline(deps.deadline);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

async function observeSubjects(
  deps: Dependencies,
  ids: readonly string[],
  release: Release,
  facts: boolean,
  labels = false,
  workContext = false,
  directionResolver?: ReleasedRelationDirectionResolver,
) {
  const results = new Map<string, SubjectObservation | null>();
  for (const [home, group] of groups(ids)) {
    for (let offset = 0; offset < group.length; offset += 100) {
      const list = group.slice(offset, offset + 100);
      // Prepare actual Access evidence with no source checkout. Never retain a verdict across reads.
      const checks = new Map<string, Awaited<ReturnType<typeof accessCheck>>>();
      for (const id of list) {
        const route = routeOf(id)!;
        checks.set(
          id,
          await accessCheck(
            deps.access,
            deps.actor,
            'subject:read',
            {
              route,
              id,
              eligibility: subjectReadEligibility({ route, id }),
            },
            { pool: deps.pool, deadline: deps.deadline },
          ),
        );
      }
      const observed = await snapshot(deps, home, async (client, _position, epoch) => {
        const rows = (await client.query<Header>(subjectsSQL.sql, [list.map((id) => routeOf(id)!), list])).rows;
        const found = new Map(rows.map((row) => [row.id, row]));
        const visible = new Map<string, SubjectObservation>();
        for (const id of list) {
          const row = found.get(id);
          if (facts && !row) unready();
          if (row?.visibility !== 'visible' || !(await checks.get(id)!(client))) continue;
          if (row.revision === null || row.release === null) unready();
          visible.set(id, { header: row, selected: [], basis: [], withheld: [] });
        }
        if (labels && visible.size) {
          const values = await readLabels(client, [...visible.keys()]);
          for (const [id, value] of visible) value.labels = values.get(id) ?? {};
        }
        if (!facts) return visible;
        const requested = [...visible.values()].flatMap(({ header }) => {
          if (header.redirect) return [];
          const type = release.types[header.type];
          if (!type) unready();
          const plan = workContext ? listWorkPlan(release, header.type, directionResolver) : undefined;
          return [
            ...new Set([
              ...(type.listPresentation?.keyFacts ?? []),
              ...(plan ? [...plan.creators, ...plan.relations, ...plan.dates] : []),
            ]),
          ].map((property) => ({
            route: routeOf(header.id)!,
            id: header.id,
            property,
          }));
        });
        const relations = requested.filter(({ property }) => isRelationProperty(release, property));
        const locators = relations.length
          ? (
              await client.query<{
                id: string;
                property: string;
                slot: string;
                candidate: string;
                order_key: string;
                source_revision: number;
                source_security_revision: string;
              }>(relationsSQL.sql, [json(relations), workContext ? 4 : 3])
            ).rows
          : [];
        if (relations.length) {
          const checkpoint = (
            await client.query<{ epoch: number; position: string }>(
              'SELECT epoch, position::text FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer=$2',
              [home, 'semantic_links'],
            )
          ).rows[0];
          // Relation locators are never authority, including a projected empty range.
          if (!checkpoint || checkpoint.epoch !== epoch) unready();
          for (const { id } of relations) {
            const header = visible.get(id)!.header;
            if (
              header.source_epoch === null ||
              header.source_position === null ||
              header.source_epoch !== epoch ||
              BigInt(checkpoint.position) < BigInt(header.source_position)
            )
              unready();
          }
          for (const locator of locators) {
            const header = visible.get(locator.id)!.header;
            if (locator.source_revision !== header.revision || locator.source_security_revision !== header.security)
              unready();
          }
        }
        // Four candidate locators per category prove at most three disclosed entries plus lookahead.
        // Generic facts retain their independent three-per-property prefix.
        const workCandidates = new Set<string>();
        if (workContext)
          for (const [id, observation] of visible) {
            const plan = listWorkPlan(release, observation.header.type, directionResolver);
            if (!plan) continue;
            for (const group of ['creators', 'relations'] as const)
              for (const row of locators
                .filter((row) => row.id === id && plan[group].includes(row.property))
                .slice(0, 4))
                workCandidates.add(`${id}/${row.candidate}`);
          }
        const selected: { id: string; property: string; fact: FactRow }[] = [];
        for (const request of requested) {
          const observation = visible.get(request.id)!;
          const relation = isRelationProperty(release, request.property);
          const allLocators = locators.filter((row) => row.id === request.id && row.property === request.property);
          const generic = release.types[observation.header.type]!.listPresentation?.keyFacts.includes(request.property);
          const chosenLocators = allLocators.filter(
            (row, index) => (generic && index < 3) || workCandidates.has(`${request.id}/${row.candidate}`),
          );
          const slots = relation ? [...new Set(chosenLocators.map((row) => row.slot))] : [undefined];
          observation.basis.push({
            property: request.property,
            locators: relation
              ? locators.filter((row) => row.id === request.id && row.property === request.property)
              : [],
          });
          for (const slot of slots) {
            const view = await effectiveGlobalSlotFacts(client, request.id, request.property, slot);
            observation.basis.push(view);
            if (workContext) {
              const basis = view.basis as { selection?: { rank: string }[] } | { rank: string }[] | null;
              const count = (Array.isArray(basis) ? basis : (basis?.selection ?? [])).filter(
                (entry) => entry.rank !== 'deprecated',
              ).length;
              if (
                count >
                  view.facts.filter((fact) =>
                    ['normal', 'preferred'].includes((fact.body as { rank?: string }).rank ?? ''),
                  ).length ||
                (relation &&
                  chosenLocators
                    .filter((row) => row.slot === slot)
                    .some((row) => !view.facts.some((fact) => fact.statement_id === row.candidate)))
              )
                observation.withheld.push(request.property);
            }
            for (const fact of view.facts) {
              if (relation && !chosenLocators.some((row) => row.candidate === fact.statement_id)) continue;
              selected.push({ id: request.id, property: request.property, fact });
            }
          }
        }
        for (let offset = 0; offset < selected.length; offset += 256) {
          const page = selected.slice(offset, offset + 256);
          const origins = (
            await client.query<Origin>(provenanceSQL.sql, [
              json(
                page.map(({ id, fact }) => ({
                  route: routeOf(id)!,
                  id,
                  candidate: fact.statement_id,
                  revision: fact.fact_revision,
                })),
              ),
              home,
            ])
          ).rows;
          const byKey = new Map(origins.map((row) => [`${row.id}/${row.candidate}`, row]));
          for (const entry of page) {
            const origin = byKey.get(`${entry.id}/${entry.fact.statement_id}`);
            if (!origin || origin.principal_kind === null) unready();
            visible.get(entry.id)!.selected.push({ ...entry, origin });
          }
        }
        return visible;
      });
      for (const id of list) results.set(id, observed.get(id) ?? null);
    }
  }
  return results;
}

async function accounts(deps: Dependencies, ids: readonly string[]) {
  const results = new Map<string, Account>();
  for (const [home, group] of groups(ids)) {
    const rows = await snapshot(
      deps,
      home,
      async (client) =>
        (
          await client.query<Account>(
            `SELECT a.account_id::text AS id, a.state, a.authn_fenced AS fenced, a.minimum_authn_epoch::text AS epoch
       FROM unnest($1::integer[], $2::uuid[]) wanted(route,id)
       JOIN LATERAL (SELECT account_id,state,authn_fenced,minimum_authn_epoch FROM access.account
         WHERE route=wanted.route AND account_id=wanted.id LIMIT 1) a ON true ORDER BY a.account_id`,
            [group.map((id) => routeOf(id)!), group],
          )
        ).rows,
    );
    for (const row of rows) results.set(row.id, row);
  }
  return results;
}

async function tuples(deps: Dependencies, values: readonly SourceFenceTuple[]) {
  const homes = new Map<number, SourceFenceTuple[]>();
  for (const tuple of new Map(values.map((value) => [fenceKey(value), value])).values()) {
    const home = partitionOf(tuple.route),
      group = homes.get(home) ?? [];
    group.push(tuple);
    homes.set(home, group);
  }
  const results = new Map<string, SourceFence>();
  for (const [home, group] of homes) {
    const rows = await snapshot(deps, home, async (client) => {
      const found = [];
      for (let offset = 0; offset < group.length; offset += 100)
        found.push(...(await readFences(client, group.slice(offset, offset + 100))));
      return found;
    });
    for (const row of rows) results.set(fenceKey(row), row);
  }
  if (results.size !== new Set(values.map(fenceKey)).size) unready();
  return results;
}

function tupleFor(deps: Dependencies, source: Source | null): SourceFenceTuple | null {
  if (!source || !('field_group' in source)) return null;
  if (source.field_group !== 'facts') unready();
  try {
    return sourceTuple(deps.routeKey, source);
  } catch {
    return unready();
  }
}

/** Reject a lossy numeric projection before using the existing Search Fact formatter. */
function representable(fact: FactRow, release: Release): IndexedStatement | null {
  const body = fact.body as { rank?: string; value?: { type: string; content?: unknown } };
  if (!['normal', 'preferred'].includes(body.rank ?? '') || body.value?.type !== 'value') return null;
  const property = fact.property!;
  if (release.properties[property]?.datatype === 'quantity') {
    const content = body.value.content as { amount?: unknown; unit?: unknown } | null;
    if (!content || typeof content.amount !== 'string' || typeof content.unit !== 'string') return null;
    const amount = Number(content.amount);
    if (!Number.isFinite(amount) || (Number.isInteger(amount) && !Number.isSafeInteger(amount))) return null;
    // Decimal round-trip: accepting +1.00 is exact; accepting a rounded 16-digit fraction is not.
    const normalize = (input: string) => {
      const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(input);
      if (!match) return null;
      let digits = (match[2]! + (match[3] ?? '')).replace(/^0+/, '');
      if (!digits) return '0';
      let exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
      while (digits.endsWith('0')) {
        digits = digits.slice(0, -1);
        exponent++;
      }
      return `${match[1] === '-' ? '-' : ''}${digits}e${exponent}`;
    };
    if (normalize(content.amount) === null || normalize(content.amount) !== normalize(String(amount))) return null;
  }
  return indexedStatement(
    {
      subject_id: '',
      property,
      rank: body.rank as 'normal' | 'preferred',
      body: fact.body,
      release: fact.fact_release!,
      ordinal: 0,
    },
    release,
  );
}

/** One current original-keyed public batch. No Source snapshot, index document or permission verdict is authority. */
export async function readListPresentationFacts(
  deps: Dependencies,
  originals: readonly string[],
  options: { languages?: readonly string[]; workContext?: boolean } = {},
): Promise<Map<string, { id: string; facts: Record<string, Fact[]>; workContext?: WorkContext } | null>> {
  if (!Array.isArray(originals) || originals.length > 100 || originals.some((id) => typeof id !== 'string'))
    throw new RangeError('List presentation accepts at most 100 raw original IDs');
  if (!Number.isFinite(deps.deadline) || !(deps.routeKey instanceof Uint8Array) || deps.routeKey.length !== 32)
    throw new TypeError('List presentation requires the trusted route key and finite request deadline');
  const { languages } = validateHitOptions(options);
  const input = [...new Set(originals)];
  const result = new Map<string, { id: string; facts: Record<string, Fact[]>; workContext?: WorkContext } | null>(
    input.map((id) => [id, null]),
  );
  requireAccessDeadline(deps.deadline);
  if (!input.length) return result;
  return withRequestDeadline(deps.deadline, () =>
    within(deps.deadline, () =>
      withPublicStatementReader(async () => {
        try {
          const valid = input.filter((id) => routeOf(id) !== null);
          if (!valid.length) return result;
          const active = await snapshot(deps, 0, (client) => activeRelease(client));
          if (!active) unready();
          const directionResolver = createReleasedRelationDirectionResolver(active.release, active.digest);
          const sources = await observeSubjects(deps, valid, active.release, false);
          const admitted = valid.filter((id) => sources.get(id) !== null);
          const mapping = await readIdentityMappings(deps.pool, admitted);
          if (mapping.some((value) => value.state === 'pending' || value.state === 'unavailable')) unready();
          const terminals = [
            ...new Set(mapping.flatMap((value) => (value.state === 'mapped' ? [value.terminal] : []))),
          ];
          const subjects = await observeSubjects(
            deps,
            terminals,
            active.release,
            true,
            false,
            options.workContext === true,
            directionResolver,
          );
          const allSelected = [...subjects.values()].flatMap((value) => value?.selected ?? []);
          const sourceTuples = allSelected.flatMap(({ origin }) => {
            const tuple = tupleFor(deps, origin.source);
            return tuple ? [tuple] : [];
          });
          const fences = await tuples(deps, sourceTuples);
          const accountIds = [
            ...new Set([
              ...[...sources.values(), ...subjects.values()].flatMap((value) =>
                value?.header.account ? [value.header.account] : [],
              ),
              ...allSelected.flatMap(({ origin }) =>
                [origin.author, origin.consent_account].filter((id): id is string => id !== null),
              ),
            ]),
          ];
          let authorStates = await accounts(deps, accountIds);
          if (accountIds.some((id) => !authorStates.has(id))) unready();
          const liveAccount = (id: string | null) => id === null || authorStates.get(id)?.state !== 'deleted';
          const workDrafts = new Map<string, ReturnType<typeof prepareListWorkContext>>();
          const projected = new Map(
            [...subjects].flatMap(([id, subject]) => {
              if (!subject) return [];
              const allowed: FactRow[] = [];
              const withheld = new Set(subject.withheld);
              const statements = subject.selected.flatMap(({ fact, origin }) => {
                if (
                  origin.retracted ||
                  (origin.consent_account && (!origin.disclosed || !liveAccount(origin.consent_account)))
                ) {
                  withheld.add(fact.property!);
                  return [];
                }
                const tuple = tupleFor(deps, origin.source);
                if (tuple && fences.get(fenceKey(tuple))?.takenDown) {
                  withheld.add(fact.property!);
                  return [];
                }
                allowed.push(fact);
                const value = representable(fact, active.release);
                return value ? [value] : [];
              });
              if (options.workContext)
                workDrafts.set(
                  id,
                  prepareListWorkContext(
                    id,
                    subject.header.type,
                    active.release,
                    allowed,
                    withheld,
                    languages,
                    directionResolver,
                  ),
                );
              return [
                [
                  id,
                  pendingFacts(
                    { statements },
                    active.release.types[subject.header.type]!.listPresentation?.keyFacts ?? [],
                  ),
                ] as const,
              ];
            }),
          );
          // Generic facts retain their independent availability. Work-only pending identities are explicit below.
          const genericItemIds = new Set(
            [...projected.values()].flatMap((properties) =>
              [...properties.values()].flatMap((values) =>
                values.flatMap((value) => (value.kind === 'item' ? [value.id] : [])),
              ),
            ),
          );
          const itemIds = [...new Set([...[...workDrafts.values()].flatMap(listWorkTargets), ...genericItemIds])];
          const itemMapping: IdentityMapping[] = [];
          for (let offset = 0; offset < itemIds.length; offset += 100)
            itemMapping.push(...(await readIdentityMappings(deps.pool, itemIds.slice(offset, offset + 100))));
          if (
            itemMapping.some(
              (value, index) =>
                genericItemIds.has(itemIds[index]!) && (value.state === 'pending' || value.state === 'unavailable'),
            )
          )
            unready();
          const relatedIds = [
            ...new Set([
              ...itemIds,
              ...itemMapping.flatMap((value) => (value.state === 'mapped' ? [value.terminal] : [])),
            ]),
          ];
          const related = await observeSubjects(deps, relatedIds, active.release, false, true);
          const relatedAccounts = [
            ...new Set([...related.values()].flatMap((value) => (value?.header.account ? [value.header.account] : []))),
          ].filter((id) => !accountIds.includes(id));
          accountIds.push(...relatedAccounts);
          authorStates = new Map([...authorStates, ...(await accounts(deps, relatedAccounts))]);
          if (accountIds.some((id) => !authorStates.has(id))) unready();

          // Double collection of the complete finite dependency set proves a common current cut.
          if (!equal(mapping, await readIdentityMappings(deps.pool, admitted))) unready();
          if (!equal([...sources], [...(await observeSubjects(deps, valid, active.release, false))])) unready();
          if (
            !equal(
              [...subjects],
              [...(await observeSubjects(deps, terminals, active.release, true, false, options.workContext === true))],
            )
          )
            unready();
          const finalItemMapping: IdentityMapping[] = [];
          for (let offset = 0; offset < itemIds.length; offset += 100)
            finalItemMapping.push(...(await readIdentityMappings(deps.pool, itemIds.slice(offset, offset + 100))));
          if (
            !equal(itemMapping, finalItemMapping) ||
            !equal([...related], [...(await observeSubjects(deps, relatedIds, active.release, false, true))])
          )
            unready();
          if (
            !equal(entries(authorStates), entries(await accounts(deps, accountIds))) ||
            !equal([...fences], [...(await tuples(deps, sourceTuples))])
          )
            unready();
          const finalActive = await snapshot(deps, 0, (client) => activeRelease(client));
          if (finalActive?.digest !== active.digest) unready();
          const workTargets = new Map<string, WorkTarget | null>();
          for (const [index, id] of itemIds.entries()) {
            const identity = itemMapping[index];
            if (identity?.state === 'pending' || identity?.state === 'unavailable') {
              workTargets.set(id, { state: 'unavailable' });
              continue;
            }
            const original = related.get(id);
            const terminal = identity?.state === 'mapped' ? related.get(identity.terminal) : null;
            if (
              !original ||
              !terminal ||
              !liveAccount(original.header.account) ||
              !liveAccount(terminal.header.account)
            ) {
              workTargets.set(id, null);
              continue;
            }
            if (
              identity?.state !== 'mapped' ||
              original.header.redirect !== (id === identity.terminal ? null : identity.terminal) ||
              terminal.header.redirect
            )
              unready();
            workTargets.set(id, { id: identity.terminal, type: terminal.header.type, labels: terminal.labels ?? {} });
          }
          for (const [index, original] of admitted.entries()) {
            const identity = mapping[index]!;
            if (identity.state !== 'mapped') continue;
            const source = sources.get(original),
              subject = subjects.get(identity.terminal);
            if (!source || !subject || !liveAccount(source.header.account) || !liveAccount(subject.header.account))
              continue;
            if (
              source.header.redirect !== (original === identity.terminal ? null : identity.terminal) ||
              subject.header.redirect
            )
              unready();
            const facts: Record<string, Fact[]> = {};
            for (const [property, values] of projected.get(identity.terminal)!) {
              const disclosed = values.flatMap((value): Fact[] => {
                if (value.kind !== 'item') return [value];
                const identity = itemMapping[itemIds.indexOf(value.id)];
                const original = related.get(value.id);
                const terminal = identity?.state === 'mapped' ? related.get(identity.terminal) : null;
                if (
                  !original ||
                  !terminal ||
                  !liveAccount(original.header.account) ||
                  !liveAccount(terminal.header.account)
                )
                  return [];
                if (
                  original.header.redirect !==
                    (identity!.state === 'mapped' && identity!.terminal !== value.id ? identity!.terminal : null) ||
                  terminal.header.redirect
                )
                  unready();
                return [
                  {
                    kind: 'item',
                    id: identity!.state === 'mapped' ? identity!.terminal : value.id,
                    labels: chooseTexts(
                      Object.entries(terminal.labels ?? {}).map(([language, value]) => ({ language, value })),
                      languages,
                      undefined,
                    ),
                  },
                ];
              });
              if (disclosed.length) facts[property] = disclosed;
            }
            const workContext = finishListWorkContext(
              identity.terminal,
              workDrafts.get(identity.terminal),
              workTargets,
              active.release,
              languages,
            );
            result.set(original, { id: identity.terminal, facts, ...(workContext ? { workContext } : {}) });
          }
          requireAccessDeadline(deps.deadline);
          return result;
        } catch (error) {
          throwAccessUnavailable(error, deps.deadline);
          throw error;
        }
      }),
    ),
  );
}
