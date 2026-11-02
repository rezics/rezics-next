import {
  Cover,
  type CoverLabels,
  type CoverRatio,
  type CoverSubject,
  type CoverSummary,
  coverIncarnation,
  resolveCoverVariants,
  usableCoverVariants,
  useIncarnationState,
} from '@rezics/ui/cover';
import { CoverViewer } from '@rezics/ui/cover-viewer';
import { useEffect, useMemo, useRef } from 'react';
import { m } from '../../paraglide/messages.js';
import type { Reader } from '../../subject/reader';

export function SubjectPageCover({
  subject,
  cover,
  size,
  src,
  suitability,
  labels,
  title,
  via,
  openLabel,
  closeLabel,
  locale,
  priority,
  decorative,
  ratio,
}: {
  subject: CoverSubject;
  cover: CoverSummary | null;
  size: 'sm' | 'lg';
  src: (media: string, format: 'avif' | 'webp', width: number) => string;
  suitability: Reader['suitability'];
  labels: Partial<CoverLabels>;
  title: string;
  via: string;
  openLabel: string;
  closeLabel: string;
  /** The page's displayed locale. The focus-fallback name uses it instead of the ambient locale. */
  locale?: string;
  priority?: boolean;
  decorative?: boolean;
  ratio?: CoverRatio;
}) {
  const resolved = useMemo(() => (cover ? resolveCoverVariants(cover, src) : []), [cover, src]);
  const incarnation = `${coverIncarnation(subject, cover, resolved)}:${suitability}`;
  const viewer = useIncarnationState(incarnation, () => false);
  const focusFallback = useRef<HTMLDivElement>(null);
  const previousViewer = useRef({ incarnation, open: false });
  const usable =
    cover && usableCoverVariants(cover.variants).length > 0 && resolved.some((variant) => variant.src.trim() !== '')
      ? cover
      : null;
  useEffect(() => {
    const previous = previousViewer.current;
    previousViewer.current = { incarnation, open: viewer.value };
    if (previous.open && previous.incarnation !== incarnation) focusFallback.current?.focus();
  }, [incarnation, viewer.value]);
  return (
    <div ref={focusFallback} role="group" aria-label={coverGroupLabel(subject.title, locale)} tabIndex={-1}>
      <Cover
        subject={subject}
        cover={cover}
        size={size}
        src={src}
        suitability={suitability}
        labels={labels}
        {...(priority ? { priority } : {})}
        {...(decorative ? { decorative } : {})}
        {...(ratio ? { ratio } : {})}
        action={{ label: openLabel, onActivate: () => viewer.setValue(true) }}
      />
      {usable ? (
        <CoverViewer
          subject={subject}
          cover={usable}
          src={src}
          labels={{ title, via, close: closeLabel }}
          open={viewer.value}
          onOpenChange={viewer.setValue}
        />
      ) : null}
    </div>
  );
}

/** The current subject's cover group, in the displayed locale when the page supplies one. */
function coverGroupLabel(title: string, locale: string | undefined) {
  return locale === undefined
    ? m.subject_cover_group({ title })
    : m.subject_cover_group({ title }, { locale: locale as never });
}
