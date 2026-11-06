import type { Database } from 'bun:sqlite';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import {
  BATCH_LIMIT,
  checkBatchWrite,
  type BatchCommand,
  type BatchWriteResult,
  type Source,
} from '@rezics/definitions/bulk';
import { mapBangumiVocabulary, bangumiVocabularyRevision } from '@rezics/conversion/bangumi-vocabulary';
import { mapVndbVocabulary, vndbVocabularyRevision } from '@rezics/conversion/vndb-vocabulary';
import type { SourceVocabularyGap, SourceVocabularyRequest } from '@rezics/conversion';
import { commandKey, sourceDigest, sourceEnvelope } from '../../../packages/conversion/src/support.ts';
import {
  bangumiRecordUrl,
  converter_revision as entityRevision,
  relationStatement,
  vndbProducerParentEnds,
  vndbRecordUrl,
} from '@rezics/conversion/cross-media-entities';
import type { Claim } from './record-bindings.ts';
import type { VndbWorkRelationEvidence } from './showcase-vndb-relations.ts';

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
  /** Exact independently retained provider claim for a selected counterpart. */
  targetAlias?: string;
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
  vndbRelation?: {
    sourceSubject: string;
    sourceEndpoint: string;
    mappingRevision: string;
    evidence: readonly VndbWorkRelationEvidence[];
  };
};

/** Exact source envelope used by an ordinary selected graph proposal. */
export function graphEdgeSource(draft: GraphEdgeDraft): Source {
  const digest = draft.vndbRelation ? sourceDigest(draft.vndbRelation.evidence) : sourceDigest(draft.record);
  return sourceEnvelope(
    {
      source: draft.alias,
      external_id: draft.holder,
      record_revision: draft.recordRevision ?? null,
      converter_revision: draft.converterRevision ?? 'cross-media-entities@1',
      digest,
    },
    'facts',
  );
}

export type UnresolvedEdge = GraphEdgeDraft & { reason: string };
export type ProposedEdge = { key: string; holder: string; target: string; property: string; subject: string };
export type GraphEdgeEvidence = {
  draft: GraphEdgeDraft;
  status: 'planned' | 'unresolved' | 'proposed';
  command?: BatchCommand;
  candidate?: string;
};
export type ReleaseEndpointCurrentness =
  | 'current'
  | 'missing'
  | 'refused'
  | 'unknown'
  | 'wrong_type'
  | 'identity_mismatch'
  | 'unavailable';
export type RelationEndpointCurrentness = ReleaseEndpointCurrentness;
export type GraphRelationSnapshot = {
  provider: Provider;
  table?: string;
  currentKeys: readonly string[];
  scope: readonly string[];
  digest: string;
  complete: boolean;
};
export type GraphMappingGap = SourceVocabularyGap & {
  sourceSubject: string;
  sourceEndpoint: string;
  record: Record<string, unknown>;
  table?: string;
};

export type BangumiAppearanceEvidence = Readonly<{
  subjectId: string;
  characterId: number;
  sourceIndex: number;
  roleCode: unknown;
  order?: number | string | null;
  sourceRow?: Readonly<Record<string, unknown>>;
}>;

/** Stable source envelope for one selected subject-characters row. */
export function bangumiAppearanceSource(alias: string, appearance: BangumiAppearanceEvidence): Source {
  if (
    !/^[1-9][0-9]*$/u.test(appearance.subjectId) ||
    !Number.isSafeInteger(appearance.characterId) ||
    appearance.characterId <= 0 ||
    !Number.isSafeInteger(appearance.sourceIndex) ||
    appearance.sourceIndex < 0
  )
    throw new TypeError('Invalid Bangumi appearance source identity');
  const sourceRow = appearance.sourceRow ?? {
    subject_id: Number(appearance.subjectId),
    character_id: appearance.characterId,
    type: appearance.roleCode,
    ...(appearance.order === undefined ? {} : { order: appearance.order }),
  };
  return sourceEnvelope(
    {
      source: alias,
      external_id: `subject-characters:${appearance.subjectId}:${appearance.sourceIndex}`,
      record_revision: null,
      converter_revision: entityRevision,
      digest: sourceDigest(sourceRow),
    },
    'facts',
  );
}

/** Merge adapter requests without allowing one taxonomy binding to replace another. */
export function combineSourceVocabularyRequests(
  requests: readonly (SourceVocabularyRequest | undefined)[],
): SourceVocabularyRequest | undefined {
  const admitted = requests.filter((request): request is SourceVocabularyRequest => request !== undefined);
  if (!admitted.length) return undefined;
  const releaseDigest = admitted[0]!.bindings.releaseDigest;
  const schemes = new Map<string, SourceVocabularyRequest['bindings']['schemes'][number]>();
  const concepts = new Map<string, SourceVocabularyRequest['bindings']['concepts'][number]>();
  const rows = new Map<string, SourceVocabularyRequest['rows'][number]>();
  for (const request of admitted) {
    if (request.bindings.releaseDigest !== releaseDigest)
      throw new TypeError('Source vocabulary adapters use different definition releases');
    for (const item of request.bindings.schemes) {
      if (item.releaseDigest !== releaseDigest)
        throw new TypeError(`Source vocabulary scheme uses a different definition release: ${item.taxonomy}`);
      const prior = schemes.get(item.taxonomy);
      if (
        prior &&
        (prior.id !== item.id ||
          prior.uri !== item.uri ||
          prior.type !== item.type ||
          prior.releaseDigest !== item.releaseDigest)
      )
        throw new TypeError(`Source vocabulary adapters disagree on scheme ${item.taxonomy}`);
      schemes.set(item.taxonomy, item);
    }
    for (const item of request.bindings.concepts) {
      if (item.releaseDigest !== releaseDigest)
        throw new TypeError(
          `Source vocabulary concept uses a different definition release: ${item.taxonomy}:${item.code}`,
        );
      const key = `${item.taxonomy}\0${item.code}`;
      const prior = concepts.get(key);
      if (
        prior &&
        (prior.id !== item.id ||
          prior.schemeId !== item.schemeId ||
          prior.type !== item.type ||
          prior.releaseDigest !== item.releaseDigest)
      )
        throw new TypeError(`Source vocabulary adapters disagree on concept ${item.taxonomy}:${item.code}`);
      concepts.set(key, item);
    }
    for (const row of request.rows) rows.set(JSON.stringify(row), row);
  }
  return {
    bindings: {
      releaseDigest,
      schemes: [...schemes.values()],
      concepts: [...concepts.values()],
    },
    rows: [...rows.values()],
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function graphEdgeKey(draft: GraphEdgeDraft): string {
  return commandKey([
    draft.alias,
    draft.table,
    draft.holder,
    draft.target,
    draft.property,
    ...(draft.targetAlias ? [draft.targetAlias] : []),
    sourceDigest(draft.record),
    ...(draft.relation ? [draft.relation.mappingRevision, sourceDigest(draft.relation.evidence)] : []),
    // Another member can invalidate this volume's ordinal without changing its own source rows.
    // Retain a new proposal when that family-wide decision changes, including known to unknown.
    ...(draft.relation && draft.property === 'wdt:P179' ? [String(draft.relation.order ?? 'unknown')] : []),
    ...(draft.producerParent
      ? [draft.producerParent.mappingRevision, sourceDigest(draft.producerParent.evidence)]
      : []),
    ...(draft.vndbRelation ? [draft.vndbRelation.mappingRevision, sourceDigest(draft.vndbRelation.evidence)] : []),
  ]);
}

function isVndbReleaseSupersession(draft: GraphEdgeDraft): boolean {
  return (
    draft.source === 'vndb' && draft.table === 'releases_supersedes' && draft.property === 'rezics:releaseSupersedes'
  );
}

/** Reuse the graph's existing operation and idempotency identity for an ordinary proposal. */
export function graphEdgeCommandKey(draft: GraphEdgeDraft): string {
  return commandKey([draft.alias, draft.holder, graphEdgeKey(draft), 'relation']);
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

  evidence(drafts: readonly GraphEdgeDraft[]): GraphEdgeEvidence[] {
    const read = this.database.prepare(
      'SELECT status,command_payload AS command,native_candidate AS candidate FROM cross_media_graph WHERE edge_key=?',
    );
    return drafts.map((draft) => {
      const row = read.get(graphEdgeKey(draft)) as {
        status: string;
        command: string | null;
        candidate: string | null;
      } | null;
      const status = row?.status === 'proposed' ? 'proposed' : row?.status === 'unresolved' ? 'unresolved' : 'planned';
      const command = row?.command
        ? ((JSON.parse(row.command) as { commands?: BatchCommand[] }).commands?.[0] ?? undefined)
        : undefined;
      return {
        draft,
        status,
        ...(command === undefined ? {} : { command }),
        ...(row?.candidate === null || row?.candidate === undefined ? {} : { candidate: row.candidate }),
      };
    });
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
    currentRelationEndpoint(
      externalId: string,
      nativeSubjectId: string,
      expectedType: string | undefined,
    ): Promise<RelationEndpointCurrentness>;
    currentReleaseEndpoint?: (externalId: string, nativeSubjectId: string) => Promise<ReleaseEndpointCurrentness>;
    /** Current provider identity gates Person endpoints without changing their sealed source binding. */
    currentPersonIdentity?: (alias: string, externalId: string, nativeSubjectId: string) => Promise<boolean>;
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
    relationSnapshots?: readonly GraphRelationSnapshot[];
  }): Promise<{ proposed: ProposedEdge[]; unresolved: UnresolvedEdge[]; gaps: GraphMappingGap[]; unchanged: number }> {
    const drafts = this.planned();
    const snapshots =
      input.relationSnapshots ??
      (input.relationSnapshot ? [{ provider: 'bangumi' as const, ...input.relationSnapshot }] : []);
    const currentRelations = snapshots.map((snapshot) => ({
      ...snapshot,
      keys: new Set(snapshot.currentKeys),
      owners: new Set(snapshot.scope),
    }));
    const proposed: ProposedEdge[] = [];
    const unresolved: UnresolvedEdge[] = [];
    const gaps: GraphMappingGap[] = [];
    let unchanged = 0;
    const mark = this.database.prepare(
      `UPDATE cross_media_graph SET status=?, command_key=COALESCE(?,command_key) WHERE edge_key=?`,
    );
    const commands: {
      draft: GraphEdgeDraft;
      command: BatchCommand;
      subject: string;
      target: string;
      sourceHolder: string;
      sourceTarget: string;
      bytes: string;
    }[] = [];
    const sourceFactFences = new Map<string, Promise<{ fenced: boolean; securityRevision: string | null }>>();
    const currentFactFence = (source: string, externalId: string) => {
      const key = `${source}\0${externalId}`;
      let fence = sourceFactFences.get(key);
      if (!fence) {
        fence = input.fence({ source, externalId, fieldGroup: 'facts' });
        sourceFactFences.set(key, fence);
      }
      return fence;
    };
    for (const draft of drafts) {
      // The previous work-link producer sealed an identifier forbidden on Visual Novels. Native admission
      // rejects that exact shape with 400; retain its bytes for inspection without resending it on reopen.
      if (
        draft.source === 'vndb' &&
        draft.table === 'extlinks' &&
        draft.targetKind === 'literal' &&
        draft.property === 'wdt:P5732' &&
        draft.converterRevision === 'vndb-work-links@1'
      ) {
        mark.run('unsupported', null, graphEdgeKey(draft));
        unresolved.push({ ...draft, reason: 'unsupported_work_link_identity' });
        continue;
      }
      const snapshot = currentRelations.find(
        (snapshot) => snapshot.provider === draft.source && (!snapshot.table || snapshot.table === draft.table),
      );
      if (
        (draft.relation || draft.vndbRelation || draft.targetAlias) &&
        snapshot?.complete &&
        !snapshot.keys.has(graphEdgeKey(draft)) &&
        (snapshot.owners.has(draft.holder) || snapshot.owners.has(draft.target)) &&
        !this.command(graphEdgeKey(draft))?.bytes
      ) {
        // No send was sealed for this old row. A newly resolved dependency cannot revive removed evidence.
        // Sealed commands still replay exactly below, then retire through the ordinary candidate command.
        continue;
      }
      const releaseSupersession = isVndbReleaseSupersession(draft);
      const holder = input.claim({ source: draft.alias, external_id: draft.holder });
      const target =
        draft.targetKind === 'literal'
          ? { state: 'bound' as const, subject: draft.target }
          : input.claim({ source: draft.targetAlias ?? draft.alias, external_id: draft.target });
      if (holder?.state !== 'bound' || target?.state !== 'bound') {
        const unresolvedOwner = holder?.state !== 'bound' ? holder : target;
        const externalId = holder?.state !== 'bound' ? draft.holder : draft.target;
        const reason = releaseSupersession
          ? unresolvedOwner?.state === 'taken-down'
            ? `endpoint_refused:${externalId}`
            : unresolvedOwner?.state === 'pending'
              ? `endpoint_unknown:${externalId}`
              : `missing_endpoint:${externalId}`
          : holder?.state !== 'bound'
            ? `missing_holder:${draft.holder}`
            : `missing_endpoint:${draft.target}`;
        unresolved.push({ ...draft, reason });
        mark.run('unresolved', null, graphEdgeKey(draft));
        continue;
      }
      if (input.currentPersonIdentity) {
        const endpoints = [
          [draft.holder, holder.subject],
          ...(draft.targetKind === 'literal' ? [] : [[draft.target, target.subject] as const]),
        ] as const;
        let staleEndpoint: string | undefined;
        for (const [externalId, nativeSubjectId] of endpoints) {
          if (input.nativeType(externalId, draft.alias) !== 'schema:Person') continue;
          if (!(await input.currentPersonIdentity(draft.alias, externalId, nativeSubjectId))) {
            staleEndpoint = externalId;
            break;
          }
        }
        if (staleEndpoint) {
          unresolved.push({ ...draft, reason: `current_person_identity_unavailable:${staleEndpoint}` });
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
      }
      if (releaseSupersession) {
        let endpointFailure: { id: string; status: ReleaseEndpointCurrentness } | undefined;
        for (const [externalId, nativeSubjectId] of [
          [draft.holder, holder.subject],
          [draft.target, target.subject],
        ] as const) {
          const status = await input.currentReleaseEndpoint?.(externalId, nativeSubjectId);
          if (status !== 'current') {
            endpointFailure = { id: externalId, status: status ?? 'unavailable' };
            break;
          }
        }
        if (endpointFailure) {
          unresolved.push({ ...draft, reason: `current_release_${endpointFailure.status}:${endpointFailure.id}` });
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
      }
      const sourceFactOwner =
        draft.source === 'vndb' && draft.table === 'vn_relations' && !draft.vndbRelation
          ? String(draft.record.id)
          : draft.fenceFacts
            ? draft.holder
            : undefined;
      if (sourceFactOwner !== undefined) {
        if ((await currentFactFence(draft.alias, sourceFactOwner)).fenced) {
          unresolved.push({ ...draft, reason: 'fenced_source_facts' });
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
      }
      if (draft.targetAlias) {
        const endpoints = [
          { alias: draft.alias, externalId: draft.holder, subject: holder.subject },
          { alias: draft.targetAlias, externalId: draft.target, subject: target.subject },
        ];
        const reads = await Promise.all(
          endpoints.map(({ alias, externalId, subject }) =>
            input.currentRelationEndpoint(externalId, subject, input.nativeType(externalId, alias)),
          ),
        );
        const fences = await Promise.all(endpoints.map(({ alias, externalId }) => currentFactFence(alias, externalId)));
        const stale = reads.findIndex((status) => status !== 'current');
        if (fences.some((fence) => fence.fenced) || stale !== -1) {
          unresolved.push({
            ...draft,
            reason: fences.some((fence) => fence.fenced)
              ? 'fenced_relation_holder'
              : `current_relation_endpoint_${reads[stale]}:${endpoints[stale]!.externalId}`,
          });
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
      }
      if (draft.relation) {
        const sourceClaim = input.claim({ source: draft.alias, external_id: draft.relation.sourceSubject });
        const endpointClaim = input.claim({ source: draft.alias, external_id: draft.relation.sourceEndpoint });
        const sourceType = input.nativeType(draft.relation.sourceSubject, draft.alias);
        const endpointType = input.nativeType(draft.relation.sourceEndpoint, draft.alias);
        if (sourceClaim?.state !== 'bound' || endpointClaim?.state !== 'bound' || !sourceType || !endpointType) {
          unresolved.push({ ...draft, reason: 'missing_native_endpoint_profile' });
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
        const endpoints = [
          { externalId: draft.relation.sourceSubject, claim: sourceClaim, nativeType: sourceType },
          { externalId: draft.relation.sourceEndpoint, claim: endpointClaim, nativeType: endpointType },
        ];
        const [endpointReads, endpointFences] = await Promise.all([
          Promise.all(
            endpoints.map(({ externalId, claim, nativeType }) =>
              input.currentRelationEndpoint(externalId, claim.subject, nativeType),
            ),
          ),
          Promise.all(endpoints.map(({ externalId }) => currentFactFence(draft.alias, externalId))),
        ]);
        if (endpointFences.some((fence) => fence.fenced)) {
          unresolved.push({ ...draft, reason: 'fenced_relation_holder' });
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
        const staleEndpointIndex = endpointReads.findIndex((status) => status !== 'current');
        if (staleEndpointIndex !== -1) {
          const endpoint = endpoints[staleEndpointIndex]!;
          unresolved.push({
            ...draft,
            reason: `current_relation_endpoint_${endpointReads[staleEndpointIndex]}:${endpoint.externalId}`,
          });
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
      if (draft.vndbRelation) {
        const relation = draft.vndbRelation;
        const endpoints = [
          {
            externalId: relation.sourceSubject,
            claim: holder,
            nativeType: input.nativeType(relation.sourceSubject, draft.alias),
          },
          {
            externalId: relation.sourceEndpoint,
            claim: target,
            nativeType: input.nativeType(relation.sourceEndpoint, draft.alias),
          },
        ];
        if (endpoints.some((endpoint) => endpoint.nativeType === undefined)) {
          unresolved.push({ ...draft, reason: 'missing_native_endpoint_profile' });
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
        const [endpointReads, endpointFences] = await Promise.all([
          Promise.all(
            endpoints.map(({ externalId, claim, nativeType }) =>
              input.currentRelationEndpoint(externalId, claim.subject, nativeType!),
            ),
          ),
          Promise.all(endpoints.map(({ externalId }) => currentFactFence(draft.alias, externalId))),
        ]);
        if (endpointFences.some((fence) => fence.fenced)) {
          unresolved.push({ ...draft, reason: 'fenced_relation_endpoint' });
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
        const staleEndpointIndex = endpointReads.findIndex((status) => status !== 'current');
        if (staleEndpointIndex !== -1) {
          const endpoint = endpoints[staleEndpointIndex]!;
          unresolved.push({
            ...draft,
            reason: 'current_relation_endpoint_' + endpointReads[staleEndpointIndex] + ':' + endpoint.externalId,
          });
          mark.run('unresolved', null, graphEdgeKey(draft));
          continue;
        }
        const citationUrls = [...new Set(relation.evidence.map((row) => row.sourceUrl))].sort();
        const statement = {
          ...relationStatement({
            property: draft.property,
            target: target.subject,
            url: citationUrls[0]!,
          }),
          references: citationUrls.map((url) => ({
            parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: url } }],
          })),
        };
        const command: BatchCommand = {
          op: 'propose',
          key: graphEdgeCommandKey(draft),
          source: graphEdgeSource(draft),
          subject: holder.subject,
          statement,
        };
        if (checkBatchWrite({ commands: [command] }, bundledRelease).length)
          throw new TypeError('VNDB work-relation proposal failed portable validation');
        const prepared = input.journal?.prepare(command);
        const exact = prepared ? (JSON.parse(prepared.bytes) as { commands?: BatchCommand[] }).commands?.[0] : command;
        if (!exact || exact.op !== 'propose') throw new TypeError('VNDB work-relation journal is invalid');
        const exactValue = exact.statement.value;
        if (
          exact.source.external_id !== relation.sourceSubject ||
          sourceDigest(exact.source) !== sourceDigest(command.source) ||
          exact.subject !== holder.subject ||
          exact.statement.property.id !== draft.property ||
          exactValue.type !== 'value' ||
          exactValue.content !== target.subject
        ) {
          unresolved.push({ ...draft, reason: 'journaled_native_identity_changed' });
          mark.run('unresolved', exact.key, graphEdgeKey(draft));
          continue;
        }
        const retained = this.retainCommand(graphEdgeKey(draft), exact);
        commands.push({
          draft,
          command: JSON.parse(retained.bytes).commands[0] as BatchCommand,
          subject: holder.subject,
          target: target.subject,
          sourceHolder: relation.sourceSubject,
          sourceTarget: relation.sourceEndpoint,
          bytes: retained.bytes,
        });
        continue;
      }
      if (draft.producerParent) {
        let fenced = false;
        for (const externalId of new Set([draft.producerParent.sourceSubject, draft.producerParent.sourceEndpoint])) {
          const fence = await currentFactFence(draft.alias, externalId);
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
      const statementBase = relationStatement({
        property: draft.property,
        target: target.subject,
        url: draft.url,
        qualifiers,
      });
      const statement = isVndbReleaseSupersession(draft)
        ? {
            ...statementBase,
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value' as const, content: vndbRecordUrl(draft.holder) },
                  },
                ],
              },
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value' as const, content: vndbRecordUrl(draft.target) },
                  },
                ],
              },
            ],
          }
        : statementBase;
      const command: BatchCommand = {
        op: 'propose',
        key: graphEdgeCommandKey(draft),
        source: graphEdgeSource(draft),
        subject: holder.subject,
        statement,
      };
      const edgeKey = graphEdgeKey(draft);
      const journaled =
        releaseSupersession || draft.targetAlias !== undefined || (draft.source === 'vndb' && draft.table === 'vn_relations');
      const prior = journaled ? this.command(edgeKey) : null;
      let sealedCommand = command;
      if (prior?.bytes) {
        const exact = (JSON.parse(prior.bytes) as { commands?: BatchCommand[] }).commands?.[0];
        if (!exact || exact.op !== 'propose' || prior.key !== exact.key)
          throw new TypeError('Cross-media release journal is invalid');
        const exactTarget = exact.statement.value.type === 'value' ? exact.statement.value.content : undefined;
        if (
          exact.source.source !== draft.alias ||
          exact.source.external_id !== draft.holder ||
          exact.source.digest !== sourceDigest(draft.record) ||
          exact.subject !== holder.subject ||
          exact.statement.property.id !== draft.property ||
          exactTarget !== target.subject
        ) {
          unresolved.push({ ...draft, reason: 'journaled_native_identity_changed' });
          mark.run('unresolved', prior.key, edgeKey);
          continue;
        }
        sealedCommand = exact;
      } else if (journaled && input.journal) {
        const prepared = input.journal.prepare(command);
        const exact = (JSON.parse(prepared.bytes) as { commands?: BatchCommand[] }).commands?.[0];
        if (!exact || exact.op !== 'propose') throw new TypeError('Cross-media release journal is invalid');
        sealedCommand = exact;
      }
      const retained = this.retainCommand(edgeKey, sealedCommand);
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
      commands.filter((entry) => !entry.draft.producerParent && !isVndbReleaseSupersession(entry.draft)),
      commands.filter((entry) => isVndbReleaseSupersession(entry.draft)),
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
          const journaled = !!(
            entry.draft.targetAlias ||
            entry.draft.relation ||
            entry.draft.producerParent ||
            entry.draft.vndbRelation ||
            (entry.draft.source === 'vndb' && entry.draft.table === 'vn_relations') ||
            isVndbReleaseSupersession(entry.draft)
          );
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
            if (isVndbReleaseSupersession(entry.draft)) {
              mark.run('unresolved', entry.command.key, graphEdgeKey(entry.draft));
              const reason =
                status === undefined
                  ? 'unknown_delivery'
                  : status === 401 || status === 403
                    ? 'endpoint_refused'
                    : status === 404 || status === 410
                      ? 'missing_endpoint'
                      : 'endpoint_unavailable';
              unresolved.push({ ...entry.draft, reason });
              continue;
            }
            if (entry.draft.producerParent && receipt === undefined) {
              mark.run('unresolved', entry.command.key, graphEdgeKey(entry.draft));
              unresolved.push({ ...entry.draft, reason: 'unknown_delivery' });
              continue;
            }
            throw new TypeError(
              `Cross-media relation write failed: ${status}: ${JSON.stringify({
                route: '/v1/subjects:batchWrite',
                command: entry.command,
                receipt,
              })}`,
            );
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
    if (snapshots.length) {
      unresolved.push(
        ...(await this.retractMissingRelations(
          {
            batch: input.batch,
            claim: input.claim,
            nativeType: input.nativeType,
            currentRelationEndpoint: input.currentRelationEndpoint,
            currentFactFence,
            ...(input.journal ? { journal: input.journal } : {}),
          },
          snapshots,
        )),
      );
    }
    return { proposed, unresolved, gaps, unchanged };
  }

  private async retractMissingRelations(
    input: {
      batch(request: { commands: BatchCommand[] }): Promise<BatchWriteResult>;
      claim(owner: { source: string; external_id: string }): Claim | null;
      nativeType(externalId: string, alias?: string): string | undefined;
      currentRelationEndpoint(
        externalId: string,
        nativeSubjectId: string,
        expectedType: string | undefined,
      ): Promise<RelationEndpointCurrentness>;
      currentFactFence(
        source: string,
        externalId: string,
      ): Promise<{ fenced: boolean; securityRevision: string | null }>;
      journal?: {
        prepare(command: BatchCommand): { bytes: string };
        acknowledge(command: BatchCommand, result: BatchWriteResult['results'][number]): void;
      };
    },
    snapshots: readonly GraphRelationSnapshot[],
  ): Promise<UnresolvedEdge[]> {
    const unresolved: UnresolvedEdge[] = [];
    const currentRelations = snapshots.map((snapshot) => ({
      ...snapshot,
      keys: new Set(snapshot.currentKeys),
      owners: new Set(snapshot.scope),
    }));
    const prior = this.database
      .prepare(`SELECT edge_key,payload,command_payload,native_candidate,retraction_key,retraction_payload
        FROM cross_media_graph WHERE table_name IN ('subject-relations','vn_relations','extlinks')
        AND status='proposed' AND native_candidate IS NOT NULL`)
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
      const draft = JSON.parse(row.payload) as GraphEdgeDraft;
      const relation = draft.relation ?? draft.vndbRelation;
      const snapshot = currentRelations.find(
        (snapshot) => snapshot.provider === draft.source && (!snapshot.table || snapshot.table === draft.table),
      );
      if ((!relation && !draft.targetAlias) || !snapshot) continue;
      const hasPendingRetraction = row.retraction_payload !== null;
      if (!hasPendingRetraction && snapshot.keys.has(row.edge_key)) continue;
      if (
        !hasPendingRetraction &&
        (!snapshot.complete || (!snapshot.owners.has(draft.holder) && !snapshot.owners.has(draft.target)))
      )
        continue;
      const original = (JSON.parse(row.command_payload) as { commands: BatchCommand[] }).commands[0];
      if (!original || original.op !== 'propose') continue;
      const endpoints = relation ? [relation.sourceSubject, relation.sourceEndpoint] : [draft.holder, draft.target];
      const aliases = [draft.alias, draft.targetAlias ?? draft.alias];
      const claims = endpoints.map((externalId, index) => ({
        externalId,
        claim: input.claim({ source: aliases[index]!, external_id: externalId }),
      }));
      const subjects = claims.map(({ claim }) => (claim?.state === 'bound' ? claim.subject : null));
      const missingIndex = subjects.findIndex((subject) => subject === null);
      if (missingIndex !== -1) {
        const missing = claims[missingIndex]!;
        const reason =
          missing.claim?.state === 'pending'
            ? `endpoint_unknown:${missing.externalId}`
            : missing.claim?.state === 'taken-down'
              ? `endpoint_refused:${missing.externalId}`
              : `missing_endpoint:${missing.externalId}`;
        unresolved.push({ ...draft, reason });
        continue;
      }
      const current = await Promise.all(
        claims.map(({ externalId }, index) =>
          input.currentRelationEndpoint(externalId, subjects[index]!, input.nativeType(externalId, aliases[index]!)),
        ),
      );
      const currentFailure = current.findIndex((status) => status !== 'current');
      if (currentFailure !== -1) {
        unresolved.push({
          ...draft,
          reason: `current_relation_endpoint_${current[currentFailure]}:${endpoints[currentFailure]}`,
        });
        continue;
      }
      const fences = await Promise.all(
        endpoints.map((externalId, index) => input.currentFactFence(aliases[index]!, externalId)),
      );
      if (fences.some((fence) => fence.fenced)) {
        unresolved.push({ ...draft, reason: 'fenced_relation_holder' });
        continue;
      }
      const sourceIndex = endpoints.indexOf(original.source.external_id);
      const targetIndex = sourceIndex === 0 ? 1 : sourceIndex === 1 ? 0 : -1;
      const targetValue = original.statement.value;
      if (
        original.source.source !== draft.alias ||
        sourceIndex === -1 ||
        original.subject !== subjects[sourceIndex] ||
        targetValue.type !== 'value' ||
        targetValue.content !== subjects[targetIndex]
      ) {
        unresolved.push({ ...draft, reason: 'journaled_native_identity_changed' });
        continue;
      }
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
          converter_revision: draft.relation
            ? `${bangumiVocabularyRevision}:relation-retract`
            : `${original.source.converter_revision}:retract`,
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
    return unresolved;
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
