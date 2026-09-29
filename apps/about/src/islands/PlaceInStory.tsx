import { badgeVariants } from '@rezics/ui/badge';
import { cn } from '@rezics/ui/utils';
import { EyeOff, MessagesSquare, UserRound } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import * as m from 'motion/react-m';
import { useId, useState } from 'react';
import { fill } from '../i18n/fill.ts';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { lanternThread } from '../illustrations/sample.ts';
import { MotionRoot, useMotion } from './motion.tsx';

export interface PlaceInStoryProps {
  words: Pick<IllustrationCopy, 'thread' | 'wiki'>;
}

const { chapters, posts, facts } = lanternThread;
/** Where a chapter sits along the track, in percent. */
const along = (chapter: number) => ((chapter - 1) / (chapters - 1)) * 100;

/**
 * Discussion and wiki that respect where you are in the story. Move the ribbon (your
 * place) along the chapters: posts about chapters you have not reached fold away, the
 * ones you have reach you, and the wiki reveals only what the story has. The control is a
 * native range input, so hands, keys and assistive technology all work; Motion springs the
 * ribbon after it and moves the posts as they arrive and leave.
 */
export function PlaceInStory({ words }: PlaceInStoryProps) {
  const [place, setPlace] = useState(12);
  const motion = useMotion();
  const id = useId();
  const text = words.thread;
  const shown = posts.filter((post) => post.chapter <= place);
  const hidden = posts.length - shown.length;
  const position = fill(text.chapterOf, { n: place, total: chapters });

  return (
    <MotionRoot>
      <div className="w-full rounded-[1.75rem] border border-border bg-card p-5 text-card-foreground shadow-(--aura-shadow-float) sm:p-7">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <label htmlFor={id} className="text-sm font-semibold text-muted-foreground">
            {text.yourPlace}
          </label>
          <p aria-hidden="true" className="text-lg font-bold tabular-nums">
            {position}
          </p>
        </div>

        <div className="place-track mt-4">
          <div aria-hidden="true" className="place-rail">
            <m.div
              className="place-fill"
              initial={false}
              animate={{ scaleX: along(place) / 100 }}
              transition={motion.settle}
            />
            {posts.map((post) => (
              <span
                key={post.id}
                className={cn('place-tick', post.chapter <= place && 'place-tick-reached')}
                style={{ insetInlineStart: `${along(post.chapter)}%` }}
              />
            ))}
          </div>
          <m.div
            aria-hidden="true"
            className="place-marker"
            initial={false}
            animate={{ x: `${along(place)}%` }}
            transition={motion.settle}
          >
            <span className="ribbon place-ribbon" />
          </m.div>
          <input
            id={id}
            type="range"
            min={1}
            max={chapters}
            step={1}
            value={place}
            aria-valuetext={position}
            onChange={(event) => setPlace(Number(event.currentTarget.value))}
            className="place-input"
          />
        </div>

        <div className="mt-7 grid gap-6 md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <section aria-label={text.realm}>
            <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <MessagesSquare aria-hidden className="size-4" />
              {text.realm}
            </p>
            <ul className="mt-3 flex flex-col gap-2.5">
              <AnimatePresence mode="popLayout" initial={false}>
                {shown.map((post) => (
                  <m.li
                    key={post.id}
                    layout="position"
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10, transition: { duration: 0.15 } }}
                    transition={motion.settle}
                    className="rounded-xl border border-border bg-background px-3.5 py-3"
                  >
                    <p className="flex items-center justify-between gap-3 text-sm">
                      <span className="flex min-w-0 items-center gap-2 font-semibold">
                        <UserRound aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{post.by}</span>
                      </span>
                      <span className={badgeVariants({ variant: 'outline', size: 'sm' })}>
                        {fill(text.about, { n: post.chapter })}
                      </span>
                    </p>
                    <p lang={post.lang} className="type-body mt-1.5">
                      {post.text}
                    </p>
                  </m.li>
                ))}
                {hidden > 0 ? (
                  <m.li
                    key="later"
                    layout="position"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={motion.settle}
                    className="flex items-center gap-2.5 rounded-xl border border-dashed border-border px-3.5 py-3 text-sm text-muted-foreground"
                  >
                    <EyeOff aria-hidden className="size-4 shrink-0" />
                    {text.later}
                  </m.li>
                ) : null}
              </AnimatePresence>
            </ul>
          </section>

          <section aria-label={text.wikiName} className="self-start rounded-xl bg-muted/60 p-4">
            <p className="text-sm text-muted-foreground">{words.wiki.character}</p>
            <p lang="en" className="font-work-title text-xl font-semibold">
              {text.wikiName}
            </p>
            <dl className="mt-3 flex flex-col gap-2 text-sm">
              {facts.map((fact) => {
                const known = fact.chapter <= place;
                return (
                  <div key={fact.key} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3">
                    <dt className="text-muted-foreground">
                      {fact.key === 'role'
                        ? text.role
                        : fact.key === 'home'
                          ? words.wiki.home
                          : words.wiki.faction}
                    </dt>
                    <dd className="swap">
                      <m.span
                        lang={fact.lang}
                        data-active={known}
                        aria-hidden={known ? undefined : true}
                        className="font-semibold"
                        initial={false}
                        animate={known ? { opacity: 1, y: [6, 0] } : { opacity: 0, y: -4 }}
                        transition={motion.swap}
                      >
                        {fact.text}
                      </m.span>
                      <m.span
                        data-active={!known}
                        aria-hidden={known ? true : undefined}
                        className="flex items-center gap-1.5 text-muted-foreground"
                        initial={false}
                        animate={known ? { opacity: 0 } : { opacity: 1 }}
                        transition={motion.swap}
                      >
                        <EyeOff aria-hidden className="size-3.5" />
                        {text.revealedLater}
                      </m.span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        </div>
      </div>
    </MotionRoot>
  );
}
