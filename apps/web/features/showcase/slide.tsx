import type { ZoneShowcaseArt, ZoneShowcaseSlide, ZoneTitleEffect } from '@rezics/zone-sdk';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { WebMediaImage } from '../document-editor/media-image.tsx';
import { AuthorNames } from '../catalogue/author-names.tsx';
import { CoverLink } from '../catalogue/work-tile.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { catalogueWork, WhyHere } from '../zones/card.tsx';
import { PrimaryAction } from './work-action.tsx';
import type { ZoneMessages } from '../zones/messages.ts';
import { focalFrame, focalPosition, logoFor, pictureSources, slideArt, viewBox } from './stage.ts';
import { Trailer } from './trailer.tsx';

export function ShowcasePreload({ slide }: { slide: ZoneShowcaseSlide }) {
  const ownArt = slideArt(slide);
  const art =
    ownArt?.landscape || ownArt?.portrait
      ? ownArt
      : slide.work?.cover
        ? { landscape: { ...slide.work.cover, framed: false } }
        : null;
  if (!art) return null;
  return pictureSources(art).map((source) => (
    <link
      key={source.shape}
      rel="preload"
      as="image"
      media={source.media}
      imageSrcSet={source.srcSet}
      imageSizes={source.sizes}
      fetchPriority="high"
    />
  ));
}

export function Background({ art, first }: { art: ZoneShowcaseArt; first: boolean }) {
  const sources = pictureSources(art);
  const fallback = art.landscape ?? art.portrait;
  if (!fallback) return null;
  const portrait = focalFrame(art.portrait ?? fallback, 3 / 4);
  const views = {
    '--view-landscape': viewBox(art.landscape ?? fallback),
    '--view-portrait': viewBox(art.portrait ?? fallback),
  } as CSSProperties;
  // Both copies pass through the media policy, so a mask also removes the ambient backdrop.
  return (
    <div aria-hidden="true" className="showcase-background" style={views}>
      <picture className="showcase-ambient">
        {sources.map((source) => (
          <source
            key={source.shape}
            media={source.media}
            srcSet={source.srcSet}
            sizes={source.sizes}
          />
        ))}
        <WebMediaImage
          revealable={false}
          alt=""
          src={fallback.url}
          loading={first ? 'eager' : 'lazy'}
          fetchPriority={first ? 'high' : 'low'}
        />
      </picture>
      <picture>
        {sources.map((source) => (
          <source
            key={source.shape}
            media={source.media}
            srcSet={source.srcSet}
            sizes={source.sizes}
          />
        ))}
        <WebMediaImage
          revealable={false}
          alt=""
          src={fallback.url}
          width={fallback.width}
          height={fallback.height}
          loading={first ? 'eager' : 'lazy'}
          fetchPriority={first ? 'high' : 'low'}
          className="showcase-art"
          style={
            {
              '--fit-landscape': art.landscape?.framed ? 'cover' : 'contain',
              '--fit-portrait': portrait.fit,
              '--focal-landscape': focalPosition(art.landscape ?? fallback),
              '--focal-portrait': portrait.position,
            } as CSSProperties
          }
        />
      </picture>
    </div>
  );
}

export function ShowcaseSlide({
  slide,
  locale,
  messages,
  first,
  effect = 'plain',
  avatarQuery,
}: {
  slide: ZoneShowcaseSlide;
  locale: UiLocale;
  messages: ZoneMessages;
  first: boolean;
  effect?: ZoneTitleEffect;
  avatarQuery?: string;
}) {
  const art = slideArt(slide);
  const background = art?.landscape || art?.portrait;
  // Main's selected title carries the content language, which can differ from interface copy.
  const logo = logoFor(art, slide.title.lang || locale);
  const title = slide.title.value || slide.work?.title?.value || messages.untitled;
  const tagline = slide.tagline ?? slide.work?.tagline;
  const work = slide.work;
  const article = useRef<HTMLElement | null>(null);
  const [logoVisible, setLogoVisible] = useState(false);
  useEffect(() => {
    const root = article.current;
    if (!root) return;
    const update = () => {
      const image = root.querySelector<HTMLImageElement>('img.showcase-logo');
      setLogoVisible(Boolean(image?.complete && image.naturalWidth));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
    return () => observer.disconnect();
  }, [logo?.url]);
  return (
    <article
      ref={article}
      className={`showcase-slide ${background ? 'showcase-art-slide' : 'showcase-cover-slide'}`}
    >
      {background && art ? (
        <Background art={art} first={first} />
      ) : work?.cover ? (
        <WebMediaImage
          revealable={false}
          alt=""
          aria-hidden="true"
          src={work.cover.url}
          loading={first ? 'eager' : 'lazy'}
          className="showcase-cover-ambient"
        />
      ) : work ? (
        <div aria-hidden="true" className="showcase-generated-ambient">
          <CoverLink work={catalogueWork(work)} avatarQuery={avatarQuery} />
        </div>
      ) : null}
      <span aria-hidden="true" className="showcase-scrim" />
      {!background && work ? (
        <div className="showcase-cover">
          <CoverLink work={catalogueWork(work)} avatarQuery={avatarQuery} />
        </div>
      ) : null}
      {logo ? (
        <WebMediaImage
          revealable={false}
          src={logo.url}
          srcSet={logo.candidates
            ?.map((candidate) => `${candidate.url} ${candidate.width}w`)
            .join(', ')}
          alt={title}
          sizes="min(58vw, 26rem)"
          width={logo.width}
          height={logo.height}
          loading={first ? 'eager' : 'lazy'}
          onLoad={() => setLogoVisible(true)}
          onError={() => setLogoVisible(false)}
          style={{ visibility: logoVisible ? 'visible' : 'hidden' }}
          className={`showcase-logo showcase-logo-${logo.anchor}`}
        />
      ) : null}
      <div className="showcase-copy">
        <p lang={slide.kicker?.lang} dir={slide.kicker?.dir} className="showcase-kicker">
          {slide.kicker?.value ?? messages.heroLabel}
        </p>
        <h2
          lang={slide.title.lang || work?.title?.lang}
          dir={slide.title.dir}
          data-effect={effect}
          className={`showcase-title ${logoVisible ? 'sr-only focus-within:not-sr-only' : ''}`}
        >
          <LocalizedLink href={slide.href}>{title}</LocalizedLink>
        </h2>
        {!background && work?.author ? (
          <p className="showcase-author" lang={work.author.lang}>
            <AuthorNames authors={catalogueWork(work).authors} />
          </p>
        ) : null}
        {tagline ? (
          <p className="showcase-tagline" lang={tagline.lang} dir={tagline.dir}>
            {tagline.value}
          </p>
        ) : null}
        <div className="showcase-actions">
          {work ? (
            <PrimaryAction
              work={{ ...work, href: slide.href }}
              locale={locale}
              messages={messages}
            />
          ) : (
            <LocalizedLink href={slide.href} className="showcase-action">
              {messages.explore}
            </LocalizedLink>
          )}
          {work ? (
            <WhyHere work={work} locale={locale} messages={messages} className="showcase-why" />
          ) : null}
          {slide.trailer ? (
            <Trailer href={slide.trailer.href} label={messages.watchTrailer} title={title} />
          ) : null}
        </div>
      </div>
    </article>
  );
}
