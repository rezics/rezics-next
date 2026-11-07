import { createHash } from 'node:crypto';
import { pickText } from '@rezics/composition';
import { publicationLimits, type Release, type TypeDefinition } from '@rezics/definitions';
import type { PoolClient } from 'pg';
import type { CommandTransaction } from '../command/command.ts';

// These are the reader locales, not a restriction on released label languages.
export const TYPE_DIRECTORY_LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const;
export const CHUNK = 128;
export const ROOT = '';
const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Database = PoolClient | CommandTransaction;
type Entry = { id: string; id_key: string; release_digest: string; body: TypeDefinition };
export type Edge = { chunk: Buffer; node_key: string; entry_key: string | null };

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
