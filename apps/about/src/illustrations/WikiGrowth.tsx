import { Badge } from '@rezics/ui/badge';
import { cn } from '@rezics/ui/utils';
import { BookOpen, Lock, MapPin, UserRound } from 'lucide-react';
import type { CSSProperties } from 'react';
import { fill } from '../i18n/fill.ts';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { Plate } from './Plate.tsx';
import { world } from './sample.ts';

/**
 * The reader's place at each stage: chapters 1, 4 and 9, then 11, one short of the reveal
 * in chapter 12, which the wiki records but does not show them.
 */
export const wikiStages = [1, 4, 9, 11] as const;
export type WikiStage = 1 | 2 | 3 | 4;

type NodeId = 'kaede' | 'archive' | 'ren' | 'iori';
const nodes: Record<
  NodeId,
  { x: number; y: number; stage: WikiStage; kind: 'character' | 'place' }
> = {
  kaede: { x: 24, y: 30, stage: 1, kind: 'character' },
  archive: { x: 72, y: 16, stage: 2, kind: 'place' },
  ren: { x: 74, y: 70, stage: 2, kind: 'character' },
  iori: { x: 22, y: 82, stage: 3, kind: 'character' },
};
type Relation = 'apprenticeAt' | 'keeps' | 'teaches' | 'rivals' | 'siblings';
const edges: { from: NodeId; to: NodeId; relation: Relation; chapter: number; stage: WikiStage }[] =
  [
    { from: 'kaede', to: 'archive', relation: 'apprenticeAt', chapter: 4, stage: 2 },
    { from: 'ren', to: 'archive', relation: 'keeps', chapter: 4, stage: 2 },
    { from: 'ren', to: 'kaede', relation: 'teaches', chapter: 9, stage: 3 },
    { from: 'iori', to: 'kaede', relation: 'rivals', chapter: 9, stage: 3 },
    { from: 'iori', to: 'ren', relation: 'siblings', chapter: 12, stage: 4 },
  ];

/** The newest entry at each stage, with the fact it adds and where the text says so. */
const facts: Record<WikiStage, { entity: NodeId; text: string; chapter: number }> = {
  1: {
    entity: 'kaede',
    text: 'Arrives at the archive to apprentice under its keeper.',
    chapter: 1,
  },
  2: { entity: 'archive', text: 'Lights one lantern for every book on loan.', chapter: 4 },
  3: { entity: 'iori', text: 'Competes with Kaede for the keeper’s post.', chapter: 9 },
  // Never rendered: the reader has not reached chapter 12, so the page carries no text to hide.
  4: { entity: 'iori', text: '', chapter: 12 },
};

/**
 * A Work's wiki growing with the story: at each stage the characters, places and
 * relations the text has stated so far, each citing its chapter. The newest arrive as
 * the step scrolls in; at the last stage the reveal is shown held back for readers who
 * have not reached its chapter.
 */
export function WikiGrowth({
  words,
  stage,
  className,
}: {
  words: IllustrationCopy;
  stage: WikiStage;
  className?: string;
}) {
  const w = words.wiki;
  const fact = facts[stage];
  const visible = (item: { stage: WikiStage }) => item.stage <= stage;
  return (
    <Plate className={cn('flex flex-col gap-5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p lang="en" className="font-work-title text-lg font-semibold">
          {world.archive}
        </p>
        <Badge variant="soft" size="md">
          <BookOpen aria-hidden />
          {fill(w.safeThrough, { n: wikiStages[stage - 1] })}
        </Badge>
      </div>
      <div className="relative aspect-[100/62] w-full rounded-2xl bg-background">
        <svg
          className="absolute inset-0 size-full text-foreground"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {edges.filter(visible).map((edge) => (
            <line
              key={edge.relation}
              x1={nodes[edge.from].x}
              y1={nodes[edge.from].y}
              x2={nodes[edge.to].x}
              y2={nodes[edge.to].y}
              stroke="currentColor"
              strokeOpacity={edge.stage === 4 ? 0.5 : 0.35}
              strokeDasharray={edge.stage === 4 ? '4 4' : undefined}
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
              data-arrive={edge.stage === stage ? '' : undefined}
            />
          ))}
        </svg>
        {edges.filter(visible).map((edge) => (
          <span
            key={edge.relation}
            data-arrive={edge.stage === stage ? '' : undefined}
            style={
              {
                left: `${(nodes[edge.from].x + nodes[edge.to].x) / 2}%`,
                top: `${(nodes[edge.from].y + nodes[edge.to].y) / 2}%`,
                '--at': 6,
              } as CSSProperties
            }
            className={cn(
              'absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs',
              edge.stage === 4
                ? 'border-dashed border-primary bg-card text-primary'
                : 'border-border bg-card text-muted-foreground',
            )}
          >
            {edge.stage === 4 ? <Lock aria-hidden className="size-3" /> : w[edge.relation]}
            <span className="font-semibold tabular-nums text-foreground">{edge.chapter}</span>
          </span>
        ))}
        {(Object.entries(nodes) as [NodeId, (typeof nodes)[NodeId]][])
          .filter(([, node]) => visible(node))
          .map(([id, node]) => {
            const Icon = node.kind === 'place' ? MapPin : UserRound;
            return (
              <span
                key={id}
                lang="en"
                data-arrive={node.stage === stage ? '' : undefined}
                style={{ left: `${node.x}%`, top: `${node.y}%` }}
                className={cn(
                  'absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-semibold shadow-(--aura-shadow-card)',
                  node.kind === 'place'
                    ? 'bg-(--cloth-wikis) text-(--cloth-ink)'
                    : 'bg-primary text-primary-foreground',
                )}
              >
                <Icon aria-hidden className="size-3.5" />
                {world[id]}
              </span>
            );
          })}
      </div>
      <div
        data-arrive
        style={{ '--at': 12 } as CSSProperties}
        className="flex items-start gap-3 rounded-2xl border border-border bg-background p-4"
      >
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span lang="en" className="font-semibold text-foreground">
              {world[fact.entity]}
            </span>
            {nodes[fact.entity].kind === 'place' ? w.place : w.character}
          </p>
          {stage === 4 ? (
            <span className="mt-2.5 block h-3 w-3/4 rounded-full bg-muted" />
          ) : (
            <p lang="en" className="mt-1 font-work-title leading-relaxed">
              {fact.text}
              <sup className="ms-0.5 font-sans text-xs font-semibold text-primary">
                {fill(words.shelf.chapter, { n: fact.chapter })}
              </sup>
            </p>
          )}
        </div>
        {stage === 4 ? (
          <Badge variant="outline" size="md" className="shrink-0">
            <Lock aria-hidden />
            {fill(w.hiddenUntil, { n: 12 })}
          </Badge>
        ) : null}
      </div>
    </Plate>
  );
}
