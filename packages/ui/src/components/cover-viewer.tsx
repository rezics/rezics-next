import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Button } from '../shadcn/button.tsx';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../shadcn/dialog.tsx';
import {
  coverIncarnation,
  resolveCoverVariants,
  type CoverFormat,
  type CoverSubject,
  type CoverSummary,
} from './cover-model.ts';
import { useIncarnationState } from './media-image-sources.ts';

export type CoverViewerLabels = { title: string; via: string; close: string };

export function CoverViewer({
  subject,
  cover,
  src,
  labels,
  open,
  onOpenChange,
}: {
  subject: CoverSubject;
  cover: CoverSummary;
  src: (media: string, format: CoverFormat, width: number) => string;
  labels: CoverViewerLabels;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const resolved = useMemo(() => resolveCoverVariants(cover, src), [cover, src]);
  const incarnation = coverIncarnation(subject, cover, resolved);
  const variants = resolved.filter((variant) => variant.src.trim() !== '');
  const variant = variants.toSorted((a, b) => a.width - b.width).at(-1);
  const failed = useIncarnationState(incarnation, () => false);
  const image = useRef<HTMLImageElement>(null);
  const available = open && variant !== undefined && !failed.value;
  const dimensions =
    Number.isFinite(cover.width) && cover.width > 0 && Number.isFinite(cover.height) && cover.height > 0;
  const track = useCallback(
    (element: HTMLImageElement | null) => {
      image.current = element;
      if (element?.complete && element.currentSrc) failed.setValue(element.naturalWidth === 0);
    },
    [incarnation, failed.setValue],
  );

  useEffect(() => {
    const element = image.current;
    if (element?.complete && element.currentSrc) failed.setValue(element.naturalWidth === 0);
  }, [incarnation, failed.setValue]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex max-h-[calc(100dvh-1rem)] w-fit max-w-[calc(100vw-1rem)] flex-col gap-3 overflow-auto p-3 sm:max-w-[calc(100vw-2rem)] sm:p-5"
      >
        <DialogTitle className="sr-only">{labels.title}</DialogTitle>
        {available ? (
          <img
            key={failed.generation}
            ref={track}
            data-slot="cover-viewer-image"
            className="mx-auto block max-h-[calc(100dvh-10rem)] max-w-full object-contain"
            src={variant.src}
            alt={subject.title}
            {...(dimensions ? { width: cover.width, height: cover.height } : {})}
            decoding="async"
            onError={() => failed.setValue(true)}
          />
        ) : null}
        {available && cover.credit ? (
          <p className="max-w-full break-words text-xs text-muted-foreground">
            © {cover.credit.rightsHolder}
            {cover.credit.via ? (
              <>
                {' · '}
                {labels.via}{' '}
                {isWebAddress(cover.credit.via.url) ? (
                  <a
                    className="text-primary underline underline-offset-2"
                    href={cover.credit.via.url}
                    rel="noreferrer noopener"
                  >
                    {cover.credit.via.name}
                  </a>
                ) : (
                  cover.credit.via.name
                )}
              </>
            ) : null}
            {cover.credit.license ? ` · ${cover.credit.license}` : null}
          </p>
        ) : null}
        <DialogClose render={<Button variant="outline" className="self-end" />}>{labels.close}</DialogClose>
      </DialogContent>
    </Dialog>
  );
}

export function coverViewerImage(
  cover: CoverSummary,
  src: (media: string, format: CoverFormat, width: number) => string,
): string {
  const resolved = resolveCoverVariants(cover, src).filter((variant) => variant.src.trim() !== '');
  const variant = resolved.toSorted((a, b) => a.width - b.width).at(-1);
  return variant?.src ?? '';
}

function isWebAddress(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
