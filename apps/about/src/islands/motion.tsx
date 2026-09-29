import { LazyMotion, MotionConfig, domMax, useReducedMotion, type Transition } from 'motion/react';
import type { ReactNode } from 'react';

/**
 * The site's motion vocabulary for React islands (PATTERNS.md, "Motion"). CSS keeps
 * scroll-driven animation and view transitions; Motion is for what CSS cannot do:
 * gestures, springs that respond to a hand, orchestrated sequences and layout changes.
 */
const vocabulary = {
  /** Something settling into a new place: a card returning to the deck, a handle snapping to a mark, a layout change. */
  settle: { type: 'spring', stiffness: 380, damping: 36, mass: 0.9 },
  /** Something picked up or pressed. */
  lift: { type: 'spring', stiffness: 520, damping: 32 },
  /** Text replacing text in place, such as a language swap: a short fade and rise, `--ease-out-soft`. */
  swap: { duration: 0.34, ease: [0.22, 1, 0.36, 1] },
} as const satisfies Record<string, Transition>;

/** Seconds between siblings in an orchestrated sequence. */
const stagger = 0.07;

/** With reduced motion every change is instant: the state still changes, nothing travels. */
const still = { settle: { duration: 0 }, lift: { duration: 0 }, swap: { duration: 0 } } as const;

export type Motion = { [Key in keyof typeof vocabulary]: Transition } & {
  stagger: number;
  reduced: boolean;
};

/** Every change instant: for reduced motion, and for changes the reader cannot see happen. */
export const instant: Motion = { ...still, stagger: 0, reduced: true };

/** The vocabulary for this reader: instant, with no stagger, when they prefer reduced motion. */
export function useMotion(): Motion {
  const reduced = useReducedMotion() ?? false;
  return reduced ? { ...still, stagger: 0, reduced } : { ...vocabulary, stagger, reduced };
}

/**
 * Wraps every Motion island: loads the gesture and layout features once for all islands
 * (`m.*` components only, so nothing else is bundled) and honours reduced motion.
 */
export function MotionRoot({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
