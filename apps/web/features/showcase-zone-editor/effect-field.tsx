'use client';

import { SegmentGroup, SegmentGroupItem, SegmentGroupItemText } from '@rezics/ui/segment-group';
import type { ZoneTitleEffect } from '@rezics/zone-sdk';
import { useId } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import '../showcase/showcase.css';
import type { ZoneEditorCopy } from './messages.ts';
import { titleEffects } from './slides.ts';

/** A language whose script the effect is tuned for (no letter-spacing, strokes under the fill), beside the editor's own. */
const SCRIPT_SAMPLE = { value: '星の潮', lang: 'ja' } as const;

/**
 * The Zone's title effect, with the stage's own title style drawn on its own scrim so the effect is
 * judged as readers see it. The same effect applies to every slide of the Zone.
 */
export function TitleEffectField({ effect, sample, sampleLanguage, onChange, t }: {
  effect: ZoneTitleEffect; sample: string; sampleLanguage: UiLocale; onChange: (effect: ZoneTitleEffect) => void; t: ZoneEditorCopy;
}) {
  const id = useId();
  const labels = { plain: t.effectPlain, outline: t.effectOutline, gradient: t.effectGradient, glow: t.effectGlow };
  return <section aria-labelledby={`${id}-title`} className="grid gap-3">
    <div className="grid gap-1">
      <h3 id={`${id}-title`} className="font-semibold text-lg">{t.effectHeading}</h3>
      <p className="max-w-3xl text-pretty text-muted-foreground text-sm">{t.effectHelp}</p>
    </div>
    <SegmentGroup aria-labelledby={`${id}-title`} value={effect} onValueChange={details => details.value && onChange(details.value as ZoneTitleEffect)}>
      {titleEffects.map(option => <SegmentGroupItem key={option} value={option}><SegmentGroupItemText>{labels[option]}</SegmentGroupItemText></SegmentGroupItem>)}
    </SegmentGroup>
    <div role="img" aria-label={`${t.effectSample}: ${labels[effect]}`}
      className="grid gap-2 rounded-2xl bg-[linear-gradient(135deg,#0b1c33,#07101d_60%,#1b3a63)] px-5 py-6 sm:px-8">
      <span className="text-[#c9d6ea] text-xs uppercase tracking-wide">{t.effectSample}</span>
      <p lang={sampleLanguage} data-effect={effect} className="showcase-title text-[clamp(1.75rem,5vw,2.75rem)]">{sample}</p>
      <p lang={SCRIPT_SAMPLE.lang} data-effect={effect} className="showcase-title text-[clamp(1.75rem,5vw,2.75rem)]">{SCRIPT_SAMPLE.value}</p>
    </div>
  </section>;
}
