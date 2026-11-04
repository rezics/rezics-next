import type { Database } from 'bun:sqlite';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { BATCH_LIMIT, checkBatchWrite, type BatchCommand, type BatchWriteResult } from '@rezics/definitions/bulk';
import { mapBangumiVocabulary, bangumiVocabularyRevision } from '@rezics/conversion/bangumi-vocabulary';
import { mapVndbVocabulary, vndbVocabularyRevision } from '@rezics/conversion/vndb-vocabulary';
import type { SourceVocabularyGap } from '@rezics/conversion';
import { commandKey, sourceDigest } from '../../../packages/conversion/src/support.ts';
import { relationStatement, vndbProducerParentEnds } from '@rezics/conversion/cross-media-entities';
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
  recordRevision?: string;
  converterRevision?: string;
  fenceFacts?: boolean;
  relation?: {
    family: 1 | 2 | 4 | 6;
    code: number;
    reciprocalCode?: number;
    path: string;
    sourceSubject: string;
    sourceEndpoint: string;
    mappingRevision: string;
    order?: number;
    evidence: { path: string; code: number; sourceSubject: string; sourceEndpoint: string; digest: string }[];
  };
  producerParent?: {
    code: string;
    path: string;
    sourceSubject: string;
    sourceEndpoint: string;
    mappingRevision: string;
    evidence: { path: string; code: string; sourceSubject: string; sourceEndpoint: string; digest: string }[];
  };
};
export type UnresolvedEdge = GraphEdgeDraft & { reason: string };
export type ProposedEdge = { key: string; holder: string; target: string; property: string; subject: string };
export type GraphMappingGap = SourceVocabularyGap & {
  sourceSubject: string;
  sourceEndpoint: string;
  record: Record<string, unknown>;
  table?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function graphEdgeKey(draft: GraphEdgeDraft): string {
  return commandKey([
    draft.alias,
    draft.table,
    draft.holder,
    draft.target,
    draft.property,
    sourceDigest(draft.record),
    ...(draft.relation ? [draft.relation.mappingRevision, sourceDigest(draft.relation.evidence)] : []),
    ...(draft.producerParent
      ? [draft.producerParent.mappingRevision, sourceDigest(draft.producerParent.evidence)]
      : []),
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
      command_key TEXT,
      command_payload TEXT,
      native_candidate TEXT,
      retraction_key TEXT,
      retraction_payload TEXT
    ) WITHOUT ROWID`);
    const columns = new Set(
      (database.query('PRAGMA table_info(cross_media_graph)').all() as { name: string }[]).map((row) => row.name),
    );
    if (!columns.has('command_payload')) database.exec('ALTER TABLE cross_media_graph ADD COLUMN command_payload TEXT');
    if (!columns.has('native_candidate'))
      database.exec('ALTER TABLE cross_media_graph ADD COLUMN native_candidate TEXT');
    if (!columns.has('retraction_key')) database.exec('ALTER TABLE cross_media_graph ADD COLUMN retraction_key TEXT');
    if (!columns.has('retraction_payload'))
      database.exec('ALTER TABLE cross_media_graph ADD COLUMN retraction_payload TEXT');
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

  private command(edgeKey: string): { key: string; bytes: string | null } | null {
    return this.database
      .prepare('SELECT command_key AS key, command_payload AS bytes FROM cross_media_graph WHERE edge_key=?')
      .get(edgeKey) as { key: string; bytes: string } | null;
  }

  private retainCommand(edgeKey: string, command: BatchCommand): { key: string; bytes: string } {
    const key = command.key;
    const bytes = JSON.stringify({ commands: [command] });
    const prior = this.command(edgeKey);
    if (prior?.bytes) {
      if (prior.key !== key || prior.bytes !== bytes)
        throw new TypeError('Cross-media relation command changed after journaling');
      return { key: prior.key, bytes: prior.bytes };
    }
    this.database
      .prepare('UPDATE cross_media_graph SET command_key=?, command_payload=? WHERE edge_key=?')
      .run(key, bytes, edgeKey);
    return { key, bytes };
  }

  async deliver(input: {
    claim(owner: { source: string; external_id: string }): Claim | null;
    nativeType(externalId: string, alias?: string): string | undefined;
    fence(input: {
      source: string;
      externalId: string;
      fieldGroup: 'facts';
    }): Promise<{ fenced: boolean; securityRevision: string | null }>;
    batch(request: { commands: BatchCommand[] }): Promise<BatchWriteResult>;
    journal?: {
      prepare(command: BatchCommand): { bytes: string };
      acknowledge(command: BatchCommand, result: BatchWriteResult['results'][number]): void;
    };
    relationSnapshot?: {
      currentKeys: readonly string[];
      scope: readonly string[];
      digest: string;
      complete: boolean;
    };
  }): Promise<{ proposed: ProposedEdge[]; unresolved: UnresolvedEdge[]; gaps: GraphMappingGap[]; unchanged: number }> {
    const drafts = this.planned();
    const proposed: ProposedEdge[] = [];
    const unresolved: UnresolvedEdge[] = [];
    const gaps: GraphMappingGap[] = [];
    let unchanged = 0;
    const mark = this.database.prepare(`UPDATE cross_media_graph SET status=?, command_key=? WHERE edge_key=?`);
    const commands: {
      draft: GraphEdgeDraft;
      command: BatchCommand;
      subject: string;
      target: string;
      sourceHolder: string;
      sourceTarget: string;
      bytes: string;
    }[] = [];
    for (const draft of drafts) {
      const holder = input.claim({ source: draft.alias, external_id: draft.holder });
      const target =
        draft.targetKind === 'literal'
          ? { state: 'bound' as const, subject: draft.target }
          : input.claim({ source: draft.alias, external_id: draft.target });
      if (holder?.state !== 'bound' || target?.state !== 'bound') {
        const reason =
          holder?.state !== 'bound' ? `missing_holder:${draft.holder}` : `missing_endpoint:${draft.target}`;
        unresolved.push({ ...draft, reason });
        mark.run('unresolved', null, graphEdgeKey(draft));
        continue;
      }
      if (
        draft.fenceFacts &&
        (await input.fence({ source: draft.alias, externalId: draft.holder, fieldGroup: 'facts' })).fenced
      ) {
        unresolved.push({ ...draft, reason: 'fenced_source_facts' });
        mark.run('unresolved', null, graphEdgeKey(draft));
        continue;
      }
      if (draft.relation) {
        let fenced = false;
        for (const externalId of new Set([draft.relation.sourceSubject, draft.relation.sourceEndpoint])) {
          const fence = await input.fence({ source: draft.alias, externalId, fieldGroup: 'facts' });
          if (fence.fenced) fenced = true;
        }
        if (fenced) {
          unresolved.push({ ...draft, reason: 'fenced_relation_holder' });
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
        const sourceClaim = input.claim({ source: draft.alias, external_id: draft.relation.sourceSubject });
        const endpointClaim = input.claim({ source: draft.alias, external_id: draft.relation.sourceEndpoint });
        const sourceType = input.nativeType(draft.relation.sourceSubject);
        const endpointType = input.nativeType(draft.relation.sourceEndpoint);
        if (sourceClaim?.state !== 'bound' || endpointClaim?.state !== 'bound' || !sourceType || !endpointType) {
          unresolved.push({ ...draft, reason: 'missing_native_endpoint_profile' });
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
        const rowDigest = sourceDigest(draft.relation.evidence);
        const mapRelation = (ownerExternalId: string) =>
          mapBangumiVocabulary({
            metadata: {
              provider: 'bangumi',
              sourceAlias: draft.alias,
              externalId: ownerExternalId,
              recordRevision: null,
              digest: rowDigest,
              converterRevision: `${bangumiVocabularyRevision}:relation-${draft.relation!.family}@2:${draft.relation!.code}:${draft.relation!.reciprocalCode ?? 'one-sided'}`,
              recordUrl: `https://bgm.tv/subject/${draft.relation!.sourceSubject}`,
              license: 'CC-BY-SA-3.0',
              attribution: 'Bangumi contributors',
            },
            bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
            rows: [
              {
                kind: 'relation',
                path: draft.relation!.path,
                origin: {
                  externalId: ownerExternalId,
                  revision: null,
                  digest: rowDigest,
                  url: `https://bgm.tv/subject/${draft.relation!.sourceSubject}`,
                },
                subject: { id: sourceClaim.subject, type: sourceType, releaseDigest: bundledDigest },
                endpoint: { id: endpointClaim.subject, type: endpointType, releaseDigest: bundledDigest },
                endpointCode: draft.relation!.sourceEndpoint,
                family: draft.relation!.family,
                code: draft.relation!.code,
                ...(draft.relation!.reciprocalCode === undefined
                  ? {}
                  : { reciprocalCode: draft.relation!.reciprocalCode }),
                ...(draft.relation!.order === undefined ? {} : { order: draft.relation!.order }),
              },
            ],
          });
        let mapped = mapRelation(draft.holder);
        const firstProposal = mapped.proposals[0];
        if (firstProposal?.op === 'propose') {
          const ownerExternalId =
            firstProposal.subject === sourceClaim.subject
              ? draft.relation.sourceSubject
              : firstProposal.subject === endpointClaim.subject
                ? draft.relation.sourceEndpoint
                : undefined;
          if (ownerExternalId === undefined)
            throw new TypeError('Cross-media relation mapper returned an unbound holder');
          if (firstProposal.source.external_id !== ownerExternalId) mapped = mapRelation(ownerExternalId);
        }
        for (const gap of mapped.gaps)
          gaps.push({
            ...gap,
            sourceSubject: draft.relation.sourceSubject,
            sourceEndpoint: draft.relation.sourceEndpoint,
            record: draft.record,
            table: draft.table,
          });
        if (mapped.proposals.length !== 1) {
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
        const mappedCommand = mapped.proposals[0]!;
        if (mappedCommand.op !== 'propose')
          throw new TypeError('Bangumi relation mapper returned a non-proposal command');
        const command: BatchCommand = mappedCommand;
        const sourceIsHolder = command.source.external_id === draft.relation.sourceSubject;
        const sourceIsEndpoint = command.source.external_id === draft.relation.sourceEndpoint;
        const actualHolder = sourceIsHolder ? sourceClaim : sourceIsEndpoint ? endpointClaim : null;
        const actualTarget = sourceIsHolder ? endpointClaim : sourceIsEndpoint ? sourceClaim : null;
        if (
          actualHolder?.state !== 'bound' ||
          actualTarget?.state !== 'bound' ||
          command.subject !== actualHolder.subject
        )
          throw new TypeError('Cross-media relation mapper did not preserve the canonical holder binding');
        const value = command.statement.value;
        if (value.type !== 'value' || value.content !== actualTarget.subject)
          throw new TypeError('Cross-media relation mapper did not preserve the canonical endpoint binding');
        if (checkBatchWrite({ commands: [command] }, bundledRelease).length)
          throw new TypeError('Cross-media relation proposal failed portable validation');
        const retained = this.database
          .transaction(() => {
            const prepared = input.journal?.prepare(command);
            const exact = prepared ? (JSON.parse(prepared.bytes) as { commands: [BatchCommand] }).commands[0] : command;
            if (!exact || exact.op !== 'propose') throw new TypeError('Cross-media relation journal is invalid');
            return this.retainCommand(graphEdgeKey(draft), exact);
          })
          .immediate();
        commands.push({
          draft,
          command: JSON.parse(retained.bytes).commands[0] as BatchCommand,
          subject: actualHolder.subject,
          target: actualTarget.subject,
          sourceHolder: command.source.external_id,
          sourceTarget: sourceIsHolder ? draft.relation.sourceEndpoint : draft.relation.sourceSubject,
          bytes: retained.bytes,
        });
        continue;
      }
      if (draft.producerParent) {
        let fenced = false;
        for (const externalId of new Set([draft.producerParent.sourceSubject, draft.producerParent.sourceEndpoint])) {
          const fence = await input.fence({ source: draft.alias, externalId, fieldGroup: 'facts' });
          if (fence.fenced) fenced = true;
        }
        if (fenced) {
          unresolved.push({ ...draft, reason: 'fenced_relation_holder' });
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
        const sourceClaim = input.claim({ source: draft.alias, external_id: draft.producerParent.sourceSubject });
        const endpointClaim = input.claim({ source: draft.alias, external_id: draft.producerParent.sourceEndpoint });
        const sourceType = input.nativeType(draft.producerParent.sourceSubject, draft.alias);
        const endpointType = input.nativeType(draft.producerParent.sourceEndpoint, draft.alias);
        if (sourceClaim?.state !== 'bound' || endpointClaim?.state !== 'bound' || !sourceType || !endpointType) {
          unresolved.push({ ...draft, reason: 'missing_native_endpoint_profile' });
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
        const parent = draft.producerParent;
        const rowDigest = sourceDigest(parent.evidence);
        const parentUrl = `https://vndb.org/${parent.sourceSubject}`;
        const mapParent = (ownerExternalId: string) =>
          mapVndbVocabulary({
            metadata: {
              provider: 'vndb',
              sourceAlias: draft.alias,
              externalId: ownerExternalId,
              recordRevision: 'unversioned',
              digest: rowDigest,
              converterRevision: `${vndbVocabularyRevision}:${parent.mappingRevision}`,
              recordUrl: parentUrl,
              license: 'ODbL-1.0',
              attribution: 'VNDB (database: ODbL-1.0; permitted metadata contents: DbCL-1.0)',
            },
            bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
            rows: [
              {
                kind: 'producer-parent',
                path: parent.path,
                origin: {
                  externalId: ownerExternalId,
                  revision: 'unversioned',
                  digest: rowDigest,
                  url: parentUrl,
                },
                subject: { id: sourceClaim.subject, type: sourceType, releaseDigest: bundledDigest },
                endpoint: { id: endpointClaim.subject, type: endpointType, releaseDigest: bundledDigest },
                endpointCode: parent.sourceEndpoint,
                code: parent.code,
              },
            ],
          });
        const orientation = vndbProducerParentEnds(parent.code, parent.sourceSubject, parent.sourceEndpoint);
        let mapped = mapParent(orientation?.holder ?? parent.sourceSubject);
        const firstProposal = mapped.proposals[0];
        if (firstProposal?.op === 'propose') {
          const ownerExternalId =
            firstProposal.subject === sourceClaim.subject
              ? draft.producerParent.sourceSubject
              : firstProposal.subject === endpointClaim.subject
                ? draft.producerParent.sourceEndpoint
                : undefined;
          if (ownerExternalId === undefined)
            throw new TypeError('VNDB producer-parent mapper returned an unbound holder');
          if (firstProposal.source.external_id !== ownerExternalId) mapped = mapParent(ownerExternalId);
        }
        for (const gap of mapped.gaps)
          gaps.push({
            ...gap,
            sourceSubject: draft.producerParent.sourceSubject,
            sourceEndpoint: draft.producerParent.sourceEndpoint,
            record: draft.record,
            table: draft.table,
          });
        if (mapped.proposals.length !== 1) {
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
        const mappedCommand = mapped.proposals[0]!;
        if (mappedCommand.op !== 'propose')
          throw new TypeError('VNDB producer-parent mapper returned a non-proposal command');
        const command: BatchCommand = mappedCommand;
        const childExternalId =
          command.subject === sourceClaim.subject
            ? draft.producerParent.sourceSubject
            : command.subject === endpointClaim.subject
              ? draft.producerParent.sourceEndpoint
              : undefined;
        if (!childExternalId) throw new TypeError('VNDB producer-parent mapper returned an unbound holder');
        const parentExternalId =
          childExternalId === draft.producerParent.sourceSubject
            ? draft.producerParent.sourceEndpoint
            : draft.producerParent.sourceSubject;
        const actualHolder = childExternalId === draft.producerParent.sourceSubject ? sourceClaim : endpointClaim;
        const actualTarget = parentExternalId === draft.producerParent.sourceSubject ? sourceClaim : endpointClaim;
        if (
          actualHolder.state !== 'bound' ||
          actualTarget.state !== 'bound' ||
          command.subject !== actualHolder.subject
        )
          throw new TypeError('VNDB producer-parent mapper did not preserve the canonical holder binding');
        const value = command.statement.value;
        if (value.type !== 'value' || value.content !== actualTarget.subject)
          throw new TypeError('VNDB producer-parent mapper did not preserve the canonical endpoint binding');
        if (checkBatchWrite({ commands: [command] }, bundledRelease).length)
          throw new TypeError('VNDB producer-parent proposal failed portable validation');
        const retained = this.database
          .transaction(() => {
            const prepared = input.journal?.prepare(command);
            const exact = prepared ? (JSON.parse(prepared.bytes) as { commands: [BatchCommand] }).commands[0] : command;
            if (!exact || exact.op !== 'propose') throw new TypeError('Cross-media relation journal is invalid');
            return this.retainCommand(graphEdgeKey(draft), exact);
          })
          .immediate();
        commands.push({
          draft,
          command: JSON.parse(retained.bytes).commands[0] as BatchCommand,
          subject: actualHolder.subject,
          target: actualTarget.subject,
          sourceHolder: childExternalId,
          sourceTarget: parentExternalId,
          bytes: retained.bytes,
        });
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
          record_revision: draft.recordRevision ?? 'unversioned',
          converter_revision: draft.converterRevision ?? 'cross-media-entities@1',
          digest: sourceDigest(draft.record),
          field_group: 'facts',
        },
        subject: holder.subject,
        statement,
      };
      const retained = this.retainCommand(graphEdgeKey(draft), command);
      commands.push({
        draft,
        command: JSON.parse(retained.bytes).commands[0] as BatchCommand,
        subject: holder.subject,
        target: target.subject,
        sourceHolder: draft.holder,
        sourceTarget: draft.target,
        bytes: retained.bytes,
      });
    }
    const groups = [
      commands.filter((entry) => !entry.draft.producerParent),
      commands.filter((entry) => Boolean(entry.draft.producerParent)),
    ];
    for (const group of groups) {
      for (let offset = 0; offset < group.length; offset += BATCH_LIMIT) {
        const page = group.slice(offset, offset + BATCH_LIMIT);
        if (checkBatchWrite({ commands: page.map((entry) => entry.command) }).length)
          throw new TypeError('Cross-media relation proposals failed portable validation');
        const result = await input.batch({ commands: page.map((entry) => entry.command) });
        for (const [index, entry] of page.entries()) {
          const receipt = result.results[index];
          const status = receipt?.status;
          const journaled = !!(entry.draft.relation || entry.draft.producerParent);
          if (status === 200) {
            unchanged++;
            if (journaled && (!receipt || !('value' in receipt) || !('candidate' in receipt.value)))
              throw new TypeError('Cross-media relation replay omitted its native candidate receipt');
            this.database
              .transaction(() => {
                if (journaled && receipt && 'value' in receipt) input.journal?.acknowledge(entry.command, receipt);
                if (journaled && receipt && 'value' in receipt && 'candidate' in receipt.value)
                  this.database
                    .prepare(
                      'UPDATE cross_media_graph SET status=?, command_key=?, native_candidate=? WHERE edge_key=?',
                    )
                    .run('proposed', entry.command.key, receipt.value.candidate, graphEdgeKey(entry.draft));
                else mark.run('proposed', entry.command.key, graphEdgeKey(entry.draft));
              })
              .immediate();
            continue;
          }
          if (status !== 201) {
            if (entry.draft.producerParent && receipt === undefined) {
              mark.run('unresolved', entry.command.key, graphEdgeKey(entry.draft));
              unresolved.push({ ...entry.draft, reason: 'unknown_delivery' });
              continue;
            }
            throw new TypeError(`Cross-media relation write failed: ${status}`);
          }
          if (!receipt || !('value' in receipt))
            throw new TypeError('Cross-media relation write omitted its native receipt');
          if (journaled && !('candidate' in receipt.value))
            throw new TypeError('Cross-media relation proposal returned no candidate');
          this.database
            .transaction(() => {
              if (journaled) input.journal?.acknowledge(entry.command, receipt);
              if (journaled && 'candidate' in receipt.value)
                this.database
                  .prepare('UPDATE cross_media_graph SET status=?, command_key=?, native_candidate=? WHERE edge_key=?')
                  .run('proposed', entry.command.key, receipt.value.candidate, graphEdgeKey(entry.draft));
              else mark.run('proposed', entry.command.key, graphEdgeKey(entry.draft));
            })
            .immediate();
          proposed.push({
            key: graphEdgeKey(entry.draft),
            holder: entry.sourceHolder,
            target: entry.sourceTarget,
            property: entry.draft.property,
            subject: entry.subject,
          });
        }
      }
    }
    if (input.relationSnapshot) {
      await this.retractMissingRelations(input, input.relationSnapshot);
    }
    return { proposed, unresolved, gaps, unchanged };
  }

  private async retractMissingRelations(
    input: {
      batch(request: { commands: BatchCommand[] }): Promise<BatchWriteResult>;
      journal?: {
        prepare(command: BatchCommand): { bytes: string };
        acknowledge(command: BatchCommand, result: BatchWriteResult['results'][number]): void;
      };
    },
    snapshot: { currentKeys: readonly string[]; scope: readonly string[]; digest: string; complete: boolean },
  ): Promise<void> {
    const currentKeys = new Set(snapshot.currentKeys);
    const scope = new Set(snapshot.scope);
    const prior = this.database
      .prepare(`SELECT edge_key,payload,command_payload,native_candidate,retraction_key,retraction_payload
        FROM cross_media_graph WHERE table_name='subject-relations' AND status='proposed' AND native_candidate IS NOT NULL`)
      .all() as {
      edge_key: string;
      payload: string;
      command_payload: string;
      native_candidate: string;
      retraction_key: string | null;
      retraction_payload: string | null;
    }[];
    const pending: { edgeKey: string; command: BatchCommand; bytes: string }[] = [];
    for (const row of prior) {
      const hasPendingRetraction = row.retraction_payload !== null;
      if (!hasPendingRetraction && currentKeys.has(row.edge_key)) continue;
      const draft = JSON.parse(row.payload) as GraphEdgeDraft;
      if (
        !draft.relation ||
        (!hasPendingRetraction && (!snapshot.complete || (!scope.has(draft.holder) && !scope.has(draft.target))))
      )
        continue;
      const original = (JSON.parse(row.command_payload) as { commands: BatchCommand[] }).commands[0];
      if (!original || original.op !== 'propose') continue;
      const command: BatchCommand = {
        op: 'retract',
        key: commandKey([
          draft.alias,
          row.edge_key,
          row.native_candidate,
          'relation-retract',
          snapshot.digest,
          bangumiVocabularyRevision,
        ]),
        source: {
          source: original.source.source,
          external_id: original.source.external_id,
          record_revision: original.source.record_revision,
          converter_revision: `${bangumiVocabularyRevision}:relation-retract`,
          digest: snapshot.digest,
          field_group: 'facts',
        },
        subject: original.subject,
        candidate: row.native_candidate,
        references: original.statement.references,
      };
      const savedBytes = row.retraction_payload;
      const pendingCommand = savedBytes
        ? (JSON.parse(savedBytes) as { commands: [BatchCommand] }).commands[0]
        : command;
      if (!pendingCommand || pendingCommand.op !== 'retract')
        throw new TypeError('Cross-media relation retraction journal is invalid');
      if (row.retraction_key && row.retraction_key !== pendingCommand.key)
        throw new TypeError('Cross-media relation retraction key changed after journaling');
      const retained = this.database
        .transaction(() => {
          const prepared = input.journal?.prepare(pendingCommand);
          const exact = prepared?.bytes ?? savedBytes ?? JSON.stringify({ commands: [pendingCommand] });
          const value = JSON.parse(exact) as { commands: [BatchCommand] };
          if (value.commands[0]?.op !== 'retract')
            throw new TypeError('Cross-media relation retraction journal is invalid');
          this.database
            .prepare('UPDATE cross_media_graph SET retraction_key=?, retraction_payload=? WHERE edge_key=?')
            .run(value.commands[0].key, exact, row.edge_key);
          return { command: value.commands[0], bytes: exact };
        })
        .immediate();
      pending.push({ edgeKey: row.edge_key, ...retained });
    }
    for (let offset = 0; offset < pending.length; offset += BATCH_LIMIT) {
      const page = pending.slice(offset, offset + BATCH_LIMIT);
      if (checkBatchWrite({ commands: page.map((entry) => entry.command) }, bundledRelease).length)
        throw new TypeError('Cross-media relation retractions failed portable validation');
      const result = await input.batch({ commands: page.map((entry) => entry.command) });
      for (const [index, entry] of page.entries()) {
        const receipt = result.results[index];
        if (!receipt || (receipt.status !== 200 && receipt.status !== 201) || !('value' in receipt))
          throw new TypeError(`Cross-media relation retraction failed: ${receipt?.status ?? 'missing receipt'}`);
        this.database
          .transaction(() => {
            input.journal?.acknowledge(entry.command, receipt);
            this.database
              .prepare(`UPDATE cross_media_graph SET status='retracted' WHERE edge_key=?`)
              .run(entry.edgeKey);
          })
          .immediate();
      }
    }
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
