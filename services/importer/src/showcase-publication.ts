import { observePersonIdentity, personIdentityForSource } from './showcase-person-identity.ts';
import { Database } from 'bun:sqlite';
import { chmodSync } from 'node:fs';
import { sameStatementProvenance } from './statement-provenance.ts';
import { showcaseFranchiseFence } from './showcase-franchise.ts';
import { showcaseTagParentSourceFence } from './showcase-cross-provider-tags.ts';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult, BatchStatement } from '@rezics/definitions/bulk';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { ReviewedSubjectRead } from './import-client.ts';
import { createImportTransport } from './import-client.ts';
import type {
  CrossMediaPlan,
  CrossMediaPort,
  CrossMediaSeedResult,
  VndbWorkRelationOutcome,
} from './cross-media-seed.ts';
import {
  buildShowcaseManifest,
  showcaseDigest,
  showcaseLimits,
  showcaseSourceMatches,
  showcaseStatementMatches,
  showcaseVocabularyExternalId,
  type ShowcaseAcknowledgement,
  type ShowcaseAssertion,
  type ShowcaseManifest,
  type ShowcaseRecord,
  type ShowcaseTagAssociation,
  type ShowcaseTagAssociationWithdrawal,
  type ShowcaseTagParentBinding,
  type ShowcaseTagParentPublication,
  type ShowcaseTagParentRefresh,
  type ShowcaseVocabularyRecord,
  type ShowcaseVocabularyRequirement,
  showcaseMediaContext,
} from './showcase-manifest.ts';
import type { PublicBulkClient } from './public-bulk-client.ts';
import { GLOBAL_CONTEXT } from './public-bulk-client.ts';
import { createSourceRegistration, crossMediaBangumiRevision } from './source-registry.ts';
import {
  bangumiRecordUrl,
  converter_revision as entityRevision,
  crossMediaCoverDigest,
  mapSourceEnumeration,
} from '@rezics/conversion/cross-media-entities';
import { createSelectedFamilySourceRegistration } from './source-registry.ts';
import { subjectSlug } from '@rezics/definitions/slug';
import { safeSourceUrl } from '../../../packages/conversion/src/support.ts';
import type {
  BangumiCoverSource,
  BangumiCoverSourceJournal,
  BangumiPersonCareerSource,
  CrossMediaMediaOutcome,
} from './showcase-media.ts';
import type { BangumiPersonSourceJournal } from './showcase-bangumi-people.ts';
import { validAvailableCover } from './showcase-media.ts';
import { vndbPublicTagConceptUri, vndbPublicTagScheme } from '../../../packages/conversion/src/support.ts';
import { vndbTagsRatingMetric } from '@rezics/conversion/vndb-vocabulary';
import type {
  VndbTagRatingBinding,
  VndbTagRatingObservation,
  VndbTagRatingSnapshot,
} from './showcase-vndb-tag-ratings.ts';

type ImportTransport = ReturnType<typeof createImportTransport>;
export type ShowcaseReviewPort = Pick<
  ImportTransport,
  'readReviewedSubject' | 'reviewedCandidates' | 'acceptReviewedCandidate' | 'adoptReviewedCandidates'
> &
  Partial<Pick<ImportTransport, 'fence'>>;

type JournalCommandRow = {
  command_key: string;
  command_digest: string;
  command_json: string;
  state: 'prepared' | 'acknowledged';
  subject_id: string | null;
  candidate_id: string | null;
};
type JournalActionRow = {
  action_key: string;
  body_digest: string;
  body_json: string;
  idempotency_key: string;
  state: 'prepared' | 'acknowledged' | 'refused';
  error_code: string | null;
  result_id: string | null;
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function successResult(
  result: BatchWriteResult['results'][number],
): result is Extract<BatchWriteResult['results'][number], { status: 200 | 201 }> {
  return result.status === 200 || result.status === 201;
}

/** Durable, local-only journal for exact source commands and separately authorized review actions. */
export class ShowcaseJournal implements BangumiCoverSourceJournal, BangumiPersonSourceJournal {
  readonly #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true });
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS showcase_command (
        command_key TEXT PRIMARY KEY,
        command_digest TEXT NOT NULL,
        command_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared','acknowledged')),
        subject_id TEXT,
        candidate_id TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS showcase_intent (
        intent_digest TEXT PRIMARY KEY,
        intent_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS showcase_cover_source (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_alias TEXT NOT NULL,
        external_id TEXT NOT NULL,
        archive_digest TEXT NOT NULL,
        response_digest TEXT NOT NULL,
        source_json TEXT NOT NULL,
        UNIQUE(source_alias,external_id,archive_digest,response_digest)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS showcase_person_career_source (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_alias TEXT NOT NULL,
        external_id TEXT NOT NULL,
        archive_digest TEXT NOT NULL,
        response_digest TEXT NOT NULL,
        source_json TEXT NOT NULL,
        UNIQUE(source_alias,external_id,archive_digest,response_digest)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS showcase_vndb_tag_rating_source (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_id TEXT NOT NULL,
        response_digest TEXT,
        observation_json TEXT NOT NULL,
        request_body TEXT,
        response_bytes BLOB,
        tag_ids_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending','terminal'))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS showcase_vndb_tag_rating_work
        ON showcase_vndb_tag_rating_source(work_id,id DESC);
      CREATE TABLE IF NOT EXISTS showcase_action (
        action_key TEXT PRIMARY KEY,
        body_digest TEXT NOT NULL,
        body_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared','acknowledged','refused')),
        error_code TEXT
      ) STRICT;
    `);
    // Native fixture creates need their acknowledged UUID alongside the sealed action.
    const actionColumns = this.#db.query<{ name: string }, []>('PRAGMA table_info(showcase_action)').all();
    if (!actionColumns.some((column) => column.name === 'result_id'))
      this.#db.exec('ALTER TABLE showcase_action ADD COLUMN result_id TEXT');
    const coverColumns = this.#db.query<{ name: string }, []>('PRAGMA table_info(showcase_cover_source)').all();
    if (!coverColumns.some((column) => column.name === 'response_digest')) {
      const receipts = this.#db
        .query<{ source_alias: string; external_id: string; archive_digest: string; source_json: string }, []>(
          'SELECT source_alias,external_id,archive_digest,source_json FROM showcase_cover_source ORDER BY rowid',
        )
        .all();
      this.#db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE showcase_cover_source RENAME TO showcase_cover_source_legacy;
        CREATE TABLE showcase_cover_source (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_alias TEXT NOT NULL,
          external_id TEXT NOT NULL,
          archive_digest TEXT NOT NULL,
          response_digest TEXT NOT NULL,
          source_json TEXT NOT NULL,
          UNIQUE(source_alias,external_id,archive_digest,response_digest)
        ) STRICT;
      `);
      try {
        const insert = this.#db.query(
          'INSERT INTO showcase_cover_source(source_alias,external_id,archive_digest,response_digest,source_json) VALUES(?,?,?,?,?)',
        );
        for (const receipt of receipts) {
          const source = JSON.parse(receipt.source_json) as BangumiCoverSource;
          if (!source.responseDigest) throw new TypeError('Legacy Bangumi source receipt has no response digest');
          insert.run(
            receipt.source_alias,
            receipt.external_id,
            receipt.archive_digest,
            source.responseDigest,
            receipt.source_json,
          );
        }
        this.#db.exec('DROP TABLE showcase_cover_source_legacy; COMMIT;');
      } catch (error) {
        this.#db.exec('ROLLBACK;');
        throw error;
      }
    }
  }

  prepareCommand(command: BatchCommand): void {
    const commandDigest = showcaseDigest(command);
    const prior = this.#db
      .query<Pick<JournalCommandRow, 'command_digest' | 'command_json'>, [string]>(
        'SELECT command_digest,command_json FROM showcase_command WHERE command_key=?',
      )
      .get(command.key);
    if (prior) {
      if (prior.command_digest !== commandDigest || prior.command_json !== json(command))
        throw new TypeError('Showcase command key was reused with a changed body');
      return;
    }
    this.#db
      .query("INSERT INTO showcase_command(command_key,command_digest,command_json,state) VALUES(?,?,?,'prepared')")
      .run(command.key, commandDigest, json(command));
  }

  acknowledgeCommand(
    command: BatchCommand,
    result: Extract<BatchWriteResult['results'][number], { status: 200 | 201 }>,
  ): void {
    const value = result.value;
    const subjectId = 'id' in value ? value.id : command.op === 'propose' ? command.subject : null;
    const candidateId = 'candidate' in value ? value.candidate : null;
    const prior = this.#db
      .query<Pick<JournalCommandRow, 'command_digest' | 'subject_id' | 'candidate_id'>, [string]>(
        'SELECT command_digest,subject_id,candidate_id FROM showcase_command WHERE command_key=?',
      )
      .get(command.key);
    if (!prior || prior.command_digest !== showcaseDigest(command))
      throw new TypeError('Showcase ACK does not match a prepared command');
    if (
      (prior.subject_id && subjectId && prior.subject_id !== subjectId) ||
      (prior.candidate_id && candidateId && prior.candidate_id !== candidateId)
    )
      throw new TypeError('Showcase ACK identity changed for a sealed command');
    this.#db
      .query(
        "UPDATE showcase_command SET state='acknowledged',subject_id=COALESCE(subject_id,?),candidate_id=COALESCE(candidate_id,?) WHERE command_key=?",
      )
      .run(subjectId, candidateId, command.key);
  }

  acknowledgedCommands(): ShowcaseAcknowledgement[] {
    return this.#commands('acknowledged');
  }

  preparedCommands(): ShowcaseAcknowledgement[] {
    return this.#commands('prepared');
  }

  #commands(state: 'prepared' | 'acknowledged'): ShowcaseAcknowledgement[] {
    return this.#db
      .query<JournalCommandRow, [string, number]>(
        'SELECT command_key,command_digest,command_json,state,subject_id,candidate_id FROM showcase_command WHERE state=? ORDER BY command_key LIMIT ?',
      )
      .all(state, showcaseLimits.candidates + showcaseLimits.records + showcaseLimits.vocabulary)
      .map((row) => ({
        command: JSON.parse(row.command_json) as BatchCommand,
        commandDigest: row.command_digest,
        ...(row.subject_id ? { subjectId: row.subject_id } : {}),
        ...(row.candidate_id ? { candidateId: row.candidate_id } : {}),
      }));
  }

  prepareAction(actionKey: string, body: unknown, idempotencyKey: string): unknown {
    const bodyJson = json(body);
    const bodyDigest = showcaseDigest(body);
    const prior = this.#db
      .query<JournalActionRow, [string]>('SELECT * FROM showcase_action WHERE action_key=?')
      .get(actionKey);
    if (prior) {
      if (
        prior.state === 'refused' &&
        prior.error_code?.startsWith('review-http-4') &&
        (prior.body_digest !== bodyDigest ||
          (prior.error_code === 'review-http-422' && prior.idempotency_key !== idempotencyKey))
      ) {
        this.#db
          .query(
            "UPDATE showcase_action SET body_digest=?,body_json=?,idempotency_key=?,state='prepared',error_code=NULL WHERE action_key=?",
          )
          .run(bodyDigest, bodyJson, idempotencyKey, actionKey);
        return body;
      }
      // A timed-out action is retried with the original sealed body and key even if
      // the current adoption head has advanced after the server committed it.
      if (prior.state === 'acknowledged' && prior.body_digest !== bodyDigest)
        throw new TypeError('Acknowledged showcase action changed under the same intent');
      return JSON.parse(prior.body_json) as unknown;
    }
    this.#db
      .query(
        "INSERT INTO showcase_action(action_key,body_digest,body_json,idempotency_key,state) VALUES(?,?,?,?,'prepared')",
      )
      .run(actionKey, bodyDigest, bodyJson, idempotencyKey);
    return body;
  }

  action(actionKey: string): JournalActionRow | null {
    return (
      this.#db.query<JournalActionRow, [string]>('SELECT * FROM showcase_action WHERE action_key=?').get(actionKey) ??
      null
    );
  }

  acknowledgeAction(actionKey: string, resultId?: string): void {
    this.#db
      .query(
        "UPDATE showcase_action SET state='acknowledged',error_code=NULL,result_id=COALESCE(result_id,?) WHERE action_key=?",
      )
      .run(resultId ?? null, actionKey);
  }

  refuseAction(actionKey: string, errorCode: string): void {
    this.#db
      .query("UPDATE showcase_action SET state='refused',error_code=? WHERE action_key=?")
      .run(errorCode, actionKey);
  }

  sealIntent(manifest: ShowcaseManifest): void {
    const intent = {
      records: manifest.records.map((record) => ({
        provider: record.provider,
        sourceKey: record.sourceKey,
        subjectId: record.subjectId,
        assertions: record.assertions.map(({ commandKey, candidateId, candidateDigest }) => ({
          commandKey,
          candidateId,
          candidateDigest,
        })),
      })),
      vocabulary: manifest.vocabulary.map((record) => ({
        sourceKey: record.sourceKey,
        subjectId: record.subjectId,
        assertions: record.assertions.map(({ commandKey, candidateId, candidateDigest, tagParentPath, rights }) => ({
          commandKey,
          candidateId,
          candidateDigest,
          ...(tagParentPath ? { tagParentPath } : {}),
          ...(rights ? { rights } : {}),
        })),
      })),
      media: manifest.media.map((record) => ({
        sourceAlias: record.sourceAlias,
        sourceKey: record.sourceKey,
        sourceRevision: record.sourceRevision,
        archiveDigest: record.archiveDigest,
        responseDigest: record.responseDigest ?? null,
        etag: record.etag ?? null,
        sourceUrl: record.sourceUrl ?? null,
        status: record.status,
        mediaState: record.mediaState ?? null,
        containerId: record.containerId,
        mediaId: record.mediaId ?? null,
        credit: record.credit ?? null,
        provenance: record.provenance ?? null,
        candidateId: record.candidateId ?? null,
        candidateDigest: record.candidateDigest ?? null,
        readHandoff: record.readHandoff ?? null,
        gap: record.gap ?? null,
      })),
      tagWeightObservations: manifest.tagWeightObservations,
      tagWeightRefreshes: manifest.tagWeightRefreshes,
      tagAssociations: manifest.tagAssociations ?? [],
      tagAssociationWithdrawals: manifest.tagAssociationWithdrawals ?? [],
      tagAssociationRefreshes: manifest.tagAssociationRefreshes ?? [],
      tagParentEvidence: manifest.tagParentEvidence ?? [],
      tagParentGaps: manifest.tagParentGaps ?? [],
      tagParentRefreshes: manifest.tagParentRefreshes ?? [],
      tagParentPublications: manifest.tagParentPublications ?? [],
    };
    const body = json(intent);
    const prior = this.#db
      .query<{ intent_json: string }, [string]>('SELECT intent_json FROM showcase_intent WHERE intent_digest=?')
      .get(manifest.digest);
    if (prior) {
      if (prior.intent_json !== body) throw new TypeError('Showcase intent changed under the same source digest');
      return;
    }
    this.#db.query('INSERT INTO showcase_intent(intent_digest,intent_json) VALUES(?,?)').run(manifest.digest, body);
  }

  coverSource(sourceAlias: string, externalId: string, archiveDigest: string): BangumiCoverSource | null {
    const row = this.#db
      .query<{ source_json: string }, [string, string, string]>(
        'SELECT source_json FROM showcase_cover_source WHERE source_alias=? AND external_id=? AND archive_digest=? ORDER BY id DESC LIMIT 1',
      )
      .get(sourceAlias, externalId, archiveDigest);
    return row ? (JSON.parse(row.source_json) as BangumiCoverSource) : null;
  }

  latestMediaStatus(sourceAlias: string, externalId: string): CrossMediaMediaOutcome['status'] | null {
    const row = this.#db
      .query<{ intent_json: string }, []>('SELECT intent_json FROM showcase_intent ORDER BY rowid DESC LIMIT 1')
      .get();
    if (!row) return null;
    const intent = JSON.parse(row.intent_json) as { media?: unknown };
    if (!Array.isArray(intent.media)) return null;
    const media = intent.media.find(
      (item): item is { sourceAlias: string; sourceKey: string; status: CrossMediaMediaOutcome['status'] } =>
        !!item &&
        typeof item === 'object' &&
        Reflect.get(item, 'sourceAlias') === sourceAlias &&
        Reflect.get(item, 'sourceKey') === externalId &&
        typeof Reflect.get(item, 'status') === 'string',
    );
    return media?.status ?? null;
  }

  sealCoverSource(source: BangumiCoverSource): BangumiCoverSource {
    const person = /^person:([1-9][0-9]*)$/u.exec(source.externalId);
    const character = /^character:([1-9][0-9]*)$/u.exec(source.externalId);
    const subject = /^[1-9][0-9]*$/u.test(source.externalId) ? source.externalId : undefined;
    const endpoint = person
      ? `https://api.bgm.tv/v0/persons/${person[1]}`
      : character
        ? `https://api.bgm.tv/v0/characters/${character[1]}`
        : subject
          ? `https://api.bgm.tv/v0/subjects/${subject}`
          : undefined;
    if (
      source.sourceAlias !== 'bangumi_cross_media' ||
      !endpoint ||
      !/^[0-9a-f]{64}$/u.test(source.archiveDigest) ||
      !['available', 'absent', 'unavailable', 'invalid'].includes(source.sourceStatus) ||
      source.endpoint !== endpoint ||
      !/^[0-9a-f]{64}$/u.test(source.responseDigest ?? '') ||
      (source.etag !== undefined && (source.etag.length > 256 || !/^[\x20-\x7e]*$/u.test(source.etag))) ||
      (source.sourceStatus === 'available' &&
        (!source.sourceUrl || !/^https:\/\/lain\.bgm\.tv\//u.test(source.sourceUrl))) ||
      (source.sourceStatus !== 'available' && source.sourceUrl !== undefined) ||
      (source.sourceStatus === 'unavailable' &&
        !['source-api-http', 'source-api-unavailable', 'source-payload-invalid', 'source-limit'].includes(
          source.code ?? '',
        ))
    )
      throw new TypeError('Invalid Bangumi cover source receipt');
    if (source.sourceStatus === 'available') safeSourceUrl(source.sourceUrl!, ['lain.bgm.tv']);
    const body = json(source);
    const priorRow = this.#db
      .query<{ source_json: string }, [string, string, string, string]>(
        'SELECT source_json FROM showcase_cover_source WHERE source_alias=? AND external_id=? AND archive_digest=? AND response_digest=?',
      )
      .get(source.sourceAlias, source.externalId, source.archiveDigest, source.responseDigest!);
    const prior = priorRow ? (JSON.parse(priorRow.source_json) as BangumiCoverSource) : null;
    if (prior) {
      const { etag: _priorEtag, ...priorEvidence } = prior;
      const { etag: _nextEtag, ...nextEvidence } = source;
      if (json(priorEvidence) !== json(nextEvidence))
        throw new TypeError('Bangumi cover source changed under the same response digest');
      return prior;
    }
    this.#db
      .query(
        'INSERT INTO showcase_cover_source(source_alias,external_id,archive_digest,response_digest,source_json) VALUES(?,?,?,?,?)',
      )
      .run(source.sourceAlias, source.externalId, source.archiveDigest, source.responseDigest!, body);
    return source;
  }

  personCareerSource(sourceAlias: string, externalId: string, archiveDigest: string): BangumiPersonCareerSource | null {
    const row = this.#db
      .query<{ source_json: string }, [string, string, string]>(
        'SELECT source_json FROM showcase_person_career_source WHERE source_alias=? AND external_id=? AND archive_digest=? ORDER BY id DESC LIMIT 1',
      )
      .get(sourceAlias, externalId, archiveDigest);
    return row ? (JSON.parse(row.source_json) as BangumiPersonCareerSource) : null;
  }

  sealPersonCareerSource(source: BangumiPersonCareerSource): BangumiPersonCareerSource {
    if (
      source.sourceAlias !== 'bangumi_cross_media' ||
      !/^person:[1-9][0-9]*$/u.test(source.externalId) ||
      !/^[0-9a-f]{64}$/u.test(source.archiveDigest) ||
      source.endpoint !== `https://api.bgm.tv/v0/persons/${source.externalId.slice('person:'.length)}` ||
      source.sourceStatus !== 'available' ||
      !/^[0-9a-f]{64}$/u.test(source.responseDigest ?? '') ||
      (source.careers !== undefined &&
        (!Array.isArray(source.careers) ||
          source.careers.length > 7 ||
          source.careers.some(
            (career) => typeof career !== 'string' || !career.isWellFormed() || career.length > 64,
          ))) ||
      (source.personChineseName !== undefined &&
        (!source.personChineseName.isWellFormed() ||
          source.personChineseName.trim().length === 0 ||
          Buffer.byteLength(source.personChineseName, 'utf8') > 4096 ||
          [...source.personChineseName].length > 500 ||
          /\p{Cc}/u.test(source.personChineseName))) ||
      (source.personNameDiagnostics !== undefined &&
        (!Array.isArray(source.personNameDiagnostics) ||
          source.personNameDiagnostics.length > 16 ||
          source.personNameDiagnostics.some(
            (item) =>
              !item ||
              typeof item.pointer !== 'string' ||
              item.pointer.length > 96 ||
              typeof item.code !== 'string' ||
              item.code.length > 64,
          ))) ||
      (source.etag !== undefined && (source.etag.length > 64 || !/^[\x20-\x7e]*$/u.test(source.etag)))
    )
      throw new TypeError('Invalid Bangumi Person career receipt');
    const body = json(source);
    const prior = this.personCareerSource(source.sourceAlias, source.externalId, source.archiveDigest);
    if (prior) {
      if (json(prior) !== body)
        throw new TypeError('Bangumi Person career source changed under the same archive digest');
      return prior;
    }
    this.#db
      .query(
        'INSERT INTO showcase_person_career_source(source_alias,external_id,archive_digest,response_digest,source_json) VALUES(?,?,?,?,?)',
      )
      .run(source.sourceAlias, source.externalId, source.archiveDigest, source.responseDigest!, body);
    return source;
  }

  vndbTagRatingSource(workId: string): {
    pending: boolean;
    observation: VndbTagRatingObservation;
    snapshot?: VndbTagRatingSnapshot;
  } | null {
    const row = this.#db
      .query<
        {
          response_digest: string | null;
          observation_json: string;
          request_body: string | null;
          response_bytes: Uint8Array | null;
          tag_ids_json: string | null;
          state: 'pending' | 'terminal';
        },
        [string]
      >(
        'SELECT response_digest,observation_json,request_body,response_bytes,tag_ids_json,state FROM showcase_vndb_tag_rating_source WHERE work_id=? ORDER BY id DESC LIMIT 1',
      )
      .get(workId);
    if (!row) return null;
    return {
      pending: row.state === 'pending',
      observation: JSON.parse(row.observation_json) as VndbTagRatingObservation,
      ...(row.response_bytes === null
        ? {}
        : {
            snapshot: {
              workId,
              requestBody: row.request_body!,
              bytes: row.response_bytes,
              digest: row.response_digest!,
              tagIds: JSON.parse(row.tag_ids_json!) as string[],
            },
          }),
    };
  }

  sealVndbTagRatingSource(observation: VndbTagRatingObservation, snapshot?: VndbTagRatingSnapshot): void {
    this.#db
      .query(
        'INSERT INTO showcase_vndb_tag_rating_source(work_id,response_digest,observation_json,request_body,response_bytes,tag_ids_json,state) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        observation.workId,
        observation.responseDigest ?? null,
        json(observation),
        snapshot?.requestBody ?? null,
        snapshot?.bytes ?? null,
        snapshot ? json(snapshot.tagIds) : null,
        snapshot ? 'pending' : 'terminal',
      );
  }

  completeVndbTagRatingSource(workId: string, responseDigest: string): void {
    this.#db
      .query(
        "UPDATE showcase_vndb_tag_rating_source SET state='terminal' WHERE id=(SELECT id FROM showcase_vndb_tag_rating_source WHERE work_id=? ORDER BY id DESC LIMIT 1) AND response_digest=?",
      )
      .run(workId, responseDigest);
  }

  close(): void {
    this.#db.close();
  }
}

/** Persist each exact body before transport, then seal only acknowledged native UUIDs. */
export function captureShowcaseCommands<Port extends CrossMediaPort>(port: Port, journal: ShowcaseJournal): Port {
  return {
    ...port,
    async batch(request: BatchWriteRequest): Promise<BatchWriteResult> {
      for (const command of request.commands) {
        if (command.op === 'create' || command.op === 'propose') journal.prepareCommand(command);
      }
      const result = await port.batch(request);
      const byKey = new Map(result.results.map((row) => [row.key, row]));
      for (const command of request.commands) {
        if (command.op !== 'create' && command.op !== 'propose') continue;
        const acknowledgement = byKey.get(command.key);
        if (acknowledgement && successResult(acknowledgement)) journal.acknowledgeCommand(command, acknowledgement);
      }
      return result;
    },
  };
}

type CandidateRead = {
  id: string;
  source: BatchCommand['source'] | null;
  statement: BatchStatement;
  head: number | null;
  decision?: 'accept' | 'reject' | 'abstain' | null;
};
type CandidatePage = {
  candidates: CandidateRead[];
  next: unknown;
  adoption: {
    head?: number | null;
    selection?: { candidate: string; rank: 'normal' | 'preferred' | 'deprecated' }[];
  } | null;
};
type AdoptionSnapshot = Readonly<{
  head: number;
  selection: readonly { candidate: string; rank: 'normal' | 'preferred' | 'deprecated' }[];
}>;
const nativeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function sameAdoptionSelection(
  left: readonly { candidate: string; rank: string }[],
  right: readonly { candidate: string; rank: string }[],
): boolean {
  const sorted = (selection: readonly { candidate: string; rank: string }[]) =>
    JSON.stringify([...selection].sort((a, b) => a.candidate.localeCompare(b.candidate)));
  return sorted(left) === sorted(right);
}

function adoptionSnapshot(adoption: CandidatePage['adoption']): AdoptionSnapshot | null {
  return adoption ? { head: adoption.head!, selection: adoption.selection! } : null;
}

function subjectId(read: ReviewedSubjectRead): string | null {
  const subject = read.subject as { id?: unknown } | undefined;
  return typeof subject?.id === 'string' ? subject.id : null;
}

/** Reads follow canonical identity; statement ownership and adoption stay on the sealed original. */
function currentSourceRead(
  read: ReviewedSubjectRead,
  record: Pick<ShowcaseRecord, 'provider' | 'sourceKey' | 'subjectId' | 'nativeType'>,
): boolean {
  if (subjectType(read) !== record.nativeType) return false;
  if (subjectId(read) === record.subjectId) return true;
  const identity = personIdentityForSource(record.provider, record.sourceKey, record.nativeType ?? undefined);
  return identity !== undefined && observePersonIdentity(identity, read).state === 'current';
}

function subjectType(read: ReviewedSubjectRead): string | null {
  const subject = read.subject as { type?: unknown } | undefined;
  return typeof subject?.type === 'string' ? subject.type : null;
}

function safeCandidatePage(value: unknown): CandidatePage {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid current candidate page');
  const page = value as Partial<CandidatePage>;
  if (
    !Array.isArray(page.candidates) ||
    page.candidates.length > showcaseLimits.reviewPage ||
    page.candidates.some(
      (candidate) =>
        !candidate ||
        typeof candidate !== 'object' ||
        !nativeUuid.test(candidate.id) ||
        !candidate.statement ||
        typeof candidate.statement !== 'object',
    ) ||
    (page.adoption !== null &&
      (!page.adoption ||
        !Number.isSafeInteger(page.adoption.head) ||
        (page.adoption.head as number) < 1 ||
        !Array.isArray(page.adoption.selection) ||
        page.adoption.selection.some(
          (selection) =>
            !selection ||
            typeof selection.candidate !== 'string' ||
            !nativeUuid.test(selection.candidate) ||
            typeof selection.rank !== 'string' ||
            !['normal', 'preferred', 'deprecated'].includes(selection.rank),
        )))
  )
    throw new TypeError('Invalid current candidate page');
  return page as CandidatePage;
}

function groupKey(subject: string, property: string): string {
  return `${subject}\0${property}`;
}

function statementOnPublicRead(value: unknown, expected: BatchStatement): boolean {
  return sameStatementProvenance(value, expected);
}

function sourceIdentity(record: ShowcaseRecord): { property: string; value: string } | null {
  if (record.provider === 'vndb') return { property: 'wdt:P3180', value: record.sourceKey };
  if (record.kind === 'work') return { property: 'wdt:P5732', value: record.sourceKey };
  if (record.kind === 'character' && record.sourceKey.startsWith('character:'))
    return { property: 'wdt:P6296', value: record.sourceKey.slice('character:'.length) };
  if (record.kind === 'person' && record.sourceKey.startsWith('person:'))
    return { property: 'wdt:P6298', value: record.sourceKey.slice('person:'.length) };
  if (record.kind === 'episode' && record.sourceUri) return { property: 'schema:url', value: record.sourceUri };
  return null;
}

function sourceIdentityProperty(record: ShowcaseRecord): string | null {
  const identity = sourceIdentity(record);
  if (identity) return identity.property;
  return record.provider === 'bangumi' &&
    record.kind === 'organization' &&
    /^person:[1-9][0-9]*$/u.test(record.sourceKey)
    ? 'schema:name'
    : null;
}

function phase(record: ShowcaseRecord, assertion: ShowcaseAssertion): number {
  if (record.kind === 'source-vocabulary' && record.nativeType === 'skos:ConceptScheme') return 0;
  if (record.kind === 'source-vocabulary' && record.nativeType === 'skos:Concept') return 1;
  if (assertion.property === sourceIdentityProperty(record)) return 2;
  return 3;
}

function actionKey(kind: 'accept' | 'adopt', identity: string, digest: string): string {
  return `${kind}:${showcaseDigest({ identity, digest })}`;
}

function actionIdempotencyKey(action: string, body: unknown): string {
  return showcaseDigest({ action, body });
}

function errorCode(error: unknown): string {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
  if (typeof status === 'number' && Number.isInteger(status)) return `review-http-${status}`;
  if (error instanceof DOMException && error.name === 'AbortError') return 'review-interrupted';
  return 'review-unavailable';
}

function permanentReviewRefusal(code: string | null | undefined): boolean {
  return ['review-http-401', 'review-http-403', 'review-http-409', 'review-http-412', 'review-http-423'].includes(
    code ?? '',
  );
}

function recordSource(record: ShowcaseRecord, assertion: ShowcaseAssertion): boolean {
  const externalId =
    record.kind === 'source-vocabulary' ? showcaseVocabularyExternalId(record.sourceKey) : record.sourceKey;
  const exactTagParent =
    record.kind === 'source-vocabulary' &&
    assertion.property === 'skos:broader' &&
    assertion.ownerKey === record.sourceKey &&
    assertion.tagParentPath === assertion.source.external_id &&
    assertion.source.converter_revision === 'vndb-public-tag-vocabulary@1' &&
    assertion.source.field_group === 'facts' &&
    /^\/tags_parents\/g[1-9][0-9]{0,9}\/g[1-9][0-9]{0,9}$/u.test(assertion.tagParentPath);
  return (
    assertion.source.source === record.sourceAlias &&
    (assertion.source.external_id === externalId ||
      exactTagParent ||
      (record.kind !== 'source-vocabulary' && assertion.ownerKey === record.sourceKey))
  );
}

function managedSourceTagParent(candidate: CandidateRead, alias: string): boolean {
  return (
    candidate.source?.source === alias &&
    candidate.source.converter_revision === 'vndb-public-tag-vocabulary@1' &&
    candidate.source.field_group === 'facts' &&
    /^\/tags_parents\/g[1-9][0-9]{0,9}\/g[1-9][0-9]{0,9}$/u.test(candidate.source.external_id) &&
    candidate.statement.property.id === 'skos:broader'
  );
}

const bangumiCharacterKindsUri = 'https://rezics.com/schemes/bangumi/character-kinds';
const bangumiAppearanceRolesUri = 'https://rezics.com/schemes/bangumi/appearance-roles';
const bangumiPersonCareersUri = 'https://rezics.com/schemes/bangumi/careers';
const bangumiCharacterKindsSource =
  'https://github.com/bangumi/api/blob/65d29cff2331e08c0110d30d515f7f1b6488f845/open-api/v0.yaml#/components/schemas/CharacterType';
const bangumiAppearanceRolesSource =
  'https://github.com/bangumi/Archive/blob/959474a4fcb833f6dabe8dd2f4fe192f82a71140/README.md';
const bangumiPersonCareersSource =
  'https://github.com/bangumi/api/blob/65d29cff2331e08c0110d30d515f7f1b6488f845/open-api/v0.yaml#/components/schemas/PersonCareer';

function sourceVocabularyCitation(record: ShowcaseRecord, uri: string): boolean {
  if (record.provider !== 'bangumi' || record.kind !== 'source-vocabulary' || !record.sourceUri) return false;
  if (/^https:\/\/rezics\.com\/schemes\/bangumi\/character-kinds(?:\/[1-4])?$/u.test(record.sourceUri))
    return uri === record.sourceUri || uri === bangumiCharacterKindsSource;
  if (/^https:\/\/rezics\.com\/schemes\/bangumi\/appearance-roles(?:\/[1-3])?$/u.test(record.sourceUri))
    return uri === record.sourceUri || uri === bangumiAppearanceRolesSource;
  if (
    /^https:\/\/rezics\.com\/schemes\/bangumi\/careers\/(?:producer|mangaka|artist|seiyu|writer|illustrator|actor)$/u.test(
      record.sourceUri,
    )
  )
    return uri === record.sourceUri || uri === bangumiPersonCareersSource;
  return false;
}

function proseOrImage(property: string): boolean {
  return (
    property === 'schema:image' ||
    property === 'schema:abstract' ||
    property === 'schema:description' ||
    property === 'schema:comment' ||
    property === 'schema:text' ||
    property === 'schema:articleBody'
  );
}

function admittedCoverMedia(
  plan: CrossMediaPlan,
  outcomes: readonly CrossMediaMediaOutcome[],
  record: ShowcaseRecord,
  assertion: ShowcaseAssertion,
): CrossMediaMediaOutcome | undefined {
  const creator =
    /^person:[1-9][0-9]*$/u.test(record.sourceKey) &&
    (record.kind === 'person' || record.kind === 'organization') &&
    (record.nativeType === 'schema:Person' || record.nativeType === 'schema:Organization');
  const work = record.kind === 'work' && /^[1-9][0-9]*$/u.test(record.sourceKey);
  const character = record.kind === 'character' && /^character:[1-9][0-9]*$/u.test(record.sourceKey);
  if (
    record.provider !== 'bangumi' ||
    (!work && !creator && !character) ||
    assertion.property !== 'schema:image' ||
    !record.subjectId ||
    record.sourceUri !== bangumiRecordUrl(record.sourceKey) ||
    assertion.statement.value.type !== 'value'
  )
    return undefined;
  const outcome = outcomes.find(
    (item) => item.sourceAlias === record.sourceAlias && item.externalId === record.sourceKey,
  );
  const receipt = [...(plan.coverSources ?? []), ...(plan.creatorImageSources ?? [])].find(
    (item) => item.sourceAlias === record.sourceAlias && item.externalId === record.sourceKey,
  );
  const imageRows = creator || character ? plan.entities.bangumi : plan.records.bangumi;
  const imageUrl = (
    imageRows.find((row) => row.key === record.sourceKey)?.payload as { images?: { large?: unknown } } | undefined
  )?.images?.large;
  const coverDigest =
    character && typeof imageUrl === 'string'
      ? crossMediaCoverDigest(record.semanticDigest, imageUrl)
      : record.semanticDigest;
  if (
    !outcome ||
    !receipt ||
    outcome.status !== 'available' ||
    outcome.sourceStatus !== 'available' ||
    outcome.containerId !== record.subjectId ||
    !validAvailableCover({
      source: outcome,
      recordKey: record.sourceKey,
      sourceAlias: record.sourceAlias,
      sourceRevision: record.sourceRevision,
      archiveDigest: receipt.archiveDigest,
      containerId: record.subjectId,
      ...(outcome.mediaId ? { mediaId: outcome.mediaId } : {}),
      ...(typeof imageUrl === 'string' ? { sourceUrl: imageUrl } : {}),
    }) ||
    receipt.endpoint !== outcome.endpoint ||
    receipt.responseDigest !== outcome.responseDigest ||
    receipt.sourceUrl !== outcome.sourceUrl ||
    assertion.source.source !== record.sourceAlias ||
    assertion.source.external_id !== record.sourceKey ||
    assertion.source.record_revision !== record.sourceRevision ||
    assertion.source.digest !== coverDigest ||
    assertion.source.converter_revision !== record.converterRevision ||
    assertion.source.field_group !== 'cover' ||
    assertion.statement.value.type !== 'value' ||
    assertion.statement.value.content !== outcome.mediaId ||
    outcome.provenance?.source !== record.sourceAlias ||
    outcome.provenance.external_id !== record.sourceKey ||
    outcome.provenance.record_revision !== record.sourceRevision ||
    outcome.provenance.converter_revision !== record.converterRevision ||
    outcome.provenance.digest !== coverDigest ||
    outcome.provenance.field_group !== 'cover' ||
    outcome.credit?.rightsHolder !== '(c) rights holder' ||
    outcome.credit.via.name !== 'Bangumi' ||
    outcome.credit.via.url !== record.sourceUri ||
    outcome.credit.license !== 'LicenseRef-unknown' ||
    outcome.credit.obligations.length !== 0 ||
    !assertion.citations.includes(record.sourceUri) ||
    !assertion.citations.includes(outcome.sourceUrl!) ||
    !outcome.provenance.references.some((reference) =>
      reference.parts.some((part) => part.value.type === 'value' && part.value.content === record.sourceUri),
    ) ||
    !outcome.provenance.references.some((reference) =>
      reference.parts.some((part) => part.value.type === 'value' && part.value.content === outcome.sourceUrl),
    )
  )
    return undefined;
  return outcome;
}

async function currentCoverFence(
  review: ShowcaseReviewPort,
  source: Pick<CrossMediaMediaOutcome, 'sourceAlias' | 'externalId'>,
): Promise<'open' | 'fenced' | 'unavailable'> {
  if (!review.fence) return 'unavailable';
  try {
    const current = await review.fence({
      source: source.sourceAlias,
      externalId: source.externalId,
      fieldGroup: 'cover',
    });
    if (current.fenced) return 'fenced';
    return current.securityRevision === null ? 'open' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

async function currentFactsFence(
  review: ShowcaseReviewPort,
  source: string,
  externalId: string,
): Promise<'open' | 'fenced' | 'unavailable'> {
  if (!review.fence) return 'unavailable';
  const current = await review.fence({ source, externalId, fieldGroup: 'facts' });
  if (current.fenced) return 'fenced';
  return current.securityRevision === null ? 'open' : 'unavailable';
}

async function currentCoverOutcomes(
  result: CrossMediaSeedResult,
  review: ShowcaseReviewPort,
): Promise<CrossMediaMediaOutcome[]> {
  const output: CrossMediaMediaOutcome[] = [];
  for (const outcome of result.mediaOutcomes) {
    if (outcome.status !== 'available') {
      output.push(outcome);
      continue;
    }
    const state = await currentCoverFence(review, outcome);
    if (state === 'open') output.push(outcome);
    else {
      const { mediaId: _mediaId, mediaKey: _mediaKey, credit: _credit, provenance: _provenance, ...source } = outcome;
      output.push({
        ...source,
        status: state === 'fenced' ? 'fenced' : 'unavailable',
        ...(state === 'fenced' ? {} : { code: 'cover-fence-unavailable' as const }),
      });
    }
  }
  return output;
}

function admittedTextRights(record: ShowcaseRecord, assertion: ShowcaseAssertion): boolean {
  const rights = assertion.rights;
  return (
    record.provider === 'bangumi' &&
    assertion.property === 'schema:abstract' &&
    rights?.license === 'CC-BY-SA-3.0' &&
    rights.obligations.includes('cc:Attribution') &&
    rights.obligations.includes('cc:ShareAlike') &&
    !!record.sourceUri &&
    rights.attribution.includes(record.sourceUri) &&
    assertion.citations.includes(record.sourceUri)
  );
}

function publicStatements(read: ReviewedSubjectRead, property: string): readonly unknown[] {
  const subject = read.subject as { statements?: Record<string, unknown[]> } | undefined;
  return subject?.statements?.[property] ?? [];
}

function publicHasValue(read: ReviewedSubjectRead, property: string, expected: unknown): boolean {
  return publicStatements(read, property).some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const value = (entry as { value?: { content?: unknown } }).value;
    return showcaseDigest(value?.content) === showcaseDigest(expected);
  });
}

function sourceTagWeight(statement: BatchStatement): boolean {
  return (
    statement.qualifiers?.some(
      (term) =>
        term.property.id === 'rezics:sourceTagWeightMetric' &&
        term.value.type === 'value' &&
        term.value.content === vndbTagsRatingMetric,
    ) ?? false
  );
}

function sourceTagId(statement: BatchStatement): string | undefined {
  for (const reference of statement.references ?? [])
    for (const part of reference.parts)
      if (
        part.property.id === 'rezics:sourceTagId' &&
        part.value.type === 'value' &&
        typeof part.value.content === 'string'
      )
        return part.value.content;
  return undefined;
}

function tagAssociationKey(association: ShowcaseTagAssociation): string {
  return [
    association.workId,
    association.sourceKey,
    association.tagId,
    association.category,
    association.conceptId ?? '',
    association.schemeId ?? '',
  ].join('\0');
}

function vndbTagMembership(record: ShowcaseRecord, assertion: ShowcaseAssertion): boolean {
  return (
    record.provider === 'vndb' &&
    record.kind === 'work' &&
    assertion.property === 'schema:genre' &&
    !sourceTagWeight(assertion.statement)
  );
}

function tagAssociationFor(
  record: ShowcaseRecord,
  assertion: ShowcaseAssertion,
  associations: readonly ShowcaseTagAssociation[],
): ShowcaseTagAssociation | undefined {
  const identity = tagAssociationPath(record, assertion.source, assertion.statement);
  if (!identity) return;
  return associations.find(
    (association) =>
      association.workId === record.sourceKey &&
      association.sourceKey === identity.sourceKey &&
      association.tagId === identity.tagId,
  );
}

function tagAssociationWithdrawn(
  record: ShowcaseRecord,
  assertion: ShowcaseAssertion,
  withdrawals: readonly ShowcaseTagAssociationWithdrawal[],
): boolean {
  const identity = tagAssociationPath(record, assertion.source, assertion.statement);
  return (
    !!identity &&
    withdrawals.some(
      (item) =>
        item.workId === record.sourceKey && item.sourceKey === identity.sourceKey && item.tagId === identity.tagId,
    )
  );
}

function tagAssociationPath(
  record: ShowcaseRecord,
  source: BatchCommand['source'] | null,
  statement: BatchStatement,
): { sourceKey: string; tagId: string } | undefined {
  if (
    record.provider !== 'vndb' ||
    record.kind !== 'work' ||
    !record.sourceUri ||
    !source ||
    source.source !== record.sourceAlias ||
    source.external_id !== record.sourceKey ||
    source.field_group !== 'facts' ||
    statement.property.id !== 'schema:genre' ||
    sourceTagWeight(statement)
  )
    return;
  for (const reference of statement.references ?? []) {
    for (const part of reference.parts) {
      if (part.property.id !== 'schema:url' || part.value.type !== 'value' || typeof part.value.content !== 'string')
        continue;
      const citation = part.value.content;
      if (!sourceCitationMatchesRecord(record, citation)) continue;
      const match = /^#\/tags_vn\/(v[1-9][0-9]*)\/(g[1-9][0-9]{0,9})\/tag$/u.exec(new URL(citation).hash);
      if (!match || match[1] !== record.sourceKey) continue;
      return { sourceKey: `/tags_vn/${match[1]}/${match[2]}/tag`, tagId: match[2]! };
    }
  }
  return;
}

function tagAssociationStatementMatches(association: ShowcaseTagAssociation, statement: BatchStatement): boolean {
  if (statement.value.type !== 'value' || statement.value.content !== association.conceptId) return false;
  const spoiler = statement.qualifiers?.find((term) => term.property.id === 'rezics:spoilerLevel');
  if (!spoiler || spoiler.value.type !== 'value' || !spoiler.value.content || typeof spoiler.value.content !== 'object')
    return false;
  const quantity = spoiler.value.content as { amount?: unknown; unit?: unknown };
  return quantity.amount === `+${association.spoiler}` && quantity.unit === '1';
}

function managedSourceTagMembership(candidate: CandidateRead, alias: string, record: ShowcaseRecord): boolean {
  return !!tagAssociationPath(record, candidate.source, candidate.statement) && candidate.source?.source === alias;
}

function managedSourceTagWeight(candidate: CandidateRead, alias: string, workId: string): boolean {
  return (
    candidate.source?.source === alias &&
    candidate.source.external_id === workId &&
    candidate.source.field_group === 'facts' &&
    candidate.statement.property.id === 'schema:genre' &&
    sourceTagWeight(candidate.statement) &&
    sourceTagId(candidate.statement) !== undefined
  );
}

function tagParentBindingFor(
  assertion: ShowcaseAssertion,
  evidence: readonly ShowcaseTagParentBinding[],
): ShowcaseTagParentBinding | undefined {
  return assertion.tagParentPath ? evidence.find((binding) => binding.path === assertion.tagParentPath) : undefined;
}

function publicStatementCites(value: unknown, uri: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const references = (value as { references?: unknown }).references;
  if (!Array.isArray(references)) return false;
  return references.some((reference) => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return false;
    const parts = (reference as { parts?: unknown }).parts;
    return (
      Array.isArray(parts) &&
      parts.some((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return false;
        const row = part as { property?: unknown; value?: { content?: unknown } };
        const property =
          typeof row.property === 'string' ? row.property : (row.property as { id?: unknown } | null)?.id;
        return property === 'schema:url' && row.value?.content === uri;
      })
    );
  });
}

function publicHasCitation(read: ReviewedSubjectRead, uri: string): boolean {
  return Object.values((read.subject as { statements?: Record<string, unknown[]> }).statements ?? {}).some((rows) =>
    rows.some((row) => publicStatementCites(row, uri)),
  );
}

function publicVocabularySourceEvidence(read: ReviewedSubjectRead, record: ShowcaseVocabularyRecord): boolean {
  if (record.provenance !== 'reviewed-catalogue')
    return !!record.sourceUri && publicHasValue(read, 'schema:url', record.sourceUri);
  if (!record.sourceUri) return false;
  if (record.nativeType === 'skos:ConceptScheme')
    return !!record.schemeUri && publicHasValue(read, 'schema:sameAs', record.schemeUri);
  return publicHasCitation(read, record.sourceUri);
}

function publicHasSourceIdentity(read: ReviewedSubjectRead, record: ShowcaseRecord): boolean {
  if (
    record.provider === 'bangumi' &&
    record.kind === 'organization' &&
    /^person:[1-9][0-9]*$/u.test(record.sourceKey) &&
    record.sourceUri
  ) {
    return record.assertions.some(
      (assertion) =>
        assertion.property === 'schema:name' &&
        assertion.source.digest === record.semanticDigest &&
        assertion.statement.value.type === 'value' &&
        assertion.citations.includes(record.sourceUri!) &&
        publicStatements(read, 'schema:name').some((entry) => statementOnPublicRead(entry, assertion.statement)),
    );
  }
  const identity = sourceIdentity(record);
  if (!identity || !record.sourceUri) return false;
  return publicStatements(read, identity.property).some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const value = (entry as { value?: { content?: unknown } }).value;
    return value?.content === identity.value && publicStatementCites(entry, record.sourceUri!);
  });
}

function recordHasSourceIdentity(record: ShowcaseRecord): boolean {
  if (
    record.provider === 'bangumi' &&
    record.kind === 'organization' &&
    /^person:[1-9][0-9]*$/u.test(record.sourceKey) &&
    record.sourceUri
  ) {
    return record.assertions.some(
      (assertion) =>
        assertion.property === 'schema:name' &&
        assertion.source.digest === record.semanticDigest &&
        assertion.statement.value.type === 'value' &&
        assertion.citations.includes(record.sourceUri!),
    );
  }
  const identity = sourceIdentity(record);
  if (!record.sourceUri || !identity) return false;
  return record.assertions.some(
    (assertion) =>
      assertion.property === identity.property &&
      assertion.source.digest === record.semanticDigest &&
      assertion.statement.value.type === 'value' &&
      assertion.statement.value.content === identity.value &&
      assertion.citations.includes(record.sourceUri!),
  );
}

function sourceCitationMatchesRecord(record: ShowcaseRecord, citation: string): boolean {
  if (!record.sourceUri) return false;
  if (citation === record.sourceUri) return true;
  try {
    const source = new URL(record.sourceUri);
    const cited = new URL(citation);
    if (
      cited.protocol !== 'https:' ||
      cited.origin !== source.origin ||
      cited.pathname !== source.pathname ||
      cited.search !== source.search
    )
      return false;
    if (record.provider === 'bangumi' && record.kind === 'work') {
      const staffPrefix = `#/subject-persons/${record.sourceKey}/`;
      const voicePrefix = `#/person-characters/${record.sourceKey}/`;
      return (
        (cited.hash.startsWith(staffPrefix) && /^[1-9][0-9]*\/position$/u.test(cited.hash.slice(staffPrefix.length))) ||
        (cited.hash.startsWith(voicePrefix) && /^[1-9][0-9]*\/[1-9][0-9]*$/u.test(cited.hash.slice(voicePrefix.length)))
      );
    }
    if (record.provider === 'bangumi' && record.kind === 'person' && record.sourceKey.startsWith('person:')) {
      const id = record.sourceKey.slice('person:'.length);
      return cited.href === `https://api.bgm.tv/v0/persons/${id}#/career`;
    }
    if (record.provider === 'vndb' && record.kind === 'work') {
      const prefix = `#/tags_vn/${record.sourceKey}/`;
      return cited.hash.startsWith(prefix) && /^g[1-9][0-9]{0,9}\/tag$/u.test(cited.hash.slice(prefix.length));
    }
    return false;
  } catch {
    return false;
  }
}

function safeGapKey(value: Record<string, unknown>): string {
  for (const field of ['id', 'subject_id', 'vid', 'person_id', 'character_id', 'episode_id']) {
    const entry = value[field];
    if ((typeof entry === 'string' || typeof entry === 'number') && /^[A-Za-z0-9:_-]{1,64}$/u.test(String(entry)))
      return String(entry);
  }
  return 'selected-family';
}

async function candidatePage(
  input: { review: ShowcaseReviewPort; id: string; property: string },
  cache: Map<string, CandidatePage>,
): Promise<CandidatePage> {
  const key = groupKey(input.id, input.property);
  const cached = cache.get(key);
  if (cached) return cached;
  const page = safeCandidatePage(
    await input.review.reviewedCandidates(input.id, {
      property: input.property,
      context: GLOBAL_CONTEXT,
      limit: showcaseLimits.reviewPage,
    }),
  );
  if (page.candidates.length > showcaseLimits.reviewPage)
    throw new RangeError('Current candidate page exceeded its bound');
  if (cache.size >= showcaseLimits.reviewPage) cache.delete(cache.keys().next().value!);
  cache.set(key, page);
  return page;
}

async function resolveLegacyCandidates(input: {
  plan: CrossMediaPlan;
  result: CrossMediaSeedResult;
  aliases: Readonly<Record<'bangumi' | 'vndb', string>>;
  review: ShowcaseReviewPort;
  existing: readonly ShowcaseAcknowledgement[];
}): Promise<{
  acknowledgements: ShowcaseAcknowledgement[];
  omissions: { provider: 'bangumi' | 'vndb'; sourceKey: string }[];
}> {
  const acknowledgements = [...input.existing];
  const known = new Set(acknowledgements.flatMap((ack) => (ack.candidateId ? [ack.command.key] : [])));
  const readings = new Map(
    input.result.readings.map((reading) => [`${reading.source}\0${reading.externalId}`, reading]),
  );
  const omissions: { provider: 'bangumi' | 'vndb'; sourceKey: string }[] = [];
  const pageCache = new Map<string, CandidatePage>();
  const rows = [
    ...input.plan.records.bangumi.map((row) => ({ provider: 'bangumi' as const, row })),
    ...input.plan.entities.bangumi.map((row) => ({ provider: 'bangumi' as const, row })),
    ...input.plan.records.vndb.map((row) => ({ provider: 'vndb' as const, row })),
    ...input.plan.entities.vndb.map((row) => ({ provider: 'vndb' as const, row })),
  ];
  let visited = 0;
  rowLoop: for (const { provider, row } of rows) {
    const reading = readings.get(`${provider}\0${row.key}`);
    const id = reading && (reading.boundSubjectId ?? subjectId(reading.subject));
    if (!id) continue;
    const alias = input.aliases[provider];
    const registration = createSelectedFamilySourceRegistration(provider, alias);
    const mediaContext =
      provider === 'bangumi'
        ? showcaseMediaContext({
            plan: input.plan,
            outcomes: input.result.mediaOutcomes,
            alias,
            externalId: row.key,
            containerId: id,
          })
        : undefined;
    const converted = registration.convert(
      { external_id: row.key, record_revision: row.revision ?? 'unversioned', record: row.payload },
      { source: alias, subjectId: id, ...(mediaContext ?? {}) },
    );
    for (const command of converted.proposals) {
      if (command.op !== 'propose' || known.has(command.key)) continue;
      if (visited >= showcaseLimits.candidates) {
        omissions.push({ provider, sourceKey: row.key });
        break rowLoop;
      }
      visited += 1;
      const property = command.statement.property.id;
      const page = await candidatePage({ review: input.review, id, property }, pageCache);
      const exact = page.candidates.filter(
        (candidate) =>
          showcaseSourceMatches(candidate.source, command.source) &&
          showcaseStatementMatches(candidate.statement, command.statement),
      );
      if (exact.length !== 1) {
        omissions.push({ provider, sourceKey: row.key });
        continue;
      }
      const candidate = exact[0]!;
      acknowledgements.push({
        command,
        commandDigest: showcaseDigest(command),
        subjectId: id,
        candidateId: candidate.id,
      });
      known.add(command.key);
      if (page.next !== null && page.next !== undefined) omissions.push({ provider, sourceKey: row.key });
    }
  }
  return { acknowledgements, omissions };
}

export type ShowcasePublicationResult = Readonly<{
  status: 'published' | 'incomplete';
  manifest: ShowcaseManifest;
  published: readonly {
    provider: 'bangumi' | 'vndb';
    sourceKey: string;
    subjectId: string;
    nativeType: string;
    readerRoute: string;
    assertions: readonly {
      candidateId: string;
      property: string;
      digest: string;
      citations?: readonly string[];
      qualifiers?: NonNullable<BatchStatement['qualifiers']>;
      rights?: Extract<BatchCommand, { op: 'propose' }>['rights'];
      target?: { sourceKey: string; subjectId: string; nativeType: string };
      adoption: { head: number; candidateId: string; rank: 'normal' | 'preferred' | 'deprecated' };
      readback: unknown;
    }[];
  }[];
  vndbWorkRelations: readonly VndbWorkRelationOutcome[];
  omissions: readonly { provider: 'bangumi' | 'vndb'; sourceKey: string; code: string }[];
  unresolvedCharacterDependencies: readonly {
    workKey: string | null;
    workSubjectId: string | null;
    characterKey: string;
    characterSubjectId: string | null;
    sourceIndex: number | null;
    conceptUri?: string;
    conceptId?: string;
    code?: string;
    reason: string;
    property?: string;
  }[];
}>;

/** Recover publication targets from original create acknowledgements, independently
 * checking the native ID/type. A fresh source identifier is itself an unadopted
 * candidate, so current source-identity readings cannot be a prerequisite for
 * publishing that identifier. These readings are local publication intent only;
 * retained identity consumers still receive the seed's independently current reads.
 */
async function publicationTargetReadings(input: {
  plan: CrossMediaPlan;
  result: CrossMediaSeedResult;
  aliases: Readonly<Record<'bangumi' | 'vndb', string>>;
  acknowledgements: readonly ShowcaseAcknowledgement[];
  review: ShowcaseReviewPort;
}): Promise<CrossMediaSeedResult['readings']> {
  const readings = [...input.result.readings];
  const present = new Set(readings.map((reading) => `${reading.source}\0${reading.externalId}`));
  const creates = new Map<string, ShowcaseAcknowledgement[]>();
  for (const entry of input.acknowledgements) {
    if (entry.command.op !== 'create') continue;
    const key = `${entry.command.source.source}\0${entry.command.source.external_id}`;
    const entries = creates.get(key) ?? [];
    entries.push(entry);
    creates.set(key, entries);
  }
  const rows = [
    ...input.plan.records.bangumi,
    ...input.plan.entities.bangumi,
    ...input.plan.records.vndb,
    ...input.plan.entities.vndb,
  ];
  if (rows.length > showcaseLimits.records) throw new RangeError('Selected showcase record limit exceeded');
  for (const row of rows) {
    const provider = row.source === 'vndb' ? 'vndb' : 'bangumi';
    const key = `${provider}\0${row.key}`;
    if (present.has(key)) continue;
    const alias = input.aliases[provider];
    const registration = createSelectedFamilySourceRegistration(provider, alias);
    const converted = registration.convert(
      { external_id: row.key, record_revision: row.revision ?? 'unversioned', record: row.payload },
      { source: alias },
    );
    const bootstrap = converted.proposals.find((command) => command.op === 'create');
    if (!bootstrap) continue;
    const initial = createSourceRegistration(provider, {
      source: alias,
      ...(provider === 'bangumi'
        ? { converterRevision: crossMediaBangumiRevision }
        : { converterRevision: entityRevision }),
    }).convert(
      { external_id: row.key, record_revision: row.revision ?? 'unversioned', record: row.payload },
      { source: alias },
    );
    const initialBootstrap = initial.proposals.find((command) => command.op === 'create');
    const bootstraps = [bootstrap, ...(initialBootstrap ? [initialBootstrap] : [])];
    const exact = (creates.get(`${alias}\0${row.key}`) ?? []).filter(
      (entry) =>
        showcaseDigest(entry.command) === entry.commandDigest &&
        bootstraps.some((expected) => showcaseDigest({ ...expected, key: entry.command.key }) === entry.commandDigest),
    );
    if (exact.length !== 1 || !exact[0]!.subjectId) continue;
    const id = exact[0]!.subjectId!;
    let read: ReviewedSubjectRead;
    try {
      read = await input.review.readReviewedSubject(id);
    } catch (error) {
      // Known native read refusal/unavailability withholds publication, never a new identity.
      if (typeof (error as { status?: unknown }).status === 'number') continue;
      throw error;
    }
    if (subjectId(read) !== id || subjectType(read) !== bootstrap.subject.type) continue;
    readings.push({
      source: provider,
      externalId: row.key,
      boundSubjectId: id,
      subject: read,
      route: `/subjects/${id}/subject`,
      selection: 'proposed',
    });
    present.add(key);
  }
  return readings;
}

/** Accept exact acknowledged candidates, adopt only those selections, then check them as a public viewer. */
export async function publishShowcase(input: {
  plan: CrossMediaPlan;
  result: CrossMediaSeedResult;
  aliases: Readonly<Record<'bangumi' | 'vndb', string>>;
  journal: ShowcaseJournal;
  review: ShowcaseReviewPort;
  publicClient: PublicBulkClient;
  vocabularyRequirements?: readonly ShowcaseVocabularyRequirement[];
  tagWeightObservations?: ShowcaseManifest['tagWeightObservations'];
  tagWeightRefreshes?: ShowcaseManifest['tagWeightRefreshes'];
  tagAssociations?: ShowcaseManifest['tagAssociations'];
  tagAssociationWithdrawals?: readonly ShowcaseTagAssociationWithdrawal[];
  tagAssociationRefreshes?: ShowcaseManifest['tagAssociationRefreshes'];
  tagParentEvidence?: readonly ShowcaseTagParentBinding[];
  tagParentGaps?: ShowcaseManifest['tagParentGaps'];
  tagParentAcknowledgements?: readonly ShowcaseAcknowledgement[];
  tagParentRefreshes?: readonly ShowcaseTagParentRefresh[];
}): Promise<ShowcasePublicationResult> {
  const mediaOutcomes = await currentCoverOutcomes(input.result, input.review);
  const readings = await publicationTargetReadings({
    ...input,
    acknowledgements: input.journal.acknowledgedCommands(),
  });
  const result = { ...input.result, readings, mediaOutcomes };
  const recovered = await resolveLegacyCandidates({
    plan: input.plan,
    result,
    aliases: input.aliases,
    review: input.review,
    existing: input.journal.acknowledgedCommands(),
  });
  const genre = input.result.bangumiGenrePublication;
  const gameGenre = input.result.bangumiGameGenrePublication;
  const tagParentCommandKeys = new Set((input.tagParentAcknowledgements ?? []).map((entry) => entry.command.key));
  let parentPublicationOutcomes: ShowcaseTagParentPublication[] = [];
  const acknowledgementByCandidate = new Map<string, ShowcaseAcknowledgement>();
  for (const acknowledgement of [
    ...recovered.acknowledgements,
    ...(genre?.acknowledgements ?? []),
    ...(gameGenre?.acknowledgements ?? []),
    ...(input.tagParentAcknowledgements ?? []),
  ]) {
    const key = acknowledgement.candidateId ?? acknowledgement.command.key;
    acknowledgementByCandidate.set(key, acknowledgement);
  }
  const buildManifest = (
    acknowledgements: readonly ShowcaseAcknowledgement[],
    outcomes: readonly CrossMediaMediaOutcome[] = mediaOutcomes,
  ) =>
    buildShowcaseManifest({
      plan: input.plan,
      readings: result.readings,
      acknowledgements,
      aliases: input.aliases,
      mediaOutcomes: outcomes,
      ...(input.result.workRelations ? { workRelations: input.result.workRelations } : {}),
      ...(input.result.vndbCreditCandidateDigests
        ? { vndbCreditCandidateDigests: input.result.vndbCreditCandidateDigests }
        : {}),
      ...(input.tagWeightObservations ? { tagWeightObservations: input.tagWeightObservations } : {}),
      ...(input.tagWeightRefreshes ? { tagWeightRefreshes: input.tagWeightRefreshes } : {}),
      ...(input.tagAssociations ? { tagAssociations: input.tagAssociations } : {}),
      ...(input.tagAssociationWithdrawals ? { tagAssociationWithdrawals: input.tagAssociationWithdrawals } : {}),
      ...(input.tagAssociationRefreshes ? { tagAssociationRefreshes: input.tagAssociationRefreshes } : {}),
      ...(input.tagParentEvidence ? { tagParentEvidence: input.tagParentEvidence } : {}),
      ...(input.tagParentGaps ? { tagParentGaps: input.tagParentGaps } : {}),
      ...(input.tagParentAcknowledgements
        ? {
            tagParentAcknowledgements: acknowledgements.filter((entry) => tagParentCommandKeys.has(entry.command.key)),
          }
        : {}),
      ...(input.tagParentRefreshes ? { tagParentRefreshes: input.tagParentRefreshes } : {}),
      ...(parentPublicationOutcomes.length ? { tagParentPublicationOutcomes: parentPublicationOutcomes } : {}),
      ...(input.vocabularyRequirements ? { vocabularyRequirements: input.vocabularyRequirements } : {}),
      ...(genre
        ? {
            reviewedVocabulary: genre.vocabulary,
            currentBangumiGenreCandidateIds: genre.candidateIds,
            bangumiGenreOwnerKeys: genre.ownerKeys,
          }
        : {}),
      ...(gameGenre
        ? {
            currentBangumiGameGenreCandidateIds: gameGenre.candidateIds,
            bangumiGameGenreOwnerKeys: gameGenre.ownerKeys,
          }
        : {}),
    });
  let manifestAcknowledgements = [...acknowledgementByCandidate.values()];
  let manifest = buildManifest(manifestAcknowledgements);

  const omissions = [
    ...manifest.omissions.map((item) => ({ ...item, code: item.code })),
    ...recovered.omissions.map((item) => ({ ...item, code: 'legacy-candidate-not-exact' })),
  ].slice(0, showcaseLimits.omissions);
  if (!manifest.records.length && !manifest.vocabulary.length)
    omissions.push({ provider: 'bangumi', sourceKey: 'selected-family', code: 'source-read-missing' });
  if (result.status === 'imported-with-gaps')
    omissions.push({ provider: 'bangumi', sourceKey: 'selected-family', code: 'source-claim-withheld' });
  for (const gap of result.gaps.slice(0, showcaseLimits.omissions))
    omissions.push({ provider: gap.source, sourceKey: safeGapKey(gap.record), code: 'source-claim-withheld' });
  for (const unresolved of result.unresolved.slice(0, showcaseLimits.omissions))
    omissions.push({ provider: 'bangumi', sourceKey: unresolved.holder, code: 'source-claim-withheld' });
  if (result.creditGaps.length || result.characterDiagnostics.length)
    omissions.push({ provider: 'bangumi', sourceKey: 'selected-family', code: 'source-claim-withheld' });
  if (gameGenre?.diagnostics.length)
    for (const item of gameGenre.diagnostics.slice(0, showcaseLimits.omissions - omissions.length))
      omissions.push({ provider: 'bangumi', sourceKey: item.sourceKey, code: 'source-claim-withheld' });
  const assertionsFor = (selectedManifest: ShowcaseManifest) =>
    [
      ...selectedManifest.records.flatMap((record) => record.assertions.map((assertion) => ({ record, assertion }))),
      ...selectedManifest.vocabulary.flatMap((record) =>
        record.assertions.map((assertion) => ({
          record: {
            provider: record.provider,
            sourceAlias: record.sourceAlias,
            sourceKey: record.sourceKey,
            sourceUri: record.sourceUri,
            sourceRevision: 'unversioned',
            rawDigest: record.assertions[0]?.source.digest ?? '',
            semanticDigest: record.assertions[0]?.source.digest ?? '',
            converterRevision: record.assertions[0]?.source.converter_revision ?? '',
            kind: 'source-vocabulary' as const,
            subjectId: record.subjectId,
            nativeType: record.nativeType,
            readerRoute: null,
            assertions: record.assertions,
          },
          assertion,
        })),
      ),
    ].sort(
      (left, right) =>
        phase(left.record, left.assertion) - phase(right.record, right.assertion) ||
        left.assertion.candidateId.localeCompare(right.assertion.candidateId),
    );
  let assertions = assertionsFor(manifest);
  const currentSubjectCache = new Map<string, ReviewedSubjectRead | null>();
  const pageCache = new Map<string, CandidatePage>();
  const validated = new Map<string, CandidateRead>();
  const currentTagMembershipCandidateDigests = new Set<string>();
  const blockedSubjects = new Set<string>();
  const blockedCoverCandidates = new Set<string>();
  let vocabularyById = new Map(manifest.vocabulary.map((record) => [record.subjectId, record]));
  const observedTagBindings = new Map<string, VndbTagRatingBinding>();
  for (const observation of manifest.tagWeightObservations)
    if (observation.responseDigest)
      for (const binding of observation.bindings)
        observedTagBindings.set(`${observation.workId}\0${binding.tagId}\0${binding.conceptId}`, binding);
  const currentTagBindings = new Set<string>();
  const currentMembershipBindings = new Set<string>();
  const bindingReadIds = new Set<string>();
  for (const binding of observedTagBindings.values()) {
    bindingReadIds.add(binding.conceptId);
    bindingReadIds.add(binding.schemeId);
  }
  for (const association of manifest.tagAssociations ?? []) {
    if (!association.conceptId || !association.schemeId) continue;
    bindingReadIds.add(association.conceptId);
    bindingReadIds.add(association.schemeId);
  }
  const readCurrentSubject = async (id: string): Promise<ReviewedSubjectRead | null> => {
    if (currentSubjectCache.has(id)) return currentSubjectCache.get(id) ?? null;
    let read: ReviewedSubjectRead | null = null;
    try {
      read = await input.review.readReviewedSubject(id);
    } catch {
      read = null;
    }
    currentSubjectCache.set(id, read);
    return read;
  };
  const bindingReadIdsList = [...bindingReadIds];
  for (let offset = 0; offset < bindingReadIdsList.length; offset += 16)
    await Promise.all(bindingReadIdsList.slice(offset, offset + 16).map(readCurrentSubject));
  const currentBindingMatches = (
    binding: Pick<VndbTagRatingBinding, 'category' | 'tagId' | 'conceptUri' | 'schemeUri'> & {
      conceptId: string | null;
      schemeId: string | null;
    },
  ) => {
    if (!binding.conceptId || !binding.schemeId) return false;
    const conceptRead = currentSubjectCache.get(binding.conceptId) ?? null;
    const schemeRead = currentSubjectCache.get(binding.schemeId) ?? null;
    return !!(
      conceptRead &&
      schemeRead &&
      subjectId(conceptRead) === binding.conceptId &&
      subjectType(conceptRead) === 'skos:Concept' &&
      binding.conceptUri === vndbPublicTagConceptUri(binding.category, binding.tagId) &&
      publicHasValue(conceptRead, 'schema:url', binding.conceptUri) &&
      publicHasValue(conceptRead, 'skos:inScheme', binding.schemeId) &&
      subjectId(schemeRead) === binding.schemeId &&
      subjectType(schemeRead) === 'skos:ConceptScheme' &&
      binding.schemeUri === vndbPublicTagScheme(binding.category) &&
      publicHasValue(schemeRead, 'schema:url', binding.schemeUri)
    );
  };
  for (const [key, binding] of observedTagBindings) {
    if (currentBindingMatches(binding)) currentTagBindings.add(key);
  }
  for (const association of manifest.tagAssociations ?? []) {
    if (
      association.conceptId &&
      association.schemeId &&
      association.releaseDigest === bundledDigest &&
      currentBindingMatches(association)
    )
      currentMembershipBindings.add(tagAssociationKey(association));
  }
  for (const record of manifest.records) {
    if (!record.subjectId || recordHasSourceIdentity(record)) continue;
    blockedSubjects.add(record.subjectId);
    omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'source-uri-not-current' });
  }
  for (const record of manifest.vocabulary) {
    const sourceUri = record.sourceUri;
    const sourceParentEndpoint =
      record.provenance === 'source-parent-binding' &&
      record.sourceAlias === input.aliases.vndb &&
      (record.nativeType === 'skos:ConceptScheme'
        ? (manifest.tagParentEvidence ?? []).some(
            (binding) => binding.schemeId === record.subjectId && binding.schemeUri === sourceUri,
          ) ||
          (manifest.tagParentRefreshes ?? []).some(
            (refresh) => refresh.schemeId === record.subjectId && refresh.schemeUri === sourceUri,
          )
        : (manifest.tagParentEvidence ?? []).some(
            (binding) =>
              binding.schemeId === record.schemeId &&
              binding.schemeUri === record.schemeUri &&
              ((binding.childId === record.subjectId && binding.childUri === sourceUri) ||
                (binding.parentId === record.subjectId && binding.parentUri === sourceUri)),
          ) ||
          (manifest.tagParentRefreshes ?? []).some(
            (refresh) =>
              refresh.schemeId === record.schemeId &&
              refresh.schemeUri === record.schemeUri &&
              refresh.childId === record.subjectId &&
              refresh.childUri === sourceUri,
          ));
    const sourceAssertion = record.assertions.find(
      (assertion) =>
        assertion.property === 'schema:url' &&
        assertion.statement.value.type === 'value' &&
        assertion.statement.value.content === sourceUri &&
        !!sourceUri &&
        assertion.citations.includes(sourceUri),
    );
    const reviewedSourceAssertion =
      record.provenance === 'reviewed-catalogue' &&
      (record.nativeType === 'skos:ConceptScheme'
        ? record.assertions.some(
            (assertion) =>
              assertion.property === 'schema:sameAs' &&
              assertion.statement.value.type === 'value' &&
              assertion.statement.value.content === record.schemeUri,
          )
        : record.assertions.some((assertion) => assertion.citations.includes(record.sourceUri!)));
    if (
      (!sourceAssertion && !reviewedSourceAssertion && !sourceParentEndpoint) ||
      (record.nativeType === 'skos:Concept' &&
        (!record.schemeId ||
          !vocabularyById.has(record.schemeId) ||
          record.schemeId === record.subjectId ||
          (!sourceParentEndpoint &&
            !record.assertions.some(
              (assertion) =>
                assertion.property === 'skos:inScheme' &&
                assertion.statement.value.type === 'value' &&
                assertion.statement.value.content === record.schemeId,
            ))))
    ) {
      blockedSubjects.add(record.subjectId);
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'vocabulary-binding-missing' });
    }
  }

  for (const { record, assertion } of assertions) {
    const id = record.subjectId;
    if (!id || !recordSource(record, assertion)) continue;
    let currentMembership = false;
    let current = currentSubjectCache.get(id);
    if (current === undefined) {
      try {
        current = await input.review.readReviewedSubject(id);
      } catch {
        current = null;
      }
      currentSubjectCache.set(id, current);
    }
    if (!current || !currentSourceRead(current, record)) {
      omissions.push({
        provider: record.provider,
        sourceKey: record.sourceKey,
        code: 'current-source-identity-mismatch',
      });
      continue;
    }
    if (blockedSubjects.has(id)) continue;
    if (sourceTagWeight(assertion.statement)) {
      const tagId = sourceTagId(assertion.statement);
      const content = assertion.statement.value.type === 'value' ? assertion.statement.value.content : null;
      if (
        !tagId ||
        typeof content !== 'string' ||
        !currentTagBindings.has(`${record.sourceKey}\0${tagId}\0${content}`)
      ) {
        omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'vocabulary-binding-missing' });
        continue;
      }
    }
    if (vndbTagMembership(record, assertion)) {
      const association = tagAssociationFor(record, assertion, manifest.tagAssociations ?? []);
      const content = assertion.statement.value.type === 'value' ? assertion.statement.value.content : null;
      if (
        !association ||
        !association.conceptId ||
        !association.schemeId ||
        association.releaseDigest !== bundledDigest ||
        content !== association.conceptId ||
        !tagAssociationStatementMatches(association, assertion.statement) ||
        !currentMembershipBindings.has(tagAssociationKey(association))
      ) {
        omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'vocabulary-binding-missing' });
        continue;
      }
      currentMembership = true;
    }
    if (assertion.graphTarget) {
      if (assertion.graphTarget.factsFence) {
        const state = await showcaseFranchiseFence(input.review, record.sourceAlias, [
          record.sourceKey,
          assertion.graphTarget.sourceKey,
        ]);
        if (state !== 'open') {
          omissions.push({
            provider: record.provider,
            sourceKey: record.sourceKey,
            code: state === 'fenced' ? 'graph-source-facts-fenced' : 'graph-source-facts-unavailable',
          });
          continue;
        }
      }
      const target = manifest.records.find(
        (candidate) =>
          candidate.provider === assertion.graphTarget!.provider &&
          candidate.sourceKey === assertion.graphTarget!.sourceKey,
      );
      const targetId = assertion.graphTarget.subjectId;
      let targetCurrent = currentSubjectCache.get(targetId);
      if (targetCurrent === undefined) {
        try {
          targetCurrent = await input.review.readReviewedSubject(targetId);
        } catch {
          targetCurrent = null;
        }
        currentSubjectCache.set(targetId, targetCurrent);
      }
      if (
        !target ||
        target.subjectId !== targetId ||
        target.nativeType !== assertion.graphTarget.nativeType ||
        !recordHasSourceIdentity(target) ||
        blockedSubjects.has(targetId) ||
        !targetCurrent ||
        !currentSourceRead(targetCurrent, target)
      ) {
        omissions.push({
          provider: record.provider,
          sourceKey: record.sourceKey,
          code: 'graph-endpoint-current-read-unavailable',
        });
        continue;
      }
    }
    if (assertion.property === 'schema:image') {
      const outcome = admittedCoverMedia(input.plan, mediaOutcomes, record, assertion);
      if (!outcome) {
        omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'cover-source-unavailable' });
        blockedCoverCandidates.add(assertion.candidateId);
        continue;
      }
      const state = await currentCoverFence(input.review, outcome);
      if (state !== 'open') {
        omissions.push({
          provider: record.provider,
          sourceKey: record.sourceKey,
          code: state === 'fenced' ? 'cover-fenced' : 'cover-fence-unavailable',
        });
        blockedCoverCandidates.add(assertion.candidateId);
        continue;
      }
    } else if (proseOrImage(assertion.property) && !admittedTextRights(record, assertion)) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'content-rights-not-admitted' });
      continue;
    }
    if (
      !assertion.citations.length ||
      assertion.citations.some((uri) => {
        try {
          const parsed = new URL(uri);
          if (parsed.protocol !== 'https:') return true;
          const host = parsed.hostname.toLowerCase();
          const exactVocabularySource =
            record.kind === 'source-vocabulary' &&
            input.vocabularyRequirements?.some(
              (requirement) =>
                requirement.provider === record.provider &&
                requirement.sourceKey === record.sourceKey &&
                requirement.sourceUri === uri,
            );
          return exactVocabularySource
            ? false
            : record.provider === 'bangumi'
              ? host !== 'bgm.tv' &&
                host !== 'bangumi.tv' &&
                host !== 'www.bgm.tv' &&
                host !== 'www.bangumi.tv' &&
                !(
                  record.kind === 'person' &&
                  assertion.property === 'wdt:P106' &&
                  sourceCitationMatchesRecord(record, uri)
                ) &&
                !(assertion.property === 'schema:image' && host === 'lain.bgm.tv') &&
                !sourceVocabularyCitation(record, uri)
              : host !== 'vndb.org' && !host.endsWith('.vndb.org');
        } catch {
          return true;
        }
      })
    ) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'source-uri-not-current' });
      continue;
    }
    if (
      record.kind !== 'source-vocabulary' &&
      assertion.source.digest === record.semanticDigest &&
      record.sourceUri &&
      !assertion.citations.some((citation) => sourceCitationMatchesRecord(record, citation))
    ) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'source-uri-not-current' });
      continue;
    }
    let page: CandidatePage;
    try {
      page = await candidatePage({ review: input.review, id, property: assertion.property }, pageCache);
    } catch {
      omissions.push({
        provider: record.provider,
        sourceKey: record.sourceKey,
        code: 'candidate-current-read-unavailable',
      });
      continue;
    }
    const candidate = page.candidates.find((entry) => entry.id === assertion.candidateId);
    if (
      !candidate ||
      !showcaseSourceMatches(candidate.source, assertion.source) ||
      !showcaseStatementMatches(candidate.statement, assertion.statement) ||
      showcaseDigest({ source: candidate.source, statement: assertion.statement }) !== assertion.candidateDigest
    ) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'candidate-digest-changed' });
      continue;
    }
    if (page.next !== null && page.next !== undefined && !candidate) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'candidate-page-bounded' });
      continue;
    }
    validated.set(assertion.candidateId, candidate);
    if (currentMembership) currentTagMembershipCandidateDigests.add(assertion.candidateDigest);
  }

  manifestAcknowledgements = manifestAcknowledgements.filter(
    (acknowledgement) => !acknowledgement.candidateId || validated.has(acknowledgement.candidateId),
  );
  manifest = buildManifest(manifestAcknowledgements);
  input.journal.sealIntent(manifest);
  const initialIntentDigest = manifest.digest;
  for (const omission of manifest.omissions) omissions.push({ ...omission, code: omission.code });
  assertions = assertionsFor(manifest);
  vocabularyById = new Map(manifest.vocabulary.map((record) => [record.subjectId, record]));
  for (const record of manifest.records)
    if (!record.subjectId || !recordHasSourceIdentity(record))
      if (record.subjectId) blockedSubjects.add(record.subjectId);

  const blockedTagSubjects = new Set<string>();
  const tagFenceWorkIds = [
    ...new Set([
      ...manifest.tagWeightRefreshes,
      ...(manifest.tagAssociationRefreshes ?? []),
      ...(manifest.tagAssociationWithdrawals ?? []).map((item) => item.workId),
    ]),
  ];
  for (const workId of tagFenceWorkIds) {
    const record = manifest.records.find((item) => item.provider === 'vndb' && item.sourceKey === workId);
    if (!record?.subjectId) continue;
    const state = await currentFactsFence(input.review, input.aliases.vndb, workId);
    const code =
      state === 'open' ? undefined : state === 'fenced' ? 'tag-weight-fenced' : 'tag-weight-fence-unavailable';
    if (code) {
      blockedTagSubjects.add(record.subjectId);
      omissions.push({ provider: 'vndb', sourceKey: workId, code });
    }
  }
  const stoppedSubjects = new Set<string>();
  for (const { record, assertion } of assertions) {
    const id = record.subjectId;
    if (
      !id ||
      !validated.has(assertion.candidateId) ||
      assertion.tagParentPath !== undefined ||
      vndbTagMembership(record, assertion) ||
      (assertion.property === 'schema:genre' && blockedTagSubjects.has(id)) ||
      stoppedSubjects.has(id) ||
      blockedCoverCandidates.has(assertion.candidateId)
    )
      continue;
    if (assertion.property === 'schema:image') {
      const outcome = admittedCoverMedia(input.plan, mediaOutcomes, record, assertion);
      const state = outcome ? await currentCoverFence(input.review, outcome) : 'unavailable';
      if (state !== 'open') {
        blockedCoverCandidates.add(assertion.candidateId);
        omissions.push({
          provider: record.provider,
          sourceKey: record.sourceKey,
          code: state === 'fenced' ? 'cover-fenced' : 'cover-fence-unavailable',
        });
        continue;
      }
    }
    if (
      record.provider === 'vndb' &&
      assertion.property === 'schema:genre' &&
      manifest.tagWeightRefreshes.includes(record.sourceKey)
    ) {
      const state = await currentFactsFence(input.review, input.aliases.vndb, record.sourceKey);
      if (state !== 'open') {
        blockedTagSubjects.add(id);
        omissions.push({
          provider: 'vndb',
          sourceKey: record.sourceKey,
          code: state === 'fenced' ? 'tag-weight-fenced' : 'tag-weight-fence-unavailable',
        });
        continue;
      }
    }
    const candidate = validated.get(assertion.candidateId)!;
    if (candidate.decision === 'accept') continue;
    if (candidate.decision === 'reject') {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'candidate-currently-rejected' });
      stoppedSubjects.add(id);
      continue;
    }
    const body = { context: GLOBAL_CONTEXT, expected_head: candidate.head ?? null };
    const key = actionKey('accept', assertion.candidateId, assertion.candidateDigest);
    const idempotencyKey = actionIdempotencyKey(key, body);
    const prior = input.journal.action(key);
    if (prior?.state === 'acknowledged') continue;
    if (prior?.state === 'refused' && permanentReviewRefusal(prior.error_code)) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: prior.error_code! });
      if (assertion.property !== 'schema:image') stoppedSubjects.add(id);
      continue;
    }
    const sealedBody = input.journal.prepareAction(key, body, idempotencyKey) as typeof body;
    const sealedKey = input.journal.action(key)!.idempotency_key;
    try {
      await input.review.acceptReviewedCandidate(id, assertion.candidateId, sealedBody, sealedKey);
      input.journal.acknowledgeAction(key);
      pageCache.delete(groupKey(id, assertion.property));
    } catch (error) {
      input.journal.refuseAction(key, errorCode(error));
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: errorCode(error) });
      if (assertion.property !== 'schema:image') stoppedSubjects.add(id);
    }
  }

  const grouped = new Map<string, { record: ShowcaseRecord; property: string; ids: Set<string> }>();
  for (const { record, assertion } of assertions) {
    const id = record.subjectId;
    if (
      !id ||
      !validated.has(assertion.candidateId) ||
      (assertion.property === 'schema:genre' && blockedTagSubjects.has(id)) ||
      stoppedSubjects.has(id) ||
      blockedCoverCandidates.has(assertion.candidateId)
    )
      continue;
    const key = groupKey(id, assertion.property);
    const group = grouped.get(key) ?? { record, property: assertion.property, ids: new Set<string>() };
    group.ids.add(assertion.candidateId);
    grouped.set(key, group);
  }
  for (const workId of manifest.tagWeightRefreshes) {
    const record = manifest.records.find(
      (item) => item.provider === 'vndb' && item.sourceAlias === input.aliases.vndb && item.sourceKey === workId,
    );
    if (!record?.subjectId) continue;
    const key = groupKey(record.subjectId, 'schema:genre');
    if (!grouped.has(key)) grouped.set(key, { record, property: 'schema:genre', ids: new Set<string>() });
  }
  for (const workId of manifest.tagAssociationRefreshes ?? []) {
    const record = manifest.records.find(
      (item) => item.provider === 'vndb' && item.sourceAlias === input.aliases.vndb && item.sourceKey === workId,
    );
    if (!record?.subjectId) continue;
    const key = groupKey(record.subjectId, 'schema:genre');
    if (!grouped.has(key)) grouped.set(key, { record, property: 'schema:genre', ids: new Set<string>() });
  }

  const publicSubjects = new Map<string, ReviewedSubjectRead | null>();
  const publicRead = async (id: string): Promise<ReviewedSubjectRead | null> => {
    if (publicSubjects.has(id)) return publicSubjects.get(id) ?? null;
    try {
      const read = await input.publicClient.readSubject(id);
      publicSubjects.set(id, read);
      return read;
    } catch {
      publicSubjects.set(id, null);
      return null;
    }
  };

  const parentEvidence = manifest.tagParentEvidence ?? [];
  const adoptionSnapshots = new Map<string, AdoptionSnapshot | null>();
  const parentOutcomeByPath = new Map(
    (manifest.tagParentPublications ?? []).map((publication) => [publication.path, publication]),
  );
  const parentCandidateIds = new Set<string>();
  const blockedMembershipCandidateIds = new Set<string>();
  const parentGroups = new Map<
    string,
    {
      record: ShowcaseRecord;
      refresh: boolean;
      edges: { binding: ShowcaseTagParentBinding; assertion: ShowcaseAssertion }[];
    }
  >();
  const tagParentRefreshIds = new Set((manifest.tagParentRefreshes ?? []).map((refresh) => refresh.childId));
  const vocabularyAsRecord = (record: ShowcaseVocabularyRecord): ShowcaseRecord => ({
    provider: record.provider,
    sourceAlias: record.sourceAlias,
    sourceKey: record.sourceKey,
    sourceUri: record.sourceUri,
    sourceRevision: 'unversioned',
    rawDigest: '',
    semanticDigest: '',
    converterRevision: 'vndb-public-tag-vocabulary@1',
    kind: 'source-vocabulary',
    subjectId: record.subjectId,
    nativeType: record.nativeType,
    readerRoute: null,
    assertions: record.assertions,
  });
  const parentGroupFor = (childId: string, record?: ShowcaseRecord) => {
    const prior = parentGroups.get(childId);
    if (prior) {
      prior.refresh ||= tagParentRefreshIds.has(childId);
      return prior;
    }
    const vocabulary = vocabularyById.get(childId);
    const selectedRecord = record ?? (vocabulary ? vocabularyAsRecord(vocabulary) : undefined);
    if (!selectedRecord) return undefined;
    const group: {
      record: ShowcaseRecord;
      refresh: boolean;
      edges: { binding: ShowcaseTagParentBinding; assertion: ShowcaseAssertion }[];
    } = { record: selectedRecord, refresh: tagParentRefreshIds.has(childId), edges: [] };
    parentGroups.set(childId, group);
    return group;
  };
  for (const refresh of manifest.tagParentRefreshes ?? []) parentGroupFor(refresh.childId);
  const parentAssertions = assertions.filter(({ assertion }) => assertion.tagParentPath !== undefined);
  for (const { record, assertion } of parentAssertions) {
    parentCandidateIds.add(assertion.candidateId);
    const binding = tagParentBindingFor(assertion, parentEvidence);
    if (!binding) continue;
    parentGroupFor(binding.childId, record)?.edges.push({ binding, assertion });
  }
  const parentBindingCurrent = async (binding: ShowcaseTagParentBinding): Promise<boolean> => {
    const child = vocabularyById.get(binding.childId);
    const parent = vocabularyById.get(binding.parentId);
    const scheme = vocabularyById.get(binding.schemeId);
    if (
      !child ||
      !parent ||
      !scheme ||
      child.nativeType !== 'skos:Concept' ||
      parent.nativeType !== 'skos:Concept' ||
      scheme.nativeType !== 'skos:ConceptScheme' ||
      child.schemeId !== binding.schemeId ||
      parent.schemeId !== binding.schemeId ||
      child.sourceUri !== binding.childUri ||
      parent.sourceUri !== binding.parentUri ||
      scheme.sourceUri !== binding.schemeUri
    )
      return false;
    const [childRead, parentRead, schemeRead] = await Promise.all([
      publicRead(binding.childId),
      publicRead(binding.parentId),
      publicRead(binding.schemeId),
    ]);
    return !!(
      childRead &&
      parentRead &&
      schemeRead &&
      subjectId(childRead) === binding.childId &&
      subjectType(childRead) === 'skos:Concept' &&
      subjectId(parentRead) === binding.parentId &&
      subjectType(parentRead) === 'skos:Concept' &&
      subjectId(schemeRead) === binding.schemeId &&
      subjectType(schemeRead) === 'skos:ConceptScheme' &&
      publicHasValue(childRead, 'schema:url', binding.childUri) &&
      publicHasValue(childRead, 'skos:inScheme', binding.schemeId) &&
      publicHasValue(parentRead, 'schema:url', binding.parentUri) &&
      publicHasValue(parentRead, 'skos:inScheme', binding.schemeId) &&
      publicHasValue(schemeRead, 'schema:url', binding.schemeUri)
    );
  };
  const parentStatementCurrent = async (
    binding: ShowcaseTagParentBinding,
    assertion: ShowcaseAssertion,
  ): Promise<boolean> => {
    if (!(await parentBindingCurrent(binding))) return false;
    const child = await publicRead(binding.childId);
    return (
      !!child && publicStatements(child, 'skos:broader').some((row) => statementOnPublicRead(row, assertion.statement))
    );
  };
  const parentRefreshCurrent = async (refresh: ShowcaseTagParentRefresh): Promise<boolean> => {
    const child = vocabularyById.get(refresh.childId);
    const scheme = vocabularyById.get(refresh.schemeId);
    if (
      !child ||
      !scheme ||
      child.nativeType !== 'skos:Concept' ||
      scheme.nativeType !== 'skos:ConceptScheme' ||
      child.schemeId !== refresh.schemeId ||
      child.sourceUri !== refresh.childUri ||
      scheme.sourceUri !== refresh.schemeUri
    )
      return false;
    const [childRead, schemeRead] = await Promise.all([publicRead(refresh.childId), publicRead(refresh.schemeId)]);
    return !!(
      childRead &&
      schemeRead &&
      subjectId(childRead) === refresh.childId &&
      subjectType(childRead) === 'skos:Concept' &&
      subjectId(schemeRead) === refresh.schemeId &&
      subjectType(schemeRead) === 'skos:ConceptScheme' &&
      publicHasValue(childRead, 'schema:url', refresh.childUri) &&
      publicHasValue(childRead, 'skos:inScheme', refresh.schemeId) &&
      publicHasValue(schemeRead, 'schema:url', refresh.schemeUri)
    );
  };
  const setParentOutcome = (
    binding: ShowcaseTagParentBinding,
    status: ShowcaseTagParentPublication['status'],
    candidateId?: string,
    reason?: string,
  ) => {
    const prior = parentOutcomeByPath.get(binding.path);
    parentOutcomeByPath.set(binding.path, {
      path: binding.path,
      childId: binding.childId,
      parentId: binding.parentId,
      schemeId: binding.schemeId,
      status,
      ...((candidateId ?? prior?.candidateId) ? { candidateId: candidateId ?? prior!.candidateId } : {}),
      ...(reason ? { reason } : {}),
      ...(prior?.rights ? { rights: prior.rights } : {}),
    });
  };
  const parentAccepted = new Set<string>();
  for (const binding of parentEvidence) {
    const edge = parentAssertions.find(({ assertion }) => assertion.tagParentPath === binding.path);
    const candidate = edge ? validated.get(edge.assertion.candidateId) : undefined;
    if (!edge || !candidate) {
      setParentOutcome(binding, 'withheld', undefined, 'exact parent candidate is unavailable');
      continue;
    }
    const fence = input.review.fence ? await showcaseTagParentSourceFence(input.review.fence, binding) : 'unavailable';
    if (fence !== 'open') {
      setParentOutcome(binding, 'withheld', edge.assertion.candidateId, `source-${fence}`);
      omissions.push({ provider: 'vndb', sourceKey: binding.path, code: 'source-claim-withheld' });
      continue;
    }
    if (!(await parentBindingCurrent(binding))) {
      setParentOutcome(
        binding,
        'withheld',
        edge.assertion.candidateId,
        'current child, parent or Scheme binding is unavailable',
      );
      omissions.push({ provider: 'vndb', sourceKey: binding.path, code: 'vocabulary-binding-not-current' });
      continue;
    }
    if (candidate.decision === 'reject') {
      setParentOutcome(binding, 'withheld', edge.assertion.candidateId, 'parent candidate is rejected');
      omissions.push({ provider: 'vndb', sourceKey: binding.path, code: 'candidate-currently-rejected' });
      continue;
    }
    if (candidate.decision !== 'accept') {
      const body = { context: GLOBAL_CONTEXT, expected_head: candidate.head ?? null };
      const key = actionKey('accept', edge.assertion.candidateId, edge.assertion.candidateDigest);
      const idempotencyKey = actionIdempotencyKey(key, body);
      const prior = input.journal.action(key);
      if (prior?.state === 'refused' && permanentReviewRefusal(prior.error_code)) {
        omissions.push({ provider: 'vndb', sourceKey: binding.path, code: prior.error_code! });
        setParentOutcome(binding, 'withheld', edge.assertion.candidateId, prior.error_code!);
        continue;
      }
      if (prior?.state !== 'acknowledged') {
        const sealedBody = input.journal.prepareAction(key, body, idempotencyKey) as typeof body;
        const sealedKey = input.journal.action(key)!.idempotency_key;
        try {
          await input.review.acceptReviewedCandidate(
            binding.childId,
            edge.assertion.candidateId,
            sealedBody,
            sealedKey,
          );
          input.journal.acknowledgeAction(key);
          pageCache.delete(groupKey(binding.childId, 'skos:broader'));
        } catch (error) {
          input.journal.refuseAction(key, errorCode(error));
          omissions.push({ provider: 'vndb', sourceKey: binding.path, code: errorCode(error) });
          setParentOutcome(binding, 'withheld', edge.assertion.candidateId, errorCode(error));
          continue;
        }
      }
    }
    parentAccepted.add(edge.assertion.candidateId);
  }
  const withheldParentTags = new Set<string>();
  const parentRefreshByChild = new Map(
    (manifest.tagParentRefreshes ?? []).map((refresh) => [refresh.childId, refresh]),
  );
  for (const [childId, group] of parentGroups) {
    const refresh = parentRefreshByChild.get(childId);
    if (group.refresh && refresh && !(await parentRefreshCurrent(refresh))) {
      for (const { binding, assertion } of group.edges)
        setParentOutcome(binding, 'withheld', assertion.candidateId, 'current parent refresh binding is unavailable');
      withheldParentTags.add(refresh.tagId);
      omissions.push({ provider: 'vndb', sourceKey: refresh.tagId, code: 'vocabulary-binding-not-current' });
      continue;
    }
    const edges = group.edges.filter(({ assertion }) => parentAccepted.has(assertion.candidateId));
    let page: CandidatePage;
    try {
      page = await candidatePage({ review: input.review, id: childId, property: 'skos:broader' }, pageCache);
    } catch {
      for (const { binding, assertion } of group.edges)
        setParentOutcome(binding, 'withheld', assertion.candidateId, 'current parent adoption read is unavailable');
      if (refresh) withheldParentTags.add(refresh.tagId);
      continue;
    }
    if ((page.next !== null && page.next !== undefined) || (page.adoption && !Array.isArray(page.adoption.selection))) {
      for (const { binding, assertion } of group.edges)
        setParentOutcome(binding, 'withheld', assertion.candidateId, 'current parent selection is incomplete');
      if (refresh) withheldParentTags.add(refresh.tagId);
      continue;
    }
    const currentEdges: typeof edges = [];
    for (const edge of edges) {
      const fence = input.review.fence
        ? await showcaseTagParentSourceFence(input.review.fence, edge.binding)
        : 'unavailable';
      const candidate = page.candidates.find((item) => item.id === edge.assertion.candidateId);
      if (
        fence !== 'open' ||
        !(await parentBindingCurrent(edge.binding)) ||
        !candidate ||
        candidate.decision !== 'accept' ||
        !showcaseSourceMatches(candidate.source, edge.assertion.source) ||
        !showcaseStatementMatches(candidate.statement, edge.assertion.statement)
      ) {
        setParentOutcome(
          edge.binding,
          'withheld',
          edge.assertion.candidateId,
          `parent-${fence === 'open' ? 'candidate-not-current' : fence}`,
        );
        continue;
      }
      currentEdges.push(edge);
    }
    const previous = page.adoption;
    const currentAdoption = adoptionSnapshot(previous);
    const adoptionKey = groupKey(childId, 'skos:broader');
    adoptionSnapshots.set(adoptionKey, currentAdoption);
    const priorSelection = Array.isArray(previous?.selection) ? previous.selection : [];
    const selections = new Map<string, 'normal' | 'preferred'>();
    let parentRetirementUnavailable = false;
    for (const item of priorSelection) {
      if (!item?.candidate) continue;
      const selectedCandidate = page.candidates.find((candidate) => candidate.id === item.candidate);
      if (group.refresh && selectedCandidate && managedSourceTagParent(selectedCandidate, input.aliases.vndb)) {
        const state = await currentFactsFence(input.review, input.aliases.vndb, selectedCandidate.source!.external_id);
        if (state !== 'open') {
          parentRetirementUnavailable = true;
          continue;
        }
        continue;
      }
      selections.set(item.candidate, item.rank === 'preferred' ? 'preferred' : 'normal');
    }
    if (parentRetirementUnavailable) {
      for (const { binding, assertion } of group.edges)
        setParentOutcome(binding, 'withheld', assertion.candidateId, 'prior source parent tuple cannot be reconciled');
      withheldParentTags.add(refresh?.tagId ?? group.edges[0]?.binding.child ?? '');
      continue;
    }
    for (const { binding, assertion } of currentEdges) selections.set(assertion.candidateId, 'normal');
    if (selections.size > showcaseLimits.reviewPage) {
      for (const { binding, assertion } of group.edges)
        setParentOutcome(binding, 'withheld', assertion.candidateId, 'parent selection exceeds the review page');
      withheldParentTags.add(refresh?.tagId ?? group.edges[0]?.binding.child ?? '');
      continue;
    }
    if (!group.refresh && !currentEdges.length) continue;
    const body = {
      context: GLOBAL_CONTEXT,
      property: 'skos:broader',
      mode: 'replace' as const,
      expected_head: previous?.head ?? null,
      selection: [...selections]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([candidate, rank]) => ({ candidate, rank })),
    };
    const action = actionKey('adopt', `${childId}:skos:broader`, showcaseDigest({ intent: manifest.digest, body }));
    const idempotencyKey = actionIdempotencyKey(action, body);
    const priorAction = input.journal.action(action);
    if (priorAction?.state === 'refused' && permanentReviewRefusal(priorAction.error_code)) {
      omissions.push({ provider: 'vndb', sourceKey: group.record.sourceKey, code: priorAction.error_code! });
      for (const { binding, assertion } of group.edges)
        setParentOutcome(binding, 'withheld', assertion.candidateId, priorAction.error_code!);
      withheldParentTags.add(refresh?.tagId ?? group.edges[0]?.binding.child ?? '');
      continue;
    }
    if (!currentAdoption || !sameAdoptionSelection(currentAdoption.selection, body.selection)) {
      const sealedBody = input.journal.prepareAction(action, body, idempotencyKey) as typeof body;
      const sealedKey = input.journal.action(action)!.idempotency_key;
      try {
        const receipt = await input.review.adoptReviewedCandidates(childId, sealedBody, sealedKey);
        adoptionSnapshots.set(adoptionKey, {
          head: receipt.adoption.head,
          selection: receipt.adoption.selection,
        });
        input.journal.acknowledgeAction(action);
      } catch (error) {
        input.journal.refuseAction(action, errorCode(error));
        omissions.push({ provider: 'vndb', sourceKey: group.record.sourceKey, code: errorCode(error) });
        for (const { binding, assertion } of group.edges)
          setParentOutcome(binding, 'withheld', assertion.candidateId, errorCode(error));
        withheldParentTags.add(refresh?.tagId ?? group.edges[0]?.binding.child ?? '');
        continue;
      }
    } else if (priorAction && priorAction.state !== 'acknowledged') {
      input.journal.acknowledgeAction(action);
    }
    pageCache.delete(groupKey(childId, 'skos:broader'));
    publicSubjects.delete(childId);
    for (const edge of currentEdges) {
      const state = input.review.fence
        ? await showcaseTagParentSourceFence(input.review.fence, edge.binding)
        : 'unavailable';
      if (state === 'open' && (await parentStatementCurrent(edge.binding, edge.assertion)))
        setParentOutcome(edge.binding, 'public', edge.assertion.candidateId);
      else {
        setParentOutcome(edge.binding, 'withheld', edge.assertion.candidateId, `parent-public-read-${state}`);
        withheldParentTags.add(edge.binding.child);
        omissions.push({ provider: 'vndb', sourceKey: edge.binding.path, code: 'public-view-unavailable' });
      }
    }
  }
  for (const binding of parentEvidence) {
    const outcome = parentOutcomeByPath.get(binding.path);
    if (outcome?.status !== 'public') withheldParentTags.add(binding.child);
  }
  const childrenByParent = new Map<string, string[]>();
  for (const binding of parentEvidence) {
    const children = childrenByParent.get(binding.parent) ?? [];
    children.push(binding.child);
    childrenByParent.set(binding.parent, children);
  }
  const parentQueue = [...withheldParentTags];
  for (let offset = 0; offset < parentQueue.length; offset += 1)
    for (const child of childrenByParent.get(parentQueue[offset]!) ?? [])
      if (!withheldParentTags.has(child)) {
        withheldParentTags.add(child);
        parentQueue.push(child);
      }
  for (const { record, assertion } of assertions) {
    if (!vndbTagMembership(record, assertion) || !validated.has(assertion.candidateId)) continue;
    const association = tagAssociationFor(record, assertion, manifest.tagAssociations ?? []);
    if (
      tagAssociationWithdrawn(record, assertion, manifest.tagAssociationWithdrawals ?? []) ||
      (association && withheldParentTags.has(association.tagId))
    ) {
      currentTagMembershipCandidateDigests.delete(assertion.candidateDigest);
      blockedMembershipCandidateIds.add(assertion.candidateId);
      omissions.push({
        provider: 'vndb',
        sourceKey:
          association?.sourceKey ??
          tagAssociationPath(record, assertion.source, assertion.statement)?.sourceKey ??
          record.sourceKey,
        code: 'vocabulary-binding-not-current',
      });
    }
  }
  parentPublicationOutcomes = [...parentOutcomeByPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  manifest = buildManifest(manifestAcknowledgements);
  input.journal.sealIntent(manifest);
  assertions = assertionsFor(manifest);
  vocabularyById = new Map(manifest.vocabulary.map((record) => [record.subjectId, record]));

  const parentWithheldWithdrawals = (manifest.tagAssociations ?? [])
    .filter((association) => withheldParentTags.has(association.tagId))
    .map((association) => ({ workId: association.workId, sourceKey: association.sourceKey, tagId: association.tagId }));
  const withdrawalWorkIds = new Set([
    ...(manifest.tagAssociationWithdrawals ?? []).map((item) => item.workId),
    ...parentWithheldWithdrawals.map((item) => item.workId),
  ]);
  for (const workId of withdrawalWorkIds) {
    const record = manifest.records.find(
      (item) => item.provider === 'vndb' && item.sourceAlias === input.aliases.vndb && item.sourceKey === workId,
    );
    if (!record?.subjectId) continue;
    const key = groupKey(record.subjectId, 'schema:genre');
    if (!grouped.has(key)) grouped.set(key, { record, property: 'schema:genre', ids: new Set<string>() });
  }

  for (const { record, assertion } of assertions) {
    const id = record.subjectId;
    if (
      !id ||
      !vndbTagMembership(record, assertion) ||
      !validated.has(assertion.candidateId) ||
      blockedTagSubjects.has(id)
    )
      continue;
    const association = tagAssociationFor(record, assertion, manifest.tagAssociations ?? []);
    if (!association || withheldParentTags.has(association.tagId)) continue;
    const candidate = validated.get(assertion.candidateId)!;
    if (candidate.decision === 'accept') continue;
    if (candidate.decision === 'reject') {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'candidate-currently-rejected' });
      continue;
    }
    const state = await currentFactsFence(input.review, input.aliases.vndb, record.sourceKey);
    if (state !== 'open') {
      blockedTagSubjects.add(id);
      omissions.push({ provider: 'vndb', sourceKey: record.sourceKey, code: 'tag-weight-fenced' });
      continue;
    }
    const body = { context: GLOBAL_CONTEXT, expected_head: candidate.head ?? null };
    const key = actionKey('accept', assertion.candidateId, assertion.candidateDigest);
    const idempotencyKey = actionIdempotencyKey(key, body);
    const prior = input.journal.action(key);
    if (prior?.state === 'acknowledged') continue;
    if (prior?.state === 'refused' && permanentReviewRefusal(prior.error_code)) {
      blockedTagSubjects.add(id);
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: prior.error_code! });
      continue;
    }
    const sealedBody = input.journal.prepareAction(key, body, idempotencyKey) as typeof body;
    const sealedKey = input.journal.action(key)!.idempotency_key;
    try {
      await input.review.acceptReviewedCandidate(id, assertion.candidateId, sealedBody, sealedKey);
      input.journal.acknowledgeAction(key);
      pageCache.delete(groupKey(id, assertion.property));
    } catch (error) {
      input.journal.refuseAction(key, errorCode(error));
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: errorCode(error) });
    }
  }
  for (const [key, group] of grouped) {
    for (const candidateId of group.ids)
      if (parentCandidateIds.has(candidateId) || blockedMembershipCandidateIds.has(candidateId))
        group.ids.delete(candidateId);
    if (group.property === 'skos:broader' && group.ids.size === 0) grouped.delete(key);
  }
  for (const [key, group] of grouped) {
    const [id] = key.split('\0');
    const refreshWeights =
      group.record.provider === 'vndb' && manifest.tagWeightRefreshes.includes(group.record.sourceKey);
    const parentOrSourceWithdrawals = [
      ...(manifest.tagAssociationWithdrawals ?? []),
      ...parentWithheldWithdrawals,
    ].filter((item) => item.workId === group.record.sourceKey);
    const refreshMemberships =
      group.record.provider === 'vndb' &&
      ((manifest.tagAssociationRefreshes ?? []).includes(group.record.sourceKey) ||
        parentOrSourceWithdrawals.length > 0);
    if (
      !id ||
      (group.property === 'schema:genre' && blockedTagSubjects.has(id)) ||
      (stoppedSubjects.has(id) && !(refreshWeights && group.ids.size === 0))
    )
      continue;
    if (group.property === 'schema:image') {
      const assertion = assertions.find(
        (entry) =>
          entry.record.subjectId === id &&
          entry.assertion.property === 'schema:image' &&
          group.ids.has(entry.assertion.candidateId),
      );
      const outcome = assertion && admittedCoverMedia(input.plan, mediaOutcomes, group.record, assertion.assertion);
      const state = outcome ? await currentCoverFence(input.review, outcome) : 'unavailable';
      if (state !== 'open') {
        omissions.push({
          provider: group.record.provider,
          sourceKey: group.record.sourceKey,
          code: state === 'fenced' ? 'cover-fenced' : 'cover-fence-unavailable',
        });
        continue;
      }
    }
    let page: CandidatePage;
    try {
      page = await candidatePage({ review: input.review, id, property: group.property }, pageCache);
    } catch {
      omissions.push({
        provider: group.record.provider,
        sourceKey: group.record.sourceKey,
        code: 'adoption-current-read-unavailable',
      });
      if (group.property !== 'schema:image') stoppedSubjects.add(id);
      continue;
    }
    const previous = page.adoption;
    const priorSelection = Array.isArray(previous?.selection) ? previous.selection : [];
    if (previous && !Array.isArray(previous.selection)) {
      omissions.push({
        provider: group.record.provider,
        sourceKey: group.record.sourceKey,
        code: 'adoption-selection-unavailable',
      });
      if (group.property !== 'schema:image') stoppedSubjects.add(id);
      continue;
    }
    const currentAdoption = adoptionSnapshot(previous);
    adoptionSnapshots.set(key, currentAdoption);
    if (refreshWeights && page.next !== null && page.next !== undefined) {
      omissions.push({
        provider: group.record.provider,
        sourceKey: group.record.sourceKey,
        code: 'adoption-selection-bounded',
      });
      continue;
    }
    if (refreshMemberships && page.next !== null && page.next !== undefined) {
      omissions.push({
        provider: group.record.provider,
        sourceKey: group.record.sourceKey,
        code: 'adoption-selection-bounded',
      });
      continue;
    }
    if (refreshWeights || refreshMemberships) {
      const state = await currentFactsFence(input.review, input.aliases.vndb, group.record.sourceKey);
      if (state !== 'open') {
        blockedTagSubjects.add(id);
        omissions.push({
          provider: 'vndb',
          sourceKey: group.record.sourceKey,
          code: state === 'fenced' ? 'tag-weight-fenced' : 'tag-weight-fence-unavailable',
        });
        continue;
      }
    }
    const selections = new Map<string, 'normal' | 'preferred'>();
    for (const item of priorSelection) {
      if (!item?.candidate) continue;
      const selectedCandidate = page.candidates.find((candidate) => candidate.id === item.candidate);
      if (
        refreshWeights &&
        selectedCandidate &&
        managedSourceTagWeight(selectedCandidate, input.aliases.vndb, group.record.sourceKey)
      )
        continue;
      if (
        refreshMemberships &&
        selectedCandidate &&
        managedSourceTagMembership(selectedCandidate, input.aliases.vndb, group.record)
      ) {
        const identity = tagAssociationPath(group.record, selectedCandidate.source, selectedCandidate.statement);
        const explicitlyWithdrawn =
          identity &&
          parentOrSourceWithdrawals.some(
            (withdrawal) => withdrawal.sourceKey === identity.sourceKey && withdrawal.tagId === identity.tagId,
          );
        const parentWithheld = !!identity && withheldParentTags.has(identity.tagId);
        const staleCurrentAssociation =
          (manifest.tagAssociationRefreshes ?? []).includes(group.record.sourceKey) &&
          !currentTagMembershipCandidateDigests.has(
            showcaseDigest({ source: selectedCandidate.source, statement: selectedCandidate.statement }),
          );
        if (explicitlyWithdrawn || parentWithheld || staleCurrentAssociation) continue;
      }
      selections.set(item.candidate, item.rank === 'preferred' ? 'preferred' : 'normal');
    }
    for (const candidateId of group.ids) selections.set(candidateId, selections.get(candidateId) ?? 'normal');
    if (selections.size > showcaseLimits.reviewPage) {
      omissions.push({
        provider: group.record.provider,
        sourceKey: group.record.sourceKey,
        code: 'adoption-selection-bounded',
      });
      if (group.property !== 'schema:image') stoppedSubjects.add(id);
      continue;
    }
    const dependencyIds = new Set<string>();
    for (const assertion of assertions.filter(
      (entry) => entry.record.subjectId === id && entry.assertion.property === group.property,
    )) {
      const value = assertion.assertion.statement.value;
      const content = value.type === 'value' ? value.content : undefined;
      if (typeof content === 'string' && vocabularyById.has(content)) dependencyIds.add(content);
    }
    const concept = vocabularyById.get(id);
    if (concept?.nativeType === 'skos:Concept' && concept.schemeId) dependencyIds.add(concept.schemeId);
    let dependencyReady = true;
    const identityProperty = group.property === sourceIdentityProperty(group.record);
    if (group.record.kind !== 'source-vocabulary' && !identityProperty) {
      const sourceRead = await publicRead(id);
      if (
        !sourceRead ||
        !currentSourceRead(sourceRead, group.record) ||
        !publicHasSourceIdentity(sourceRead, group.record)
      ) {
        omissions.push({
          provider: group.record.provider,
          sourceKey: group.record.sourceKey,
          code: 'source-uri-not-current',
        });
        stoppedSubjects.add(id);
        continue;
      }
    }
    for (const dependencyId of dependencyIds) {
      const dependency = vocabularyById.get(dependencyId);
      const dependencyRead = await publicRead(dependencyId);
      if (
        !dependency ||
        !dependencyRead ||
        subjectId(dependencyRead) !== dependencyId ||
        subjectType(dependencyRead) !== dependency.nativeType ||
        !dependency.sourceUri ||
        !publicVocabularySourceEvidence(dependencyRead, dependency) ||
        (dependency.nativeType === 'skos:Concept' &&
          (!dependency.schemeId || !publicHasValue(dependencyRead, 'skos:inScheme', dependency.schemeId)))
      ) {
        omissions.push({
          provider: group.record.provider,
          sourceKey: group.record.sourceKey,
          code: 'vocabulary-binding-not-current',
        });
        dependencyReady = false;
        break;
      }
    }
    if (!dependencyReady) {
      if (group.property !== 'schema:image') stoppedSubjects.add(id);
      continue;
    }
    const body = {
      context: GLOBAL_CONTEXT,
      property: group.property,
      mode: 'replace' as const,
      expected_head: previous?.head ?? null,
      selection: [...selections]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([candidate, rank]) => ({ candidate, rank })),
    };
    const action = actionKey('adopt', `${id}:${group.property}`, showcaseDigest({ intent: manifest.digest, body }));
    const idempotencyKey = actionIdempotencyKey(action, body);
    const priorAction = input.journal.action(action);
    if (priorAction?.state === 'refused' && permanentReviewRefusal(priorAction.error_code)) {
      omissions.push({
        provider: group.record.provider,
        sourceKey: group.record.sourceKey,
        code: priorAction.error_code!,
      });
      if (group.property !== 'schema:image') stoppedSubjects.add(id);
      continue;
    }
    if (currentAdoption && sameAdoptionSelection(currentAdoption.selection, body.selection)) {
      if (priorAction && priorAction.state !== 'acknowledged') input.journal.acknowledgeAction(action);
      continue;
    }
    const sealedBody = input.journal.prepareAction(action, body, idempotencyKey) as typeof body;
    const sealedKey = input.journal.action(action)!.idempotency_key;
    try {
      const receipt = await input.review.adoptReviewedCandidates(id, sealedBody, sealedKey);
      adoptionSnapshots.set(key, {
        head: receipt.adoption.head,
        selection: receipt.adoption.selection,
      });
      input.journal.acknowledgeAction(action);
      pageCache.delete(groupKey(id, group.property));
      publicSubjects.delete(id);
    } catch (error) {
      input.journal.refuseAction(action, errorCode(error));
      omissions.push({ provider: group.record.provider, sourceKey: group.record.sourceKey, code: errorCode(error) });
      if (group.property !== 'schema:image') stoppedSubjects.add(id);
    }
  }

  const published: {
    provider: 'bangumi' | 'vndb';
    sourceKey: string;
    subjectId: string;
    nativeType: string;
    readerRoute: string;
    kind: string;
    assertions: {
      candidateId: string;
      property: string;
      digest: string;
      citations?: readonly string[];
      qualifiers?: NonNullable<BatchStatement['qualifiers']>;
      rights?: Extract<BatchCommand, { op: 'propose' }>['rights'];
      target?: { sourceKey: string; subjectId: string; nativeType: string };
      adoption: { head: number; candidateId: string; rank: 'normal' | 'preferred' | 'deprecated' };
      readback: unknown;
    }[];
  }[] = [];
  const finalMediaOutcomes = [...mediaOutcomes];
  const readbacksByCandidate = new Map<string, unknown>();
  const adoptionsByCandidate = new Map<
    string,
    { head: number; candidateId: string; rank: 'normal' | 'preferred' | 'deprecated' }
  >();
  const readHandoffs = new Map<
    string,
    { subjectId: string; readerRoute: string; property: 'schema:image'; value: string }
  >();
  const publicRecords = [
    ...manifest.records,
    ...manifest.vocabulary
      .filter((record) => record.provenance !== 'source-parent-binding' || record.assertions.length > 0)
      .map((record) => ({
        provider: record.provider,
        sourceAlias: record.sourceAlias,
        sourceKey: record.sourceKey,
        sourceUri: record.sourceUri,
        sourceRevision: 'unversioned',
        rawDigest: '',
        semanticDigest: '',
        converterRevision: '',
        kind: 'source-vocabulary' as const,
        subjectId: record.subjectId,
        nativeType: record.nativeType,
        readerRoute: null,
        assertions: record.assertions,
      })),
  ];
  for (const record of publicRecords) {
    if (!record.subjectId || !record.nativeType) continue;
    const read = await publicRead(record.subjectId);
    if (!read || !currentSourceRead(read, record)) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'public-view-unavailable' });
      continue;
    }
    const publicSubject = read.subject as { statements?: Record<string, unknown[]> } | undefined;
    const withheldGraphCandidates = new Set<string>();
    const graphAssertions = record.assertions.filter((assertion) => assertion.graphTarget);
    if (graphAssertions.length && !publicHasSourceIdentity(read, record)) {
      for (const assertion of graphAssertions) withheldGraphCandidates.add(assertion.candidateId);
      omissions.push({
        provider: record.provider,
        sourceKey: record.sourceKey,
        code: 'graph-endpoint-public-read-unavailable',
      });
    }
    for (const assertion of graphAssertions) {
      const endpoint = assertion.graphTarget!;
      if (endpoint.factsFence) {
        const state = await showcaseFranchiseFence(input.review, record.sourceAlias, [
          record.sourceKey,
          endpoint.sourceKey,
        ]);
        if (state !== 'open') {
          withheldGraphCandidates.add(assertion.candidateId);
          omissions.push({
            provider: record.provider,
            sourceKey: record.sourceKey,
            code: state === 'fenced' ? 'graph-source-facts-fenced' : 'graph-source-facts-unavailable',
          });
          continue;
        }
      }
      const target = manifest.records.find(
        (candidate) => candidate.provider === endpoint.provider && candidate.sourceKey === endpoint.sourceKey,
      );
      const targetRead = await publicRead(endpoint.subjectId);
      if (
        !target ||
        target.subjectId !== endpoint.subjectId ||
        target.nativeType !== endpoint.nativeType ||
        !targetRead ||
        !currentSourceRead(targetRead, target) ||
        !publicHasSourceIdentity(targetRead, target)
      ) {
        withheldGraphCandidates.add(assertion.candidateId);
        omissions.push({
          provider: record.provider,
          sourceKey: record.sourceKey,
          code: 'graph-endpoint-public-read-unavailable',
        });
      }
    }
    const imageAssertion = record.assertions.find((assertion) => assertion.property === 'schema:image');
    let imagePublishable = false;
    let cover: CrossMediaMediaOutcome | undefined;
    if (imageAssertion) {
      cover = admittedCoverMedia(input.plan, finalMediaOutcomes, record, imageAssertion);
      const state = cover ? await currentCoverFence(input.review, cover) : 'unavailable';
      if (state === 'open') imagePublishable = true;
      else {
        const index = finalMediaOutcomes.findIndex(
          (outcome) => outcome.sourceAlias === record.sourceAlias && outcome.externalId === record.sourceKey,
        );
        if (index >= 0) {
          const {
            mediaId: _mediaId,
            mediaKey: _mediaKey,
            credit: _credit,
            provenance: _provenance,
            ...source
          } = finalMediaOutcomes[index]!;
          finalMediaOutcomes[index] = {
            ...source,
            status: state === 'fenced' ? 'fenced' : 'unavailable',
            ...(state === 'fenced' ? {} : { code: 'cover-fence-unavailable' }),
          };
        }
        omissions.push({
          provider: record.provider,
          sourceKey: record.sourceKey,
          code: state === 'fenced' ? 'cover-fenced' : 'cover-source-unavailable',
        });
      }
    }
    const visible = record.assertions.filter((assertion) => {
      if (
        !validated.has(assertion.candidateId) ||
        withheldGraphCandidates.has(assertion.candidateId) ||
        blockedMembershipCandidateIds.has(assertion.candidateId)
      )
        return false;
      const rows = publicSubject?.statements?.[assertion.property] ?? [];
      const readback = rows.find((row) => statementOnPublicRead(row, assertion.statement));
      if (!readback && assertion.graphTarget) {
        withheldGraphCandidates.add(assertion.candidateId);
        omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'graph-relation-not-public' });
      }
      if (!readback) return false;
      const adoption = adoptionSnapshots.get(groupKey(record.subjectId!, assertion.property));
      const selected = adoption?.selection.find((selection) => selection.candidate === assertion.candidateId);
      if (!adoption || !selected) {
        omissions.push({
          provider: record.provider,
          sourceKey: record.sourceKey,
          code: 'candidate-not-currently-adopted',
        });
        return false;
      }
      readbacksByCandidate.set(assertion.candidateId, readback);
      adoptionsByCandidate.set(assertion.candidateId, {
        head: adoption.head,
        candidateId: assertion.candidateId,
        rank: selected.rank,
      });
      return true;
    });
    const imageVisible =
      imagePublishable &&
      !!imageAssertion &&
      visible.some((assertion) => assertion.candidateId === imageAssertion.candidateId);
    const reportable = visible.filter((assertion) => assertion.property !== 'schema:image' || imageVisible);
    const required = record.assertions.filter(
      (assertion) =>
        !withheldGraphCandidates.has(assertion.candidateId) &&
        !blockedMembershipCandidateIds.has(assertion.candidateId) &&
        (assertion.property !== 'schema:image' || imageVisible),
    );
    if (imageAssertion && imagePublishable && !imageVisible) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'cover-not-public' });
    }
    if (reportable.length !== required.length) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'selected-facts-not-public' });
      continue;
    }
    const publicIdentity = read.subject as { labels?: Record<string, string> } | undefined;
    const label =
      publicIdentity?.labels?.und ??
      publicIdentity?.labels?.en ??
      publicIdentity?.labels?.ja ??
      publicIdentity?.labels?.zh ??
      Object.values(publicIdentity?.labels ?? {})[0] ??
      'subject';
    const route = `/subjects/${subjectId(read)}/${subjectSlug(label)}`;
    if (imageVisible && imageAssertion && cover) {
      readHandoffs.set(`${record.sourceAlias}\0${record.sourceKey}`, {
        subjectId: record.subjectId,
        readerRoute: route,
        property: 'schema:image',
        value: cover.mediaId!,
      });
    }
    published.push({
      provider: record.provider,
      sourceKey: record.sourceKey,
      subjectId: record.subjectId,
      nativeType: record.nativeType,
      readerRoute: route,
      kind: record.kind,
      assertions: reportable.map(
        ({ candidateId, property, candidateDigest, citations: sourceCitations, statement, graphTarget, rights }) => ({
          candidateId,
          property,
          digest: candidateDigest,
          citations: sourceCitations,
          ...(statement.qualifiers?.length ? { qualifiers: statement.qualifiers } : {}),
          ...(rights ? { rights } : {}),
          ...(graphTarget
            ? {
                target: {
                  sourceKey: graphTarget.sourceKey,
                  subjectId: graphTarget.subjectId,
                  nativeType: graphTarget.nativeType,
                },
              }
            : {}),
          adoption: adoptionsByCandidate.get(candidateId)!,
          readback: readbacksByCandidate.get(candidateId)!,
        }),
      ),
    });
  }

  const finalManifest = buildManifest(manifestAcknowledgements, finalMediaOutcomes);
  const finalMedia = finalManifest.media.map((item) => {
    const handoff = readHandoffs.get(`${item.sourceAlias}\0${item.sourceKey}`);
    if (handoff) {
      const { gap: _gap, ...record } = item;
      return { ...record, readHandoff: handoff };
    }
    if (item.status === 'available' && item.candidateId) return { ...item, gap: 'cover-not-public' };
    return item;
  });
  const finalOmissions = [
    ...finalManifest.omissions,
    ...finalMedia
      .filter((item) => item.gap === 'cover-not-public')
      .map((item) => ({ provider: 'bangumi' as const, sourceKey: item.sourceKey, code: 'cover-not-public' as const })),
  ].slice(0, showcaseLimits.omissions);
  manifest =
    JSON.stringify(finalMedia) === JSON.stringify(finalManifest.media)
      ? finalManifest
      : {
          ...finalManifest,
          digest: showcaseDigest({ baseDigest: finalManifest.digest, media: finalMedia }),
          media: finalMedia,
          omissions: finalOmissions,
        };
  if (manifest.digest !== initialIntentDigest) input.journal.sealIntent(manifest);
  for (const omission of manifest.omissions) omissions.push(omission);

  const uniqueOmissions = [
    ...new Map(omissions.map((item) => [`${item.provider}\0${item.sourceKey}\0${item.code}`, item])).values(),
  ].slice(0, showcaseLimits.omissions);
  const unresolvedCharacterDependencies = input.result.characterDiagnostics
    .slice(0, showcaseLimits.omissions)
    .flatMap((gap) => {
      const appearanceIndex = /^\/subject-characters\/([0-9]+)\/type$/u.exec(gap.path)?.[1];
      const appearance =
        appearanceIndex === undefined
          ? undefined
          : input.plan.characterAppearances?.find((row) => row.sourceIndex === Number(appearanceIndex));
      const characterCode = /^\/character\/([1-9][0-9]*)\/type$/u.exec(gap.path)?.[1];
      const characterKey = appearance
        ? `character:${appearance.characterId}`
        : characterCode
          ? `character:${characterCode}`
          : undefined;
      if (!characterKey) return [];
      const workKey = appearance?.subjectId ?? null;
      const work = workKey
        ? manifest.records.find((record) => record.provider === 'bangumi' && record.sourceKey === workKey)
        : undefined;
      const character = manifest.records.find(
        (record) => record.provider === 'bangumi' && record.sourceKey === characterKey,
      );
      const characterRecord = [...input.plan.records.bangumi, ...input.plan.entities.bangumi].find(
        (record) => record.key === characterKey,
      );
      const code = appearance?.roleCode ?? (characterRecord?.payload as Record<string, unknown> | undefined)?.type;
      const group = appearance ? 'subject-characters.type' : 'character.role';
      const enumeration =
        typeof code === 'number' || typeof code === 'string' ? mapSourceEnumeration('bangumi', group, code) : undefined;
      const conceptUri = enumeration?.concept?.id;
      const concept = conceptUri
        ? manifest.vocabulary.find(
            (record) =>
              record.provider === 'bangumi' && record.nativeType === 'skos:Concept' && record.sourceUri === conceptUri,
          )
        : undefined;
      return [
        {
          workKey,
          workSubjectId: work?.subjectId ?? null,
          characterKey,
          characterSubjectId: character?.subjectId ?? null,
          sourceIndex: appearance?.sourceIndex ?? null,
          ...(conceptUri ? { conceptUri } : {}),
          ...(concept?.subjectId ? { conceptId: concept.subjectId } : {}),
          ...(gap.code ? { code: gap.code.slice(0, 64) } : {}),
          reason: gap.reason,
          ...(gap.property ? { property: gap.property } : {}),
        },
      ];
    });
  for (const observation of manifest.tagWeightObservations) {
    if (
      observation.responseDigest &&
      published.some((record) => record.provider === 'vndb' && record.sourceKey === observation.workId) &&
      !uniqueOmissions.some((item) => item.provider === 'vndb' && item.sourceKey === observation.workId)
    )
      input.journal.completeVndbTagRatingSource(observation.workId, observation.responseDigest);
  }
  const vndbWorkRelations = input.result.vndbWorkRelations.map((relation) => {
    const publicRelation = published
      .find(
        (record) =>
          record.provider === 'vndb' &&
          record.sourceKey === relation.holderKey &&
          record.subjectId === relation.holderSubjectId,
      )
      ?.assertions.find(
        (assertion) =>
          assertion.candidateId === relation.candidateId &&
          assertion.property === relation.property &&
          assertion.target?.sourceKey === relation.targetKey &&
          assertion.target.subjectId === relation.targetSubjectId,
      );
    if (relation.delivery === 'acknowledged' && publicRelation)
      return { ...relation, publication: 'published' as const };
    const omission = uniqueOmissions.find(
      (item) =>
        item.provider === 'vndb' && (item.sourceKey === relation.holderKey || item.sourceKey === relation.targetKey),
    );
    return {
      ...relation,
      publication: 'withheld' as const,
      ...(omission ? { publicationReason: omission.code } : {}),
    };
  });
  return {
    status:
      uniqueOmissions.length || published.length !== manifest.records.length + manifest.vocabulary.length
        ? 'incomplete'
        : 'published',
    manifest,
    published,
    vndbWorkRelations,
    omissions: uniqueOmissions,
    unresolvedCharacterDependencies,
  };
}
