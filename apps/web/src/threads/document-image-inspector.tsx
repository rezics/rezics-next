import { useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@rezics/ui/shadcn/dialog';
import { m } from '../paraglide/messages.js';
import type { DocumentImagePresentation } from './document-media';
import { DocumentImageInspectionControls } from './document-image-inspection-controls';
import {
  selectDocumentImageInspectionVariant,
  type DocumentImageInspectionMode,
} from './document-image-inspection';

export function DocumentImageInspector({
  image,
  alt,
  locale,
  onUnavailable,
}: {
  image: DocumentImagePresentation;
  alt: string;
  locale: string;
  onUnavailable: () => void;
}) {
  const options = { locale: locale as never };
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DocumentImageInspectionMode>('fit');
  const openRef = useRef(false);
  const visitRef = useRef(0);
  // Variant work is paid only by the selected image while its one inspector is open.
  const variant = useMemo(
    () => (open ? selectDocumentImageInspectionVariant(image) : null),
    [image, open],
  );

  const changeOpen = (next: boolean) => {
    if (next) {
      visitRef.current += 1;
      openRef.current = true;
      setMode('fit');
    } else {
      openRef.current = false;
    }
    setOpen(next);
  };
  const visit = visitRef.current;
  const failCurrentVisit = () => {
    if (openRef.current && visitRef.current === visit) onUnavailable();
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="min-h-11 rounded-md px-3 text-sm font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        }
      >
        {m.document_image_inspect({}, options)}
      </DialogTrigger>
      {open && variant ? (
        <DialogContent
          showCloseButton={false}
          className="grid h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[calc(100dvw-1rem-env(safe-area-inset-left)-env(safe-area-inset-right))] max-h-none max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden rounded-xl p-3 motion-reduce:animate-none motion-reduce:duration-0 motion-reduce:transition-none sm:h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] sm:w-[calc(100dvw-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] sm:p-5 sm:max-w-none"
        >
          <DialogHeader className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
            <div className="min-w-0 space-y-3">
              <div className="min-w-0 space-y-1">
                <DialogTitle className="[overflow-wrap:anywhere]">
                  {m.document_image_inspection_title({}, options)}
                </DialogTitle>
                <DialogDescription className="[overflow-wrap:anywhere]">
                  {mode === 'fit'
                    ? m.document_image_inspection_fit_state({}, options)
                    : m.document_image_inspection_actual_state({}, options)}{' '}
                  · {m.document_image_inspection_size({ width: variant.width, height: variant.height }, options)}
                </DialogDescription>
              </div>
              <DocumentImageInspectionControls
                mode={mode}
                variant={variant}
                locale={locale}
                onModeChange={setMode}
              />
            </div>
            <DialogClose
              render={
                <button
                  type="button"
                  aria-label={m.document_image_inspection_close({}, options)}
                  className="min-h-11 min-w-11 shrink-0 rounded-md border px-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                />
              }
            >
              <span aria-hidden="true">×</span>
            </DialogClose>
          </DialogHeader>

          <div
            data-slot="document-image-inspection-stage"
            data-scale={mode}
            role="region"
            aria-label={m.document_image_inspection_title({}, options)}
            tabIndex={0}
            className="min-h-0 min-w-0 overflow-auto overscroll-contain rounded-md bg-muted/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <img
              src={variant.src}
              width={variant.width}
              height={variant.height}
              alt={alt}
              loading="eager"
              decoding="async"
              onError={failCurrentVisit}
              className={mode === 'fit' ? 'block h-full w-full object-contain' : 'block max-h-none max-w-none'}
              style={
                mode === 'fit'
                  ? { width: '100%', height: '100%', objectFit: 'contain' }
                  : { width: `${variant.width}px`, height: `${variant.height}px` }
              }
            />
          </div>

          <div
            role="region"
            aria-label={m.document_image_inspection_title({}, options)}
            tabIndex={0}
            className="max-h-[25dvh] min-w-0 space-y-3 overflow-y-auto overscroll-contain [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {alt ? (
              <section aria-label={m.document_image_inspection_alt({}, options)} className="min-w-0 space-y-1">
                <h2 className="text-sm font-medium">{m.document_image_inspection_alt({}, options)}</h2>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{alt}</p>
              </section>
            ) : null}
            {image.credit ? (
              <figcaption
                aria-label={m.document_image_credit({}, options)}
                className="min-w-0 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]"
              >
                {image.credit.rightsHolder} · {m.document_image_via({}, options)}{' '}
                <a
                  href={image.credit.via.url}
                  rel="noopener noreferrer nofollow ugc"
                  className="break-words underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [overflow-wrap:anywhere]"
                >
                  {image.credit.via.name}
                </a>
                {' · '}
                {image.credit.license}
              </figcaption>
            ) : null}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
