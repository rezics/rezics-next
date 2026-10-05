'use client';

import {
  Carousel,
  CarouselAutoplayTrigger,
  CarouselContent,
  CarouselIndicator,
  CarouselIndicatorGroup,
  CarouselItem,
  useCarousel,
} from '@rezics/ui/carousel';
import type { ZoneShowcaseSlide, ZoneTitleEffect } from '@rezics/zone-sdk';
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { WorkCover } from '@rezics/ui/work-cover';
import { workCoverProps } from '@rezics/zone-sdk';
import { WebMediaImage } from '../document-editor/media-image.tsx';
import type { ZoneMessages } from '../zones/messages.ts';
import { ShowcasePreload, ShowcaseSlide } from './slide.tsx';
import { imageSet, rotationDelay, rotationWindow, slideArt, stageWindowCss } from './stage.ts';
import './showcase.css';

function SlideThumbnail({ slide }: { slide: ZoneShowcaseSlide }) {
  const landscape = slideArt(slide)?.landscape;
  const image = landscape ?? slide.work?.cover;
  return (
    <span
      className="showcase-thumbnail"
      data-cover={!landscape ? '' : undefined}
      aria-hidden="true"
    >
      {image ? (
        <WebMediaImage
          revealable={false}
          src={image.url}
          alt=""
          loading="lazy"
          fetchPriority="low"
          srcSet={imageSet(image)}
          sizes="80px"
        />
      ) : slide.work ? (
        <WorkCover {...workCoverProps(slide.work)} size="fill" />
      ) : null}
    </span>
  );
}

function StageContents({
  slides,
  locale,
  messages,
  effect,
  avatarQuery,
  rotate,
}: {
  slides: readonly ZoneShowcaseSlide[];
  locale: UiLocale;
  messages: ZoneMessages;
  effect: ZoneTitleEffect;
  avatarQuery?: string;
  rotate: boolean;
}) {
  const api = useCarousel();
  const [rotationRun, setRotationRun] = useState(0);
  useEffect(() => {
    if (api.isPlaying) setRotationRun((run) => run + 1);
  }, [api.isPlaying]);
  const stage = useRef<HTMLDivElement | null>(null);
  const current = slides[api.page] ?? slides[0];
  const cutout = current && slideArt(current)?.cutout;
  const t = materializeData(messages, { locale });
  const position = (index: number) =>
    t.slide({ index: String(index + 1), count: String(slides.length) });
  function move(index: number) {
    // The grid and late artwork can change Ark's cached snap points after its initial layout.
    api.refresh();
    api.scrollTo(index, matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  return (
    <>
      <div className="showcase-layout">
        {slides.length > 1 ? (
          <div className="showcase-controls">
            {rotate ? (
              <CarouselAutoplayTrigger
                className="showcase-rotation"
                aria-label={
                  api.isRotationRequested ? messages.pauseRotation : messages.startRotation
                }
              >
                {api.isRotationRequested ? (
                  <PauseIcon aria-hidden="true" />
                ) : (
                  <PlayIcon aria-hidden="true" />
                )}
                <span>
                  {api.isRotationRequested ? messages.pauseRotation : messages.startRotation}
                </span>
              </CarouselAutoplayTrigger>
            ) : null}
            {slides.length > 1 ? (
              <CarouselIndicatorGroup
                className="showcase-progress"
                aria-label={messages.chooseSlide}
              >
                {slides.map((slide, index) => (
                  <CarouselIndicator
                    key={slide.id}
                    index={index}
                    aria-label={`${slide.title.value} · ${position(index)}`}
                    aria-disabled={api.page === index}
                    className="showcase-progress-button"
                  >
                    <span
                      aria-hidden="true"
                      className="showcase-progress-fill"
                      key={`${api.page}-${index}-${rotationRun}`}
                      style={{
                        animationPlayState: api.isPlaying ? 'running' : 'paused',
                        animationDuration: `${rotationDelay}ms`,
                        transform: !rotate ? `scaleX(${api.page === index ? 1 : 0})` : undefined,
                      }}
                    />
                  </CarouselIndicator>
                ))}
              </CarouselIndicatorGroup>
            ) : null}
            <div className="showcase-arrows">
              <button
                type="button"
                aria-label={messages.previous}
                disabled={!api.canScrollPrev}
                onClick={() => {
                  api.refresh();
                  api.scrollToIndex(
                    (api.page + slides.length - 1) % slides.length,
                    matchMedia('(prefers-reduced-motion: reduce)').matches,
                  );
                }}
                className="showcase-arrow"
              >
                <ChevronLeftIcon aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={messages.next}
                disabled={!api.canScrollNext}
                onClick={() => {
                  api.refresh();
                  api.scrollToIndex(
                    (api.page + 1) % slides.length,
                    matchMedia('(prefers-reduced-motion: reduce)').matches,
                  );
                }}
                className="showcase-arrow"
              >
                <ChevronRightIcon aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}

        <div
          ref={stage}
          className="showcase-stage"
          onPointerMove={(event) => {
            if (
              event.pointerType !== 'mouse' ||
              !matchMedia(
                '(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)',
              ).matches
            )
              return;
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.style.setProperty(
              '--parallax-x',
              `${((event.clientX - rect.left) / rect.width - 0.5) * 14}px`,
            );
            event.currentTarget.style.setProperty(
              '--parallax-y',
              `${((event.clientY - rect.top) / rect.height - 0.5) * 10}px`,
            );
          }}
          onPointerLeave={() => {
            stage.current?.style.setProperty('--parallax-x', '0px');
            stage.current?.style.setProperty('--parallax-y', '0px');
          }}
        >
          <CarouselContent
            className="showcase-track"
            aria-live={api.isPlaying ? 'off' : 'polite'}
            aria-atomic="false"
          >
            {slides.map((slide, index) => (
              <CarouselItem
                key={slide.id}
                index={index}
                coverImages={false}
                aria-label={`${slide.title.value || messages.untitled} · ${position(index)}`}
                className="showcase-item"
              >
                <ShowcaseSlide
                  slide={slide}
                  first={index === 0}
                  locale={locale}
                  messages={messages}
                  effect={effect}
                  avatarQuery={avatarQuery}
                />
              </CarouselItem>
            ))}
          </CarouselContent>
          {cutout ? (
            <div aria-hidden="true" className="showcase-cutout-layer" key={current?.id}>
              <WebMediaImage
                revealable={false}
                src={cutout.url}
                srcSet={cutout.candidates
                  ?.map((candidate) => `${candidate.url} ${candidate.width}w`)
                  .join(', ')}
                alt=""
                sizes="min(40vw, 30rem)"
                width={cutout.width}
                height={cutout.height}
                loading={api.page === 0 ? 'eager' : 'lazy'}
                className="showcase-cutout"
              />
            </div>
          ) : null}
        </div>
        {slides.length > 1 ? (
          <aside className="showcase-coming" aria-label={messages.comingSlides}>
            <p className="showcase-coming-label">{messages.comingSlides}</p>
            {slides.map((slide, index) => (
              <button
                type="button"
                key={slide.id}
                onClick={() => move(index)}
                aria-current={api.page === index ? 'true' : undefined}
                aria-disabled={api.page === index}
                className="showcase-coming-slide"
              >
                <SlideThumbnail slide={slide} />
                <span className="showcase-coming-number">{String(index + 1).padStart(2, '0')}</span>
                <span lang={slide.title.lang} dir={slide.title.dir}>
                  {slide.title.value || messages.untitled}
                </span>
              </button>
            ))}
          </aside>
        ) : null}
      </div>
    </>
  );
}

export function Showcase({
  slides: allSlides,
  label,
  locale,
  messages,
  effect = 'plain',
  avatarQuery,
  direction = 'ltr',
}: {
  slides: readonly ZoneShowcaseSlide[];
  label: string;
  locale: UiLocale;
  messages: ZoneMessages;
  effect?: ZoneTitleEffect;
  avatarQuery?: string;
  direction?: 'ltr' | 'rtl';
}) {
  const slides = allSlides.slice(0, 5);
  const [rotate, setRotate] = useState(false);
  useEffect(() => {
    const media = matchMedia(rotationWindow);
    const changed = () => setRotate(media.matches);
    changed();
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  if (!slides.length) return null;
  return (
    <>
      <style>{stageWindowCss}</style>
      <ShowcasePreload slide={slides[0]!} />
      <Carousel
        className="showcase"
        aria-label={label}
        slideCount={slides.length}
        autoSize
        slidesPerMove={1}
        spacing="12px"
        loop
        autoplay={rotate && slides.length > 1 ? { delay: rotationDelay } : false}
        dir={direction}
      >
        <StageContents
          slides={slides}
          locale={locale}
          messages={messages}
          effect={effect}
          avatarQuery={avatarQuery}
          rotate={rotate}
        />
      </Carousel>
    </>
  );
}
