import { createHash } from 'node:crypto';
import { pickText } from '@rezics/composition';
import { publicationLimits, type Release, type TypeDefinition, type PropertyDefinition } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { withReadTransaction } from './read.ts';

// These are the reader locales, not a restriction on released label languages.
export const TYPE_DIRECTORY_LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const;
const CHUNK = 128;
const ROOT = '';
const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Database = PoolClient | CommandTransaction;
type Entry = { id: string; id_key: string; release_digest: string; body: TypeDefinition };
type Edge = { chunk: Buffer; node_key: string; entry_key: string | null };
type Head = { catalogue: string; head: number; native: boolean };

// Three bytes per UTF-16 unit, plus a zero terminator, preserve JS string order,
// including embedded nulls, supplementary characters and prefix IDs. Fixed-size
// trie edges avoid PostgreSQL's B-tree tuple limit for admitted unbounded IDs.
export function typeDirectorySort(...parts: string[]): Buffer {
  const result = Buffer.alloc(parts.reduce((n, part) => n + 3 * (part.length + 1), 0));
  let offset = 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++, offset += 3) result.writeUIntBE(part.charCodeAt(i) + 1, offset, 3);
    offset += 3;
  }
  return result;
}
const childKey = (parent: string, chunk: Buffer) => createHash('sha256').update(parent).update(chunk).digest('hex');

async function stageEntry(tx: Database, catalogue: string, entry: Entry) {
  const saved = await tx.query<{ id: string }>(
    `INSERT INTO semantic.definition_type_entry(route,catalogue,id_key,id,release_digest,body)
     VALUES(0,$1,$2,$3::json,$4,$5::json)
     ON CONFLICT(route,catalogue,id_key) DO UPDATE SET release_digest=LEAST(
       definition_type_entry.release_digest,EXCLUDED.release_digest) RETURNING id`,
    [catalogue, entry.id_key, JSON.stringify(entry.id), entry.release_digest, JSON.stringify(entry.body)],
  );
  if (saved.rows[0]?.id !== entry.id) throw new Error('Definition Type identity hash collision');
  const edges: { locale: string; parent: string; chunk: Buffer; node: string; entry: string | null }[] = [];
  for (const locale of TYPE_DIRECTORY_LOCALES) {
    const sort = typeDirectorySort(pickText(entry.body.labels, locale).text, entry.id);
    let parent = ROOT;
    for (let offset = 0; offset < sort.length; offset += CHUNK) {
      const chunk = sort.subarray(offset, offset + CHUNK),
        node = childKey(parent, chunk);
      edges.push({ locale, parent, chunk, node, entry: offset + CHUNK >= sort.length ? entry.id_key : null });
      parent = node;
    }
  }
  await tx.query(
    `INSERT INTO semantic.definition_type_edge(route,catalogue,locale,parent_key,chunk,node_key,entry_key)
     SELECT 0,$1,l,p,c,n,e FROM unnest($2::text[],$3::text[],$4::bytea[],$5::text[],$6::text[]) AS edges(l,p,c,n,e)
     ON CONFLICT(route,catalogue,locale,parent_key,chunk) DO NOTHING`,
    [
      catalogue,
      edges.map((e) => e.locale),
      edges.map((e) => e.parent),
      edges.map((e) => e.chunk),
      edges.map((e) => e.node),
      edges.map((e) => e.entry),
    ],
  );
}

export async function typeDirectoryReady(tx: Database, catalogue: string): Promise<boolean> {
  return (
    (
      await tx.query<{ complete: boolean }>(
        'SELECT complete FROM semantic.definition_type_build WHERE route=0 AND catalogue=$1',
        [catalogue],
      )
    ).rows[0]?.complete === true
  );
}

/** An authorized immutable catalogue build owns this resumable final index phase. */
export async function stageTypeDirectory(tx: CommandTransaction, catalogue: string): Promise<boolean> {
  await tx.query(`INSERT INTO semantic.definition_type_build(route,catalogue) VALUES(0,$1) ON CONFLICT DO NOTHING`, [
    catalogue,
  ]);
  const progress = (
    await tx.query<{ complete: boolean; after_release: string; after_key: string }>(
      'SELECT complete,after_release,after_key FROM semantic.definition_type_build WHERE route=0 AND catalogue=$1 FOR UPDATE',
      [catalogue],
    )
  ).rows[0]!;
  if (progress.complete) return true;
  const rows = (
    await tx.query<Entry>(
      `SELECT id, id_key, release_digest, body FROM semantic.definition_catalogue_member
     WHERE route=0 AND root_digest=$1 AND category='type'
       AND (release_digest,id_key)>($2::text,$3::text)
     ORDER BY release_digest,id_key LIMIT 65`,
      [catalogue, progress.after_release, progress.after_key],
    )
  ).rows;
  const page = rows.slice(0, 64);
  for (const row of page) {
    // Original native member identities use UTF-8 bytes; the directory stores JSON strings.
    const id = (row.id as unknown as Buffer).toString('utf8');
    await stageEntry(tx, catalogue, { ...row, id, id_key: key(id) });
  }
  const last = page.at(-1);
  await tx.query(
    `UPDATE semantic.definition_type_build SET after_release=$2,after_key=$3,complete=$4
     WHERE route=0 AND catalogue=$1`,
    [catalogue, last?.release_digest ?? progress.after_release, last?.id_key ?? progress.after_key, rows.length <= 64],
  );
  return rows.length <= 64;
}

/** Release1 has one bounded active release; activation and its derived index commit together. */
export async function stageReleaseTypeDirectory(tx: CommandTransaction, digest: string, release: Release) {
  if (await typeDirectoryReady(tx, digest)) return;
  // Historical oversized releases remain activatable/readable with their original meaning.
  if (publicationLimits(release).length) return;
  for (const [id, body] of Object.entries(release.types))
    await stageEntry(tx, digest, { id, id_key: key(id), release_digest: digest, body });
  for (const [id, body] of Object.entries(release.properties))
    await tx.query(
      `INSERT INTO semantic.definition_type_property(route,release_digest,id_key,id,body)
       VALUES(0,$1,$2,$3::json,$4::json) ON CONFLICT DO NOTHING`,
      [digest, key(id), JSON.stringify(id), JSON.stringify(body)],
    );
  await tx.query(
    `INSERT INTO semantic.definition_type_build(route,catalogue,complete) VALUES(0,$1,true)
     ON CONFLICT(route,catalogue) DO UPDATE SET complete=true`,
    [digest],
  );
}

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
