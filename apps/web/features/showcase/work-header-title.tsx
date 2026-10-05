'use client';

import type { ZoneShowcaseLogo } from '@rezics/zone-sdk';
import { cn } from '@rezics/ui/utils';
import { useEffect, useRef, useState } from 'react';
import { WebMediaImage } from '../document-editor/media-image.tsx';

/**
 * The Work's title over its art: the official logo when it has loaded, else the
 * live title. The heading stays in the document either way, so a logo never
 * replaces the title as the page's name or its text alternative.
 */
export function WorkArtTitle({ logo, title, lang, dir, className }: {
  logo: ZoneShowcaseLogo | null;
  title: string;
  lang: string;
  dir: 'ltr' | 'rtl';
  className: string;
}) {
  const root = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    // The image can finish loading before hydration attaches its handler.
    const image = root.current?.querySelector('img');
    setShown(Boolean(image?.complete && image.naturalWidth));
  }, [logo?.url]);
  return (
    <>
      {logo ? (
        <span ref={root} className="work-hero-logo" hidden={!shown} aria-hidden="true">
          <WebMediaImage
            revealable={false}
            alt=""
            src={logo.url}
            srcSet={logo.candidates
              ?.map((candidate) => `${candidate.url} ${candidate.width}w`)
              .join(', ')}
            sizes="min(80vw, 24rem)"
            width={logo.width}
            height={logo.height}
            loading="eager"
            onLoad={() => setShown(true)}
            onError={() => setShown(false)}
          />
        </span>
      ) : null}
      <h1 lang={lang} dir={dir} className={cn(className, logo && shown && 'sr-only')}>
        {title}
      </h1>
    </>
  );
}
