import { expect, test } from 'bun:test';
import { exportAccessErasureRecoveryAttachment } from '../src/modules/access/erasure-recovery.ts';
import type { PoolClient } from 'pg';
import { ACCESS_RECOVERY_CLASSIFICATION, accessAuthorityValues, accessRecoveryCatalog,
  accessRecoveryRule, assertAccessRecoveryClassification, resetAccessRecoveryState } from '../src/modules/work/access-recovery-coverage.ts';
import { type OwnerCatalog, type OwnerTable } from '../src/modules/work/pg-recovery-frontier.ts';

function table(name: string, columns: string[]): OwnerTable {
  return { name: `access.${name}`, schema: 'access', table: name,
    columns: columns.map(column => `${column} text`), key: ['id'], keyTypes: ['text'] };
}

const generationRule = ACCESS_RECOVERY_CLASSIFICATION['access.derived_generation']!;
const generation = table('derived_generation', Object.keys(generationRule.columns!));
const building = Object.fromEntries(Object.keys(generationRule.columns!)
  .map(column => [column, column === 'state' ? 'building' : column]));

test('restore keeps excluded backup state and resets only named owner-rebuild state', async () => {
  const queries: string[] = [];
  const client = { query: async (sql: string) => {
    if (sql.includes('FROM pg_class c JOIN pg_namespace')) return { rows:
      Object.keys(ACCESS_RECOVERY_CLASSIFICATION).map(name => ({ schema: 'access', table: name.slice(7),
        persistence: 'p', comment: null, key: ['id'], key_types: ['text'], columns: ['id text'] })) };
    queries.push(sql);
    return { rows: [], rowCount: 0 };
  } } as unknown as PoolClient;
  await resetAccessRecoveryState(client);
  expect(queries.map(sql => /(?:UPDATE|DELETE FROM) access\.(\w+)/.exec(sql)?.[1]).sort())
    .toEqual(['derived_generation', 'discovery_refresh', 'rate_limit_v1', 'realm_directory', 'realm_directory_position']);
});

test('durable temporal publication intents remain authority', async () => {
  await expect(exportAccessErasureRecoveryAttachment(
    comparisonClient('event_temporal_window_update', { id: 'base', digest: 'old' }),
    comparisonClient('event_temporal_window_update', { id: 'base', digest: 'changed' }), async () => {}))
    .rejects.toThrow('base Access row changed: access.event_temporal_window_update');
});


test('Access recovery protects literal generation identities while building and closed evidence after finish', async () => {
  const authority = accessAuthorityValues(generation, building);
  // Independent of the rule being constrained: removing any identity exclusion
  // must fail this test while the generation is still building.
  for (const column of ['id', 'family', 'scope_key', 'input_digest', 'input_manifest',
    'validation_digest', 'created_at', 'ready_at']) {
    const changed = { ...building, [column]: `${building[column]}-changed` };
    expect(accessAuthorityValues(generation, changed)).not.toEqual(authority);
    await expect(exportAccessErasureRecoveryAttachment(comparisonClient('derived_generation', building),
      comparisonClient('derived_generation', changed), async () => {}))
      .rejects.toThrow('base Access row changed: access.derived_generation');
  }
  for (const column of ['lease_epoch', 'lease_expires_at', 'failure_reason', 'finished_at']) {
    expect(accessAuthorityValues(generation, { ...building, [column]: 'changed' })).toEqual(authority);
  }
  const ready = { ...building, state: 'ready' };
  expect(accessAuthorityValues(generation, ready)).toEqual(ready);
  expect(accessAuthorityValues(generation, { ...ready, lease_epoch: 'changed' })).not.toEqual(ready);
  expect(accessAuthorityValues(generation, { ...building, state: 'failed' })).not.toEqual(authority);
  const extended = { ...generation, columns: [...generation.columns, 'unclassified_build_state text'] };
  const unknown = { ...building, unclassified_build_state: 'base' };
  expect(accessAuthorityValues(extended, { ...unknown, unclassified_build_state: 'changed' }))
    .not.toEqual(accessAuthorityValues(extended, unknown));
  const input = { id: 'base', generation_id: 'generation', source: 'main-graph', data_epoch: 'epoch',
    pinned_sequence: '0', checkpoint_sequence: '0', checkpoint_event: null, snapshot_complete: 'false', snapshot_cursor: null };
  for (const column of ['generation_id', 'source', 'data_epoch', 'pinned_sequence']) {
    await expect(exportAccessErasureRecoveryAttachment(comparisonClient('derived_generation_input', input),
      comparisonClient('derived_generation_input', { ...input, [column]: 'changed' }), async () => {}))
      .rejects.toThrow('base Access row changed: access.derived_generation_input');
  }
});

test('Access recovery catalog custody commits to table classes, column classes and reset rules', () => {
  const directory = table('realm_directory', ['id']);
  const catalog: OwnerCatalog = { tables: [directory, generation], excluded: {}, digest: 'a'.repeat(64) };
  const digest = accessRecoveryCatalog(catalog).digest;
  const directoryRule = ACCESS_RECOVERY_CLASSIFICATION[directory.name]!;
  const oldClass = directoryRule.class, oldReset = directoryRule.reset;
  try {
    directoryRule.class = 'authority';
    expect(accessRecoveryCatalog(catalog).digest).not.toBe(digest);
    directoryRule.class = oldClass;
    directoryRule.reset = `${oldReset} WHERE false`;
    expect(accessRecoveryCatalog(catalog).digest).not.toBe(digest);
  } finally { directoryRule.class = oldClass; directoryRule.reset = oldReset; }
  const columns = generationRule.columns as Record<string, 'authority' | 'operational'>;
  try {
    columns.lease_expires_at = 'authority';
    expect(accessRecoveryCatalog(catalog).digest).not.toBe(digest);
  } finally { columns.lease_expires_at = 'operational'; }
});

test('delivery and revocation leases remain authority despite their lease names', () => {
  for (const name of ['search_read_lease', 'download_read_lease']) {
    const entry = table(name, ['id', 'state', 'expires_at']);
    expect(accessRecoveryRule(entry).class).toBe('authority');
    const row = { id: 'lease', state: 'delivering', expires_at: 'old' };
    expect(accessAuthorityValues(entry, row)).toEqual(row);
    expect(accessAuthorityValues(entry, { ...row, state: 'delivered' })).not.toEqual(row);
  }
});





const rebuiltTables = [
  'feed_author_dirty', 'feed_checkpoint', 'feed_item', 'feed_target', 'feed_target_checkpoint',
  'serial_chapter', 'serial_content_words', 'serial_stats_checkpoint', 'serial_summary',
  'zone_browse_entry', 'statement_seek', 'statement_seek_coverage', 'statement_publication_seek_coverage',
  'template_seek_basis', 'template_seek_checkpoint', 'template_seek_entity', 'template_seek_entry',
  'template_seek_pending', 'template_seek_pending_anchor',
  'event_temporal_applied', 'event_temporal_bucket', 'event_temporal_checkpoint', 'event_temporal_interval',
  'event_temporal_member', 'event_temporal_pending', 'event_temporal_window',
  'judgment_badge_projection', 'read_ranking_admitted', 'read_ranking_checkpoint', 'read_ranking_pending',
  'read_ranking_publication', 'read_ranking_removal', 'read_ranking_score', 'read_ranking_target',
  'realm_thread_checkpoint', 'realm_thread_dirty', 'realm_thread_order', 'realm_thread_population',
  'realm_thread_population_admission', 'realm_thread_population_job', 'realm_thread_private_order',
  'realm_thread_reference', 'realm_thread_state', 'read_ranking_admission', 'notification_filter_bounds',
  'watch_participation',
  'notification_filter_seek', 'template_discovery_basis', 'realm_directory', 'realm_directory_position',
  'follow_activity', 'realm_growth_day', 'realm_growth_change', 'realm_growth_position',
  'realm_count_change', 'site_moderation_change', 'discovery_source_change', 'discovery_source_key',
  'discovery_source_fence', 'also_enjoyed_source_change', 'also_enjoyed_source_fence',
] as const;
const operationalTables = ['discovery_refresh', 'discovery_refresh_catalog', 'discovery_retirement',
  'public_name_backfill_checkpoint', 'rate_limit_v1', 'ranking_partition', 'ranking_score',
  'ranking_signal_slot', 'discovery_entry', 'discovery_coverage', 'discovery_concept_count',
  'discovery_term_count', 'also_enjoyed_pair', 'also_enjoyed_signal', 'event_histogram_bucket',
  'event_interval_key', 'notification_producer_cursor', 'library_follow_position',
  'relationship_recovery_cursor', 'owner_consumer_checkpoint', 'notification_recipient_progress'] as const;

/** Native owner protocol double: the exporter, catalogue and comparisons stay real. */
function comparisonClient(target: string, values: Record<string, unknown> | undefined, generationBuilding = true,
  catalogValues = values): PoolClient {
  const keys = target === 'watch' ? ['principal_id', 'target'] : ['id'];
  const names = [...new Set(['admission', 'admission_receipt', 'outbox', 'discovery_source_change',
    'also_enjoyed_source_change', target])].sort();
  return { query: async (sql: string, params: unknown[] = []) => {
    let rows: unknown[] = [];
    if (sql.includes('FROM access.recovery_fence')) rows = [{ open: false, generation: '0' }];
    else if (sql.includes('FROM pg_class c JOIN pg_namespace')) rows = names.map(name => ({
      schema: 'access', table: name, persistence: 'p', comment: null,
      key: name === target ? keys : ['id'], key_types: name === target ? keys.map(() => 'text') : ['text'],
      columns: Object.keys(catalogValues ?? { id: 'base', payload: 'old' }).sort().map(column => `${column} text`),
    }));
    else if (sql.includes('FROM pg_attribute a WHERE a.attrelid')) rows = Object.keys(catalogValues ?? { id: 'base', payload: 'old' })
      .map(name => ({ name, type: 'text', generated: false }));
    else if (sql.includes('::text AS values') && sql.includes(`FROM "access"."${target}" t`)
      && params.length === 0 && values) rows = [{
        key: JSON.stringify(Object.fromEntries(keys.map(key => [key, key === 'id' ? 'base' : String(values[key])]))), values: JSON.stringify(values), building: generationBuilding,
        ...(sql.includes('AS authoritative') ? { authoritative: !(target === 'watch' && values.kind === 'thread'
          && values.reason !== 'manual' && values.manual_choice === 'false') } : {}),
      }];
    else if (!(sql.includes('set_config(') || sql.includes('::text AS body')
      || sql.includes('FROM access.outbox') || sql.includes('::text AS values'))) {
      throw new Error(`Unexpected comparison query: ${sql}`);
    }
    return { rows, rowCount: rows.length };
  } } as unknown as PoolClient;
}

test('native capture accepts pruned recipient traversal while durable delivery identities remain exact', async () => {
  const before = { id: 'base', source_owner: 'owner', source_event: 'event', topic: 'topic', complete: 'true', updated_at: 'old' };
  expect((await exportAccessErasureRecoveryAttachment(comparisonClient('notification_recipient_progress', before),
    comparisonClient('notification_recipient_progress', undefined, true, before), async () => {})).rowCount).toBe('0');
  for (const column of ['source_owner', 'source_event', 'topic']) {
    await expect(exportAccessErasureRecoveryAttachment(comparisonClient('notification_digest_candidate', before),
      comparisonClient('notification_digest_candidate', { ...before, [column]: 'changed' }), async () => {}))
      .rejects.toThrow('base Access row changed: access.notification_digest_candidate');
  }
});

test('native capture excludes automatic thread watches and protects manual watch decisions', async () => {
  const before = { principal_id: 'principal', target: 'thread', kind: 'thread', reason: 'author', manual_choice: 'false',
    proposal: null, level: 'participating', revision: '1', changed_at: 'old' };
  for (const after of [{ ...before, revision: '2', changed_at: 'new' }, undefined]) {
    expect((await exportAccessErasureRecoveryAttachment(comparisonClient('watch', before),
      comparisonClient('watch', after, true, before), async () => {})).rowCount).toBe('0');
  }
  const manual = { ...before, manual_choice: 'true' };
  await expect(exportAccessErasureRecoveryAttachment(comparisonClient('watch', manual),
    comparisonClient('watch', { ...manual, level: 'ignore' }), async () => {}))
    .rejects.toThrow('base Access row changed: access.watch');
  await expect(exportAccessErasureRecoveryAttachment(comparisonClient('watch', manual),
    comparisonClient('watch', undefined, true, manual), async () => {}))
    .rejects.toThrow('base Access row was removed: access.watch');
  const extended = { ...before, unclassified_intent: 'before' };
  await expect(exportAccessErasureRecoveryAttachment(comparisonClient('watch', extended),
    comparisonClient('watch', { ...extended, unclassified_intent: 'after' }), async () => {}))
    .rejects.toThrow('base Access row changed: access.watch');
});

test('native capture accepts the automatic watch participation cascade', async () => {
  const before = { id: 'base', principal_id: 'principal', target: 'thread' };
  expect((await exportAccessErasureRecoveryAttachment(comparisonClient('watch_participation', before),
    comparisonClient('watch_participation', undefined, true, before), async () => {})).rowCount).toBe('0');
});

for (const name of ['ranking_partition', 'ranking_score', 'ranking_signal_slot', 'discovery_entry',
  'discovery_coverage', 'discovery_concept_count', 'discovery_term_count', 'also_enjoyed_pair', 'also_enjoyed_signal']) {
  test(`native capture authenticates closed generation payloads: ${name}`, async () => {
    const before = { id: 'base', generation_id: 'generation', payload: 'old' };
    await expect(exportAccessErasureRecoveryAttachment(comparisonClient(name, before, false),
      comparisonClient(name, { ...before, payload: 'changed' }, false), async () => {}))
      .rejects.toThrow(`base Access row changed: access.${name}`);
    await expect(exportAccessErasureRecoveryAttachment(comparisonClient(name, before, false),
      comparisonClient(name, undefined, false, before), async () => {}))
      .rejects.toThrow(`base Access row was removed: access.${name}`);
  });
}

for (const [kind, names] of [['derived-projection', rebuiltTables], ['operational', operationalTables]] as const) {
  for (const name of names) test(`native capture accepts changed and removed ${kind} rows: ${name}`, async () => {
    expect(accessRecoveryRule(table(name, ['id', 'payload'])).class).toBe(kind);
    const before = { id: 'base', payload: 'old' };
    for (const after of [{ ...before, payload: 'new' }, undefined]) {
      const summary = await exportAccessErasureRecoveryAttachment(comparisonClient(name, before),
        comparisonClient(name, after), async () => {});
      expect(summary.rowCount).toBe('0');
    }
  });
}

test('native capture still refuses an altered authority row', async () => {
  await expect(exportAccessErasureRecoveryAttachment(comparisonClient('permission_grant', { id: 'base', payload: 'old' }),
    comparisonClient('permission_grant', { id: 'base', payload: 'new' }), async () => {}))
    .rejects.toThrow('base Access row changed: access.permission_grant');
});

for (const name of ['account_deletion_classification_frontier',
  'governance_preservation_delivery_head', 'live_principal_controller']) {
  test(`native capture keeps current deletion and preservation cuts exact: ${name}`, async () => {
    const before = { id: 'base', payload: 'retained' };
    expect(ACCESS_RECOVERY_CLASSIFICATION[`access.${name}`]?.class).toBe('authority');
    for (const after of [{ ...before, payload: 'changed' }, undefined]) {
      await expect(exportAccessErasureRecoveryAttachment(comparisonClient(name, before),
        comparisonClient(name, after, true, before), async () => {}))
        .rejects.toThrow(after ? `base Access row changed: access.${name}` : `base Access row was removed: access.${name}`);
    }
  });
}


test('native capture accepts every mutable building input checkpoint and protects closed input evidence', async () => {
  const before = { id: 'base', generation_id: 'generation', source: 'main-graph', data_epoch: 'old-cut',
    pinned_sequence: '0', checkpoint_sequence: '0', checkpoint_event: null, snapshot_cursor: null, snapshot_complete: 'false' };
  for (const column of ['checkpoint_sequence', 'checkpoint_event', 'snapshot_cursor', 'snapshot_complete']) {
    const after = { ...before, [column]: 'changed' };
    const inputTable = table('derived_generation_input', Object.keys(before));
    expect((await exportAccessErasureRecoveryAttachment(comparisonClient('derived_generation_input', before),
      comparisonClient('derived_generation_input', after), async () => {})).rowCount).toBe('0');
    expect(accessAuthorityValues(inputTable, before, false)).toEqual(before);
    expect(accessAuthorityValues(inputTable, after, false)).toEqual(after);
    expect(accessAuthorityValues(inputTable, after, false)).not.toEqual(accessAuthorityValues(inputTable, before, false));
    await expect(exportAccessErasureRecoveryAttachment(comparisonClient('derived_generation_input', before, false),
      comparisonClient('derived_generation_input', after, false), async () => {}))
      .rejects.toThrow('base Access row changed: access.derived_generation_input');
  }
});

for (const { name, identities, progress } of [
  { name: 'also_enjoyed_generation',
    identities: ['generation_id', 'family', 'graph_epoch', 'graph_sequence', 'access_revision', 'content_revision'],
    progress: ['after_key', 'pair_count', 'phase', 'signal_count'] },
  { name: 'discovery_generation',
    identities: ['generation_id', 'family', 'scope', 'realm', 'principal_id', 'context', 'source_epoch', 'access_revision', 'recovery_generation'],
    progress: ['catchup_works', 'changed_works', 'checkpoint', 'complete', 'rebuild_pending', 'source_sequence',
      'storage_generation', 'storage_version', 'work_count'] },
  { name: 'notification_digest_day', identities: ['principal_id', 'day'], progress: ['state', 'lease_until'] },
  { name: 'safety_notice_job', identities: ['decision_id', 'ordinal', 'target', 'participant'],
    progress: ['phase', 'after_subject', 'subject', 'after_principal'] },
  { name: 'safety_notice_mail_cursor', identities: ['decision_id'],
    progress: ['phase', 'after_party', 'after_report_at', 'after_report'] },
] as const) {
  test(`native capture protects literal identities and accepts worker progress: ${name}`, async () => {
    const before = { id: 'base', ...Object.fromEntries([...identities, ...progress].map(column => [column, column])) };
    for (const column of progress) {
      const after = { ...before, [column]: 'changed' };
      expect((await exportAccessErasureRecoveryAttachment(comparisonClient(name, before),
        comparisonClient(name, after), async () => {})).rowCount).toBe('0');
      if (name === 'also_enjoyed_generation' || name === 'discovery_generation') {
        await expect(exportAccessErasureRecoveryAttachment(comparisonClient(name, before, false),
          comparisonClient(name, after, false), async () => {})).rejects.toThrow(`base Access row changed: access.${name}`);
      }
    }
    for (const column of identities) {
      await expect(exportAccessErasureRecoveryAttachment(comparisonClient(name, before),
        comparisonClient(name, { ...before, [column]: 'changed' }), async () => {}))
        .rejects.toThrow(`base Access row changed: access.${name}`);
    }
  });
}

test('recovery mapping progress remains excluded while original input identity stays exact', async () => {
  const before = { id: 'base', generation_id: 'generation', source: 'main-graph', data_epoch: 'original', pinned_sequence: '0',
    recovery_data_epoch: null };
  for (const column of ['recovery_data_epoch']) {
    const after = { ...before, [column]: 'changed' };
    expect((await exportAccessErasureRecoveryAttachment(comparisonClient('derived_generation_input', before),
      comparisonClient('derived_generation_input', after), async () => {})).rowCount).toBe('0');
    await expect(exportAccessErasureRecoveryAttachment(comparisonClient('derived_generation_input', before, false),
      comparisonClient('derived_generation_input', after, false), async () => {}))
      .rejects.toThrow('base Access row changed: access.derived_generation_input');
  }
});


test('operational fencing columns require a signed monotone restore floor', () => {
  const entry = table('rate_limit_v1', ['id', 'lease_epoch']);
  expect(() => assertAccessRecoveryClassification({ tables: [entry], digest: 'a'.repeat(64), excluded: {} }))
    .toThrow('Access recovery operational lease needs a signed monotone floor');
});


test('prototype-named unknown columns remain exact authority and fail classification enumeration', async () => {
  for (const column of ['constructor', '__proto__', 'toString']) {
    const before = { ...building, [column]: 'before' };
    const after = { ...before, [column]: 'after' };
    await expect(exportAccessErasureRecoveryAttachment(comparisonClient('derived_generation', before),
      comparisonClient('derived_generation', after), async () => {}))
      .rejects.toThrow('base Access row changed: access.derived_generation');
    const extended = { ...generation, columns: [...generation.columns, `${column} text`] };
    expect(accessAuthorityValues(extended, after)).not.toEqual(accessAuthorityValues(extended, before));
    expect(() => assertAccessRecoveryClassification({ tables: [extended], excluded: {}, digest: 'a'.repeat(64) }))
      .toThrow('Access recovery column is unclassified');
  }
});
