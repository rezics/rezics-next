import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { normalizeAddressName, InvalidAddressName } from '@rezics/model/address/names';
import {
  DATASET,
  GRAPHS,
  RV,
  hash,
  iri,
  lit,
  type WorkActivationEnvironment,
} from '../work/activate.ts';
import { NameInvalid, NameUnavailable, type NameRow } from './registry.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { prepareZoneNameCleanup } from './migrate-zone.ts';
import { platformNameAuthority } from './write.ts';
import { readWorkComponentState } from '../work/history.ts';
import type { SparqlResult } from '../../infrastructure/fuseki.ts';

type LegacyName = NonNullable<SparqlResult['results']>['bindings'][number];
export const NAME_IMPORT_COST = {
  page: 45,
  historyPage: 50,
  preparationMs: 600_000,
  complexity:
    'Keyset pages over epoch/source reports and source revisions; memory O(page), work O(imported and skipped evidence).',
} as const;
class LegacyNameInvalid extends Error {}
function rdfIri(value: string) {
  if (!/^(?:https?:\/\/|urn:)[^\s<>"{}|^`\\]+$/u.test(value))
    throw new NameUnavailable('Invalid legacy RDF IRI');
  return `<${value}>`;
}

/** Non-fatal maintenance import. Cursor-sized pages
 * move the former graph names to Access, then delete their naming projections.
 * Replaying after a lost cleanup response cannot assign a key to a new holder. */
export async function migrateGraphNames(env: WorkActivationEnvironment) {
  try {
    await importGraphNames(env);
    return { status: 'complete' as const };
  } catch (error) {
    console.warn('Name import deferred; identity addresses remain available', error);
    return { status: 'deferred' as const };
  }
}

async function importGraphNames(env: WorkActivationEnvironment) {
  const registry = env.addresses;
  if (!registry) throw new NameUnavailable('Name registry is unavailable');
  const completed = await registry.pool.query(
    'SELECT cursor,completed_at FROM access.name_graph_import WHERE data_epoch = $1',
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
    throw new NameUnavailable('Name import waits for the restore hold to clear');
  const deadline = Date.now() + NAME_IMPORT_COST.preparationMs;
  await repairSkippedNames(env, deadline);
  if (completed.rows[0]?.completed_at) return;
  let after = completed.rows[0]?.cursor ?? '';
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
      } } ORDER BY STR(?source) LIMIT ${NAME_IMPORT_COST.page}`,
          256 * 1024,
        )
      ).results?.bindings ?? [];
    if (!rows.length) break;
    await importNameRows(env, rows, deadline);
    await cleanupGraphNames(
      env,
      rows.map((row) => ({ source: row.source!.value, kind: row.kind!.value })),
    );
    after = rows.at(-1)!.source!.value;
    await registry.pool.query(
      `INSERT INTO access.name_graph_import(data_epoch,cursor) VALUES ($1,$2)
      ON CONFLICT(data_epoch) DO UPDATE SET cursor = EXCLUDED.cursor`,
      [env.lineage.dataEpoch, after],
    );
  }
  await registry.pool.query(
    'INSERT INTO access.name_graph_import(data_epoch,completed_at) VALUES ($1,clock_timestamp()) ON CONFLICT(data_epoch) DO UPDATE SET completed_at = EXCLUDED.completed_at',
    [env.lineage.dataEpoch],
  );
}

async function importNameRows(
  env: WorkActivationEnvironment,
  rows: LegacyName[],
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
      throw new NameUnavailable('Name import waits for the restore hold to clear');
    for (const row of rows) {
      if (Date.now() > deadline)
        throw new NameUnavailable('Name import exceeded its preparation budget');
      await client.query('SAVEPOINT import_name');
      try {
        if (!row.scope || !row.key || !row.holder || !row.controller || !row.state || !row.source)
          throw new LegacyNameInvalid('Former name is incomplete');
        const scope = row.scope.value as 'space' | 'work';
        const name = normalizeAddressName(
          row.key.value,
          scope === 'space' ? 'ascii-handle' : 'unicode-title',
        );
        await registry.assertNameAllowed(
          scope,
          name.key,
          client,
          await platformNameAuthority(env, scope, row.holder.value),
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
          throw new LegacyNameInvalid('Former name has a non-equivalent merge successor');
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
        if (!imported) throw new LegacyNameInvalid('Former name conflicts with a permanent holder');
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
        await client.query(
          `UPDATE access.name_graph_import_report SET legacy_name = $3,
          attempted_at = clock_timestamp(),repaired_at = clock_timestamp(),reason = 'Imported retained name'
          WHERE data_epoch = $1 AND source = $2 AND repaired_at IS NULL`,
          [env.lineage.dataEpoch, row.source.value, JSON.stringify(row)],
        );
        await client.query('RELEASE SAVEPOINT import_name');
      } catch (error) {
        if (
          !(
            error instanceof LegacyNameInvalid ||
            error instanceof NameInvalid ||
            error instanceof InvalidAddressName ||
            (error &&
              typeof error === 'object' &&
              'code' in error &&
              ['23505', '23514'].includes(String(error.code)))
          )
        )
          throw error;
        await client.query('ROLLBACK TO SAVEPOINT import_name');
        const reason = error instanceof Error ? error.message : String(error);
        console.warn('Skipped legacy name; holder uses its identity address', {
          source: row.source?.value,
          key: row.key?.value,
          reason,
        });
        await client.query(
          `INSERT INTO access.name_graph_import_report(data_epoch,source,reason,legacy_name,attempted_at)
          VALUES ($1,$2,$3,$4,clock_timestamp()) ON CONFLICT(data_epoch,source) DO UPDATE SET
            reason = EXCLUDED.reason,legacy_name = EXCLUDED.legacy_name,attempted_at = EXCLUDED.attempted_at`,
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
      } } ORDER BY STR(?revision) LIMIT ${NAME_IMPORT_COST.historyPage}`,
          64 * 1024,
        )
      ).results?.bindings ?? [];
    if (!rows.length) break;
    const records = rows.map((row) => {
      if (!row.revision || row.work?.value !== holder)
        throw new LegacyNameInvalid('Former name history has a different holder');
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

/** Completed epochs still have a repair queue. Advance by source even on a
 * repeated denial so one bad legacy value cannot starve later reports. */
async function repairSkippedNames(env: WorkActivationEnvironment, deadline: number) {
  const registry = env.addresses!;
  let after = '';
  for (;;) {
    if (Date.now() > deadline)
      throw new NameUnavailable('Name repair exceeded its preparation budget');
    const reports = (
      await registry.pool.query<{ source: string; legacy_name: LegacyName | null }>(
        `SELECT source,legacy_name FROM access.name_graph_import_report
      WHERE data_epoch = $1 AND repaired_at IS NULL AND source > $2 ORDER BY source LIMIT ${NAME_IMPORT_COST.page}`,
        [env.lineage.dataEpoch, after],
      )
    ).rows;
    if (!reports.length) return;
    const rows: LegacyName[] = [];
    for (const report of reports) {
      const row = report.legacy_name ?? (await recoverLegacyName(env, report.source, deadline));
      if (row) rows.push(row);
      else
        await registry.pool.query(
          `UPDATE access.name_graph_import_report
        SET attempted_at = clock_timestamp(),reason = 'Retained name evidence is unavailable'
        WHERE data_epoch = $1 AND source = $2 AND repaired_at IS NULL`,
          [env.lineage.dataEpoch, report.source],
        );
    }
    if (rows.length) await importNameRows(env, rows, deadline);
    after = reports.at(-1)!.source;
  }
}

/** Pre-upgrade reports contain only a source IRI. Read retained bytes rather
 * than guessing a key from labels, URLs or a platform-specific lookup table. */
async function recoverLegacyName(env: WorkActivationEnvironment, source: string, deadline: number) {
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
  if (base.length > 1) throw new LegacyNameInvalid('Former name source is ambiguous');
  let after = '';
  let afterSequence: string | null = null;
  for (;;) {
    if (Date.now() > deadline)
      throw new NameUnavailable('Name evidence exceeded its preparation budget');
    const revisions: LegacyName[] =
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
        } } ORDER BY DESC(?sequence) DESC(STR(?revision)) LIMIT ${NAME_IMPORT_COST.page}`,
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
        throw new NameUnavailable('Legacy name projection contains a blank node');
      if (object['xml:lang'] && !/^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/.test(object['xml:lang']))
        throw new NameUnavailable('Invalid legacy language tag');
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
    throw new NameUnavailable(`Name projection cleanup did not commit (${JSON.stringify(result)})`);
}
