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
import { useMemo } from 'react';
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
  priority?: boolean;
  decorative?: boolean;
  ratio?: CoverRatio;
}) {
  const resolved = useMemo(() => (cover ? resolveCoverVariants(cover, src) : []), [cover, src]);
  const incarnation = `${coverIncarnation(subject, cover, resolved)}:${suitability}`;
  const viewer = useIncarnationState(incarnation, () => false);
  const usable =
    cover && usableCoverVariants(cover.variants).length > 0 && resolved.some((variant) => variant.src.trim() !== '')
      ? cover
      : null;
  return (
    <>
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
    </>
  );
}
