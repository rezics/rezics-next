import { Database } from 'bun:sqlite';
import { chmodSync } from 'node:fs';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { safeSourceUrl } from '@rezics/conversion/support';
import {
  showcaseDigest,
  showcaseLimits,
  type CrossMediaPort,
  type ShowcaseAcknowledgement,
  type ShowcaseManifest,
} from './showcase-contract.ts';
import { showcaseAdoptInvocationBound } from './showcase-publication-contract.ts';
import type { BangumiCoverSource, BangumiPersonCareerSource, CrossMediaMediaOutcome } from './showcase-media.ts';
import type { BangumiCoverSourceJournal } from './showcase-media.ts';
import type { BangumiPersonSourceJournal } from './showcase-bangumi-people.ts';
import type { VndbTagRatingObservation, VndbTagRatingSnapshot } from './showcase-vndb-tag-ratings.ts';

type JournalCommandRow = {
  command_key: string;
  command_digest: string;
  command_json: string;
  state: 'prepared' | 'acknowledged';
  subject_id: string | null;
  candidate_id: string | null;
};
export type ShowcaseJournalActionRow = {
  action_key: string;
  body_digest: string;
  body_json: string;
  idempotency_key: string;
  state: 'prepared' | 'acknowledged' | 'refused';
  error_code: string | null;
  result_id: string | null;
};
export type ShowcaseActionDecision = Readonly<{
  decision: 'explicit-422-key' | 'changed-body';
  refusal: string;
  priorIdempotencyKey: string;
  idempotencyKey: string;
}>;
type ShowcaseActionDecisionRow = {
  decision: ShowcaseActionDecision['decision'];
  refusal: string;
  prior_idempotency_key: string;
  idempotency_key: string;
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
      CREATE TABLE IF NOT EXISTS showcase_action_decision (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_key TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('explicit-422-key','changed-body')),
        refusal TEXT NOT NULL,
        prior_idempotency_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS showcase_action_decision_action
        ON showcase_action_decision(action_key,id);
      CREATE TABLE IF NOT EXISTS showcase_adopt_generation (
        identity TEXT PRIMARY KEY,
        generation INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS showcase_adopt_pending (
        identity TEXT NOT NULL,
        action_key TEXT NOT NULL,
        PRIMARY KEY (identity, action_key)
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
      .query<ShowcaseJournalActionRow, [string]>('SELECT * FROM showcase_action WHERE action_key=?')
      .get(actionKey);
    if (prior) {
      if (
        prior.state === 'refused' &&
        prior.error_code?.startsWith('review-http-4') &&
        (prior.body_digest !== bodyDigest ||
          (prior.error_code === 'review-http-422' && prior.idempotency_key !== idempotencyKey))
      ) {
        // Replacing a refused action is a separate decision: it names the refusal it supersedes and
        // is written with the state change, so the original refusal stays inspectable after replay.
        const decision =
          prior.error_code === 'review-http-422' && prior.idempotency_key !== idempotencyKey
            ? 'explicit-422-key'
            : 'changed-body';
        this.#db.transaction(() => {
          this.#db
            .query(
              'INSERT INTO showcase_action_decision(action_key,decision,refusal,prior_idempotency_key,idempotency_key) VALUES(?,?,?,?,?)',
            )
            .run(actionKey, decision, prior.error_code!, prior.idempotency_key, idempotencyKey);
          this.#db
            .query(
              "UPDATE showcase_action SET body_digest=?,body_json=?,idempotency_key=?,state='prepared',error_code=NULL WHERE action_key=?",
            )
            .run(bodyDigest, bodyJson, idempotencyKey, actionKey);
        })();
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

  action(actionKey: string): ShowcaseJournalActionRow | null {
    return (
      this.#db
        .query<ShowcaseJournalActionRow, [string]>('SELECT * FROM showcase_action WHERE action_key=?')
        .get(actionKey) ?? null
    );
  }

  /** Pending adopt actions, bounded independently of command history. */
  preparedAdoptActions(): ShowcaseJournalActionRow[] {
    return this.#db
      .query<ShowcaseJournalActionRow, [string, number]>(
        "SELECT * FROM showcase_action WHERE state='prepared' AND action_key LIKE ? ORDER BY action_key LIMIT ?",
      )
      .all('adopt:%', showcaseLimits.candidates);
  }

  recordPendingAdopt(identity: string, actionKey: string): void {
    this.#db
      .query('INSERT OR IGNORE INTO showcase_adopt_pending(identity,action_key) VALUES(?,?)')
      .run(identity, actionKey);
  }

  /** Identity-bound prepared adopt rows; other subjects and properties cannot hide them. */
  pendingAdoptActions(identity: string): ShowcaseJournalActionRow[] {
    return this.#db
      .query<ShowcaseJournalActionRow, [string, number]>(
        `SELECT a.action_key, a.body_digest, a.body_json, a.idempotency_key, a.state, a.error_code, a.result_id
         FROM showcase_adopt_pending p
         INNER JOIN showcase_action a ON a.action_key=p.action_key
         WHERE p.identity=? AND a.state='prepared'
         ORDER BY p.action_key
         LIMIT ?`,
      )
      .all(identity, showcaseAdoptInvocationBound);
  }

  /** One bounded page of prepared adopt actions after `after`, for resumable previous-format discovery. */
  preparedAdoptPage(after: string): ShowcaseJournalActionRow[] {
    return this.#db
      .query<ShowcaseJournalActionRow, [string, string, number]>(
        "SELECT * FROM showcase_action WHERE state='prepared' AND action_key LIKE ? AND action_key > ? ORDER BY action_key LIMIT ?",
      )
      .all('adopt:%', after, showcaseAdoptInvocationBound);
  }

  adoptGeneration(identity: string): number {
    return (
      this.#db
        .query<{ generation: number }, [string]>('SELECT generation FROM showcase_adopt_generation WHERE identity=?')
        .get(identity)?.generation ?? 0
    );
  }

  advanceAdoptGeneration(identity: string, generation: number): void {
    this.#db
      .query(
        'INSERT INTO showcase_adopt_generation(identity,generation) VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET generation=excluded.generation',
      )
      .run(identity, generation);
  }

  /** Recorded replacements of refused actions, oldest first; each names the refusal it superseded. */
  actionDecisions(actionKey: string): ShowcaseActionDecision[] {
    return this.#db
      .query<ShowcaseActionDecisionRow, [string]>(
        'SELECT decision,refusal,prior_idempotency_key,idempotency_key FROM showcase_action_decision WHERE action_key=? ORDER BY id',
      )
      .all(actionKey)
      .map((row) => ({
        decision: row.decision,
        refusal: row.refusal,
        priorIdempotencyKey: row.prior_idempotency_key,
        idempotencyKey: row.idempotency_key,
      }));
  }

  acknowledgeAction(actionKey: string, resultId?: string): void {
    this.#db.transaction(() => {
      this.#db
        .query(
          "UPDATE showcase_action SET state='acknowledged',error_code=NULL,result_id=COALESCE(result_id,?) WHERE action_key=?",
        )
        .run(resultId ?? null, actionKey);
      this.#db.query('DELETE FROM showcase_adopt_pending WHERE action_key=?').run(actionKey);
    })();
  }

  refuseAction(actionKey: string, errorCode: string): void {
    this.#db.transaction(() => {
      this.#db
        .query("UPDATE showcase_action SET state='refused',error_code=? WHERE action_key=?")
        .run(errorCode, actionKey);
      this.#db.query('DELETE FROM showcase_adopt_pending WHERE action_key=?').run(actionKey);
    })();
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
