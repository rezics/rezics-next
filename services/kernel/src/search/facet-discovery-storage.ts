import type { FacetNativePlan, FacetNativeRead } from './facet-discovery-native.ts';
import type { PublicFilterConsumerContext, PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';
import type { PublicFilterCost } from '../semantic/index.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import { discardConnection, withConnection } from '../database/pool.ts';
import { withBoundedReadLifetime } from '../database/bounded-read-lifetime.ts';
import type { KernelClock } from '../clock.ts';
import type { PrivacyReductionStart, PublicFilterSource, PublicFilterProjectionFrontier } from '../semantic/index.ts';
import type { PublicFilterSourceBinding } from '../semantic/index.ts';
import type { FacetPopulationSource } from '../semantic/facet-population-contract.ts';
import type { OpenSearch } from './opensearch.ts';
import { assertCompleteSearch } from './complete-search.ts';
import { compileText } from './text.ts';
import { compileCreditedText } from './credit-search-query.ts';
import { creditEvidenceFromEngineHit, verifyCreditedHit } from './credit-hit.ts';
import { compileCurrentFilter } from './current-filter-plan.ts';
import { holdsCurrentStatements, holdsCurrentType } from './current-leaf.ts';
import { subjectPartition, type SubjectSource, type RelationFacetMatch } from './source.ts';
import { validateRequestSourceSnapshot } from './request-source-snapshot.ts';
import {
  scopedFacetIdentityKey,
  type ScopedFacetAdmission,
  type ScopedFacetObservation,
  type ScopedFacetPage,
} from './scoped-facet-source.ts';
import { sourceObservationIsDisclosable } from './query-privacy-observation.ts';

const idle = 24 * 60 * 60 * 1000;
const rollbackTimeoutMs = 100;
const deadlineError = () => new Error('Facet deadline exceeded');
const emptyCost = (): PublicFilterCost => ({
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
});
type Meter = { -readonly [K in keyof PublicFilterCost]: number };
function add(meter: Meter, cost: PublicFilterCost) {
  for (const key of Object.keys(meter) as (keyof PublicFilterCost)[]) {
    if (!Number.isSafeInteger(cost[key]) || cost[key] < 0) throw new Error('Invalid native facet cost');
    meter[key] += cost[key];
  }
}
const hash = (value: unknown) =>
  createHash('sha256')
    .update(canonicalize(value) ?? '')
    .digest('hex');
type Generation = {
  state: 'building' | 'ready' | 'retired';
  phase: 'population' | 'projection' | 'contribute' | 'seal';
  version: string;
  lease_until: string;
  expires_at: string;
  frontier: string | null;
  population_complete: boolean;
  subject: string | null;
  terminal: string | null;
  subject_type: string | null;
  security_revision: string | null;
  projection: { build: string; generation: string; continuation: string } | null;
  accumulator: RelationFacetMatch[];
  contribution_after: string | null;
  as_of: string | null;
};
type StoredValue = {
  value: string;
  labels: Record<string, string>;
  contributor_original: string;
  contributor_terminal: string;
  target_original: string | null;
  target_terminal: string | null;
};

/** Search-owned value preparation and paging. Shared consumer capture/repair plus Semantic's complete population
 * or the admitted scoped candidate/membership source own lifecycle and coverage. No registration, guard,
 * bootstrap or ACK is implemented here.
 */
export function createFacetDiscoveryStorage(
  config: Readonly<{
    pool: Pool;
    source: PublicFilterSource;
    binding: PublicFilterSourceBinding;
    population: FacetPopulationSource;
    scopedFacets?: Readonly<{
      observe: (
        admission: ScopedFacetAdmission,
        context: PublicFilterConsumerContext,
      ) => Promise<ScopedFacetObservation>;
      readPage: (
        admission: ScopedFacetAdmission,
        after: string | null,
        inputLimit: number,
        context: PublicFilterConsumerContext,
      ) => Promise<ScopedFacetPage>;
    }>;
    subjects: SubjectSource;
    search: OpenSearch;
    clock: KernelClock;
  }>,
) {
  const { pool, source, binding, population, scopedFacets, subjects, search, clock } = config;
  function check(context: PublicFilterConsumerContext) {
    if (!Number.isFinite(context.deadline) || Date.now() >= context.deadline) throw deadlineError();
  }
  /** The shared lifetime bounds checkout and every statement without imposing a read-only transaction.
   * Physical custody outlives a refused turn only for bounded rollback; owner I/O never holds this client.
   */
  function connection<T>(
    context: PublicFilterConsumerContext,
    work: (db: PoolClient) => Promise<T>,
    transaction = false,
  ): Promise<T> {
    const deadline = context.deadline;
    let began = false;
    let committed = false;
    return withBoundedReadLifetime(
      (run) =>
        withConnection(pool, async (raw) => {
          try {
            // A checkout can arrive after its waiter has expired. Never return that late client to the pool.
            if (Date.now() >= deadline) throw deadlineError();
            return await run(raw);
          } finally {
            if (began && !committed) {
              try {
                // The expired/retired work client cannot roll back. Only cleanup uses this separate deadline.
                await withBoundedReadLifetime(
                  (cleanup) => cleanup(raw),
                  discardConnection,
                  Date.now() + rollbackTimeoutMs,
                  (db) => db.query('ROLLBACK'),
                  { isUncertainSettledQueryError: () => true },
                );
              } catch (error) {
                discardConnection(raw, error instanceof Error ? error : new Error('Facet rollback failed'));
              }
            }
            if (Date.now() >= deadline) discardConnection(raw, deadlineError());
          }
        }),
      discardConnection,
      deadline,
      async (db) => {
        if (!transaction) return work(db);
        began = true;
        await db.query('BEGIN');
        const result = await work(db);
        await db.query('COMMIT');
        committed = true;
        return result;
      },
      { deadlineError, isUncertainSettledQueryError: () => true },
    );
  }
  function writeTransaction<T>(context: PublicFilterConsumerContext, work: (db: PoolClient) => Promise<T>) {
    return connection(context, work, true);
  }
  async function sql<T extends import('pg').QueryResultRow>(
    context: PublicFilterConsumerContext,
    db: Pool | PoolClient,
    meter: Meter,
    query: string,
    args: unknown[],
  ) {
    const execute = async (client: Pool | PoolClient) => {
      const result = await client.query<T>(query, args);
      if (/^(INSERT|UPDATE|DELETE)/.test(query)) meter.resultWrites += result.rowCount ?? 0;
      return result.rows;
    };
    return db === pool ? connection(context, execute) : execute(db);
  }
  async function anchor(id: string, meter: Meter) {
    meter.accessPoints++;
    const partition = subjectPartition(id);
    const snapshot = await subjects.read(partition, [id]);
    return validateRequestSourceSnapshot(snapshot, partition, [id]).get(id);
  }
  async function target(id: string, meter: Meter) {
    const original = await anchor(id, meter);
    if (!original || original.visibility !== 'visible') return null;
    const terminal = original.redirect ? await anchor(original.redirect, meter) : original;
    if (!terminal || terminal.visibility !== 'visible' || terminal.redirect !== null) return null;
    return {
      original: id,
      terminal: terminal.id,
      labels: Object.fromEntries(terminal.labels.map(({ language, value }) => [language, value])),
    };
  }
  function coordinates(plan: FacetNativePlan, queried: PublicFilterQueriedObservation, partition: number) {
    const scope = plan.scope ? scopedFacetIdentityKey(plan.scope.identity) : null;
    return [
      partition,
      hash({
        consumer: queried.consumer,
        property: plan.property,
        meaning: plan.meaning.digest,
        kinds: plan.kinds ?? null,
        text: plan.text ?? null,
        textField: plan.textField ?? null,
        creditQualifiers: plan.creditQualifiers ?? null,
        ...(scope === null ? {} : { scope }),
      }),
      hash({
        observation: queried.snapshot.observation,
        property: plan.property,
        kinds: plan.kinds ?? null,
        text: plan.text ?? null,
        textField: plan.textField ?? null,
        creditQualifiers: plan.creditQualifiers ?? null,
        ...(scope === null ? {} : { scope }),
      }),
    ];
  }
  async function join(
    plan: FacetNativePlan,
    queried: PublicFilterQueriedObservation,
    context: PublicFilterConsumerContext,
    meter: Meter,
  ) {
    const joined = await binding.join({ queried }, context);
    add(meter, joined.cost);
    if (joined.status !== 'joined') return null;
    // The actual Source definition must cover value membership AND target labels, including excluded contributors.
    const keys = joined.definition.dependencyKeys;
    const capturedText = plan.textField === 'credited_creator' ? undefined : plan.text;
    if (
      hash({
        filter: joined.definition.capture.filterDocument ?? null,
        text: joined.definition.capture.text ?? null,
      }) !== hash({ filter: plan.filterDocument ?? null, text: capturedText ?? null }) ||
      joined.definition.meaning.digest !== plan.meaning.digest ||
      !keys.some((key) =>
        plan.valueKind === 'type' ? key.kind === 'type' : key.kind === 'property' && key.property === plan.property,
      ) ||
      (plan.valueKind === 'item' && !keys.some((key) => key.kind === 'field' && key.field === 'labels'))
    )
      return null;
    return joined;
  }
  async function creditedMembership(
    plan: FacetNativePlan,
    observation: PublicFilterQueriedObservation | undefined,
    subject: string,
    context: PublicFilterConsumerContext,
    meter: Meter,
  ): Promise<'match' | 'absent' | 'unready'> {
    if (plan.textField !== 'credited_creator') return 'match';
    if (!plan.text || !observation || observation.snapshot.kind !== 'pit') return 'unready';
    const predicate = compileCreditedText(plan.text, plan.creditQualifiers ?? []).query;
    const response = await search.request<{
      hits: { hits: { _id: string; inner_hits?: unknown }[] };
    }>(
      'POST',
      '/_search',
      {
        pit: { id: observation.snapshot.pit, keep_alive: '1m' },
        size: 1,
        track_total_hits: false,
        version: true,
        _source: false,
        query: {
          bool: {
            filter: [
              { ids: { values: [subject] } },
              ...(plan.kinds?.length ? [{ terms: { kind: [...plan.kinds] } }] : []),
              predicate,
            ],
          },
        },
      },
      { timeoutMs: Math.max(1, context.deadline - Date.now()) },
    );
    meter.engineSearches++;
    assertCompleteSearch(response.body);
    const hits = response.body.hits.hits;
    if (hits.length === 0) return 'absent';
    const hit = hits[0];
    if (hits.length !== 1 || !hit || hit._id !== subject) return 'unready';
    const evidence = creditEvidenceFromEngineHit(hit);
    if (!evidence) return 'unready';
    const verified = await verifyCreditedHit(subjects.creditSearch, subject, evidence);
    if (verified.state === 'current') return 'match';
    if (verified.state === 'absent') return 'absent';
    return 'unready';
  }
  async function safe(
    queried: PublicFilterQueriedObservation,
    execution: Readonly<{ start: PrivacyReductionStart; execution: string }>,
    context: PublicFilterConsumerContext,
    meter: Meter,
  ) {
    const observed = await source.readPrivacyReductionHeads({
      kind: 'population',
      queried,
      start: execution.start,
      execution: execution.execution,
      context,
    });
    add(meter, observed.cost);
    return sourceObservationIsDisclosable(observed) ? observed : null;
  }
  async function safeScope(plan: FacetNativePlan, context: PublicFilterConsumerContext, meter: Meter) {
    if (!plan.scope) return true;
    if (!scopedFacets) return false;
    const observed = await scopedFacets.observe(plan.scope, context);
    add(meter, observed.cost);
    return (
      observed.status === 'observed' &&
      scopedFacetIdentityKey(observed.identity) === scopedFacetIdentityKey(plan.scope.identity)
    );
  }
  /** One complete native input record per durable step. Lower producer limits, retries and rejects remain charged.
   * Effects and their frontier commit together by version CAS, after releasing connections for all owner I/O.
   */
  async function step(
    plan: FacetNativePlan,
    queried: PublicFilterQueriedObservation,
    context: PublicFilterConsumerContext,
    meter: Meter,
    textObservation?: PublicFilterQueriedObservation,
    execution?: Readonly<{ start: PrivacyReductionStart; execution: string }>,
  ) {
    check(context);
    const joined = await join(plan, queried, context, meter);
    if (!joined || queried.snapshot.kind !== 'prepared') return false;
    const key = coordinates(plan, queried, joined.definition.source.partition);
    const now = clock().getTime();
    await sql(
      context,
      pool,
      meter,
      `UPDATE search.facet_generation SET state='retired'
      WHERE partition_no=$1 AND definition=$2 AND state='building' AND expires_at<=$3`,
      [key[0], key[1], now],
    );
    await sql(
      context,
      pool,
      meter,
      `UPDATE search.facet_generation SET state='retired'
      WHERE partition_no=$1 AND definition=$2 AND state='ready' AND expires_at<=$3`,
      [key[0], key[1], now],
    );
    await sql(
      context,
      pool,
      meter,
      `INSERT INTO search.facet_generation
      (partition_no,definition,generation,property,observation,state,phase,expires_at)
      VALUES ($1,$2,$3,$4,$5,'building','population',$6) ON CONFLICT DO NOTHING`,
      [...key, plan.property, queried.snapshot.observation, now + idle],
    );
    const rows = await sql<Generation>(
      context,
      pool,
      meter,
      `UPDATE search.facet_generation SET lease_until=$4
      WHERE partition_no=$1 AND definition=$2 AND generation=$3 AND state='building'
      AND expires_at>$5 AND lease_until<=$6 RETURNING *`,
      [...key, context.deadline, now, Date.now()],
    );
    const state = rows[0];
    if (!state) {
      const current = await sql<{ state: string }>(
        context,
        pool,
        meter,
        `SELECT state FROM search.facet_generation
        WHERE partition_no=$1 AND definition=$2 AND generation=$3 AND expires_at>$4`,
        [...key, now],
      );
      return current[0]?.state === 'ready';
    }
    const changed = async () => {
      await sql(
        context,
        pool,
        meter,
        `UPDATE search.facet_generation SET state='retired',expires_at=$6,version=version+1
        WHERE partition_no=$1 AND definition=$2 AND generation=$3 AND version=$4 AND lease_until=$5`,
        [...key, state.version, context.deadline, clock().getTime()],
      );
      return 'changed' as const;
    };
    const planner = plan.filterDocument ? compileCurrentFilter(plan.filterDocument) : null;
    let phase = state.phase;
    let frontier = state.frontier;
    let complete = state.population_complete;
    let subject = state.subject;
    let terminal = state.terminal;
    let subjectType = state.subject_type;
    let security = state.security_revision;
    let projection = state.projection;
    let accumulator = [...state.accumulator];
    let after = state.contribution_after;
    let publish = false;
    const staged: {
      key: string;
      value: string;
      labels: Record<string, string>;
      original: string | null;
      terminal: string | null;
    }[] = [];
    let contributions: (StoredValue & { key: string })[] = [];
    let failed = false;
    try {
      if (phase === 'population') {
        if (plan.scope && !scopedFacets) return false;
        const page: ScopedFacetPage | Awaited<ReturnType<FacetPopulationSource['readFacetPopulationPage']>> = plan.scope
          ? await scopedFacets!.readPage(plan.scope, frontier, 1, context)
          : await population.readFacetPopulationPage({
              population: joined.definition.readDefinition,
              frontier,
              inputLimit: 1,
              capture: { kind: 'population', queried, start: null, context },
            });
        add(meter, page.cost);
        if (page.status === 'changed') return await changed();
        if (page.status !== 'progress' && page.status !== 'complete') return false;
        const expectedPopulation = plan.scope
          ? scopedFacetIdentityKey(plan.scope.identity)
          : queried.snapshot.observation;
        if (
          page.observation !== expectedPopulation ||
          page.subjects.length > 1 ||
          !page.frontier ||
          (page.status === 'progress' && page.frontier === frontier)
        )
          return false;
        frontier = page.frontier;
        complete = page.status === 'complete';
        const next = page.subjects[0];
        if (next) {
          if (subjectPartition(next.subject) !== next.partition) return false;
          subject = next.subject;
          const current = await anchor(subject, meter);
          // A hidden original never borrows a public survivor's membership.
          if (current?.visibility === 'visible' && current.redirect === null) {
            terminal = current.id;
            subjectType = current.type;
            security = String(current.securityRevision);
            accumulator =
              planner?.leaves.map((leaf) => (leaf.facet === 'type' ? holdsCurrentType(current.type, leaf) : false)) ??
              [];
            projection = null;
            after = null;
            phase = 'projection';
          } else {
            subject = null;
            phase = complete ? 'seal' : 'population';
          }
        } else phase = complete ? 'seal' : 'population';
      } else if (phase === 'projection' && subject && terminal) {
        const previous: PublicFilterProjectionFrontier | null = projection
          ? { ...projection, generation: BigInt(projection.generation) }
          : null;
        const page = await source.readPublicFilterProjectionPage({
          subject,
          meaning: plan.meaning,
          inputLimit: 1,
          frontier: previous,
          context,
        });
        add(meter, page.cost);
        if (page.status === 'changed') return await changed();
        if (page.status !== 'progress' && page.status !== 'complete') return false;
        if (
          page.source.subject !== subject ||
          page.source.terminal !== terminal ||
          page.source.securityRevision !== security
        )
          return await changed();
        if (
          page.records.length > 1 ||
          (previous && page.frontier.continuation === previous.continuation && page.status === 'progress')
        )
          return false;
        if (previous && (page.frontier.build !== previous.build || page.frontier.generation !== previous.generation))
          return await changed();
        projection = { ...page.frontier, generation: page.frontier.generation.toString() };
        for (const record of page.records) {
          if (record.subject !== subject || record.terminal !== terminal) return false;
          for (const [index, leaf] of (planner?.leaves ?? []).entries()) {
            if (leaf.facet !== 'statement' || leaf.property !== record.statement.property.id) continue;
            const match = record.indexed ? holdsCurrentStatements([record.indexed], leaf) : 'not_proven';
            if (match === true) accumulator[index] = true;
            else if (match === 'not_proven' && accumulator[index] !== true) accumulator[index] = 'not_proven';
          }
          if (plan.valueKind === 'type' || record.statement.property.id !== plan.property) continue;
          if (record.statement.value.type !== 'value') continue;
          const value = record.statement.value.content;
          if (typeof value !== 'string') return false;
          if (record.statement.property.data_type !== (plan.valueKind === 'item' ? 'wikibase-item' : 'string'))
            return false;
          const selected = plan.valueKind === 'item' ? await target(value, meter) : null;
          if (plan.valueKind === 'item' && !selected) continue;
          staged.push({
            key: hash({ slot: record.slot, candidate: record.candidate }),
            value: selected?.terminal ?? value,
            labels: selected?.labels ?? {},
            original: selected?.original ?? null,
            terminal: selected?.terminal ?? null,
          });
        }
        if (page.status === 'complete') {
          const match = planner?.evaluate(accumulator) ?? true;
          if (match === 'not_proven') return false;
          // Text membership is evaluated by the shared consumer against its registered immutable execution.
          // Its complete native result must contain this enumerated subject; no string matcher or preview is used.
          let textMatches = true;
          if (plan.text) {
            // The shared lifecycle supplies its actual immutable PIT. A prepared locator is never a PIT.
            if (!textObservation || textObservation.snapshot.kind !== 'pit') return false;
            const textBinding = await join(plan, textObservation, context, meter);
            if (
              !textBinding ||
              textBinding.definition.readDefinition !== joined.definition.readDefinition ||
              hash(textBinding.definition.source) !== hash(joined.definition.source)
            )
              return false;
            const body = {
              pit: { id: textObservation.snapshot.pit, keep_alive: '1m' },
              size: 1,
              track_total_hits: false,
              version: true,
              _source: false,
              query: { ids: { values: [subject] } },
            };
            const indexed = await search.request<{ hits: { hits: { _id: string; _version: number | string }[] } }>(
              'POST',
              '/_search',
              body,
              { timeoutMs: Math.max(1, context.deadline - Date.now()) },
            );
            meter.engineSearches++;
            assertCompleteSearch(indexed.body);
            const hit = indexed.body.hits.hits[0];
            if (
              indexed.body.hits.hits.length !== 1 ||
              !hit ||
              hit._id !== subject ||
              !/^[0-9]+$/.test(String(hit._version)) ||
              (typeof hit._version === 'number' && !Number.isSafeInteger(hit._version)) ||
              BigInt(hit._version) !== page.source.position
            )
              return false;
            if (plan.textField === 'credited_creator') {
              const membership = await creditedMembership(plan, textObservation, subject, context, meter);
              if (membership === 'unready') return false;
              textMatches = membership === 'match';
            } else {
              const matched = await search.request<{ hits: { hits: { _id: string }[] } }>(
                'POST',
                '/_search',
                {
                  ...body,
                  query: {
                    bool: {
                      filter: [
                        body.query,
                        ...(plan.kinds?.length ? [{ terms: { kind: [...plan.kinds] } }] : []),
                        compileText(plan.text, { field: 'search_text', prefix: 'facet-text-' }).query,
                      ],
                    },
                  },
                },
                { timeoutMs: Math.max(1, context.deadline - Date.now()) },
              );
              meter.engineSearches++;
              assertCompleteSearch(matched.body);
              if (matched.body.hits.hits.length > 1 || matched.body.hits.hits.some((entry) => entry._id !== subject))
                return false;
              textMatches = matched.body.hits.hits.length === 1;
            }
          }
          if (match && textMatches) {
            if (plan.valueKind === 'type' && subjectType)
              staged.push({ key: 'type', value: subjectType, labels: {}, original: null, terminal: null });
            phase = 'contribute';
          } else {
            subject = null;
            phase = complete ? 'seal' : 'population';
          }
        }
      } else if (phase === 'contribute' && subject && terminal) {
        contributions = await sql<StoredValue & { key: string }>(
          context,
          pool,
          meter,
          `SELECT key,value,labels,
          subject AS contributor_original,$6::text AS contributor_terminal,target_original,target_terminal
          FROM search.facet_stage WHERE partition_no=$1 AND definition=$2 AND generation=$3
          AND subject=$4 AND ($5::text IS NULL OR key>$5) ORDER BY key LIMIT 100`,
          [...key, subject, after, terminal],
        );
        if (contributions.length) after = contributions.at(-1)!.key;
        else {
          subject = null;
          phase = complete ? 'seal' : 'population';
        }
      } else if (phase === 'seal') {
        // Complete is native finite population proof, including creation/change bridge and final validation.
        if (
          !complete ||
          !execution ||
          !(await safe(queried, execution, context, meter)) ||
          !(await safeScope(plan, context, meter)) ||
          !(await join(plan, queried, context, meter))
        )
          return false;
        publish = true;
      }
      check(context);
      // Byte and write ceilings include internal staging and duplicate insert attempts.
      if (
        Buffer.byteLength(JSON.stringify({ staged, contributions, projection, accumulator })) > 4 * 1024 * 1024 ||
        staged.length + contributions.length + 1 > 1000
      )
        return false;
      meter.inputKeys += staged.length + contributions.length;
      return await writeTransaction(context, async (db) => {
        const locked = await db.query(
          `SELECT version FROM search.facet_generation WHERE partition_no=$1 AND definition=$2
          AND generation=$3 AND version=$4 AND lease_until=$5 AND state='building' FOR UPDATE`,
          [...key, state.version, context.deadline],
        );
        if (!locked.rowCount) return false;
        for (const value of staged)
          await sql(
            context,
            db,
            meter,
            `INSERT INTO search.facet_stage
          (partition_no,definition,generation,subject,key,value,labels,target_original,target_terminal)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
            [...key, state.subject ?? subject, value.key, value.value, value.labels, value.original, value.terminal],
          );
        if (contributions.length)
          await sql(
            context,
            db,
            meter,
            `INSERT INTO search.facet_value
          (partition_no,definition,generation,value,labels,contributor_original,contributor_terminal,target_original,target_terminal)
          SELECT $1,$2,$3,value,labels,contributor_original,contributor_terminal,target_original,target_terminal
          FROM jsonb_to_recordset($4::jsonb) AS x(value text,labels jsonb,contributor_original text,
            contributor_terminal text,target_original text,target_terminal text) ON CONFLICT DO NOTHING`,
            [...key, JSON.stringify(contributions)],
          );
        if (publish)
          await sql(
            context,
            db,
            meter,
            `UPDATE search.facet_generation SET state='retired'
          WHERE partition_no=$1 AND definition=$2 AND generation<>$3 AND state='ready'`,
            key,
          );
        await sql(
          context,
          db,
          meter,
          `UPDATE search.facet_generation SET phase=$4,frontier=$5,population_complete=$6,
          subject=$7,terminal=$8,subject_type=$9,security_revision=$10,projection=$11,accumulator=$12,
          contribution_after=$13,state=$14,as_of=$15,expires_at=$16,lease_until=0,version=version+1
          WHERE partition_no=$1 AND definition=$2 AND generation=$3`,
          [
            ...key,
            phase,
            frontier,
            complete,
            subject,
            terminal,
            subjectType,
            security,
            projection,
            JSON.stringify(accumulator),
            after,
            publish ? 'ready' : 'building',
            publish ? clock().toISOString() : null,
            clock().getTime() + idle,
          ],
        );
        meter.frontierWrites++;
        return publish;
      });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Release is best effort within the original turn. After expiry the deadline lease is already reclaimable;
      // neither cleanup failure nor process loss discards the last committed frontier or masks a preparation error.
      if (Date.now() < context.deadline)
        await sql(
          context,
          pool,
          meter,
          `UPDATE search.facet_generation SET lease_until=0 WHERE partition_no=$1 AND definition=$2
        AND generation=$3 AND version=$4 AND lease_until=$5`,
          [...key, state.version, context.deadline],
        ).catch(() => undefined);
      if (!failed) check(context);
    }
  }
  /** Private candidate data only. The shared native page executor brackets ALL siblings with one START/FINAL,
   * retains these original/terminal rows in its execution and revalidates Source/Access before disclosure.
   * This function cannot mint ready, exhaustion, permission, an ACK or a public continuation.
   */
  async function readFacetCandidates(read: FacetNativeRead, context: PublicFilterConsumerContext) {
    const meter: Meter = { ...emptyCost() };
    check(context);
    if (!Number.isInteger(read.size) || read.size < 1 || read.size > 20) throw new RangeError('Invalid facet size');
    const joined = await join(read.plan, read.queried, context, meter);
    if (!joined) return { status: 'unready' as const, cost: meter };
    const key = coordinates(read.plan, read.queried, joined.definition.source.partition);
    // One statement observes both ready generation and values. Expiry/replacement cannot delete a prefix
    // between a metadata check and the value seek and thereby manufacture final exhaustion.
    const selected = await sql<{ as_of: string; item: StoredValue | null }>(
      context,
      pool,
      meter,
      `WITH valid AS (
      UPDATE search.facet_generation SET expires_at=$6
      WHERE partition_no=$1 AND definition=$2 AND generation=$3 AND state='ready' AND expires_at>$5 RETURNING as_of
    ) SELECT valid.as_of,to_jsonb(v) AS item FROM valid LEFT JOIN LATERAL (
      SELECT value,labels,contributor_original,contributor_terminal,target_original,target_terminal
      FROM search.facet_value WHERE partition_no=$1 AND definition=$2 AND generation=$3
      AND ($4::text IS NULL OR value>$4) ORDER BY value LIMIT $7
    ) v ON true`,
      [...key, read.after, clock().getTime(), clock().getTime() + idle, read.size + 1],
    );
    if (!selected[0]) return { status: 'unready' as const, cost: meter };
    meter.resultWrites++;
    const rows = selected.flatMap(({ item }) => (item === null ? [] : [item]));
    meter.candidates += rows.length;
    return { status: 'candidates' as const, rows, asOf: selected[0].as_of, cost: meter };
  }

  async function verifyCreditedCandidate(read: FacetNativeRead, subject: string, context: PublicFilterConsumerContext) {
    const meter: Meter = { ...emptyCost() };
    const status = await creditedMembership(read.plan, read.textObservation, subject, context, meter);
    return { status, cost: meter };
  }

  /** Retire the exact retained value generation as soon as its contributor/target observation fails. */
  async function retireFacetCandidates(read: FacetNativeRead, context: PublicFilterConsumerContext) {
    const meter: Meter = { ...emptyCost() };
    check(context);
    const joined = await join(read.plan, read.queried, context, meter);
    if (!joined) return { cost: meter };
    const key = coordinates(read.plan, read.queried, joined.definition.source.partition);
    await sql(
      context,
      pool,
      meter,
      `UPDATE search.facet_generation SET state='retired',version=version+1
       WHERE partition_no=$1 AND definition=$2 AND generation=$3 AND state='ready'`,
      key,
    );
    return { cost: meter };
  }

  async function expireFacetStep(context: PublicFilterConsumerContext) {
    check(context);
    const meter: Meter = { ...emptyCost() };
    return writeTransaction(context, async (db) => {
      const expired = await db.query<{ partition_no: number; definition: string; generation: string }>(
        `SELECT partition_no,definition,generation FROM search.facet_generation WHERE expires_at<=$1
         ORDER BY expires_at,partition_no,definition,generation LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [clock().getTime()],
      );
      const row = expired.rows[0];
      if (row) {
        const key = [row.partition_no, row.definition, row.generation];
        await sql(
          context,
          db,
          meter,
          `UPDATE search.facet_generation SET state='retired' WHERE partition_no=$1 AND definition=$2 AND generation=$3`,
          key,
        );
        const removed = await sql(
          context,
          db,
          meter,
          `DELETE FROM search.facet_stage WHERE (partition_no,definition,generation,subject,key) IN
          (SELECT partition_no,definition,generation,subject,key FROM search.facet_stage WHERE partition_no=$1 AND definition=$2
           AND generation=$3 ORDER BY subject,key LIMIT 499) RETURNING key`,
          key,
        );
        const values = await sql(
          context,
          db,
          meter,
          `DELETE FROM search.facet_value WHERE (partition_no,definition,generation,value) IN
          (SELECT partition_no,definition,generation,value FROM search.facet_value WHERE partition_no=$1 AND definition=$2
           AND generation=$3 ORDER BY value LIMIT 499) RETURNING value`,
          key,
        );
        if (!removed.length && !values.length)
          await sql(
            context,
            db,
            meter,
            `DELETE FROM search.facet_generation WHERE partition_no=$1 AND definition=$2 AND generation=$3`,
            key,
          );
      }
      return meter;
    });
  }
  return {
    prepareFacetStep: step,
    readFacetCandidates,
    verifyCreditedCandidate,
    retireFacetCandidates,
    expireFacetStep,
  };
}
