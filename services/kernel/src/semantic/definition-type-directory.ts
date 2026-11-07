import { pickText } from '@rezics/composition';
import { createHash } from 'node:crypto';
import type { TypeDefinition, PropertyDefinition } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { ProblemError } from '../http/problem-error.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { withReadTransaction } from './read.ts';

import {
  TYPE_DIRECTORY_LOCALES,
  typeDirectorySort,
  typeDirectoryReady,
  CHUNK,
  ROOT,
  type Edge,
} from './definition-type-directory-stage.ts';
export {
  TYPE_DIRECTORY_LOCALES,
  typeDirectorySort,
  typeDirectoryReady,
  stageTypeDirectory,
  stageReleaseTypeDirectory,
} from './definition-type-directory-stage.ts';

const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Entry = { id: string; id_key: string; release_digest: string; body: TypeDefinition };
type Head = { catalogue: string; head: number; native: boolean };

function localeOf(locale = 'en'): string {
  if (!(TYPE_DIRECTORY_LOCALES as readonly string[]).includes(locale)) throw new ProblemError('invalid_request');
  return locale;
}
async function currentHead(client: PoolClient): Promise<Head | null> {
  const native = (
    await client.query<{ root_digest: string | null; head: number }>(
      'SELECT root_digest,head FROM semantic.definition_catalogue_head WHERE route=0',
    )
  ).rows[0];
  if (native?.root_digest) return { catalogue: native.root_digest, head: native.head, native: true };
  const legacy = (
    await client.query<{ digest: string; head: number }>(
      'SELECT digest,head FROM semantic.definition_activation WHERE route=0 ORDER BY head DESC LIMIT 1',
    )
  ).rows[0];
  return legacy ? { catalogue: legacy.digest, head: legacy.head, native: false } : null;
}
function summary(entry: Entry, locale: string) {
  const label = pickText(entry.body.labels, locale),
    description = pickText(entry.body.descriptions ?? {}, locale);
  return {
    typeId: entry.id,
    releaseDigest: entry.release_digest,
    label: label.text,
    language: label.lang,
    parents: entry.body.bases,
    description: description.text || null,
    descriptionLanguage: description.lang,
  };
}
async function entryAt(client: PoolClient, catalogue: string, idKey: string): Promise<Entry | undefined> {
  return (
    await client.query<Entry>(
      'SELECT id,id_key,release_digest,body FROM semantic.definition_type_entry WHERE route=0 AND catalogue=$1 AND id_key=$2',
      [catalogue, idKey],
    )
  ).rows[0];
}

/** Seek a prefix in the trie, then walk only successor edges. No registry scan or sort. */
async function pageKeys(
  client: PoolClient,
  catalogue: string,
  locale: string,
  prefix: Buffer,
  after: Buffer | null,
  limit: number,
) {
  const keys: string[] = [];
  const children = async (parent: string, lower: Buffer, inclusive: boolean) =>
    (
      await client.query<Edge>(
        `SELECT chunk,node_key,entry_key FROM semantic.definition_type_edge
     WHERE route=0 AND catalogue=$1 AND locale=$2 AND parent_key=$3
       AND chunk ${inclusive ? '>=' : '>'} $4::bytea ORDER BY chunk LIMIT $5`,
        [catalogue, locale, parent, lower, limit - keys.length],
      )
    ).rows;
  async function walk(parent: string, depth: number, onBoundary: boolean): Promise<void> {
    const boundary = after && onBoundary && after.length > depth ? after.subarray(depth, depth + CHUNK) : null;
    const required = prefix.length > depth ? prefix.subarray(depth, depth + CHUNK) : null;
    const lower = boundary ?? required ?? Buffer.alloc(0);
    let cursor = lower,
      inclusive = true;
    while (keys.length < limit) {
      const rows = await children(parent, cursor, inclusive);
      if (!rows.length) return;
      for (const row of rows) {
        if (required && !row.chunk.subarray(0, required.length).equals(required)) return;
        const equalBoundary = boundary !== null && row.chunk.equals(boundary);
        if (row.entry_key) {
          if (!equalBoundary) keys.push(row.entry_key);
        } else await walk(row.node_key, depth + row.chunk.length, equalBoundary);
        if (keys.length === limit) return;
      }
      cursor = rows.at(-1)!.chunk;
      inclusive = false;
    }
  }
  await walk(ROOT, 0, after !== null);
  return keys;
}

export function createTypeDirectory(dependencies: { pool: Pool; tokens: KeyRing; clock: () => Date }) {
  async function read<T>(
    authorize: (client: PoolClient) => Promise<boolean>,
    deadline: number,
    body: (client: PoolClient, head: Head | null) => Promise<T>,
  ) {
    return withReadTransaction(
      dependencies.pool,
      async (client) => {
        if (!(await authorize(client))) throw new ProblemError('not_found');
        const head = await currentHead(client);
        return body(client, head);
      },
      deadline,
    );
  }
  return {
    async list(
      input: { query?: string; typeId?: string; locale?: string; limit?: number; cursor?: string },
      authorize: (client: PoolClient) => Promise<boolean>,
      deadline: number,
    ) {
      const locale = localeOf(input.locale),
        limit = input.limit ?? 20,
        query = input.query ?? '';
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 20 ||
        query.length > 512 ||
        (input.typeId !== undefined && query)
      )
        throw new ProblemError('invalid_request');
      const binding = {
        operation: 'definitionTypes.list',
        parameters: { query, locale, limit, typeId: input.typeId ?? null },
      };
      const decoded = input.cursor
        ? decodeCursor(dependencies.tokens, binding, input.cursor, dependencies.clock().getTime())
        : null;
      if (decoded && !decoded.ok)
        throw new ProblemError(decoded.reason === 'expired' ? 'stale_cursor' : 'invalid_cursor');
      return read(authorize, deadline, async (client, head) => {
        if (
          decoded?.ok &&
          (!head ||
            decoded.epoch !== head.head ||
            decoded.after[0] !== head.catalogue ||
            decoded.after[1] !== (head.native ? 1 : 0))
        )
          throw new ProblemError('stale_cursor');
        if (!head) return { types: [], next: null };
        if (!(await typeDirectoryReady(client, head.catalogue))) throw new ProblemError('semantic_not_ready');
        if (input.typeId !== undefined) {
          const entry = await entryAt(client, head.catalogue, key(input.typeId));
          return { types: entry?.id === input.typeId ? [summary(entry, locale)] : [], next: null };
        }
        let after: Buffer | null = null;
        if (decoded?.ok) {
          const entry =
            typeof decoded.after[2] === 'string' ? await entryAt(client, head.catalogue, decoded.after[2]) : undefined;
          if (!entry) throw new ProblemError('invalid_cursor');
          after = typeDirectorySort(pickText(entry.body.labels, locale).text, entry.id);
        }
        const prefix = typeDirectorySort(query).subarray(0, query.length * 3);
        const keys = await pageKeys(client, head.catalogue, locale, prefix, after, limit + 1);
        const entries = await Promise.all(
          keys.slice(0, limit).map(async (id) => (await entryAt(client, head.catalogue, id))!),
        );
        return {
          types: entries.map((entry) => summary(entry, locale)),
          next:
            keys.length > limit
              ? encodeCursor(
                  dependencies.tokens,
                  binding,
                  { epoch: head.head, after: [head.catalogue, head.native ? 1 : 0, keys[limit - 1]!] },
                  dependencies.clock().getTime(),
                )
              : null,
        };
      });
    },
    async exact(
      typeId: string,
      locale: string | undefined,
      authorize: (client: PoolClient) => Promise<boolean>,
      deadline: number,
    ) {
      const language = localeOf(locale);
      return read(authorize, deadline, async (client, head) => {
        if (head && !(await typeDirectoryReady(client, head.catalogue))) throw new ProblemError('semantic_not_ready');
        const entry = head ? await entryAt(client, head.catalogue, key(typeId)) : undefined;
        if (!entry || entry.id !== typeId) throw new ProblemError('not_found');
        const ids = entry.body.properties;
        const properties = head!.native
          ? (
              await client.query<{ id: Buffer; body: PropertyDefinition }>(
                `SELECT id,body FROM semantic.definition_catalogue_member WHERE route=0 AND root_digest=$1
             AND release_digest=$2 AND category='property' AND id_key=ANY($3::text[])`,
                [head!.catalogue, entry.release_digest, ids.map((id) => `sha256:${key(id)}`)],
              )
            ).rows.map((row) => [row.id.toString('utf8'), row.body] as const)
          : (
              await client.query<{ id: string; body: PropertyDefinition }>(
                `SELECT id,body FROM semantic.definition_type_property WHERE route=0 AND release_digest=$1 AND id_key=ANY($2::text[])`,
                [entry.release_digest, ids.map(key)],
              )
            ).rows.map((row) => [row.id, row.body] as const);
        if (properties.length !== ids.length || properties.some(([id]) => !ids.includes(id)))
          throw new ProblemError('semantic_not_ready');
        return { ...summary(entry, language), definition: entry.body, properties: Object.fromEntries(properties) };
      });
    },
  };
}
