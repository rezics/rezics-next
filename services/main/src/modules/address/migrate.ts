import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { normalizeAddressName } from '@rezics/model/address/names';
import {
  DATASET,
  GRAPHS,
  RV,
  hash,
  iri,
  lit,
  type WorkActivationEnvironment,
} from '../work/activate.ts';
import { NameUnavailable, type NameRow } from './registry.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { prepareZoneNameCleanup } from './migrate-zone.ts';

/** Pre-serving migration, not a compatibility resolver. Cursor-sized pages
 * move the former graph names to Access, then delete their naming projections.
 * Replaying after a lost cleanup response cannot assign a key to a new holder. */
export async function migrateGraphNames(env: WorkActivationEnvironment) {
  const registry = env.addresses;
  if (!registry) throw new NameUnavailable('Name registry is unavailable');
  const completed = await registry.pool.query(
    'SELECT 1 FROM access.name_graph_import WHERE data_epoch = $1',
    [env.lineage.dataEpoch],
  );
  if (completed.rowCount) return;
  const deadline = Date.now() + 600_000;
  let after = '';
  for (;;) {
    if (Date.now() > deadline)
      throw new NameUnavailable('Name migration exceeded its preparation budget');
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
      } } ORDER BY STR(?source) LIMIT 50`,
          256 * 1024,
        )
      ).results?.bindings ?? [];
    if (!rows.length) break;
    const client = await registry.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      for (const row of rows) {
        if (!row.scope || !row.key || !row.holder || !row.controller || !row.state || !row.source)
          throw new NameUnavailable('Former name is incomplete');
        const scope = row.scope.value as 'space' | 'work';
        const name = normalizeAddressName(
          row.key.value,
          scope === 'space' ? 'ascii-handle' : 'unicode-title',
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
          throw new NameUnavailable('Former name has a non-equivalent merge successor');
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
              `SELECT 1 FROM access.name_registry
          WHERE scope = 'space' AND holder = $1 AND state = 'current' AND key <> $2`,
              [row.holder.value, name.key],
            )
          ).rowCount
        )
          state = 'redirect';
        const imported = (
          await client.query<NameRow>(
            `INSERT INTO access.name_registry(scope,key,display,skeleton,holder,controller,state,revision,successor)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(scope,key) DO UPDATE SET key = EXCLUDED.key
          WHERE access.name_registry.holder = EXCLUDED.holder RETURNING *`,
            [
              scope,
              name.key,
              name.display,
              name.skeleton,
              row.holder.value,
              row.controller.value,
              state,
              row.revision?.value.slice(-36) ?? randomUUID(),
              row.successor?.value ?? null,
            ],
          )
        ).rows[0];
        if (!imported) throw new NameUnavailable('Former name conflicts with a permanent holder');
        await client.query(
          `INSERT INTO access.name_history(revision,scope,key,holder,display,state,successor)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(revision) DO NOTHING`,
          [
            imported.revision,
            scope,
            name.key,
            imported.holder,
            imported.display,
            imported.state,
            imported.successor,
          ],
        );
        if (scope === 'work')
          await importWorkNameHistory(
            env,
            client,
            row.source.value,
            name.key,
            row.holder.value,
            deadline,
          );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    await cleanupGraphNames(
      env,
      rows.map((row) => ({ source: row.source!.value, kind: row.kind!.value })),
    );
    after = rows.at(-1)!.source!.value;
  }
  await registry.pool.query(
    'INSERT INTO access.name_graph_import(data_epoch) VALUES ($1) ON CONFLICT DO NOTHING',
    [env.lineage.dataEpoch],
  );
}

async function importWorkNameHistory(
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
      throw new NameUnavailable('Name history import exceeded its preparation budget');
    const rows =
      (
        await env.fuseki.query(
          `PREFIX rv: <${RV}> SELECT ?revision ?work ?state ?successor WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RevisionAnchor ; rv:component ${iri(source)} ;
        rv:targetWork ?work ; rv:normalizedSlug ${lit(key)} .
        OPTIONAL { ?revision rv:routeState ?state }
        OPTIONAL { ?revision rv:redirectWork ?target . FILTER(?target != ?work) BIND(?target AS ?successor) }
        FILTER(STR(?revision) > ${lit(after)})
      } } ORDER BY STR(?revision) LIMIT 50`,
          64 * 1024,
        )
      ).results?.bindings ?? [];
    if (!rows.length) break;
    const records = rows.map((row) => {
      if (!row.revision || row.work?.value !== holder)
        throw new NameUnavailable('Former name history has a different holder');
      return {
        revision: row.revision.value.slice(-36),
        scope: 'work',
        key,
        holder,
        display: key,
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
      `INSERT INTO access.name_history(revision,scope,key,holder,display,state,successor)
      SELECT revision::uuid,scope,key,holder,display,state,successor FROM jsonb_to_recordset($1::jsonb)
        AS names(revision text,scope text,key text,holder text,display text,state text,successor text)
      ON CONFLICT(revision) DO NOTHING`,
      [JSON.stringify(records)],
    );
    after = rows.at(-1)!.revision!.value;
  }
}

async function cleanupGraphNames(
  env: WorkActivationEnvironment,
  entries: { source: string; kind: string }[],
) {
  const first = entries[0]!.source,
    last = entries.at(-1)!.source;
  const digest = hash(`name-registry-v1\0${env.lineage.dataEpoch}\0${first}\0${last}`);
  const receipt = `urn:rezics:name-migration:${digest}`;
  const event = `urn:rezics:event:${hash(receipt)}`,
    batch = `urn:rezics:outbox:${hash(receipt)}`;
  const predicates = entries.map((entry, index) => ({
    ...entry,
    index,
    predicate:
      entry.kind === 'realm'
        ? 'rv:communityHandle'
        : entry.kind === 'zone'
          ? 'rv:routeSegment'
          : `?predicate${index}`,
  }));
  const zoneChanges = [];
  for (const entry of entries.filter((entry) => entry.kind === 'zone')) {
    const change = await prepareZoneNameCleanup(env, entry.source);
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
      ${predicates.map((entry) => `${iri(entry.source)} ${entry.predicate} ?value${entry.index} .`).join(' ')}
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
      ${predicates.map((entry) => `OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(entry.source)} ${entry.predicate} ?value${entry.index} } }`).join(' ')}
      ${zoneChanges.map((change) => change.guard).join(' ')}
      BIND(?sequence + 1 AS ?next)
    }`,
  });
  if (result.status !== 'committed')
    throw new NameUnavailable(`Name projection cleanup did not commit (${JSON.stringify(result)})`);
}
