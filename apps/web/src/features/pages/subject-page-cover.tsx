import { Cover, type CoverLabels, type CoverRatio, type CoverSubject, type CoverSummary } from '@rezics/ui/cover';
import { CoverViewer } from '@rezics/ui/cover-viewer';
import { useState } from 'react';
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
  const [open, setOpen] = useState(false);
  const usable = cover && cover.variants.length > 0 ? cover : null;
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
        action={{ label: openLabel, onActivate: () => setOpen(true) }}
      />
      {usable ? (
        <CoverViewer
          subject={subject}
          cover={usable}
          src={src}
          labels={{ title, via, close: closeLabel }}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}
