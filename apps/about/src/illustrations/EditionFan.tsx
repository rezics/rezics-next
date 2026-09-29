import { WorkCover } from '@rezics/ui/work-cover';
import { Pause, Play } from 'lucide-react';
import type { CSSProperties } from 'react';
import { localeNames } from '../i18n/locales.ts';
import { lantern, type EditionLang } from './sample.ts';

/** Which turn each edition takes in front: Japanese, then Traditional Chinese, then English. */
const turns: Record<EditionLang, number> = { ja: 0, en: 1, 'zh-Hant': 2 };

/**
 * The home hero's picture: one story's three editions, typeset each in its own tradition
 * on the same cloth, taking turns in front while the red ribbon (your place) stays put.
 * The loop has a CSS-only pause toggle; with reduced motion it is a still fan.
 */
export function EditionFan({ caption, pause }: { caption: string; pause: string }) {
  const editions = [...lantern.editions].sort((a, b) => turns[a.lang] - turns[b.lang]);
  return (
    <figure data-loop className="edition-fan">
      <div aria-hidden="true" className="fan-stage">
        {editions.map((edition) => (
          <div
            key={edition.lang}
            className="fan-cover"
            data-slot-index={turns[edition.lang]}
            style={{ '--turn': turns[edition.lang] } as CSSProperties}
          >
            <WorkCover
              kind="book"
              id={lantern.id}
              title={edition.title}
              lang={edition.lang}
              authors={[lantern.author[edition.lang]]}
              loading="eager"
              className="w-full rounded-[0.625rem] shadow-[0_2px_4px_rgb(0_0_0/0.12),0_30px_60px_-24px_rgb(0_0_0/0.45)]"
            />
          </div>
        ))}
        <span className="ribbon fan-ribbon" />
      </div>
      <div className="fan-controls">
        <div aria-hidden="true" className="fan-langs">
          {lantern.editions.map((edition) => (
            <span
              key={edition.lang}
              lang={edition.lang}
              className="fan-lang"
              data-slot-index={turns[edition.lang]}
              style={{ '--turn': turns[edition.lang] } as CSSProperties}
            >
              {localeNames[edition.lang]}
            </span>
          ))}
        </div>
        <label className="motion-toggle">
          <input type="checkbox" className="sr-only" />
          <Pause aria-hidden className="icon-pause size-4" />
          <Play aria-hidden className="icon-play size-4" />
          <span className="sr-only">{pause}</span>
        </label>
      </div>
      <figcaption className="sr-only">{caption}</figcaption>
    </figure>
  );
}
