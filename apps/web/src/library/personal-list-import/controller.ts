import {
  freezeVndbCommand,
  newVndbKey,
  VNDB_ID,
  type VndbApplyRow,
  type VndbCommand,
  type VndbFailure,
  type VndbOutcome,
  type VndbPage,
  type VndbPort,
  type VndbPreview,
  type VndbReviewResult,
  type VndbReviewInput,
  type VndbRow,
  type VndbScoreDecision,
  type VndbUnknown,
} from './contract';
import type { VndbVisit } from './visit';

export type VndbStage = 'upload' | 'review' | 'confirm' | 'applying' | 'results' | 'removed';
export type VndbNotice = VndbFailure | VndbUnknown | { kind: 'file-read' } | null;
export type VndbScoreNotice = {
  ordinal: number;
  reason: string;
  reviewId?: string;
  targetId?: string;
};
export type VndbEffect = {
  ordinal: number;
  kind: 'entry-state' | 'score';
  reviewId: string;
  targetId: string | null;
  status: string;
};
export type VndbJourneySnapshot = {
  stage: VndbStage;
  busy: boolean;
  notice: VndbNotice;
  uploadId: string | null;
  total: number;
  page: VndbPage | null;
  rows: VndbRow[];
  selection: VndbRow[];
  selectedEffects: number;
  outcomes: VndbOutcome[];
  settledEffects: VndbEffect[];
  unattempted: number[];
  unattemptedEffects: VndbEffect[];
  applying: number;
  applied: number;
  cancelled: boolean;
  stopped: 'cancelled' | 'deadline' | null;
  limits: VndbPreview['limits'] | null;
  sourceXML: string | null;
  sourceVisible: boolean;
  retryCommand: VndbCommand['kind'] | null;
  pendingOrdinals: number[];
  pendingEffects: VndbEffect[];
  scoreNotices: VndbScoreNotice[];
  reviewCurrent: boolean;
  offset: number;
};

function outcomeReviewId(outcome: VndbOutcome): string {
  return typeof outcome.reviewId === 'string' ? outcome.reviewId : outcome.scoreReviewId!;
}

function effectKey(ordinal: number, reviewId: string, kind: VndbEffect['kind']): string {
  return `${ordinal}:${kind}:${reviewId}`;
}

function outcomeKey(outcome: VndbOutcome): string {
  return effectKey(outcome.ordinal, outcomeReviewId(outcome), 'scoreReviewId' in outcome ? 'score' : 'entry-state');
}

function sameCommand(left: VndbCommand, right: VndbCommand): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isVndbUnknown(value: unknown): value is VndbUnknown {
  return (
    typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'unknown' && 'command' in value
  );
}

function rowEffects(row: VndbRow): VndbEffect[] {
  const effects: VndbEffect[] = [];
  const score = scoreDecision(row);
  if (row.decision && ['reviewed', 'skipped', 'unsupported'].includes(row.decision.status)) {
    effects.push({
      ordinal: row.ordinal,
      kind: 'entry-state',
      reviewId: row.decision.reviewId,
      targetId: row.decision.targetId,
      status: row.decision.status,
    });
  }
  if (score?.status === 'reviewed') {
    effects.push({
      ordinal: row.ordinal,
      kind: 'score',
      reviewId: score.reviewId,
      targetId: score.targetId,
      status: score.status,
    });
  }
  return effects;
}

function scoreReviewMatchesPreview(row: VndbRow): boolean {
  const decision = scoreDecision(row);
  const question = row.nativeScore.question;
  if (!decision || decision.status !== 'reviewed' || !question || !row.target) return false;
  return (
    decision.targetId === row.target.targetId &&
    decision.question.id === question.id &&
    decision.question.revision === question.revision &&
    decision.question.meaning === question.meaning &&
    JSON.stringify(decision.question.scale) === JSON.stringify(question.scale) &&
    JSON.stringify(decision.currentVote) === JSON.stringify(row.nativeScore.currentVote)
  );
}

function scoreDecision(row: VndbRow): VndbScoreDecision | null {
  const decision = row.scoreDecision;
  return decision && 'action' in decision && (decision.action === 'vote' || decision.action === 'clear')
    ? decision
    : null;
}

function effectRow(effect: VndbEffect): VndbApplyRow {
  return effect.kind === 'score'
    ? { ordinal: effect.ordinal, scoreReviewId: effect.reviewId }
    : { ordinal: effect.ordinal, reviewId: effect.reviewId };
}

function unappliedEffects(rows: VndbRow[], outcomes: Map<string, VndbOutcome>): VndbEffect[] {
  return rows
    .flatMap(rowEffects)
    .filter((effect) => !outcomes.has(effectKey(effect.ordinal, effect.reviewId, effect.kind)))
    .sort((a, b) => a.ordinal - b.ordinal || a.kind.localeCompare(b.kind));
}

function effectsFromCommands(
  commands: readonly Extract<VndbCommand, { kind: 'apply' }>[],
  rows: readonly VndbRow[],
): VndbEffect[] {
  const byOrdinal = new Map(rows.map((row) => [row.ordinal, row]));
  return commands.flatMap((command) =>
    command.body.rows.flatMap((row) => {
      const effects: VndbEffect[] = [];
      const current = byOrdinal.get(row.ordinal);
      if (row.reviewId) {
        effects.push({
          ordinal: row.ordinal,
          kind: 'entry-state',
          reviewId: row.reviewId,
          targetId: current?.decision?.reviewId === row.reviewId ? current.decision.targetId : null,
          status: 'pending',
        });
      }
      if (row.scoreReviewId) {
        const score = current ? scoreDecision(current) : null;
        effects.push({
          ordinal: row.ordinal,
          kind: 'score',
          reviewId: row.scoreReviewId,
          targetId: score?.reviewId === row.scoreReviewId ? score.targetId : null,
          status: 'pending',
        });
      }
      return effects;
    }),
  );
}

function outcomeEffects(outcomes: readonly VndbOutcome[], rows: readonly VndbRow[]): VndbEffect[] {
  const byOrdinal = new Map(rows.map((row) => [row.ordinal, row]));
  return outcomes.map((outcome) => {
    const score = 'scoreReviewId' in outcome;
    const id = outcomeReviewId(outcome);
    const row = byOrdinal.get(outcome.ordinal);
    const decision = row ? scoreDecision(row) : null;
    const targetId = score
      ? decision?.reviewId === id
        ? decision.targetId
        : null
      : row?.decision?.reviewId === id
        ? row.decision.targetId
        : null;
    return {
      ordinal: outcome.ordinal,
      kind: score ? 'score' : 'entry-state',
      reviewId: id,
      targetId,
      status: outcome.status,
    };
  });
}

function applyBatches(effects: readonly VndbEffect[]): VndbApplyRow[][] {
  const batches: VndbApplyRow[][] = [];
  let batch: VndbApplyRow[] = [];
  for (const effect of effects) {
    if (batch.length === 8 || batch.some((row) => row.ordinal === effect.ordinal)) {
      batches.push(batch);
      batch = [];
    }
    batch.push(effectRow(effect));
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function isScoreDecision(value: VndbReviewResult): value is VndbScoreDecision {
  return 'action' in value && (value.action === 'vote' || value.action === 'clear');
}

function scoreReviewFitsPreview(row: VndbRow, body: Extract<VndbReviewInput, { action: 'score' }>): boolean {
  const { question, currentVote, exactUnits } = row.nativeScore;
  if (
    row.kind !== 'vn' ||
    !row.target ||
    row.target.targetId !== body.targetId ||
    !question ||
    question.grain !== 'work' ||
    !question.meaning?.trim() ||
    question.id !== body.questionId ||
    question.revision !== body.questionRevision ||
    currentVote.state === 'unavailable'
  )
    return false;
  if (body.selection.kind === 'clear') return currentVote.state === 'set' && body.consent === 'clear-native-vote';
  const source = row.fields.score;
  return (
    body.consent === 'adopt-native-vote' &&
    source?.kind === 'value' &&
    typeof source.value === 'number' &&
    source.scale?.min === 1 &&
    source.scale.max === 10 &&
    source.scale.step === 0.1 &&
    exactUnits !== null &&
    exactUnits === body.selection.units &&
    Number.isSafeInteger(exactUnits) &&
    exactUnits >= question.scale.min &&
    exactUnits <= question.scale.max &&
    (exactUnits - question.scale.min) % question.scale.step === 0
  );
}

export function createVndbJourney(input: { port: VndbPort; visit: VndbVisit }) {
  const { port, visit } = input;
  const sender = { subject: visit.subject, csrfToken: visit.csrfToken };
  let stage: VndbStage = 'upload';
  let pending = 0;
  let notice: VndbNotice = null;
  let uploadId: string | null = null;
  let total = 0;
  let page: VndbPage | null = null;
  let pageOffset = 0;
  const rows = new Map<number, VndbRow>();
  const outcomes = new Map<string, VndbOutcome>();
  const effectReferences = new Map<string, VndbEffect>();
  let retiredUnattempted: VndbEffect[] = [];
  const scoreNotices = new Map<number, VndbScoreNotice>();
  let applyQueue: Extract<VndbCommand, { kind: 'apply' }>[] = [];
  let currentApply: Extract<VndbCommand, { kind: 'apply' }> | null = null;
  let confirmed: Extract<VndbCommand, { kind: 'apply' }>[] = [];
  let unknown: VndbCommand | null = null;
  let pendingPreview: Extract<VndbCommand, { kind: 'preview' }> | null = null;
  let replacementXML: string | null = null;
  let limits: VndbPreview['limits'] | null = null;
  let cancelled = false;
  let stopped: 'cancelled' | 'deadline' | null = null;
  let stopApply = false;
  let applying = 0;
  let sourceXML: string | null = null;
  let sourceVisible = false;
  let sourceRetired = false;
  let retired = false;
  let generation = 0;

  function live(): boolean {
    if (!retired && (!visit.current() || sender.subject !== visit.subject || sender.csrfToken !== visit.csrfToken)) {
      retired = true;
      clearForReplacement();
    }
    return !retired;
  }

  function selection(): VndbRow[] {
    return [...rows.values()]
      .filter((row) =>
        rowEffects(row).some((effect) => !outcomes.has(effectKey(effect.ordinal, effect.reviewId, effect.kind))),
      )
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  function rememberRowEffects(row: VndbRow): void {
    for (const effect of rowEffects(row))
      effectReferences.set(effectKey(effect.ordinal, effect.reviewId, effect.kind), effect);
  }

  function snapshot(): VndbJourneySnapshot {
    if (!live()) clearForReplacement();
    const receipts = [...outcomes.values()].sort((a, b) => a.ordinal - b.ordinal);
    const selected = [...rows.values()].sort((a, b) => a.ordinal - b.ordinal);
    const unattemptedEffects = selected.length
      ? unappliedEffects(selected, outcomes)
      : retiredUnattempted.filter((effect) => !outcomes.has(effectKey(effect.ordinal, effect.reviewId, effect.kind)));
    const pendingEffects = currentApply
      ? effectsFromCommands([currentApply], selected).filter(
          (effect) => !outcomes.has(effectKey(effect.ordinal, effect.reviewId, effect.kind)),
        )
      : [];
    for (const effect of pendingEffects) {
      const remembered = effectReferences.get(effectKey(effect.ordinal, effect.reviewId, effect.kind));
      if (remembered) Object.assign(effect, remembered);
    }
    const unattempted = [...new Set(unattemptedEffects.map((effect) => effect.ordinal))];
    const selectedEffects = unappliedEffects(selection(), outcomes).length;
    return {
      stage,
      busy: live() && pending > 0,
      notice,
      uploadId,
      total,
      page,
      rows: selected,
      selection: selection(),
      selectedEffects,
      outcomes: receipts,
      settledEffects: outcomeEffects(receipts, selected).map(
        (effect) => effectReferences.get(effectKey(effect.ordinal, effect.reviewId, effect.kind)) ?? effect,
      ),
      unattempted,
      unattemptedEffects,
      applying,
      applied: receipts.filter((item) => item.status === 'applied').length,
      cancelled,
      stopped,
      limits,
      sourceXML,
      sourceVisible,
      retryCommand: unknown?.kind ?? null,
      pendingOrdinals: [...new Set(pendingEffects.map((effect) => effect.ordinal))],
      pendingEffects,
      scoreNotices: [...scoreNotices.values()],
      reviewCurrent: !!page && !sourceRetired && !cancelled,
      offset: pageOffset,
    };
  }

  function clearForReplacement(): void {
    notice = null;
    uploadId = null;
    total = 0;
    page = null;
    pageOffset = 0;
    rows.clear();
    outcomes.clear();
    effectReferences.clear();
    retiredUnattempted = [];
    scoreNotices.clear();
    applyQueue = [];
    currentApply = null;
    confirmed = [];
    unknown = null;
    pendingPreview = null;
    replacementXML = null;
    limits = null;
    cancelled = false;
    stopped = null;
    stopApply = false;
    applying = 0;
    sourceXML = null;
    sourceVisible = false;
    sourceRetired = false;
    stage = 'upload';
  }

  function retirePrivateReview(): void {
    if (rows.size) retiredUnattempted = unappliedEffects([...rows.values()], outcomes);
    page = null;
    rows.clear();
    scoreNotices.clear();
    sourceXML = null;
    sourceVisible = false;
    sourceRetired = true;
    confirmed = [];
  }

  async function run<T extends { kind: string }>(
    command: VndbCommand,
    send: () => Promise<T | VndbFailure | VndbUnknown>,
    options: { retry?: boolean; concurrent?: boolean } = {},
  ): Promise<T | VndbFailure | VndbUnknown | undefined> {
    if (!live() || (pending > 0 && !options.concurrent) || (unknown !== null && !options.retry)) return undefined;
    pending += 1;
    let response: T | VndbFailure | VndbUnknown;
    try {
      response = await send();
    } catch {
      response = { kind: 'unknown', command };
    }
    pending -= 1;
    if (!live()) return undefined;
    if (isVndbUnknown(response)) {
      unknown = command;
      notice = { kind: 'unknown', command };
      return notice;
    }
    if ('status' in response) {
      if (unknown && !sameCommand(unknown, command)) {
        notice = { kind: 'unknown', command: unknown };
        return response;
      }
      // Refusal does not authorize a different apply or cleanup command on retry.
      unknown = command.kind === 'apply' || command.kind === 'delete' ? command : null;
      notice = response;
      if (command.kind === 'preview') pendingPreview = null;
      return response;
    }
    if (unknown && !sameCommand(unknown, command)) {
      notice = { kind: 'unknown', command: unknown };
      return response;
    }
    unknown = null;
    notice = null;
    return response;
  }

  async function loadPage(offset: number, retry = false): Promise<VndbJourneySnapshot> {
    const id = uploadId;
    if (!id || !live() || sourceRetired) return snapshot();
    const command: Extract<VndbCommand, { kind: 'page' }> = { kind: 'page', uploadId: id, offset };
    const ticket = generation;
    const response = await run(command, () => port.page(command), { retry });
    if (ticket !== generation) return snapshot();
    if (response && 'status' in response && ['denied', 'not-found', 'conflict'].includes(response.kind)) {
      generation += 1;
      retirePrivateReview();
      stage = 'results';
    }
    if (!response || response.kind !== 'page' || !live()) return snapshot();
    if (
      response.value.uploadId !== id ||
      response.value.total > 5000 ||
      new Set(response.value.rows.map((row) => row.ordinal)).size !== response.value.rows.length ||
      response.value.rows.some(
        (row) => row.ordinal < offset || row.ordinal >= offset + 8 || row.ordinal >= response.value.total,
      )
    ) {
      unknown = command;
      notice = { kind: 'unknown', command };
      return snapshot();
    }
    confirmed = [];
    page = response.value;
    pageOffset = offset;
    total = response.value.total;
    for (const row of response.value.rows) {
      const decision = scoreDecision(row);
      if (decision?.status === 'reviewed' && !scoreReviewMatchesPreview(row)) {
        scoreNotices.set(row.ordinal, {
          ordinal: row.ordinal,
          reason: 'native-current-vote-changed',
          reviewId: decision.reviewId,
          targetId: decision.targetId,
        });
        const refreshed = { ...row, scoreDecision: null };
        rows.set(row.ordinal, refreshed);
        rememberRowEffects(refreshed);
      } else {
        rows.set(row.ordinal, row);
        rememberRowEffects(row);
      }
    }
    page = { ...response.value, rows: response.value.rows.map((row) => rows.get(row.ordinal) ?? row) };
    cancelled = response.value.state === 'cancelled';
    if (cancelled) {
      stage = 'results';
      retirePrivateReview();
    } else stage = 'review';
    return snapshot();
  }

  async function sendPreview(
    command: Extract<VndbCommand, { kind: 'preview' }>,
    retry = false,
  ): Promise<VndbJourneySnapshot> {
    pendingPreview = command;
    const response = await run(command, () => port.preview(command), { retry });
    if (!response || response.kind !== 'previewed' || !live()) return snapshot();
    pendingPreview = null;
    replacementXML = null;
    uploadId = response.value.uploadId;
    total = response.value.rows;
    limits = response.value.limits;
    stage = 'review';
    return loadPage(0);
  }

  async function preview(xml: string): Promise<VndbJourneySnapshot> {
    if (!live() || pending > 0 || unknown) return snapshot();
    const command: Extract<VndbCommand, { kind: 'preview' }> = { kind: 'preview', key: newVndbKey(), xml };
    generation += 1;
    pendingPreview = command;
    if (uploadId) {
      const previousUploadId = uploadId;
      // Replacement retires private review authority before cleanup can fail or lose its acknowledgement.
      clearForReplacement();
      uploadId = previousUploadId;
      sourceRetired = true;
      pendingPreview = command;
      replacementXML = xml;
      const remove: Extract<VndbCommand, { kind: 'delete' }> = {
        kind: 'delete',
        uploadId,
        key: newVndbKey(),
      };
      const response = await run(remove, () => port.delete(remove));
      if (!response || response.kind !== 'deleted' || !live()) {
        return snapshot();
      }
      clearForReplacement();
    }
    return sendPreview(command);
  }

  async function source(retryCommand?: Extract<VndbCommand, { kind: 'source' }>): Promise<VndbJourneySnapshot> {
    if (!uploadId || !live() || sourceRetired || (pending > 0 && !retryCommand)) return snapshot();
    const command = retryCommand ?? { kind: 'source' as const, uploadId };
    const response = await run(command, () => port.source(command), { retry: !!retryCommand });
    if (response?.kind === 'source' && live()) {
      sourceXML = response.xml;
      sourceVisible = true;
    }
    return snapshot();
  }

  function hideSource(): VndbJourneySnapshot {
    sourceVisible = false;
    return snapshot();
  }

  function replaceSource(): VndbJourneySnapshot {
    if (!live() || pending > 0 || unknown) return snapshot();
    const previousUploadId = uploadId;
    generation += 1;
    clearForReplacement();
    uploadId = previousUploadId;
    sourceRetired = true;
    return snapshot();
  }

  function retire(): void {
    retired = true;
    clearForReplacement();
  }

  async function review(
    body: VndbReviewInput,
    retryCommand?: Extract<VndbCommand, { kind: 'review' }>,
  ): Promise<VndbJourneySnapshot> {
    if (
      !uploadId ||
      !live() ||
      sourceRetired ||
      cancelled ||
      stage === 'applying' ||
      (pending > 0 && !retryCommand) ||
      (unknown && !retryCommand)
    )
      return snapshot();
    const row = rows.get(body.ordinal);
    if (!row || (row.kind === 'retained' && body.action === 'state')) return snapshot();
    if (body.action === 'state' && (typeof body.targetId !== 'string' || !VNDB_ID.test(body.targetId) || !body.state))
      return snapshot();
    if (body.action === 'score' && !scoreReviewFitsPreview(row, body)) return snapshot();
    const command = retryCommand ?? freezeVndbCommand({ kind: 'review', uploadId, key: newVndbKey(), body });
    // A replacement review withdraws the prior confirmation even if admission is refused.
    stage = 'review';
    confirmed = [];
    const pendingRow: VndbRow = body.action === 'score' ? { ...row, scoreDecision: null } : { ...row, decision: null };
    if (body.action === 'score') scoreNotices.delete(row.ordinal);
    rows.set(row.ordinal, pendingRow);
    if (page) page = { ...page, rows: page.rows.map((item) => (item.ordinal === row.ordinal ? pendingRow : item)) };
    const response = await run(command, () => port.review(command), { retry: !!retryCommand });
    if (response?.kind !== 'reviewed' || !live()) return snapshot();
    if (body.action === 'score') {
      if (isScoreDecision(response.value)) {
        // A refreshed vote basis can differ from the preview the reader approved.
        // Require another explicit review before this new basis can be selected.
        const prior = row.nativeScore.currentVote;
        if (JSON.stringify(prior) !== JSON.stringify(response.value.currentVote)) {
          scoreNotices.set(row.ordinal, {
            ordinal: row.ordinal,
            reason: 'native-current-vote-changed',
            reviewId: response.value.reviewId,
            targetId: response.value.targetId,
          });
          const updated = {
            ...pendingRow,
            nativeScore: { ...row.nativeScore, currentVote: response.value.currentVote },
          };
          rows.set(row.ordinal, updated);
          if (page) page = { ...page, rows: page.rows.map((item) => (item.ordinal === row.ordinal ? updated : item)) };
          return snapshot();
        }
        const updated: VndbRow = { ...row, scoreDecision: response.value };
        rows.set(row.ordinal, updated);
        rememberRowEffects(updated);
        if (page) page = { ...page, rows: page.rows.map((item) => (item.ordinal === row.ordinal ? updated : item)) };
      } else if ('reason' in response.value) {
        scoreNotices.set(row.ordinal, { ordinal: row.ordinal, reason: response.value.reason });
      }
    } else if (!isScoreDecision(response.value) && !('reason' in response.value)) {
      const updated: VndbRow = { ...row, decision: response.value };
      rows.set(row.ordinal, updated);
      rememberRowEffects(updated);
      if (page) page = { ...page, rows: page.rows.map((item) => (item.ordinal === row.ordinal ? updated : item)) };
    }
    stage = 'review';
    return snapshot();
  }

  async function applyBatch(command: Extract<VndbCommand, { kind: 'apply' }>, retry = false): Promise<boolean> {
    if (!live()) return false;
    const ticket = generation;
    currentApply = command;
    applying = command.body.rows.reduce((sum, row) => sum + Number(!!row.reviewId) + Number(!!row.scoreReviewId), 0);
    const response = await run(command, () => port.apply(command), { retry });
    applying = 0;
    if (ticket !== generation) return false;
    if (!response || response.kind !== 'applied' || !live()) {
      if (live()) stage = 'results';
      return false;
    }
    const expected = new Set(
      command.body.rows.flatMap((row) => [
        ...(row.reviewId ? [effectKey(row.ordinal, row.reviewId, 'entry-state')] : []),
        ...(row.scoreReviewId ? [effectKey(row.ordinal, row.scoreReviewId, 'score')] : []),
      ]),
    );
    const received = response.value.outcomes.map(outcomeKey);
    if (
      response.value.uploadId !== command.uploadId ||
      new Set(received).size !== received.length ||
      received.some((key) => !expected.has(key))
    ) {
      unknown = command;
      notice = { kind: 'unknown', command };
      stage = 'results';
      return false;
    }
    for (const receipt of response.value.outcomes) {
      outcomes.set(outcomeKey(receipt), receipt);
    }
    stopped = response.value.stopped;
    if (stopped) {
      cancelled = stopped === 'cancelled';
      stage = 'results';
      if (cancelled) {
        stopApply = true;
        retirePrivateReview();
      }
      return false;
    }
    const complete = response.value.outcomes.length === expected.size;
    if (!complete) {
      const held = { kind: 'unknown' as const, command };
      unknown = command;
      notice = held;
      stage = 'results';
      return false;
    }
    applyQueue.shift();
    currentApply = applyQueue[0] ?? null;
    return true;
  }

  async function continueApply(retryCommand?: Extract<VndbCommand, { kind: 'apply' }>): Promise<VndbJourneySnapshot> {
    if (!live() || (stopApply && !retryCommand)) return snapshot();
    if (retryCommand) {
      const done = await applyBatch(retryCommand, true);
      if (!done) return snapshot();
    }
    while (applyQueue.length && live() && !stopApply) {
      const command = applyQueue[0]!;
      const done = await applyBatch(command);
      if (!done) break;
    }
    if (live() && !unknown) stage = 'results';
    return snapshot();
  }

  function openConfirm(): VndbJourneySnapshot {
    const effects = unappliedEffects(selection(), outcomes);
    if (stage !== 'review' || cancelled || pending > 0 || unknown || effects.length === 0) return snapshot();
    confirmed = applyBatches(effects).map((batch) =>
      freezeVndbCommand({ kind: 'apply', uploadId: uploadId!, body: { rows: batch } }),
    );
    stage = 'confirm';
    return snapshot();
  }

  async function backToReview(): Promise<VndbJourneySnapshot> {
    if (stage === 'applying' || !uploadId || unknown || sourceRetired || cancelled) return snapshot();
    confirmed = [];
    stage = 'results';
    return loadPage(pageOffset);
  }

  async function confirm(): Promise<VndbJourneySnapshot> {
    if (!uploadId || cancelled || !live() || stage !== 'confirm' || pending > 0 || unknown) return snapshot();
    if (!confirmed.length) return snapshot();
    applyQueue = confirmed;
    confirmed = [];
    currentApply = applyQueue[0] ?? null;
    stopApply = false;
    stopped = null;
    stage = 'applying';
    return continueApply();
  }

  async function retryUnknown(): Promise<VndbJourneySnapshot> {
    const command = unknown;
    if (!command || !live() || pending > 0) return snapshot();
    if (command.kind === 'preview') return sendPreview(command, true);
    if (command.kind === 'page') return loadPage(command.offset, true);
    if (command.kind === 'source') return source(command);
    if (command.kind === 'review') return review(command.body, command);
    if (command.kind === 'apply') return continueApply(command);
    if (command.kind === 'cancel') {
      const response = await run(command, () => port.cancel(command), { retry: true, concurrent: true });
      if (response?.kind === 'cancelled') {
        const inFlight = stage === 'applying' ? currentApply : null;
        generation += 1;
        cancelled = true;
        stopped = 'cancelled';
        stage = 'results';
        retirePrivateReview();
        if (inFlight) {
          currentApply = inFlight;
          applyQueue = [inFlight];
          stopApply = true;
          unknown = inFlight;
          notice = { kind: 'unknown', command: inFlight };
        } else {
          currentApply = null;
          applyQueue = [];
        }
      }
      return snapshot();
    }
    const response = await run(command, () => port.delete(command), { retry: true });
    if (response?.kind === 'deleted') {
      const xml = replacementXML;
      const next = pendingPreview;
      const receipts = [...outcomes.values()];
      const references = [...effectReferences.entries()];
      const unsettled = rows.size ? unappliedEffects([...rows.values()], outcomes) : retiredUnattempted;
      clearForReplacement();
      if (xml === null) {
        receipts.forEach((receipt) => outcomes.set(outcomeKey(receipt), receipt));
        references.forEach(([key, effect]) => effectReferences.set(key, effect));
        retiredUnattempted = unsettled;
        stage = 'removed';
        return snapshot();
      }
      return sendPreview(next ?? { kind: 'preview', key: newVndbKey(), xml });
    }
    return snapshot();
  }

  async function resume(): Promise<VndbJourneySnapshot> {
    if (stopped !== 'deadline' || !currentApply || !live() || pending > 0) return snapshot();
    stopped = null;
    stage = 'applying';
    return continueApply(currentApply);
  }

  async function cancelAdmission(): Promise<VndbJourneySnapshot> {
    if (!uploadId || !live() || unknown || (pending > 0 && stage !== 'applying')) return snapshot();
    stopApply = true;
    const command: Extract<VndbCommand, { kind: 'cancel' }> = { kind: 'cancel', uploadId, key: newVndbKey() };
    const response = await run(command, () => port.cancel(command), { concurrent: true });
    if (response?.kind === 'cancelled' && live()) {
      const inFlight = stage === 'applying' ? currentApply : null;
      generation += 1;
      cancelled = true;
      stopped = 'cancelled';
      stage = 'results';
      retirePrivateReview();
      if (inFlight) {
        currentApply = inFlight;
        applyQueue = [inFlight];
        stopApply = true;
        unknown = inFlight;
        notice = { kind: 'unknown', command: inFlight };
      } else {
        currentApply = null;
        applyQueue = [];
      }
    }
    return snapshot();
  }

  async function discard(): Promise<VndbJourneySnapshot> {
    const id = uploadId;
    if (!id || !live() || pending > 0 || unknown) return snapshot();
    const command: Extract<VndbCommand, { kind: 'delete' }> = { kind: 'delete', uploadId: id, key: newVndbKey() };
    const response = await run(command, () => port.delete(command));
    if (response?.kind === 'deleted' && live()) {
      const receipts = [...outcomes.values()];
      const references = [...effectReferences.entries()];
      const unsettled = rows.size ? unappliedEffects([...rows.values()], outcomes) : retiredUnattempted;
      clearForReplacement();
      receipts.forEach((receipt) => outcomes.set(outcomeKey(receipt), receipt));
      references.forEach(([key, effect]) => effectReferences.set(key, effect));
      retiredUnattempted = unsettled;
      stage = 'removed';
    }
    return snapshot();
  }

  function retryVisibleSource(): Promise<VndbJourneySnapshot> {
    return unknown?.kind === 'source' ? source(unknown) : source();
  }

  function fileReadFailed(): VndbJourneySnapshot {
    notice = { kind: 'file-read' };
    return snapshot();
  }

  return {
    snapshot,
    preview,
    loadPage,
    source: retryVisibleSource,
    hideSource,
    replaceSource,
    review,
    openConfirm,
    backToReview,
    confirm,
    resume,
    retryUnknown,
    cancelAdmission,
    discard,
    fileReadFailed,
    retire,
    live,
  };
}

export type VndbJourney = ReturnType<typeof createVndbJourney>;
