import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { PageHeading } from '../../shell/page-heading';
import { m } from '../../paraglide/messages.js';
import {
  albumCurrentVisitFromReturnHash,
  albumCurrentVisitMatches,
  albumCurrentVisitReturnHref,
  type AlbumCurrentReading,
  type AlbumCurrentVisitOrigin,
} from './album-current-visit-model';

const publicLinkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal rounded-md underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

export function AlbumCurrentVisitGate({
  id,
  slug,
  locale,
  origin,
  token,
  renderCorrection,
}: {
  id: string;
  slug: string;
  locale: string;
  origin: AlbumCurrentVisitOrigin;
  token: string;
  renderCorrection: () => ReactNode;
}) {
  const [chosenGlobal, setChosenGlobal] = useState(false);
  const o = { locale: locale as never };
  const returnHref = albumCurrentVisitReturnHref(origin, token);
  if (!returnHref) return <AlbumCurrentVisitUnsupported id={id} slug={slug} locale={locale} />;
  if (chosenGlobal)
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-5 sm:px-6">
        <a className={publicLinkClass} href={returnHref}>
          {m.album_current_return_original({}, o)}
        </a>
        {renderCorrection()}
      </div>
    );
  const context = origin.context.label || m.subject_context_global({}, o);
  return (
    <article
      data-album-current-visit={origin.subject.id}
      className="mx-auto w-full max-w-4xl space-y-5 px-4 py-8 sm:px-6"
    >
      <header className="space-y-3">
        <PageHeading className="font-sans">{m.album_current_visit_title({}, o)}</PageHeading>
        <p className="max-w-prose break-words [overflow-wrap:anywhere]" lang={locale}>
          {m.album_current_origin({ subject: origin.subject.label, context }, o)}
        </p>
        <a className={publicLinkClass} href={origin.address}>
          {m.album_current_return_original({}, o)}
        </a>
      </header>
      <section className="space-y-3 rounded-xl border border-border p-4 sm:p-5">
        <p role="status" className="max-w-prose text-sm text-muted-foreground">
          {m.album_current_global_boundary({}, o)}
        </p>
        <Button
          type="button"
          className="h-auto min-h-11 max-w-full whitespace-normal break-words py-2"
          onClick={() => setChosenGlobal(true)}
        >
          {m.album_current_global_choice({}, o)}
        </Button>
      </section>
    </article>
  );
}

export function AlbumCurrentVisitUnsupported({ id, slug, locale }: { id: string; slug: string; locale: string }) {
  const o = { locale: locale as never };
  const restart = `/${locale}/subjects/${id}/${slug}/album`;
  return (
    <article className="mx-auto w-full max-w-4xl space-y-5 px-4 py-8 sm:px-6">
      <PageHeading className="font-sans">{m.album_current_visit_title({}, o)}</PageHeading>
      <p role="status" className="max-w-prose text-muted-foreground">
        {m.album_current_origin_unsupported({}, o)}
      </p>
      <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={restart}>
        {m.album_current_restart_global({}, o)}
      </a>
    </article>
  );
}

export function AlbumCurrentVisitReturn({
  locale,
  current,
  validateAddress,
}: {
  locale: string;
  current?: AlbumCurrentReading | undefined;
  validateAddress: (value: unknown, locale: string) => string | undefined;
}) {
  const [changed, setChanged] = useState(false);
  const handled = useRef('');
  const o = { locale: locale as never };
  const key = JSON.stringify([current ?? null, locale]);
  useEffect(() => {
    const marker = albumCurrentVisitFromReturnHash(window.location.hash, locale, validateAddress);
    if (!marker || handled.current === key) return;
    handled.current = key;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    document.addEventListener('focusin', cancel, true);
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      const matches = !!marker.origin && !!current && albumCurrentVisitMatches(marker.origin, current);
      const address = matches
        ? marker.origin!.address
        : `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(window.history.state, '', address);
      const heading = document.querySelector('main h1, h1');
      if (heading instanceof HTMLElement) heading.focus();
      if (!matches) setChanged(true);
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
      document.removeEventListener('focusin', cancel, true);
    };
  }, [current, key, locale, validateAddress]);
  return changed ? (
    <p role="status" className="sr-only">
      {m.album_current_return_changed({}, o)}
    </p>
  ) : null;
}
