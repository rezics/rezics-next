import type { CommandEvent, CommandTransaction } from '../command/command.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import type { IdentityRepairPage } from './identity-work-frame.ts';
import { identityRoute } from './identity-work-frame.ts';
import { RatingIdentityVotePending, type RatingIdentityMapping } from './segment-identity-guard.ts';
import { populationsForVoteKey } from './voter-realms.ts';
import readCapped from './voter-realms-capped.sql';
import lockVote from './vote-lock.sql';
import lockCounted from './vote-counted-target-lock.sql';
import setCounted from './vote-counted-target-set.sql';

/** This writer changes counted identity only. Original vote units, revision, time and key survive repair. */
export async function applyRatingIdentityPage(
  tx: CommandTransaction,
  page: IdentityRepairPage,
  mappings: readonly RatingIdentityMapping[],
): Promise<CommandEvent[]> {
  const route = identityRoute(page.voterId);
  const realms = await readCapped.run(tx, { route, voter_id: page.voterId });
  const events: CommandEvent[] = [];
  const destinations = new Map(mappings.map((mapping) => [mapping.originalId, mapping.terminalId]));
  const populations = (vote: { questionId: string; targetId: string }) => [
    ...new Set([GLOBAL_CONTEXT.id, ...populationsForVoteKey(vote, realms)]),
  ];
  const key = { route, voter_id: page.voterId };
  type Row = NonNullable<Awaited<ReturnType<typeof lockVote.run>>>;
  const change = async (vote: Row, terminal: string | null, revision: number) => {
    const result = await setCounted.run(tx, {
      ...key,
      question_id: vote.questionId,
      target_id: vote.targetId,
      expected_counted_target: vote.countedTarget,
      counted_target: terminal,
      counted_revision: revision,
    });
    if (!result) throw new Error('Rating identity vote changed while locked');
  };
  const emit = (vote: Row, target: string, units: number | null, revision: number) => {
    events.push({
      type: 'com.rezics.rating.vote.changed.v1',
      subject: page.voterId,
      data: {
        voterId: page.voterId,
        questionId: vote.questionId,
        targetId: vote.targetId,
        ...(target === vote.targetId ? {} : { aggregateTargetId: target }),
        previous: vote.units === null ? null : Number(vote.units),
        units,
        revision,
        populations: populations(vote),
      },
    });
  };
  for (const selected of page.votes) {
    // A preceding item may have displaced this row. Use the live row after validating the entire selection.
    const source = await lockVote.run(tx, { ...key, question_id: selected.questionId, target_id: selected.targetId });
    if (!source) throw new Error('Rating identity selected vote disappeared');
    const terminal = page.mode === 'withdrawal' ? null : destinations.get(source.targetId);
    if (terminal === undefined) throw new Error('Rating identity currentness omitted an original');
    if (terminal === null) {
      if (source.countedTarget !== null) {
        const revision = Number(source.countedRevision) + 1;
        await change(source, null, revision);
        emit(source, source.countedTarget, null, revision);
      }
      continue;
    }
    const targetVote =
      terminal === source.targetId
        ? source
        : await lockVote.run(tx, {
            ...key,
            question_id: source.questionId,
            target_id: terminal,
          });
    const current = await lockCounted.run(tx, { ...key, question_id: source.questionId, counted_target: terminal });
    let currentMatches = true;
    if (current && current.targetId !== source.targetId && current.targetId !== terminal && !targetVote) {
      const currentTerminal = destinations.get(current.targetId);
      if (currentTerminal === undefined)
        throw new RatingIdentityVotePending('competing-original-currentness-unavailable');
      currentMatches = currentTerminal === terminal;
    }
    // An explicit vote at the terminal, including a clear, always supersedes a redirected original.
    const wins =
      !(targetVote && targetVote.targetId !== source.targetId) &&
      (!current || current.targetId === source.targetId || !currentMatches || newerOriginal(source, current));
    const desired = wins ? terminal : null;
    if (source.countedTarget === desired) continue;
    let revision = Number(source.countedRevision);
    if (source.countedTarget !== null) {
      await change(source, null, ++revision);
      emit(source, source.countedTarget, null, revision);
    }
    if (!wins) continue;
    if (current && current.targetId !== source.targetId) {
      const removal = Number(current.countedRevision) + 1;
      await change(current, null, removal);
      emit(current, terminal, null, removal);
      revision = Math.max(revision, removal);
    }
    // A removal and addition at different destinations have distinct ordered revisions.
    await change({ ...source, countedTarget: null }, terminal, ++revision);
    emit(source, terminal, source.units === null ? null : Number(source.units), revision);
  }
  return events;
}

function newerOriginal(
  candidate: { changedAt: string | null; targetId: string },
  current: { changedAt: string | null; targetId: string },
): boolean {
  if (candidate.changedAt === null || current.changedAt === null)
    throw new Error('Rating identity current vote has no timestamp');
  return (
    candidate.changedAt > current.changedAt ||
    (candidate.changedAt === current.changedAt && candidate.targetId < current.targetId)
  );
}
