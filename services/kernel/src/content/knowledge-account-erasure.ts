import { authoritativeTimeValue, commandTime, type CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import nextNotebook from './knowledge-account-erasure-notebook.sql';
import markDocument from './knowledge-account-erasure-mark.sql';
import prepareDocument from './knowledge-account-erasure-document.sql';

const phases = [
  'mark',
  'documents',
  'selections',
  'publications',
  'revisions',
  'frontier',
  'restores',
  'roots',
  'cut-pages',
  'pages',
  'changes',
  'headers',
  'cut-placements',
  'placements',
  'detach',
  'finish',
] as const;
type Phase = (typeof phases)[number];
export type KnowledgeAccountErasureCursor = Readonly<{
  phase: Phase;
  afterNotebook: string | null;
  notebookId: string | null;
  afterDocument: string | null;
  documentId: string | null;
  after: readonly (string | null)[] | null;
}>;
const initial = (): KnowledgeAccountErasureCursor => ({
  phase: 'mark',
  afterNotebook: null,
  notebookId: null,
  afterDocument: null,
  documentId: null,
  after: null,
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const nullableId = (value: unknown) => value === null || (typeof value === 'string' && uuid.test(value));

export function isKnowledgeAccountErasureCursor(value: unknown): value is KnowledgeAccountErasureCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const basic =
    Object.keys(row).sort().join(',') === 'after,afterDocument,afterNotebook,documentId,notebookId,phase' &&
    phases.includes(row.phase as Phase) &&
    ['afterNotebook', 'notebookId', 'afterDocument', 'documentId'].every((key) => nullableId(row[key])) &&
    (row.after === null ||
      (Array.isArray(row.after) &&
        row.after.length <= 3 &&
        row.after.every((key) => key === null || (typeof key === 'string' && /^[0-9a-f-]{1,64}$/i.test(key)))));
  if (!basic) return false;
  const phase = row.phase as Phase;
  if (row.notebookId === null)
    return (
      (phase === 'mark' || phase === 'documents') &&
      row.documentId === null &&
      row.afterDocument === null &&
      row.after === null
    );
  if (['selections', 'publications', 'revisions'].includes(phase) && row.documentId === null) return false;
  if (row.after !== null) {
    const shape = shapes[phase];
    const after = row.after as string[];
    if (!shape || after.length !== shape.keys.length) return false;
    return shape.keys.every(([, type], index) =>
      type === 'uuid'
        ? typeof after[index] === 'string' && uuid.test(after[index])
        : typeof after[index] === 'string' &&
          /^(0|[1-9][0-9]{0,18})$/.test(after[index]) &&
          BigInt(after[index]) <= 9223372036854775807n,
    );
  }
  return true;
}

type Notebook = { notebook_id: string; structure_revision_id: string };
type Document = {
  document_id: string;
  lifecycle_generation: string;
  retained_public_generation: string | null;
  legal_hold: boolean;
};
type Key = readonly [name: string, type: 'uuid' | 'bigint'];
type Shape = Readonly<{ table: string; scope: 'document_id' | 'notebook_id'; keys: readonly Key[] }>;
const shapes: Partial<Record<Phase, Shape>> = {
  selections: {
    table: 'knowledge_publication_selection',
    scope: 'document_id',
    keys: [
      ['lifecycle_generation', 'bigint'],
      ['revision_id', 'uuid'],
    ],
  },
  publications: { table: 'knowledge_publication', scope: 'document_id', keys: [['publication_id', 'uuid']] },
  revisions: { table: 'knowledge_revision', scope: 'document_id', keys: [['revision_id', 'uuid']] },
  frontier: {
    table: 'knowledge_lifecycle_frontier',
    scope: 'notebook_id',
    keys: [
      ['root_document_id', 'uuid'],
      ['parent_placement_id', 'uuid'],
    ],
  },
  restores: { table: 'knowledge_lifecycle_restore', scope: 'notebook_id', keys: [['root_document_id', 'uuid']] },
  roots: {
    table: 'knowledge_structure_parent_root',
    scope: 'notebook_id',
    keys: [
      ['parent_id', 'uuid'],
      ['revision_number', 'bigint'],
    ],
  },
  'cut-pages': { table: 'knowledge_structure_page', scope: 'notebook_id', keys: [['page_id', 'uuid']] },
  pages: { table: 'knowledge_structure_page', scope: 'notebook_id', keys: [['page_id', 'uuid']] },
  changes: {
    table: 'knowledge_structure_change',
    scope: 'notebook_id',
    keys: [
      ['revision_number', 'bigint'],
      ['placement_id', 'uuid'],
    ],
  },
  headers: { table: 'knowledge_structure_revision', scope: 'notebook_id', keys: [['revision_id', 'uuid']] },
  'cut-placements': { table: 'knowledge_placement', scope: 'notebook_id', keys: [['placement_id', 'uuid']] },
  placements: { table: 'knowledge_placement', scope: 'notebook_id', keys: [['placement_id', 'uuid']] },
};

async function runQuery(
  tx: CommandTransaction,
  query: Readonly<{ sql: string; params: readonly string[] }>,
  parameters: Record<string, unknown>,
) {
  return tx.query(
    query.sql,
    query.params.map((name) => parameters[name]),
  );
}

async function rawKeys(
  tx: CommandTransaction,
  shape: Shape,
  route: number,
  scopeId: string,
  after: readonly (string | null)[] | null,
  limit: number,
): Promise<readonly (readonly (string | null)[])[]> {
  const values: unknown[] = [route, scopeId];
  let continuation = '';
  if (after) {
    if (after.length !== shape.keys.length || after.some((key) => key === null))
      throw new TypeError('Invalid Knowledge erasure key');
    continuation = ` AND (${shape.keys.map(([name]) => name).join(',')})>(${shape.keys
      .map(([, type], index) => {
        values.push(after[index]);
        return `$${values.length}::${type}`;
      })
      .join(',')})`;
  }
  values.push(limit);
  // All identifiers come from the fixed phase map, never from cursor operands.
  const result = await tx.query<Record<string, string | null>>(
    `SELECT ${shape.keys.map(([name], index) => `${name}::text AS key${index}`).join(',')}
     FROM content.${shape.table} WHERE route=$1 AND ${shape.scope}=$2${continuation}
     ORDER BY ${shape.keys.map(([name]) => name).join(',')} LIMIT $${values.length}`,
    values,
  );
  return result.rows.map((row) => shape.keys.map((_key, index) => row[`key${index}`]!));
}

function exactKey(shape: Shape, route: number, scopeId: string, key: readonly (string | null)[]) {
  const values: unknown[] = [route, scopeId];
  const predicates = shape.keys.map(([name, type], index) => {
    if (key[index] === null) return `${name} IS NULL`;
    values.push(key[index]);
    return `${name}=$${values.length}::${type}`;
  });
  return { values, where: `route=$1 AND ${shape.scope}=$2 AND ${predicates.join(' AND ')}` };
}

async function documentRow(tx: CommandTransaction, route: number, notebookId: string, documentId: string) {
  return (
    (
      await tx.query<Document>(
        `SELECT document_id,lifecycle_generation::text,retained_public_generation::text,legal_hold
     FROM content.knowledge_document WHERE route=$1 AND notebook_id=$2 AND document_id=$3 FOR UPDATE`,
        [route, notebookId, documentId],
      )
    ).rows[0] ?? null
  );
}

/** The caller owns the immutable account obligation, native transaction, receipt and durable next cursor. */
export async function advanceKnowledgeAccountErasure(
  tx: CommandTransaction,
  accountId: string,
  input: unknown,
  limit = 100,
): Promise<Readonly<{ next: KnowledgeAccountErasureCursor | null; found: number; pending?: boolean }>> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Knowledge erasure page exceeds its bound');
  if (input !== null && input !== undefined && !isKnowledgeAccountErasureCursor(input))
    throw new TypeError('Invalid Knowledge erasure cursor');
  let cursor = input == null ? initial() : structuredClone(input as KnowledgeAccountErasureCursor);
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid Knowledge erasure owner');
  const time = commandTime(tx);
  if (!time) throw new Error('Knowledge erasure requires its native command transaction');
  const recordedAt = authoritativeTimeValue(time);
  let used = 0;
  let found = 0;
  while (used < limit) {
    if (cursor.notebookId === null) {
      const selected = (
        await runQuery(tx, nextNotebook, { route, account_id: accountId, after_id: cursor.afterNotebook })
      ).rows[0] as Notebook | undefined;
      used++;
      if (!selected) {
        if (cursor.phase === 'mark') {
          cursor = { ...initial(), phase: 'documents' };
          continue;
        }
        return { next: null, found };
      }
      found++;
      cursor = { ...cursor, notebookId: selected.notebook_id, afterDocument: null, documentId: null, after: null };
      continue;
    }
    const notebook = (
      await tx.query<Notebook>(
        `SELECT notebook_id,structure_revision_id FROM content.knowledge_notebook
       WHERE route=$1 AND notebook_id=$2 AND owner_account_id=$3 FOR UPDATE`,
        [route, cursor.notebookId, accountId],
      )
    ).rows[0];
    if (!notebook) {
      cursor = {
        ...cursor,
        afterNotebook: cursor.notebookId,
        notebookId: null,
        afterDocument: null,
        documentId: null,
        after: null,
      };
      used++;
      continue;
    }
    if (cursor.phase === 'mark') {
      const remaining = limit - used;
      const rows = (
        await tx.query<{ document_id: string }>(
          `SELECT document_id FROM content.knowledge_document WHERE route=$1 AND notebook_id=$2
         ${cursor.afterDocument === null ? '' : 'AND document_id>$3::uuid'} ORDER BY route,notebook_id,document_id
         LIMIT $${cursor.afterDocument === null ? 3 : 4} FOR UPDATE`,
          cursor.afterDocument === null
            ? [route, cursor.notebookId, remaining]
            : [route, cursor.notebookId, cursor.afterDocument, remaining],
        )
      ).rows;
      for (const row of rows)
        await runQuery(tx, markDocument, { route, notebook_id: cursor.notebookId, document_id: row.document_id });
      used += Math.max(rows.length, 1);
      found += rows.length;
      cursor =
        rows.length < remaining
          ? { ...cursor, afterNotebook: cursor.notebookId, notebookId: null, afterDocument: null }
          : { ...cursor, afterDocument: rows.at(-1)!.document_id };
      continue;
    }
    const held = await tx.query(
      'SELECT document_id FROM content.knowledge_document WHERE route=$1 AND notebook_id=$2 AND legal_hold ORDER BY document_id LIMIT 1',
      [route, cursor.notebookId],
    );
    if (held.rowCount) return { next: cursor, found, pending: true };
    await tx.query(
      'UPDATE content.knowledge_notebook SET account_erased=true WHERE route=$1 AND notebook_id=$2 AND NOT account_erased',
      [route, cursor.notebookId],
    );
    if (cursor.phase === 'documents') {
      const rows = (
        await tx.query<{ document_id: string }>(
          `SELECT document_id FROM content.knowledge_document WHERE route=$1 AND notebook_id=$2
         ${cursor.afterDocument === null ? '' : 'AND document_id>$3::uuid'} ORDER BY route,notebook_id,document_id LIMIT 1 FOR UPDATE`,
          cursor.afterDocument === null ? [route, cursor.notebookId] : [route, cursor.notebookId, cursor.afterDocument],
        )
      ).rows;
      used++;
      found += rows.length;
      if (!rows[0]) {
        cursor = { ...cursor, phase: 'frontier', documentId: null, after: null };
        continue;
      }
      await runQuery(tx, prepareDocument, {
        route,
        notebook_id: cursor.notebookId,
        document_id: rows[0].document_id,
        recorded_at: recordedAt,
      });
      cursor = { ...cursor, phase: 'selections', documentId: rows[0].document_id, after: null };
      continue;
    }
    if (cursor.phase === 'detach') {
      const remaining = limit - used;
      const rows = (
        await tx.query<{ document_id: string }>(
          'SELECT document_id FROM content.knowledge_document WHERE route=$1 AND notebook_id=$2 ORDER BY route,notebook_id,document_id LIMIT $3 FOR UPDATE',
          [route, cursor.notebookId, remaining],
        )
      ).rows;
      for (const row of rows)
        await tx.query(
          `UPDATE content.knowledge_document SET notebook_id=NULL,head_revision_id=NULL,created_transaction_id=NULL,created_at=NULL,
           current_publication_id=CASE WHEN retained_public_generation=lifecycle_generation THEN current_publication_id ELSE NULL END,
           purge_started_at=CASE WHEN retained_public_generation=lifecycle_generation THEN NULL ELSE COALESCE(purge_started_at,$3::timestamptz) END,
           purge_completed=NOT COALESCE(retained_public_generation=lifecycle_generation,false),
           retained_public_generation=CASE WHEN retained_public_generation=lifecycle_generation THEN retained_public_generation ELSE NULL END
         WHERE route=$1 AND document_id=$2 AND account_erased AND NOT legal_hold`,
          [route, row.document_id, recordedAt],
        );
      used += Math.max(rows.length, 1);
      found += rows.length;
      if (rows.length < remaining) cursor = { ...cursor, phase: 'finish' };
      continue;
    }
    if (cursor.phase === 'finish') {
      // The two header FKs are already deferred; this constant pair contains no manuscript or graph cascade.
      await tx.query(
        'DELETE FROM content.knowledge_structure_revision WHERE route=$1 AND notebook_id=$2 AND revision_id=$3',
        [route, cursor.notebookId, notebook.structure_revision_id],
      );
      await tx.query(
        'DELETE FROM content.knowledge_notebook WHERE route=$1 AND notebook_id=$2 AND owner_account_id=$3',
        [route, cursor.notebookId, accountId],
      );
      found++;
      used++;
      cursor = {
        ...cursor,
        phase: 'documents',
        afterNotebook: cursor.notebookId,
        notebookId: null,
        afterDocument: null,
        documentId: null,
        after: null,
      };
      continue;
    }
    const shape = shapes[cursor.phase];
    if (!shape) throw new TypeError('Invalid Knowledge erasure phase');
    const scopeId = shape.scope === 'document_id' ? cursor.documentId : cursor.notebookId;
    if (!scopeId) throw new TypeError('Knowledge erasure phase lost its identity');
    const document = shape.scope === 'document_id' ? await documentRow(tx, route, cursor.notebookId, scopeId) : null;
    if (shape.scope === 'document_id' && !document) throw new Error('Knowledge erasure document changed notebooks');
    if (document?.legal_hold) return { next: cursor, found, pending: true };
    const remaining = limit - used;
    const keys = await rawKeys(tx, shape, route, scopeId, cursor.after, remaining);
    for (const key of keys) {
      const exact = exactKey(shape, route, scopeId, key);
      if (
        cursor.phase === 'selections' &&
        document?.retained_public_generation === document?.lifecycle_generation &&
        key[0] === document?.retained_public_generation
      )
        continue;
      if (cursor.phase === 'publications') {
        const selected = await tx.query(
          `SELECT 1 FROM content.knowledge_publication_selection s JOIN content.knowledge_document d USING(route,document_id)
           WHERE s.route=$1 AND s.document_id=$2 AND s.publication_id=$3
             AND s.lifecycle_generation=d.retained_public_generation AND s.lifecycle_generation=d.lifecycle_generation LIMIT 1`,
          [route, scopeId, key[0]],
        );
        if (selected.rowCount) continue;
      }
      if (cursor.phase === 'revisions') {
        const selected = await tx.query(
          `SELECT 1 FROM content.knowledge_publication_selection s JOIN content.knowledge_document d USING(route,document_id)
           WHERE s.route=$1 AND s.document_id=$2 AND s.revision_id=$3
             AND s.lifecycle_generation=d.retained_public_generation AND s.lifecycle_generation=d.lifecycle_generation LIMIT 1`,
          [route, scopeId, key[0]],
        );
        if (selected.rowCount) {
          await tx.query(
            `UPDATE content.knowledge_revision SET author_account_id=NULL,
            copy_provenance=CASE WHEN copy_provenance->>'representation'='public' THEN copy_provenance ELSE NULL END
            WHERE ${exact.where}`,
            exact.values,
          );
          continue;
        }
      }
      if (cursor.phase === 'headers' && key[0] === notebook.structure_revision_id) continue;
      if (cursor.phase === 'cut-pages')
        await tx.query(
          `UPDATE content.knowledge_structure_page SET left_page_id=NULL,right_page_id=NULL WHERE ${exact.where}`,
          exact.values,
        );
      else if (cursor.phase === 'cut-placements')
        await tx.query(`UPDATE content.knowledge_placement SET parent_id=NULL WHERE ${exact.where}`, exact.values);
      else await tx.query(`DELETE FROM content.${shape.table} WHERE ${exact.where}`, exact.values);
    }
    used += Math.max(keys.length, 1);
    found += keys.length;
    const replacing = ['selections', 'publications', 'revisions', 'headers', 'cut-pages', 'cut-placements'].includes(
      cursor.phase,
    );
    if (keys.length === remaining) {
      if (replacing) cursor = { ...cursor, after: keys.at(-1)! };
      continue;
    }
    if (cursor.phase === 'revisions')
      cursor = { ...cursor, phase: 'documents', afterDocument: cursor.documentId, documentId: null, after: null };
    else cursor = { ...cursor, phase: phases[phases.indexOf(cursor.phase) + 1]!, after: null };
  }
  return { next: cursor, found };
}
