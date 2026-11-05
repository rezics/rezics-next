import { t } from 'elysia';
import { Value } from 'typebox/value';
import type { Source } from '@rezics/definitions/bulk';
import type { Pool, PoolClient } from 'pg';
import { noEffect, runCommand, type CommandAuthorization } from '../command/command.ts';
import { isSpdxLicense } from '../content/document.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccountActor } from '../request/access.ts';
import { partitionOf } from '../route/route.ts';
import { withReadTransaction } from './read.ts';
import writeMetadata from './source-records-write.sql';

export type SourceRecord = {
  name: string;
  url: string;
  licence?: { id: string; url?: string };
  attribution?: string;
};
export type SourceRecordMetadataCommand = {
  source: string;
  external_id: string;
  metadata: SourceRecord;
  expected_metadata_revision: number | null;
};
export type SourceRecordMetadataResult = {
  record: SourceRecord;
  metadata_revision: number;
  effect: 'filled' | 'corrected' | 'noEffect';
};

const scalar = (maximum: number) => t.String({ minLength: 1, maxLength: maximum });
export const SourceRecordSchema = t.Object(
  {
    name: scalar(255),
    url: scalar(2048),
    licence: t.Optional(t.Object({ id: scalar(128), url: t.Optional(scalar(2048)) }, { additionalProperties: false })),
    attribution: t.Optional(scalar(500)),
  },
  { additionalProperties: false },
);
export const SourceRecordMetadataCommandSchema = t.Object(
  {
    source: t.String({ pattern: '^[a-z][a-z0-9_-]{0,31}$' }),
    external_id: scalar(255),
    metadata: SourceRecordSchema,
    expected_metadata_revision: t.Union([t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), t.Null()]),
  },
  { additionalProperties: false },
);
export const SourceRecordMetadataResultSchema = t.Object(
  {
    record: SourceRecordSchema,
    metadata_revision: t.Integer({ minimum: 1 }),
    effect: t.Union([t.Literal('filled'), t.Literal('corrected'), t.Literal('noEffect')]),
  },
  { additionalProperties: false },
);

export class SourceRecordMetadataInputError extends Error {}
export class SourceRecordMetadataConflictError extends Error {}

const controls = /[\u0000-\u001f\u007f-\u009f]/u;
function text(value: string): boolean {
  return value.isWellFormed() && !controls.test(value) && value.trim().length > 0;
}
function url(value: string): boolean {
  if (!text(value) || /\s/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function leaves(record: SourceRecord): Record<string, string> {
  return {
    name: record.name,
    url: record.url,
    ...(record.licence ? { 'licence.id': record.licence.id } : {}),
    ...(record.licence?.url === undefined ? {} : { 'licence.url': record.licence.url }),
    ...(record.attribution === undefined ? {} : { attribution: record.attribution }),
  };
}

/** Native metadata validation does not infer registration or rights from an alias or URL. */
export function validateSourceRecordMetadata(input: unknown): asserts input is SourceRecordMetadataCommand {
  if (!Value.Check(SourceRecordMetadataCommandSchema, input)) throw new SourceRecordMetadataInputError();
  const { metadata } = input;
  if (
    !text(input.external_id) ||
    !text(metadata.name) ||
    !url(metadata.url) ||
    (metadata.attribution !== undefined && !text(metadata.attribution)) ||
    (metadata.licence !== undefined &&
      (!isSpdxLicense(metadata.licence.id) || (metadata.licence.url !== undefined && !url(metadata.licence.url))))
  )
    throw new SourceRecordMetadataInputError();
}

export const SOURCE_RECORD_METADATA = 'source_record.set_metadata';
export const SOURCE_RECORD_METADATA_CHANGED = 'com.rezics.source-record.metadata-changed.v1';

type SourceTuple = { route: number; source: string; external_id: string };

/** Disclosed reads batch their already-selected tuples by owner partition. */
async function metadataPoints(client: Pick<PoolClient, 'query'>, tuples: readonly SourceTuple[]) {
  return client.query<{ source: string; external_id: string; record: SourceRecord; metadata_revision: number }>(
    `SELECT stored.source,stored.external_id,stored.record,stored.metadata_revision
     FROM jsonb_to_recordset($1::jsonb) AS wanted(route integer,source text,external_id text)
     CROSS JOIN LATERAL (
       SELECT source,external_id,record,metadata_revision FROM semantic.source_record
       WHERE route=wanted.route AND source=wanted.source AND external_id=wanted.external_id
         AND (route::text || ':' || source || ':' || external_id) =
             (wanted.route::text || ':' || wanted.source || ':' || wanted.external_id)
       LIMIT 1
     ) stored`,
    [JSON.stringify(tuples)],
  );
}

/** Independent tuple-home command. Authorization is prepared afresh by runCommand before every receipt read. */
export async function writeSourceRecordMetadata(
  pool: Pool,
  options: {
    command: SourceRecordMetadataCommand;
    validated?: boolean;
    routeKey: Uint8Array;
    actor: AccountActor;
    authorization: CommandAuthorization;
    idempotencyKey: string;
    digest: Uint8Array;
    deadline: number;
    clock: () => Date;
  },
) {
  if (!options.validated) validateSourceRecordMetadata(options.command);
  const { source, external_id, metadata, expected_metadata_revision } = options.command;
  const route = tupleRoute(options.routeKey, source, external_id);
  const actor = options.actor;
  const outcome = await runCommand<{ status: 200 | 201; value: SourceRecordMetadataResult }>(
    pool,
    {
      partition: partitionOf(route),
      authorization: options.authorization,
      deadline: options.deadline,
      clock: options.clock,
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      receipt: {
        actorAccountId: actor.accountId,
        kind: SOURCE_RECORD_METADATA,
        key: options.idempotencyKey,
        digest: options.digest,
      },
    },
    async (tx, { transactionId }) => {
      const result = await writeMetadata.run(tx, {
        route,
        source,
        external_id,
        metadata,
        // Revisions are positive, so zero encodes the schema's null fill mode.
        expected_revision: expected_metadata_revision ?? 0,
        transaction_id: transactionId,
      });
      const current = result[0];
      if (!current || current.conflict) throw new SourceRecordMetadataConflictError();
      const record = current.record as SourceRecord;
      const revision = current.metadata_revision as number;
      if (!current.changed)
        return noEffect({
          status: 200 as const,
          value: { record, metadata_revision: revision, effect: 'noEffect' as const },
        });
      return {
        value: {
          status: expected_metadata_revision === null && revision === 1 ? (201 as const) : (200 as const),
          value: {
            record,
            metadata_revision: revision,
            effect: expected_metadata_revision === null ? ('filled' as const) : ('corrected' as const),
          },
        },
        events: [{ type: SOURCE_RECORD_METADATA_CHANGED, data: { source, external_id, metadata_revision: revision } }],
      };
    },
  );
  return {
    ...outcome.value,
    component: { partition: outcome.partition, epoch: outcome.epoch, position: outcome.position },
  };
}

/** Exact already-disclosed tuples only. No claim, candidate or history discovery takes place here. */
export async function readSourceRecords(
  pool: Pool,
  routeKey: Uint8Array,
  support: readonly Source[],
): Promise<SourceRecord[]> {
  const tuples = new Map<string, { route: number; source: string; external_id: string }>();
  for (const source of support) {
    const key = JSON.stringify([source.source, source.external_id]);
    if (!tuples.has(key))
      tuples.set(key, {
        route: tupleRoute(routeKey, source.source, source.external_id),
        source: source.source,
        external_id: source.external_id,
      });
  }
  const homes = new Map<number, SourceTuple[]>();
  for (const tuple of tuples.values()) {
    const home = partitionOf(tuple.route);
    const group = homes.get(home) ?? [];
    group.push(tuple);
    homes.set(home, group);
  }
  const hydrated = new Map<string, SourceRecord>();
  for (const [home, group] of homes) {
    await withReadTransaction(pool, async (client) => {
      const state = await readPartition(client, home);
      if (!state) throw new CommandUnavailableError('deadline', home);
      if (state.writeState === 'moved') throw new CommandUnavailableError('moved', home, state.movedTo);
      const result = await metadataPoints(client, group);
      for (const row of result.rows) hydrated.set(JSON.stringify([row.source, row.external_id]), row.record);
    });
  }
  const seen = new Set<string>();
  const records: SourceRecord[] = [];
  for (const key of tuples.keys()) {
    const record = hydrated.get(key);
    if (!record) continue;
    const wire = JSON.stringify(leaves(record));
    if (!seen.has(wire)) {
      seen.add(wire);
      records.push(record);
    }
  }
  return records;
}
