import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { logWorkerFault } from '@rezics/observability/log';
import { normalizeAddressAlias, InvalidAddressAlias } from '@rezics/model/address/aliases';
import {
  DATASET,
  GRAPHS,
  RV,
  hash,
  iri,
  lit,
  type WorkActivationEnvironment,
} from '../work/activate.ts';
import { AliasInvalid, AliasUnavailable, type AliasRow } from './registry.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { prepareZoneAliasCleanup } from './migrate-zone.ts';
import { platformAliasAuthority } from './write.ts';
import { readWorkComponentState } from '../work/history.ts';
import type { SparqlResult } from '../../infrastructure/fuseki.ts';

type LegacyAlias = NonNullable<SparqlResult['results']>['bindings'][number];
export const ALIAS_IMPORT_COST = {
  page: 45,
  historyPage: 50,
  preparationMs: 600_000,
  complexity:
    'Keyset pages over epoch/source reports and source revisions; memory O(page), work O(imported and skipped evidence).',
} as const;
class LegacyAliasInvalid extends Error {}
function rdfIri(value: string) {
  if (!/^(?:https?:\/\/|urn:)[^\s<>"{}|^`\\]+$/u.test(value))
    throw new AliasUnavailable('Invalid legacy RDF IRI');
  return `<${value}>`;
}

/** Non-fatal maintenance import. Cursor-sized pages
 * move the former graph aliases to Access, then delete their naming projections.
 * Replaying after a lost cleanup response cannot assign a key to a new holder. */
export async function migrateGraphAliases(env: WorkActivationEnvironment) {
  try {
    await importGraphAliases(env);
    return { status: 'complete' as const };
  } catch (error) {
    logWorkerFault('main.address.alias-import', error);
    return { status: 'deferred' as const };
  }
}

async function importGraphAliases(env: WorkActivationEnvironment) {
  const registry = env.addresses;
  if (!registry) throw new AliasUnavailable('Alias registry is unavailable');
  const completed = await registry.pool.query(
    'SELECT cursor,completed_at FROM access.alias_graph_import WHERE data_epoch = $1',
    [env.lineage.dataEpoch],
  );
  const held = await env.fuseki.query(
    `PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`,
    1024,
  );
  if (
    held.boolean ||
    !(await registry.pool.query('SELECT 1 FROM access.recovery_fence WHERE id AND open')).rowCount
  )
    throw new AliasUnavailable('Alias import waits for the restore hold to clear');
  const deadline = Date.now() + ALIAS_IMPORT_COST.preparationMs;
  await repairSkippedAliases(env, deadline);
  if (completed.rows[0]?.completed_at) return;
  let after = completed.rows[0]?.cursor ?? '';
  for (;;) {
    if (Date.now() > deadline)
      throw new AliasUnavailable('Alias migration exceeded its preparation budget');
    const rows =
      (
        await env.fuseki.query(
          `PREFIX rv: <${RV}> SELECT ?source ?kind ?scope ?key ?holder ?controller ?state ?successor ?revision WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        { ?source a rv:Realm ; rv:communityHandle ?key ; rv:space ?holder .
          ?holder rv:owner ?controller . BIND("space" AS ?scope) BIND(rv:Current AS ?state) BIND("realm" AS ?kind) }
        UNION { ?source a rv:Zone ; rv:official true ; rv:routeSegment ?key ; rv:space ?holder .
          OPTIONAL { ?holder rv:owner ?owner } BIND(COALESCE(?owner,?holder) AS ?controller)
          BIND("space" AS ?scope) BIND("zone" AS ?kind)
          BIND(IF(EXISTS { ?realm a rv:Realm ; rv:space ?holder ; rv:communityHandle ?handle . FILTER(?handle != ?key) },rv:Redirected,rv:Current) AS ?state) }
        UNION { ?source a rv:RouteBinding ; rv:routeNamespace "work" ; rv:normalizedSlug ?key ;
          rv:targetWork ?holder ; rv:routeState ?state ; rv:routeRevision ?revision .
          OPTIONAL { ?source rv:redirectWork ?target . FILTER(?target != ?holder) }
          BIND(?target AS ?successor) BIND(?holder AS ?controller) BIND("work" AS ?scope) BIND("work" AS ?kind) }
        FILTER(STR(?source) > ${lit(after)})
      } } ORDER BY STR(?source) LIMIT ${ALIAS_IMPORT_COST.page}`,
          256 * 1024,
        )
      ).results?.bindings ?? [];
    if (!rows.length) break;
    await importAliasRows(env, rows, deadline);
    await cleanupGraphAliases(
      env,
      rows.map((row) => ({ source: row.source!.value, kind: row.kind!.value })),
    );
    after = rows.at(-1)!.source!.value;
    await registry.pool.query(
      `INSERT INTO access.alias_graph_import(data_epoch,cursor) VALUES ($1,$2)
      ON CONFLICT(data_epoch) DO UPDATE SET cursor = EXCLUDED.cursor`,
      [env.lineage.dataEpoch, after],
    );
  }
  await registry.pool.query(
    'INSERT INTO access.alias_graph_import(data_epoch,completed_at) VALUES ($1,clock_timestamp()) ON CONFLICT(data_epoch) DO UPDATE SET completed_at = EXCLUDED.completed_at',
    [env.lineage.dataEpoch],
  );
}

async function importAliasRows(
  env: WorkActivationEnvironment,
  rows: LegacyAlias[],
  deadline: number,
) {
  const registry = env.addresses!;
  const client = await registry.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '5s'");
    if (
      !(await client.query('SELECT 1 FROM access.recovery_fence WHERE id AND open FOR SHARE'))
        .rowCount
    )
      throw new AliasUnavailable('Alias import waits for the restore hold to clear');
    for (const row of rows) {
      if (Date.now() > deadline)
        throw new AliasUnavailable('Alias import exceeded its preparation budget');
      await client.query('SAVEPOINT import_name');
      try {
        if (!row.scope || !row.key || !row.holder || !row.controller || !row.state || !row.source)
          throw new LegacyAliasInvalid('Former alias is incomplete');
        const scope = row.scope.value as 'space' | 'work';
        const alias = normalizeAddressAlias(
          row.key.value,
          scope === 'space' ? 'ascii-handle' : 'unicode-title',
        );
        await registry.assertAliasAllowed(
          scope,
          alias.key,
          client,
          await platformAliasAuthority(env, scope, row.holder.value),
        );
        if (
          row.successor &&
          (
            await env.fuseki.query(
              `PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
        ${iri(row.holder.value)} rv:mergedInto ${iri(row.successor.value)} } }`,
              1024,
            )
          ).boolean !== true
        ) {
          throw new LegacyAliasInvalid('Former alias has a non-equivalent merge successor');
        }
        let state =
          row.state.value === `${RV}Current`
            ? 'current'
            : row.state.value === `${RV}Retired`
              ? 'retired'
              : 'redirect';
        if (
          row.kind?.value === 'zone' &&
          (
            await client.query(
              `SELECT 1 FROM access.alias_registry
        WHERE scope = 'space' AND holder = $1 AND state = 'current' AND key <> $2`,
              [row.holder.value, alias.key],
            )
          ).rowCount
        )
          state = 'redirect';
        const imported = (
          await client.query<AliasRow>(
            `INSERT INTO access.alias_registry(scope,key,skeleton,holder,controller,state,revision,successor)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(scope,key) DO UPDATE SET key = EXCLUDED.key
        WHERE access.alias_registry.holder = EXCLUDED.holder RETURNING *`,
            [
              scope,
              alias.key,
              alias.skeleton,
              row.holder.value,
              row.controller.value,
              state,
              row.revision?.value.slice(-36) ?? randomUUID(),
              row.successor?.value ?? null,
            ],
          )
        ).rows[0];
        if (!imported)
          throw new LegacyAliasInvalid('Former alias conflicts with a permanent holder');
        await client.query(
          `INSERT INTO access.alias_history(revision,scope,key,holder,state,successor)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(revision) DO NOTHING`,
          [
            imported.revision,
            scope,
            alias.key,
            imported.holder,
            imported.state,
            imported.successor,
          ],
        );
        if (scope === 'work')
          await importWorkAliasHistory(
            env,
            client,
            row.source.value,
            alias.key,
            row.holder.value,
            deadline,
          );
        await client.query(
          `UPDATE access.alias_graph_import_report SET legacy_alias = $3,
          attempted_at = clock_timestamp(),repaired_at = clock_timestamp(),reason = 'Imported retained alias'
          WHERE data_epoch = $1 AND source = $2 AND repaired_at IS NULL`,
          [env.lineage.dataEpoch, row.source.value, JSON.stringify(row)],
        );
        await client.query('RELEASE SAVEPOINT import_name');
      } catch (error) {
        if (
          !(
            error instanceof LegacyAliasInvalid ||
            error instanceof AliasInvalid ||
            error instanceof InvalidAddressAlias ||
            (error &&
              typeof error === 'object' &&
              'code' in error &&
              ['23505', '23514'].includes(String(error.code)))
          )
        )
          throw error;
        await client.query('ROLLBACK TO SAVEPOINT import_name');
        const reason = error instanceof Error ? error.message : String(error);
        logWorkerFault('main.address.alias-import.skip', error);
        await client.query(
          `INSERT INTO access.alias_graph_import_report(data_epoch,source,reason,legacy_alias,attempted_at)
          VALUES ($1,$2,$3,$4,clock_timestamp()) ON CONFLICT(data_epoch,source) DO UPDATE SET
            reason = EXCLUDED.reason,legacy_alias = EXCLUDED.legacy_alias,attempted_at = EXCLUDED.attempted_at`,
          [env.lineage.dataEpoch, row.source!.value, reason, JSON.stringify(row)],
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function importWorkAliasHistory(
  env: WorkActivationEnvironment,
  client: PoolClient,
  source: string,
  key: string,
  holder: string,
  deadline: number,
) {
  let after = '';
  for (;;) {
    if (Date.now() > deadline)
      throw new AliasUnavailable('Alias history import exceeded its preparation budget');
    const rows =
      (
        await env.fuseki.query(
          `PREFIX rv: <${RV}> SELECT ?revision ?work ?state ?successor WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RevisionAnchor ; rv:component ${iri(source)} ;
        rv:targetWork ?work ; rv:normalizedSlug ${lit(key)} .
        OPTIONAL { ?revision rv:routeState ?state }
        OPTIONAL { ?revision rv:redirectWork ?target . FILTER(?target != ?work) BIND(?target AS ?successor) }
        FILTER(STR(?revision) > ${lit(after)})
      } } ORDER BY STR(?revision) LIMIT ${ALIAS_IMPORT_COST.historyPage}`,
          64 * 1024,
        )
      ).results?.bindings ?? [];
    if (!rows.length) break;
    const records = rows.map((row) => {
      if (!row.revision || row.work?.value !== holder)
        throw new LegacyAliasInvalid('Former alias history has a different holder');
      return {
        revision: row.revision.value.slice(-36),
        scope: 'work',
        key,
        holder,
        state:
          row.state?.value === `${RV}Retired`
            ? 'retired'
            : row.state?.value === `${RV}Redirected`
              ? 'redirect'
              : 'current',
        successor: row.successor?.value ?? null,
      };
    });
    await client.query(
      `INSERT INTO access.alias_history(revision,scope,key,holder,state,successor)
      SELECT revision::uuid,scope,key,holder,state,successor FROM jsonb_to_recordset($1::jsonb)
        AS aliases(revision text,scope text,key text,holder text,state text,successor text)
      ON CONFLICT(revision) DO NOTHING`,
      [JSON.stringify(records)],
    );
    after = rows.at(-1)!.revision!.value;
  }
}

/** Completed epochs still have a repair queue. Advance by source even on a
 * repeated denial so one bad legacy value cannot starve later reports. */
async function repairSkippedAliases(env: WorkActivationEnvironment, deadline: number) {
  const registry = env.addresses!;
  let after = '';
  for (;;) {
    if (Date.now() > deadline)
      throw new AliasUnavailable('Alias repair exceeded its preparation budget');
    const reports = (
      await registry.pool.query<{ source: string; legacy_alias: LegacyAlias | null }>(
        `SELECT source,legacy_alias FROM access.alias_graph_import_report
      WHERE data_epoch = $1 AND repaired_at IS NULL AND source > $2 ORDER BY source LIMIT ${ALIAS_IMPORT_COST.page}`,
        [env.lineage.dataEpoch, after],
      )
    ).rows;
    if (!reports.length) return;
    const rows: LegacyAlias[] = [];
    for (const report of reports) {
      const row = report.legacy_alias ?? (await recoverLegacyAlias(env, report.source, deadline));
      if (row) rows.push(row);
      else
        await registry.pool.query(
          `UPDATE access.alias_graph_import_report
        SET attempted_at = clock_timestamp(),reason = 'Retained alias evidence is unavailable'
        WHERE data_epoch = $1 AND source = $2 AND repaired_at IS NULL`,
          [env.lineage.dataEpoch, report.source],
        );
    }
    if (rows.length) await importAliasRows(env, rows, deadline);
    after = reports.at(-1)!.source;
  }
}

/** Pre-upgrade reports contain only a source IRI. Read retained bytes rather
 * than guessing a key from labels, URLs or a platform-specific lookup table. */
async function recoverLegacyAlias(
  env: WorkActivationEnvironment,
  source: string,
  deadline: number,
) {
  const binding = (value: string) => ({ type: 'literal' as const, value });
  const base =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}>
    SELECT ?kind ?holder ?controller WHERE { GRAPH ${iri(GRAPHS.current)} {
      { ${iri(source)} a rv:Zone ; rv:space ?holder . BIND("zone" AS ?kind) }
      UNION { ${iri(source)} a rv:Realm ; rv:space ?holder . BIND("realm" AS ?kind) }
      OPTIONAL { ?holder rv:owner ?owner } BIND(COALESCE(?owner,?holder) AS ?controller)
    } } LIMIT 2`,
        8192,
      )
    ).results?.bindings ?? [];
  if (base.length > 1) throw new LegacyAliasInvalid('Former alias source is ambiguous');
  let after = '';
  let afterSequence: string | null = null;
  for (;;) {
    if (Date.now() > deadline)
      throw new AliasUnavailable('Alias evidence exceeded its preparation budget');
    const revisions: LegacyAlias[] =
      (
        await env.fuseki.query(
          `PREFIX rv: <${RV}>
      SELECT ?revision ?manifest ?profile ?key ?holder ?state ?successor ?sequence WHERE {
        GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RevisionAnchor ; rv:component ${iri(source)} .
          OPTIONAL { ?revision rv:sequence ?recordedSequence }
          BIND(COALESCE(?recordedSequence,0) AS ?sequence)
          OPTIONAL { ?revision rv:manifest ?manifest ; rv:modelRevision ?profile }
          OPTIONAL { ?revision rv:normalizedSlug ?key ; rv:targetWork ?holder ; rv:routeState ?state }
          OPTIONAL { ?revision rv:redirectWork ?successor . FILTER(?successor != ?holder) }
          ${
            afterSequence === null
              ? ''
              : `FILTER(?sequence < ${lit(afterSequence)}^^<http://www.w3.org/2001/XMLSchema#integer>
            || ?sequence = ${lit(afterSequence)}^^<http://www.w3.org/2001/XMLSchema#integer> && STR(?revision) < ${lit(after)})`
          }
        } } ORDER BY DESC(?sequence) DESC(STR(?revision)) LIMIT ${ALIAS_IMPORT_COST.page}`,
          256 * 1024,
        )
      ).results?.bindings ?? [];
    if (!revisions.length) return null;
    for (const revision of revisions) {
      if (revision.key && revision.holder && revision.state)
        return {
          ...revision,
          source: binding(source),
          kind: binding('work'),
          scope: binding('work'),
          controller: revision.holder,
        };
      const owner = base[0];
      if (
        !owner?.kind ||
        !owner.holder ||
        !owner.controller ||
        !revision.manifest ||
        !revision.profile
      )
        continue;
      const state = await readWorkComponentState(
        env,
        revision.manifest.value,
        source,
        revision.profile.value,
      );
      const configuration = state.configuration as
        | { official?: { routeSegment?: unknown } }
        | undefined;
      const key =
        owner.kind.value === 'zone' ? configuration?.official?.routeSegment : state.handle;
      if (typeof key === 'string')
        return {
          ...owner,
          source: binding(source),
          scope: binding('space'),
          key: binding(key),
          state: binding(RV + 'Current'),
        };
    }
    after = revisions.at(-1)!.revision!.value;
    afterSequence = revisions.at(-1)!.sequence!.value;
  }
}

async function cleanupGraphAliases(
  env: WorkActivationEnvironment,
  entries: { source: string; kind: string }[],
) {
  // This import resumes the retained pre-alias cleanup protocol. Its model,
  // RDF predicates and receipt digests identify historical migration evidence.
  const first = entries[0]!.source,
    last = entries.at(-1)!.source;
  const digest = hash(`name-registry-v1\0${env.lineage.dataEpoch}\0${first}\0${last}`);
  const receipt = `urn:rezics:name-migration:${digest}`;
  const event = `urn:rezics:event:${hash(receipt)}`,
    batch = `urn:rezics:outbox:${hash(receipt)}`;
  const kinds = new Map(entries.map((entry) => [entry.source, entry.kind]));
  // One linear read per page. OPTIONAL for each binding multiplies unrelated
  // triples and makes both preparation and native command execution unbounded.
  const triples =
    (
      await env.fuseki.query(
        `SELECT ?s ?p ?o WHERE {
    VALUES ?s { ${[...kinds.keys()].map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?s ?p ?o }
    }`,
        1024 * 1024,
      )
    ).results?.bindings ?? [];
  const deleted = triples
    .filter(
      (row) =>
        kinds.get(row.s!.value) === 'work' ||
        row.p!.value ===
          RV + (kinds.get(row.s!.value) === 'realm' ? 'communityHandle' : 'routeSegment'),
    )
    .map((row) => {
      const object = row.o!;
      if (object.type === 'bnode')
        throw new AliasUnavailable('Legacy alias projection contains a blank node');
      if (object['xml:lang'] && !/^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/.test(object['xml:lang']))
        throw new AliasUnavailable('Invalid legacy language tag');
      const value =
        object.type === 'uri'
          ? rdfIri(object.value)
          : lit(object.value) +
            (object['xml:lang']
              ? `@${object['xml:lang']}`
              : object.datatype
                ? `^^${rdfIri(object.datatype)}`
                : '');
      return `${iri(row.s!.value)} ${rdfIri(row.p!.value)} ${value} .`;
    })
    .join(' ');
  const zoneChanges = [];
  for (const entry of entries.filter((entry) => entry.kind === 'zone')) {
    const change = await prepareZoneAliasCleanup(env, entry.source);
    if (change) zoneChanges.push(change);
  }
  // Native commands require explicit data subjects and permit at most 100.
  // Each page carries its own receipt, so cleanup and completion can both retry.
  const validations = await profileValidations(env.fuseki, 'name-registry-cleanup-v1', [
    {
      shape: 'https://rezics.com/definition/name-registry-cleanup-v1/cleaned-shape',
      focus: entries.map((entry) => entry.source),
      graphs: [GRAPHS.current],
    },
  ]);
  const result = await env.fuseki.commandWithReceipt({
    receipt,
    digest,
    validations: [...validations, ...zoneChanges.flatMap((change) => change.validations)],
    deadlineMs: 10_000,
    update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${deleted}
      ${zoneChanges.map((change) => change.delete).join(' ')}
    } GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence } }
    INSERT {
      GRAPH ${iri(GRAPHS.current)} { ${zoneChanges.map((change) => change.current).join(' ')} }
      GRAPH ${iri(GRAPHS.revisions)} { ${zoneChanges.map((change) => change.revisions).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ${entries
        .filter((entry) => entry.kind === 'work')
        .map((entry) => `${iri(entry.source)} a rv:RetiredNameProjection .`)
        .join(' ')} }
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
        rv:outcome rv:Succeeded ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
        rv:nameMigrationBegin ${lit(first)} ; rv:nameMigrationEnd ${lit(last)} }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:NamesMigratedEvent ; rv:ordinal 0 ; rv:action "address.migrate" ; rv:receipt ${iri(receipt)} }
    }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?sequence }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      ${zoneChanges.map((change) => change.guard).join(' ')}
      BIND(?sequence + 1 AS ?next)
    }`,
  });
  if (result.status !== 'committed')
    throw new AliasUnavailable(
      `Alias projection cleanup did not commit (${JSON.stringify(result)})`,
    );
}
