import { Button } from '../shadcn/button.tsx';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../shadcn/dialog.tsx';
import type { CoverFormat, CoverSubject, CoverSummary } from './cover-model.ts';

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
  const source = coverViewerImage(cover, src);
  const credit = cover.credit;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex max-h-[calc(100dvh-1rem)] w-fit max-w-[calc(100vw-1rem)] flex-col gap-3 overflow-auto p-3 sm:max-w-[calc(100vw-2rem)] sm:p-5"
      >
        <DialogTitle className="sr-only">{labels.title}</DialogTitle>
        <img
          className="mx-auto block max-h-[calc(100dvh-10rem)] max-w-full object-contain"
          src={source}
          alt={subject.title}
          width={cover.width}
          height={cover.height}
          decoding="async"
        />
        {credit ? (
          <p className="max-w-full break-words text-xs text-muted-foreground">
            © {credit.rightsHolder}
            {credit.via ? (
              <>
                {' · '}
                {labels.via}{' '}
                {isWebAddress(credit.via.url) ? (
                  <a
                    className="text-primary underline underline-offset-2"
                    href={credit.via.url}
                    rel="noreferrer noopener"
                  >
                    {credit.via.name}
                  </a>
                ) : (
                  credit.via.name
                )}
              </>
            ) : null}
            {credit.license ? ` · ${credit.license}` : null}
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
  const variant = cover.variants.reduce((largest, candidate) =>
    candidate.width > largest.width ? candidate : largest,
  );
  return src(cover.media, variant.format, variant.width);
}

function isWebAddress(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
