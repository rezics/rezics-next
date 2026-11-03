import type { Database } from 'bun:sqlite';
import { BATCH_LIMIT, checkBatchWrite, type BatchCommand } from '@rezics/definitions/bulk';
import { commandKey, sourceDigest } from '../../../packages/conversion/src/support.ts';
import { relationStatement } from '@rezics/conversion/cross-media-entities';
import type { Claim } from './record-bindings.ts';

export type Provider = 'bangumi' | 'vndb';
export type GraphMembership = 'family' | 'referenced';
export type GraphEdgeDraft = {
  source: Provider;
  alias: string;
  table: string;
  holder: string;
  target: string;
  property: string;
  url: string;
  targetKind?: 'subject' | 'literal';
  qualifiers?: { property: string; content: unknown }[];
  membership: GraphMembership;
  record: Record<string, unknown>;
  fields: string[];
};
export type UnresolvedEdge = GraphEdgeDraft & { reason: string };
export type ProposedEdge = { key: string; holder: string; target: string; property: string; subject: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function graphEdgeKey(draft: GraphEdgeDraft): string {
  return commandKey([
    draft.alias,
    draft.table,
    draft.holder,
    draft.target,
    draft.property,
    sourceDigest(draft.record),
  ]);
}

export class CrossMediaGraph {
  constructor(private readonly database: Database) {
    database.exec(`CREATE TABLE IF NOT EXISTS cross_media_graph (
      edge_key TEXT PRIMARY KEY,
      alias TEXT NOT NULL,
      table_name TEXT NOT NULL,
      holder TEXT NOT NULL,
      target TEXT NOT NULL,
      property TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      command_key TEXT
    ) WITHOUT ROWID`);
  }

  remember(drafts: readonly GraphEdgeDraft[]): void {
    const insert = this.database.prepare(
      `INSERT INTO cross_media_graph(edge_key,alias,table_name,holder,target,property,payload,status)
       VALUES(?,?,?,?,?,?,?,'planned')
       ON CONFLICT(edge_key) DO NOTHING`,
    );
    const write = this.database.transaction((rows: readonly GraphEdgeDraft[]) => {
      for (const draft of rows) {
        insert.run(
          graphEdgeKey(draft),
          draft.alias,
          draft.table,
          draft.holder,
          draft.target,
          draft.property,
          JSON.stringify(draft),
        );
      }
    });
    write(drafts);
  }

  planned(): GraphEdgeDraft[] {
    const rows = this.database
      .prepare(`SELECT payload FROM cross_media_graph WHERE status IN ('planned','unresolved')`)
      .all() as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as GraphEdgeDraft);
  }

  async deliver(input: {
    claim(owner: { source: string; external_id: string }): Claim | null;
    batch(request: { commands: BatchCommand[] }): Promise<{ results: { key: string; status: number }[] }>;
  }): Promise<{ proposed: ProposedEdge[]; unresolved: UnresolvedEdge[]; unchanged: number }> {
    const drafts = this.planned();
    const proposed: ProposedEdge[] = [];
    const unresolved: UnresolvedEdge[] = [];
    let unchanged = 0;
    const mark = this.database.prepare(`UPDATE cross_media_graph SET status=?, command_key=? WHERE edge_key=?`);
    const commands: { draft: GraphEdgeDraft; command: BatchCommand; subject: string; target: string }[] = [];
    for (const draft of drafts) {
      const holder = input.claim({ source: draft.alias, external_id: draft.holder });
      const target =
        draft.targetKind === 'literal'
          ? { state: 'bound' as const, subject: draft.target }
          : input.claim({ source: draft.alias, external_id: draft.target });
      if (holder?.state !== 'bound' || target?.state !== 'bound') {
        const reason =
          holder?.state !== 'bound'
            ? `Missing target record ${draft.holder}`
            : `Missing target record ${draft.target}`;
        unresolved.push({ ...draft, reason });
        mark.run('unresolved', null, graphEdgeKey(draft));
        continue;
      }
      const qualifiers = (draft.qualifiers ?? []).map((qualifier) => {
        if (typeof qualifier.content !== 'string') return qualifier;
        const bound = input.claim({ source: draft.alias, external_id: qualifier.content });
        return bound?.state === 'bound' ? { ...qualifier, content: bound.subject } : qualifier;
      });
      const statement = relationStatement({
        property: draft.property,
        target: target.subject,
        url: draft.url,
        qualifiers,
      });
      const command: BatchCommand = {
        op: 'propose',
        key: commandKey([draft.alias, draft.holder, graphEdgeKey(draft), 'relation']),
        source: {
          source: draft.alias,
          external_id: draft.holder,
          record_revision: 'unversioned',
          converter_revision: 'cross-media-entities@1',
          digest: sourceDigest(draft.record),
          field_group: 'facts',
        },
        subject: holder.subject,
        statement,
      };
      commands.push({ draft, command, subject: holder.subject, target: target.subject });
    }
    for (let offset = 0; offset < commands.length; offset += BATCH_LIMIT) {
      const page = commands.slice(offset, offset + BATCH_LIMIT);
      if (checkBatchWrite({ commands: page.map((entry) => entry.command) }).length)
        throw new TypeError('Cross-media relation proposals failed portable validation');
      const result = await input.batch({ commands: page.map((entry) => entry.command) });
      for (const [index, entry] of page.entries()) {
        const status = result.results[index]?.status;
        if (status === 200) {
          unchanged++;
          mark.run('proposed', entry.command.key, graphEdgeKey(entry.draft));
          continue;
        }
        if (status !== 201) throw new TypeError(`Cross-media relation write failed: ${status}`);
        mark.run('proposed', entry.command.key, graphEdgeKey(entry.draft));
        proposed.push({
          key: graphEdgeKey(entry.draft),
          holder: entry.draft.holder,
          target: entry.draft.target,
          property: entry.draft.property,
          subject: entry.subject,
        });
      }
    }
    return { proposed, unresolved, unchanged };
  }
}

export function citedProviderBinding(url: string): { provider: Provider; key: string } | undefined {
  const bangumi = /^https:\/\/(?:bgm|bangumi)\.tv\/(subject|character|person)\/([1-9][0-9]*)(?:\/|$)/.exec(url);
  if (bangumi) {
    const kind = bangumi[1] === 'subject' ? '' : `${bangumi[1]}:`;
    return { provider: 'bangumi', key: `${kind}${bangumi[2]}` };
  }
  const vndb = /^https:\/\/vndb\.org\/([vcsrp][1-9][0-9]*)(?:[./]|$)/.exec(url);
  if (vndb) return { provider: 'vndb', key: vndb[1]! };
  return undefined;
}

export function boundSubject(claim: Claim | null): string | undefined {
  return claim?.state === 'bound' && UUID.test(claim.subject) ? claim.subject : undefined;
}
