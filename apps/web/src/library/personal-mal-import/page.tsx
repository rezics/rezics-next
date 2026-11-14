import { ImportPageCoordinates, ImportPageReadRecovery } from '../personal-list-import/page-navigation';
import { ImportDetails, ImportJourney, ImportReturn } from '../personal-list-import/presentation';
import { useEffect, useRef, useState } from 'react';
import { useOperation } from '../../kernel/exposure';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { sourceAdmissionBlock, sourceAdmissionBody } from '../rich-private-entry/admission';
import {
  MAL_UPLOAD_BYTES,
  newCommandKey,
  sameCommand,
  type MalApplyPage,
  type MalCommand,
  type MalFailure,
  type MalOutcome,
  type MalPage,
  type MalPreviewRow,
  type MalScoreReviewInput,
  type MalUnknown,
} from './contract';
import { MalConfirmPage, scoreConsentKey } from './confirm';
import { MalAction } from './controls';
import { MalDeparture } from './departure';
import { malFailureLabel, malVoteReadKey } from './meaning';
import { useMalImportPort } from './port';
import { MalResultPage } from './results';
import { MalReviewPage } from './review';
import { draftFromRow, type RowDraft } from './row';
import { malSourcePreview } from './source';
import { MalRetainedSource } from './labels';
import { MalRetainedUpload, MalUploadForm } from './upload';
import { useMalVisit, type MalVisit } from './visit';
import type { SourceAdmissionOutcome } from '../rich-private-entry/admission';
import type { MalDeliveryCustody, MalOwnVoteReadback, MalQuestion } from './contract';

type Stage = 'upload' | 'review' | 'confirm' | 'results';
type PageRequest = {
  command: Extract<MalCommand, { kind: 'page' }>;
  switchToReview: boolean;
  preserveFields: boolean;
};

type Notice = MalFailure | MalUnknown | { kind: 'too-large' } | null;

function noticeText(notice: Notice): string | null {
  if (!notice) return null;
  if (notice.kind === 'unknown') return m.library_mal_uncertain();
  if (notice.kind === 'too-large') return m.library_mal_too_large();
  return malFailureLabel(notice.kind, 'detail' in notice ? notice.detail : undefined);
}

function commandUploadId(command: MalCommand | null): string | null {
  if (!command || command.kind === 'preview' || command.kind === 'admit-source') return null;
  return command.id;
}

function commandStage(command: MalCommand | null): Stage {
  if (!command || command.kind === 'preview') return 'upload';
  return command.kind === 'apply' || command.kind === 'admit-source' ? 'results' : 'review';
}

export function PersonalMalImportPage({ visit }: { visit?: MalVisit | null }) {
  const observed = useMalVisit();
  const current = visit === undefined ? observed : visit;
  useOperation('library_entry.put');
  if (!current) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-6">
        <PageHeading>{m.library_mal_title()}</PageHeading>
        <p role="status">{m.library_mal_sign_in()}</p>
      </main>
    );
  }
  return (
    <MalImportSession
      key={`${current.identity ?? ''}:${current.subject}:${current.csrfToken}:${current.locale}`}
      visit={current}
    />
  );
}

function MalImportSession({ visit }: { visit: MalVisit }) {
  const port = useMalImportPort();
  const [restored] = useState<MalDeliveryCustody | null>(() => visit.delivery());
  const [stage, setStage] = useState<Stage>(() => commandStage(restored?.command ?? null));
  const [page, setPage] = useState<MalPage | null>(null);
  const [after, setAfter] = useState(0);
  const [pageRevision, setPageRevision] = useState(0);
  const coordinates = useRef(new ImportPageCoordinates(0));
  const [position, setPosition] = useState(() => coordinates.current.position());
  const pageRequest = useRef<PageRequest | null>(null);
  const [pageFailure, setPageFailure] = useState<PageRequest | null>(null);
  const draftReviews = useRef(new Map<number, string | null>());
  const reviewedFields = useRef(new Map<number, { version: string | null; fields: string[] }>());
  const generation = useRef(0);
  const sending = useRef(false);
  const [drafts, setDrafts] = useState<Record<number, RowDraft>>({});
  const [result, setResult] = useState<MalApplyPage | null>(restored?.result ?? null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(restored ? { kind: 'unknown', command: restored.command } : null);
  const [unknownCommand, setUnknownCommand] = useState<MalCommand | null>(restored?.command ?? null);
  const [confirmPrivacy, setConfirmPrivacy] = useState(restored?.sourceConsent.privacy ?? false);
  const [confirmTimestamps, setConfirmTimestamps] = useState(restored?.sourceConsent.timestamps ?? false);
  const [question, setQuestion] = useState<MalQuestion | null>(null);
  const [questionLoading, setQuestionLoading] = useState(false);
  const [questionUnavailable, setQuestionUnavailable] = useState(false);
  const [voteReadbacks, setVoteReadbacks] = useState<Map<string, MalOwnVoteReadback>>(() => new Map());
  const [admissions, setAdmissions] = useState<Map<number, SourceAdmissionOutcome | null>>(() => new Map());
  const delivery = useRef<MalDeliveryCustody | null>(restored);
  const unknownRef = useRef<MalCommand | null>(restored?.command ?? null);
  const sender = useRef({ subject: visit.subject, csrfToken: visit.csrfToken });
  const titles = useRef(new Map<number, string>());
  const retiredReviews = useRef(new Map<number, string>());
  const applyCommand = useRef<Extract<MalCommand, { kind: 'apply' }> | null>(
    restored?.command.kind === 'apply' ? restored.command : null,
  );
  const admitQueue = useRef<Extract<MalCommand, { kind: 'admit-source' }>[]>(
    restored?.command.kind === 'admit-source' ? [restored.command] : [],
  );
  const uploadId = useRef<string | null>(commandUploadId(restored?.command ?? null) ?? restored?.uploadId ?? null);
  const lastResult = useRef<MalApplyPage | null>(restored?.result ?? null);
  const confirmFlags = useRef({
    privacy: restored?.sourceConsent.privacy ?? false,
    timestamps: restored?.sourceConsent.timestamps ?? false,
  });

  useEffect(() => () => {
    coordinates.current.retire();
    pageRequest.current = null;
    visit.retire();
  }, [visit]);

  function live() {
    return visit.current() && sender.current.subject === visit.subject && sender.current.csrfToken === visit.csrfToken;
  }

  function retireCoordinates() {
    coordinates.current.retire();
    pageRequest.current = null;
    setPageFailure(null);
    setPosition(coordinates.current.position());
  }

  function acceptCancellation() {
    generation.current += 1;
    setQuestionLoading(false);
    retireCoordinates();
    setPage((current) => current ? { ...current, canceled: true } : current);
  }

  function resetPrivate() {
    generation.current += 1;
    retireCoordinates();
    draftReviews.current.clear();
    reviewedFields.current.clear();
    delivery.current = null;
    if (unknownCommand) visit.resolveDelivery(unknownCommand);
    unknownRef.current = null;
    setUnknownCommand(null);
    applyCommand.current = null;
    admitQueue.current = [];
    uploadId.current = null;
    titles.current = new Map();
    retiredReviews.current.clear();
    confirmFlags.current = { privacy: false, timestamps: false };
    setPage(null);
    setDrafts({});
    setAfter(0);
    setPageRevision(0);
    setResult(null);
    lastResult.current = null;
    setQuestion(null);
    setQuestionLoading(false);
    setQuestionUnavailable(false);
    setVoteReadbacks(new Map());
    setAdmissions(new Map());
    setStage('upload');
    setNotice(null);
    setConfirmPrivacy(false);
    setConfirmTimestamps(false);
  }

  function withPreview(rows: MalPreviewRow[]): MalPreviewRow[] {
    return rows.map((row) => ({
      ...row,
      sourcePreview: row.sourcePreview ?? malSourcePreview(row),
      sourceAdmission: row.sourceAdmission ?? admissions.get(row.index) ?? null,
    }));
  }

  function setRowAdmission(index: number, outcome: SourceAdmissionOutcome | null) {
    setAdmissions((current) => new Map(current).set(index, outcome));
    setPage((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((row) => (row.index === index ? { ...row, sourceAdmission: outcome } : row)),
          }
        : current,
    );
  }

  function clearCurrentScoreReadings() {
    setVoteReadbacks(new Map());
    setPage((current) => {
      if (!current) return current;
      return {
        ...current,
        rows: current.rows.map((row) => {
          const next = { ...row };
          Reflect.deleteProperty(next, 'currentScoreVote');
          return next;
        }),
      };
    });
  }

  async function run<T extends { kind: string }>(
    command: MalCommand,
    send: () => Promise<T | MalFailure | MalUnknown>,
    sourceConsent = confirmFlags.current,
    retry = false,
  ) {
    if (!live() || sending.current || (unknownRef.current && (!retry || !sameCommand(unknownRef.current, command)))) return;
    const token = generation.current;
    sending.current = true;
    setBusy(true);
    let response: T | MalFailure | MalUnknown;
    try {
      response = await send();
    } finally {
      if (token === generation.current) {
        sending.current = false;
        setBusy(false);
      }
    }
    if (token !== generation.current) return;
    if (response.kind === 'unknown') {
      const lost = response as MalUnknown;
      const custody: MalDeliveryCustody = {
        command: lost.command,
        sender: { subject: visit.subject, csrfToken: visit.csrfToken },
        sourceConsent: { ...sourceConsent },
        uploadId: uploadId.current,
        ...(lastResult.current ? { result: lastResult.current } : {}),
      };
      delivery.current = custody;
      unknownRef.current = lost.command;
      if (lost.command.kind === 'admit-source') {
        const lostAdmit = lost.command;
        const queuedIndex = admitQueue.current.findIndex((item) => item.key === lostAdmit.key);
        if (queuedIndex >= 0) {
          admitQueue.current = admitQueue.current.map((item, index) =>
            index === queuedIndex ? (lost.command as Extract<MalCommand, { kind: 'admit-source' }>) : item,
          );
        }
      }
      visit.retainDelivery(custody);
      if (live()) {
        setUnknownCommand(lost.command);
        setNotice(lost);
      }
      return response;
    }
    visit.resolveDelivery(command);
    if (delivery.current && sameCommand(delivery.current.command, command)) delivery.current = null;
    if (unknownRef.current && sameCommand(unknownRef.current, command)) unknownRef.current = null;
    if (!live()) return;
    setUnknownCommand(null);
    if (
      response.kind === 'previewed' ||
      response.kind === 'page' ||
      response.kind === 'reviewed' ||
      response.kind === 'applied' ||
      response.kind === 'done' ||
      response.kind === 'admitted' ||
      response.kind === 'conflict'
    ) {
      setNotice(null);
      return response;
    }
    setNotice(response as MalFailure);
    return response;
  }

  function acceptPage(nextPage: MalPage, cursor: number, switchToReview: boolean, preserveFields: boolean) {
    const rows = withPreview(nextPage.rows).map((row) => {
      const review = row.review?.version === retiredReviews.current.get(row.index) ? null : row.review;
      const fields = reviewedFields.current.get(row.index);
      if (!review || (fields?.version && fields.version !== review.version)) {
        reviewedFields.current.delete(row.index);
      } else if (fields) {
        fields.version = review.version;
        return { ...row, review, selectedFields: [...fields.fields] };
      }
      return { ...row, review };
    });
    uploadId.current = nextPage.id;
    for (const row of rows) titles.current.set(row.index, row.title);
    setPage({ ...nextPage, rows });
    setAfter(cursor);
    setPageRevision((current) => current + 1);
    if (nextPage.canceled) retireCoordinates();
    else {
      coordinates.current.observe(cursor);
      setPosition(coordinates.current.position());
    }
    pageRequest.current = null;
    setPageFailure(null);
    // Keep only draft state across pages. Native rereads supply every row and review again.
    const priorVersions = new Map(draftReviews.current);
    for (const row of rows) draftReviews.current.set(row.index, row.review?.version ?? null);
    setDrafts((current) => {
      const next = { ...current };
      for (const row of rows) {
        const prior = current[row.index];
        const sameReview = priorVersions.has(row.index) && priorVersions.get(row.index) === (row.review?.version ?? null);
        next[row.index] = prior && sameReview
          ? prior
          : {
              ...draftFromRow(row),
              ...(row.selectedFields ? { fields: [...row.selectedFields] } : {}),
              ...(preserveFields && prior ? { fields: prior.fields } : {}),
            };
      }
      return next;
    });
    if (switchToReview) setStage('review');
  }

  async function loadPage(
    id: string,
    cursor: number,
    switchToReview = true,
    preserveFields = false,
    retry = false,
    originalCommand?: Extract<MalCommand, { kind: 'page' }>,
  ): Promise<MalPage | null> {
    if (!live() || sending.current || (unknownRef.current && !retry)) return null;
    const token = generation.current;
    const command: Extract<MalCommand, { kind: 'page' }> = originalCommand ?? { kind: 'page', id, after: cursor };
    const request = { command, switchToReview, preserveFields };
    pageRequest.current = request;
    setPageFailure(null);
    const response = await run(command, () => port.page(command), confirmFlags.current, retry);
    if (!live() || token !== generation.current) return null;
    if (response?.kind !== 'page') {
      if (response && response.kind !== 'unknown') setPageFailure(request);
      return null;
    }
    if (!preserveFields) {
      setVoteReadbacks(new Map());
    } else {
      const refreshedKeys = response.page.rows.flatMap((row) => {
        if (row.currentScoreVote === undefined) return [];
        const target = row.review?.target ?? row.target;
        const questionId = question?.id ?? row.review?.score?.question.id;
        return target && questionId ? [malVoteReadKey(row.index, target, questionId)] : [];
      });
      if (refreshedKeys.length) {
        setVoteReadbacks((current) => {
          const next = new Map(current);
          for (const key of refreshedKeys) next.delete(key);
          return next;
        });
      }
    }
    acceptPage(response.page, cursor, switchToReview, preserveFields);
    if (!lastResult.current) {
      const outcomes = response.page.rows.flatMap((row) => (row.outcome ? [row.outcome] : []));
      if (outcomes.length) {
        const reopened: MalApplyPage = {
          id: response.page.id,
          outcomes,
          remaining: [],
          stopped: response.page.canceled,
        };
        lastResult.current = reopened;
        setResult(reopened);
      }
    }
    return response.page;
  }

  async function upload(xml: string) {
    if (!xml || new TextEncoder().encode(xml).length > MAL_UPLOAD_BYTES) {
      setNotice({ kind: 'too-large' });
      return;
    }
    if (!live() || sending.current || unknownRef.current) return;
    const previous = uploadId.current;
    resetPrivate();
    // Only the identifier remains while native replacement cleanup is unresolved.
    uploadId.current = previous;
    if (previous) {
      const remove: Extract<MalCommand, { kind: 'delete' }> = {
        kind: 'delete',
        id: previous,
        key: newCommandKey(),
      };
      const deleted = await run(remove, () => port.delete(remove));
      if (!deleted || deleted.kind !== 'done' || !live()) return;
      uploadId.current = null;
    }
    const command: Extract<MalCommand, { kind: 'preview' }> = { kind: 'preview', key: newCommandKey(), xml };
    const response = await run(command, () => port.preview(command));
    if (!response || response.kind !== 'previewed' || !live()) return;
    uploadId.current = response.id;
    await loadPage(response.id, 0);
  }

  async function saveReview(draft: RowDraft) {
    const id = uploadId.current;
    if (!id || !page || busy || unknownRef.current || !live()) return;
    if (draft.score?.action === 'adopt' && draft.score.units === undefined) return;
    const score: MalScoreReviewInput | undefined =
      draft.score?.action === 'adopt'
        ? {
            action: 'adopt',
            questionId: draft.score.questionId,
            questionRevision: draft.score.questionRevision,
            units: draft.score.units!,
            ...(draft.score.replaceCurrent ? { replaceCurrent: true } : {}),
          }
        : draft.score?.action === 'clear'
          ? draft.score
          : undefined;
    const command: Extract<MalCommand, { kind: 'review' }> = {
      kind: 'review',
      key: newCommandKey(),
      id,
      input: {
        row: draft.row,
        target: draft.target,
        skip: draft.skip,
        replace: draft.replace,
        ...(draft.labels === undefined ? {} : { labels: draft.labels }),
        ...(draft.skip || !score ? {} : { score }),
      },
    };
    const previous = page.rows.find((row) => row.index === draft.row)?.review;
    if (previous) retiredReviews.current.set(draft.row, previous.version);
    setPage((current) =>
      current
        ? { ...current, rows: current.rows.map((row) => (row.index === draft.row ? { ...row, review: null } : row)) }
        : current,
    );
    const response = await run(command, () => port.review(command));
    if (!response || response.kind !== 'reviewed' || !live()) return;
    reviewedFields.current.set(draft.row, { version: null, fields: [...draft.fields] });
    if (command.input.score && command.input.target) {
      const key = malVoteReadKey(command.input.row, command.input.target, command.input.score.questionId);
      setVoteReadbacks((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    }
    const refreshed = await loadPage(id, after, true, true);
    if (!refreshed || !live()) return;
    setDrafts((current) => ({
      ...current,
      [draft.row]: { ...(current[draft.row] ?? draft), fields: [...draft.fields] },
    }));
  }

  function queueSourceAdmissions(currentPage: MalPage, outcomes: MalOutcome[]) {
    if (!confirmFlags.current.privacy || !confirmFlags.current.timestamps) return;
    const stateApplied = new Set(outcomes.filter((item) => item.applied.includes('status')).map((item) => item.row));
    for (const row of currentPage.rows) {
      if (row.review?.skip || !stateApplied.has(row.index) || row.sourceAdmission) continue;
      const preview = row.sourcePreview ?? malSourcePreview(row);
      const body = sourceAdmissionBody(preview);
      const blocked = sourceAdmissionBlock(preview);
      const target = row.review?.target ?? row.target;
      if (!body || !target) {
        setRowAdmission(row.index, {
          status: 'unsupported',
          reason: target
            ? (blocked ?? 'This provider record has no stable identity.')
            : 'This row has no canonical Subject.',
        });
        continue;
      }
      admitQueue.current.push({
        kind: 'admit-source',
        key: newCommandKey(),
        subjectId: target,
        ordinal: row.index,
        body,
      });
    }
  }

  async function admitQueued(): Promise<boolean> {
    while (admitQueue.current.length) {
      if (!live()) return false;
      const command = admitQueue.current[0]!;
      const response = await run(command, () => port.admitSource(command));
      if (!response || response.kind === 'unknown') return false;
      if (response.kind === 'admitted' || response.kind === 'conflict') {
        setRowAdmission(command.ordinal, { status: response.kind === 'admitted' ? 'admitted' : 'conflict' });
        setNotice(null);
        admitQueue.current.shift();
        continue;
      }
      setRowAdmission(command.ordinal, { status: 'failed' });
      setNotice(response);
      return false;
    }
    return true;
  }

  async function confirm(scoreConsents: Set<string>) {
    const id = uploadId.current;
    if (!id || !page) return;
    const rows = page.rows.flatMap((row) => {
      const review = row.review;
      if (!review) return [];
      const draft = drafts[row.index] ?? draftFromRow(row);
      const fields: string[] = review.skip
        ? []
        : draft.fields.filter((field) => field === 'status' || field === 'tags');
      const consentKey = scoreConsentKey(row);
      const scoreCurrent =
        row.scoreReviewState === 'observations-match' &&
        review.score?.support.status === 'supported' &&
        review.score.admission.status === 'conditional';
      if (scoreCurrent && consentKey && scoreConsents.has(consentKey) && !review.skip) fields.push('score');
      return [{ row: row.index, version: review.version, fields }];
    });
    if (!rows.length) return;
    const command: Extract<MalCommand, { kind: 'apply' }> = { kind: 'apply', id, body: { confirm: true, rows } };
    applyCommand.current = command;
    const consent = { ...confirmFlags.current };
    const response = await run(command, () => port.apply(command), consent);
    if (!response || response.kind !== 'applied' || !live()) return;
    clearCurrentScoreReadings();
    lastResult.current = response.result;
    setResult(response.result);
    setStage('results');
    queueSourceAdmissions(page, response.result.outcomes);
    await admitQueued();
  }

  async function readQuestion() {
    if (busy || unknownCommand || !live()) return;
    const token = generation.current;
    setQuestionLoading(true);
    const response = await port.readQuestion();
    if (!live() || token !== generation.current) return;
    setQuestionLoading(false);
    if (response.kind === 'question') {
      setQuestion(response.question);
      setQuestionUnavailable(false);
    } else {
      setQuestion(null);
      setQuestionUnavailable(true);
    }
  }

  async function readVote(row: MalPreviewRow, targetOverride?: string | null) {
    const targetId = targetOverride ?? row.review?.target ?? row.target;
    const questionId = question?.id ?? row.review?.score?.question.id;
    if (!targetId || !questionId || busy || unknownCommand || !live()) return;
    const token = generation.current;
    const key = malVoteReadKey(row.index, targetId, questionId);
    const response = await port.readVote({ targetId, questionId });
    if (!live() || token !== generation.current) return;
    const value = response.kind === 'vote' ? response.value : { kind: 'unavailable' as const };
    setVoteReadbacks((current) => new Map(current).set(key, value));
  }

  async function recoverApply(command: Extract<MalCommand, { kind: 'apply' }>, applied: MalApplyPage) {
    clearCurrentScoreReadings();
    lastResult.current = applied;
    setResult(applied);
    setStage('results');
    const firstRow = command.body.rows[0]?.row ?? 0;
    const cursor = Math.floor(firstRow / 20) * 20;
    const recoveredPage = await loadPage(command.id, cursor, false, true);
    if (!live() || !recoveredPage) return;
    queueSourceAdmissions(recoveredPage, applied.outcomes);
    await admitQueued();
  }

  async function retryUnknown() {
    const command = unknownCommand;
    const sourceConsent = delivery.current?.sourceConsent ?? confirmFlags.current;
    if (!command || !live()) return;
    if (command.kind === 'preview') {
      const response = await run(command, () => port.preview(command), sourceConsent, true);
      if (response?.kind === 'previewed' && live()) {
        uploadId.current = response.id;
        await loadPage(response.id, 0);
      }
    } else if (command.kind === 'page') {
      const request = pageRequest.current;
      await loadPage(command.id, command.after, request?.switchToReview ?? true, request?.preserveFields ?? false, true, command);
    } else if (command.kind === 'review') {
      const response = await run(command, () => port.review(command), sourceConsent, true);
      if (response?.kind === 'reviewed' && live()) {
        reviewedFields.current.set(command.input.row, {
          version: null,
          fields: [...(drafts[command.input.row]?.fields ?? [])],
        });
        await loadPage(command.id, after, true, true);
      }
    } else if (command.kind === 'apply') {
      applyCommand.current = command;
      const response = await run(command, () => port.apply(command), sourceConsent, true);
      if (response?.kind === 'applied' && live()) await recoverApply(command, response.result);
    } else if (command.kind === 'admit-source') {
      const knownResult = delivery.current?.result;
      const knownUploadId = delivery.current?.uploadId ?? uploadId.current;
      const response = await run(command, () => port.admitSource(command), sourceConsent, true);
      if (!response || !live()) return;
      if (response.kind === 'admitted' || response.kind === 'conflict') {
        setRowAdmission(command.ordinal, { status: response.kind === 'admitted' ? 'admitted' : 'conflict' });
        admitQueue.current = admitQueue.current.filter((item) => !sameCommand(item, command));
        setNotice(null);
        if (knownResult) {
          lastResult.current = knownResult;
          setResult(knownResult);
          setStage('results');
          if (knownUploadId) {
            uploadId.current = knownUploadId;
            const cursor = Math.floor(command.ordinal / 20) * 20;
            await loadPage(knownUploadId, cursor, false, false);
          }
        }
        await admitQueued();
      }
    } else if (command.kind === 'cancel') {
      const response = await run(command, () => port.cancel(command), sourceConsent, true);
      if (response?.kind === 'done' && live()) {
        acceptCancellation();
        await loadPage(command.id, after);
      }
    } else {
      const response = await run(command, () => port.delete(command), sourceConsent, true);
      if (response?.kind === 'done' && live()) resetPrivate();
    }
  }

  async function discard() {
    const id = uploadId.current;
    if (!id || unknownCommand) return;
    const command: Extract<MalCommand, { kind: 'delete' }> = { kind: 'delete', id, key: newCommandKey() };
    const response = await run(command, () => port.delete(command));
    if (response?.kind === 'done' && live()) resetPrivate();
  }

  const locked = busy || unknownCommand !== null;
  const currentRows = page?.rows ?? [];
  const rowByIndex = new Map(currentRows.map((row) => [row.index, row]));

  function movePage(cursor: number | null) {
    const id = uploadId.current;
    if (id && cursor !== null && !locked && !page?.canceled) void loadPage(id, cursor);
  }

  function retryPage() {
    if (!pageFailure) return;
    const { command, switchToReview, preserveFields } = pageFailure;
    void loadPage(command.id, command.after, switchToReview, preserveFields, true, command);
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6">
      <PageHeading>{m.library_mal_title()}</PageHeading>
      <ImportJourney stage={stage} />
      {noticeText(notice) ? <p role="status">{noticeText(notice)}</p> : null}
      {unknownCommand ? (
        <div className="space-y-2 rounded-md border p-3" role="group" aria-label={m.library_mal_uncertain()}>
          <p>{m.library_mal_retry_original_help()}</p>
          <MalAction type="button" disabled={busy} onClick={() => void retryUnknown()}>
            {m.library_mal_retry_command()}
          </MalAction>
        </div>
      ) : null}
      {pageFailure && !unknownCommand ? (
        <ImportPageReadRecovery busy={locked} onRetry={retryPage} />
      ) : null}
      {stage === 'upload' ? (
        <>
          <MalUploadForm busy={busy} disabled={locked} onUpload={(xml) => void upload(xml)} />
          <MalRetainedUpload
            busy={locked}
            onOpen={(id) => {
              uploadId.current = id;
              void loadPage(id, 0);
            }}
          />
        </>
      ) : null}
      {page ? (
        <>
          <ImportDetails title={m.library_import_retained()}>
            <p>{m.library_import_reopen_help()}</p>
            <p className="break-all">
              {m.library_mal_label_upload_id()}: {page.id}
            </p>
            <MalRetainedSource key={page.id} id={page.id} />
          </ImportDetails>
        </>
      ) : null}
      {stage === 'review' && page ? (
        <MalReviewPage
          page={page}
          drafts={drafts}
          question={question}
          questionLoading={questionLoading}
          questionUnavailable={questionUnavailable}
          voteReadbacks={voteReadbacks}
          after={after}
          pageRevision={pageRevision}
          position={position}
          busy={locked}
          onReadQuestion={() => void readQuestion()}
          onReadVote={(row, draft) => void readVote(row, draft.target)}
          onChangeDraft={(draft) => {
            const previous = drafts[draft.row] ?? draftFromRow(rowByIndex.get(draft.row)!);
            if (previous.target !== draft.target) {
              setVoteReadbacks(new Map());
              setDrafts((current) => ({ ...current, [draft.row]: { ...draft, score: undefined } }));
            } else {
              setDrafts((current) => ({ ...current, [draft.row]: draft }));
            }
          }}
          onSave={(draft) => void saveReview(draft)}
          onNext={() => movePage(page.next)}
          onPrevious={() => movePage(position.previous)}
          onFirst={() => movePage(position.canFirst ? coordinates.current.first : null)}
          onConfirm={() => {
            confirmFlags.current = { privacy: false, timestamps: false };
            setConfirmPrivacy(false);
            setConfirmTimestamps(false);
            setStage('confirm');
          }}
        />
      ) : null}
      {stage === 'review' && !page && uploadId.current ? (
        <p role="status">{m.library_mal_retry_original_help()}</p>
      ) : null}
      {stage === 'confirm' && page ? (
        <MalConfirmPage
          rows={page.rows}
          drafts={drafts}
          busy={locked}
          confirmPrivacy={confirmPrivacy}
          confirmTimestamps={confirmTimestamps}
          question={question}
          voteReadbacks={voteReadbacks}
          onBack={() => setStage('review')}
          onConfirm={(consents) => void confirm(consents)}
          onConfirmSource={(choice) => {
            if (choice.privacy !== undefined) {
              confirmFlags.current.privacy = choice.privacy;
              setConfirmPrivacy(choice.privacy);
            }
            if (choice.timestamps !== undefined) {
              confirmFlags.current.timestamps = choice.timestamps;
              setConfirmTimestamps(choice.timestamps);
            }
          }}
        />
      ) : null}
      {stage === 'results' && result ? (
        <MalResultPage
          result={result}
          titles={titles.current}
          admissions={admissions}
          rows={currentRows}
          questionId={question?.id ?? null}
          voteReadbacks={voteReadbacks}
          busy={locked}
          canRetry={
            !!applyCommand.current &&
            result.outcomes.some(
              (item) =>
                item.status === 'failed' ||
                item.score?.status === 'failed' ||
                item.labels?.some((label) => label.status === 'failed'),
            )
          }
          canRetrySource={admitQueue.current.length > 0 && !unknownCommand && notice !== null}
          onRetrySource={() => void admitQueued()}
          onRetry={() => {
            const command = applyCommand.current;
            if (!command || unknownCommand) return;
            void run(command, () => port.apply(command), delivery.current?.sourceConsent).then(async (response) => {
              if (response?.kind === 'applied' && live()) {
                clearCurrentScoreReadings();
                lastResult.current = response.result;
                setResult(response.result);
                if (page) queueSourceAdmissions(page, response.result.outcomes);
                await admitQueued();
              }
            });
          }}
          onReview={() => setStage('review')}
          onReadVote={(row) => void readVote(row)}
        />
      ) : null}
      {stage === 'results' && !result ? <p role="status">{m.library_mal_retry_original_help()}</p> : null}
      {stage === 'review' && result ? (
        <MalAction type="button" onClick={() => setStage('results')}>
          {m.library_mal_label_results()}
        </MalAction>
      ) : null}
      {uploadId.current ? (
        <MalAction
          type="button"
          variant="outline"
          disabled={locked}
          onClick={async () => {
            const id = uploadId.current!;
            const command: Extract<MalCommand, { kind: 'cancel' }> = {
              kind: 'cancel',
              id,
              key: newCommandKey(),
            };
            const response = await run(command, () => port.cancel(command));
            if (response?.kind === 'done' && live()) {
              acceptCancellation();
              await loadPage(id, after);
            }
          }}
        >
          {m.library_mal_label_cancel()}
        </MalAction>
      ) : null}
      {uploadId.current ? (
        <MalAction type="button" variant="outline" disabled={locked} onClick={() => void discard()}>
          {m.library_mal_discard()}
        </MalAction>
      ) : null}
      {stage !== 'results' ? <ImportReturn /> : null}
      <MalDeparture active={!!uploadId.current} locked={locked} onDiscard={() => void discard()} />
    </main>
  );
}
