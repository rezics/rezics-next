import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/data';
import type { CandidateTransport } from '../../subject/candidate-review';
import {
  applyReuse,
  captureReuse,
  cloneReferenceGroup,
  type ReuseCapture,
  type ReuseRefusal,
  type ReuseSource,
} from './reference-reuse';
import { ReferenceReusePanel } from './reference-reuse-view';
import { FactsChangedReview, FactsResultBoard } from './subject-facts-review';
import {
  factHolder,
  factLimit,
  includedChanges,
  projectChangedSet,
  type ChangedSetReview,
  type FactDraft,
  type FactResult,
  type FactsCurrent,
} from './subject-facts';
import { GameClassificationReuseNotes } from './game-classification-view';

const wrap =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 [@media(max-width:639px)_and_(pointer:coarse)]:min-h-11';

export type GameReuseSession = {
  source: ReuseSource;
  selected: string[];
  capture: ReuseCapture;
  applied: { holder: string; property: string; index: number }[];
  refused: { holder: string; property: string; reason: ReuseRefusal }[];
  trigger: HTMLButtonElement | null;
};

export type GameCopiedGroup = {
  holder: string;
  sourceHolder: string;
  sourceProperty: string;
  index: number;
};

export type GameOrphanDiagnostic = { holder: string; property: string; result: FactResult };

export function bindGameClassificationReview(
  review: (property: string, session?: string) => CandidateTransport,
  reread: (() => Promise<void>) | undefined,
  live: () => boolean,
  onSelected: (property: string) => void,
): (property: string, session?: string) => CandidateTransport {
  return (property, session) => {
    const transport = review(property, session);
    return {
      ...transport,
      confirm: async (command, work) => {
        const result = await transport.confirm(command, work);
        if (result.ok && result.kind === 'selected' && live()) {
          await reread?.();
          if (live()) onSelected(property);
        }
        return result;
      },
    };
  };
}

export function GameClassificationReviewControls({
  drafts,
  admitted,
  read,
  locale,
  busy,
  review,
  copies,
  orphans,
  onReview,
  onSubmit,
  onJump,
}: {
  drafts: FactDraft[];
  admitted: readonly string[];
  read: FactsCurrent;
  locale: string;
  busy: boolean;
  review: ChangedSetReview;
  copies: GameCopiedGroup[];
  orphans: GameOrphanDiagnostic[];
  onReview: () => void;
  onSubmit: () => void;
  onJump: (holder: string) => void;
}) {
  const o = { locale: locale as never };
  const pending = drafts.filter((draft) => admitted.includes(draft.property));
  const changed = includedChanges(pending);
  const unsealed = changed.some((draft) => !draft.command);
  const staleResult = pending.some(
    (draft) => draft.result && !draft.result.ok && draft.result.reason === 'stale',
  );
  const submitDisabled = busy || !changed.length || staleResult || (unsealed && review.status !== 'current');
  return (
    <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl bg-card p-4 sm:p-5">
      {review.status !== 'closed' && (
        <FactsChangedReview
          items={projectChangedSet(pending)}
          read={read}
          locale={locale}
          stale={review.status === 'stale'}
          onJump={onJump}
        />
      )}
      {review.status !== 'closed' && (
        <GameClassificationReuseNotes copies={copies} drafts={pending} read={read} locale={locale} />
      )}
      {orphans.map((item) => (
        <p key={item.holder} role="status" className="text-sm">
          {m.game_classification_removed_diagnostic(
            {
              field: pageText(read.release.properties[item.property]?.labels, locale).text || item.property,
            },
            o,
          )}
        </p>
      ))}
      <FactsResultBoard drafts={drafts} read={read} locale={locale} />
      <ContentItemHeading level={2} className="text-lg font-semibold">
        {m.facts_selection({ count: changed.length, limit: factLimit }, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.facts_separate_results({}, o)}</p>
      <div className="flex min-w-0 flex-wrap gap-2">
        <Button type="button" variant="outline" className={wrap} disabled={busy || !changed.length} onClick={onReview}>
          {m.facts_review({}, o)}
        </Button>
        <Button type="button" className={wrap} disabled={submitDisabled} onClick={onSubmit}>
          {m.facts_submit({}, o)}
        </Button>
      </div>
    </ContentItemFrame>
  );
}

export function GameClassificationReuse({
  reuse,
  drafts,
  read,
  locale,
  onSelected,
  onRefresh,
  onApply,
  onCancel,
  onOpen,
}: {
  reuse: GameReuseSession;
  drafts: FactDraft[];
  read: FactsCurrent;
  locale: string;
  onSelected: (holders: string[]) => void;
  onRefresh: () => void;
  onApply: () => void;
  onCancel: () => void;
  onOpen: (holder: string, index: number) => void;
}) {
  return (
    <ReferenceReusePanel
      source={reuse.source}
      drafts={drafts}
      selected={reuse.selected}
      read={read}
      locale={locale}
      capture={reuse.capture}
      applied={reuse.applied}
      refused={reuse.refused}
      onSelected={onSelected}
      onRefresh={onRefresh}
      onApply={onApply}
      onCancel={onCancel}
      onOpen={onOpen}
    />
  );
}

export function openGameReuse(draft: FactDraft, index: number, drafts: FactDraft[]): GameReuseSession | null {
  const group = draft.statement.references[index];
  if (!group) return null;
  const source = {
    holder: factHolder(draft),
    property: draft.property,
    groupIndex: index,
    snapshot: cloneReferenceGroup(group),
  };
  return {
    source,
    selected: [],
    capture: captureReuse(source, drafts),
    applied: [],
    refused: [],
    trigger: document.activeElement instanceof HTMLButtonElement ? document.activeElement : null,
  };
}

export function refreshGameReuse(reuse: GameReuseSession, drafts: FactDraft[]): GameReuseSession | null {
  const origin = drafts.find((draft) => factHolder(draft) === reuse.source.holder);
  const group = origin?.statement.references[reuse.source.groupIndex];
  if (!origin || !group) return null;
  const source = { ...reuse.source, snapshot: cloneReferenceGroup(group) };
  return { ...reuse, source, capture: captureReuse(source, drafts), applied: [], refused: [] };
}

export function applyGameReuse(
  drafts: FactDraft[],
  reuse: GameReuseSession,
  release: FactsCurrent['release'],
): {
  drafts: FactDraft[];
  reuse: GameReuseSession;
  copies: GameCopiedGroup[];
} {
  const result = applyReuse(drafts, reuse.source, reuse.selected, release);
  return {
    drafts: result.drafts,
    reuse: { ...reuse, applied: result.applied, refused: result.refused },
    copies: result.applied.map((item) => ({
      holder: item.holder,
      sourceHolder: reuse.source.holder,
      sourceProperty: reuse.source.property,
      index: item.index,
    })),
  };
}
