import { WorkCover } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { AnimatePresence, type PanInfo } from 'motion/react';
import * as m from 'motion/react-m';
import { useState } from 'react';
import { fill } from '../i18n/fill.ts';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { kindsOfStory } from '../illustrations/sample.ts';
import { MotionRoot, useMotion } from './motion.tsx';

export interface StoryDeckProps {
  words: Pick<IllustrationCopy, 'kinds' | 'deck'>;
  /** What the deck shows, for people who cannot see the covers. */
  caption: string;
}

/**
 * Where a card sits by its depth in the deck: the front card upright, the next two fanned
 * behind it, the rest hidden at the back. Percentages are of the card's own width.
 */
function pose(depth: number) {
  if (depth === 0) return { x: '0%', y: '0%', rotate: 0, scale: 1, opacity: 1 };
  if (depth === 1) return { x: '34%', y: '2%', rotate: 7, scale: 0.84, opacity: 1 };
  if (depth === 2) return { x: '-34%', y: '2%', rotate: -7, scale: 0.84, opacity: 1 };
  return { x: '0%', y: '4%', rotate: 0, scale: 0.7, opacity: 0 };
}

/** A card flung this far (px) or this fast (px/s) leaves the front of the deck. */
const flingDistance = 90;
const flingSpeed = 500;

/**
 * The home hero's picture: a deck of every kind of story, each one work named in the
 * scripts it is read in. Drag or swipe the front card away, or use the buttons; the card
 * springs to the back and the next kind comes forward. Server-rendered in its first pose,
 * so it is complete before hydration and with reduced motion (where nothing travels).
 */
export function StoryDeck({ words, caption }: StoryDeckProps) {
  const [front, setFront] = useState(0);
  const motion = useMotion();
  const count = kindsOfStory.length;
  const current = kindsOfStory[front]!;
  const turn = (by: number) => setFront((index) => (index + by + count) % count);

  function release(_: unknown, { offset, velocity }: PanInfo) {
    if (offset.x < -flingDistance || velocity.x < -flingSpeed) turn(1);
    else if (offset.x > flingDistance || velocity.x > flingSpeed) turn(-1);
  }

  return (
    <MotionRoot>
      <figure className="story-deck">
        <div className="deck-stage" aria-hidden="true">
          {kindsOfStory.map((work, index) => {
            const depth = (index - front + count) % count;
            return (
              <m.div
                key={work.key}
                className="deck-card"
                initial={false}
                animate={pose(depth)}
                transition={motion.settle}
                style={{ zIndex: count - depth }}
              >
                <m.div
                  className={cn('deck-grip', depth === 0 && 'deck-grip-front')}
                  drag={depth === 0 ? 'x' : false}
                  dragConstraints={{ left: 0, right: 0 }}
                  dragElastic={0.7}
                  onDragEnd={release}
                  whileHover={depth === 0 ? { y: -6 } : undefined}
                  whileTap={depth === 0 ? { scale: 0.98 } : undefined}
                  // Motion makes tap targets focusable; the buttons below are the keyboard's way to turn.
                  tabIndex={-1}
                  transition={motion.lift}
                >
                  <WorkCover
                    kind={work.cover}
                    id={work.id}
                    title={work.names[0].text}
                    lang={work.names[0].lang}
                    loading="eager"
                    className="deck-cover"
                  />
                </m.div>
              </m.div>
            );
          })}
        </div>
        <div className="deck-caption">
          <div aria-live="polite" className="deck-names">
            <AnimatePresence mode="popLayout" initial={false}>
              <m.div
                key={current.key}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={motion.swap}
              >
                <p className="text-sm font-semibold text-muted-foreground">
                  {words.kinds[current.key].name}
                </p>
                <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-lg font-semibold">
                  {current.names.map((name, index) => (
                    <m.span
                      key={name.lang}
                      lang={name.lang}
                      className={cn('font-work-title', index > 0 && 'text-muted-foreground')}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ ...motion.swap, delay: index * motion.stagger }}
                    >
                      {name.text}
                    </m.span>
                  ))}
                </p>
              </m.div>
            </AnimatePresence>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" className="deck-button" onClick={() => turn(-1)}>
              <ChevronLeft aria-hidden className="size-5 rtl:-scale-x-100" />
              <span className="sr-only">{words.deck.previous}</span>
            </button>
            <span className="min-w-12 text-center text-sm tabular-nums text-muted-foreground">
              {fill(words.deck.position, { n: front + 1, total: count })}
            </span>
            <button type="button" className="deck-button" onClick={() => turn(1)}>
              <ChevronRight aria-hidden className="size-5 rtl:-scale-x-100" />
              <span className="sr-only">{words.deck.next}</span>
            </button>
          </div>
        </div>
        <figcaption className="sr-only">{caption}</figcaption>
      </figure>
    </MotionRoot>
  );
}
