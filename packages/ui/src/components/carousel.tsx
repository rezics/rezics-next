'use client';

import { Carousel as ArkCarousel, useCarouselContext } from '@ark-ui/react/carousel';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import type React from 'react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useUiCopy } from '../i18n/copy.ts';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import { LocaleProvider, useLocale } from './locale.tsx';

const RotationContext = createContext({
  manual: () => {},
  toggle: (_pause?: boolean) => {},
  requested: false,
  reduced: true,
  stopped: false,
  slidesPerMove: 1,
  visibilityThreshold: 0.6,
});

export const useCarousel = () => {
  const api = useCarouselContext();
  const rotation = useContext(RotationContext);
  return {
    ...api,
    isRotationRequested: rotation.requested,
    play: () => {
      rotation.toggle(false);
      api.play();
    },
    pause: () => {
      rotation.toggle(true);
      api.pause();
    },
    scrollTo: (page: number, instant?: boolean) => {
      if (page === api.page) return;
      rotation.manual();
      api.scrollTo(page, instant);
    },
    scrollToIndex: (index: number, instant?: boolean) => {
      rotation.manual();
      api.scrollToIndex(index, instant);
    },
    scrollNext: (instant?: boolean) => {
      rotation.manual();
      api.scrollNext(instant);
    },
    scrollPrev: (instant?: boolean) => {
      rotation.manual();
      api.scrollPrev(instant);
    },
  };
};

function RotationGuard({ playing }: { playing: boolean }) {
  const api = useCarouselContext();
  useEffect(() => {
    if (!playing && api.isPlaying) api.pause();
    if (playing && !api.isPlaying) api.play();
  }, [playing, api]);
  return null;
}

export const Carousel = (props: React.ComponentProps<typeof ArkCarousel.Root>) => {
  const { spacing = '16px', className, autoplay, children, ref, ...rest } = props;
  const root = useRef<HTMLDivElement | null>(null);
  const parentLocale = useLocale();
  const machineLocale =
    rest.dir === 'rtl' && parentLocale.dir !== 'rtl'
      ? 'ar'
      : rest.dir === 'ltr' && parentLocale.dir !== 'ltr'
        ? 'en'
        : parentLocale.locale;
  const touch = useRef<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState(false);
  const [focusStopped, setFocusStopped] = useState(false);
  const [paused, setPaused] = useState(false);
  const [userStarted, setUserStarted] = useState(false);
  const [manual, setManual] = useState(false);
  const [visible, setVisible] = useState(false);
  const [tabVisible, setTabVisible] = useState(false);
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(media.matches);
    const visibility = () => setTabVisible(document.visibilityState === 'visible');
    motion();
    visibility();
    media.addEventListener('change', motion);
    document.addEventListener('visibilitychange', visibility);
    const observer = new IntersectionObserver((entries) =>
      setVisible(entries.some((entry) => entry.isIntersecting)),
    );
    if (root.current) observer.observe(root.current);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', motion);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  const requested = (Boolean(autoplay) || userStarted) && !manual && !paused && !focusStopped;
  const playing = requested && !hover && visible && tabVisible && !reduced;
  const stop = () => setManual(true);

  return (
    <LocaleProvider locale={machineLocale}>
      <ArkCarousel.Root
        className={cn(
          'relative',
          'flex flex-col',
          'data-[orientation=vertical]:w-max data-[orientation=vertical]:flex-row',
          className,
        )}
        data-slot="carousel"
        data-rotation-state={
          manual
            ? 'manual'
            : reduced
              ? 'reduced'
              : !tabVisible
                ? 'hidden'
                : !visible
                  ? 'offscreen'
                  : focusStopped
                    ? 'focus'
                    : hover
                      ? 'hover'
                      : paused
                        ? 'paused'
                        : requested
                          ? 'playing'
                          : 'disabled'
        }
        spacing={spacing}
        {...rest}
        ref={(element) => {
          root.current = element;
          if (typeof ref === 'function') ref(element);
          else if (ref) ref.current = element;
        }}
        autoplay={playing ? autoplay || true : false}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') setHover(true);
          rest.onPointerEnter?.(event);
        }}
        onPointerLeave={(event) => {
          setHover(false);
          rest.onPointerLeave?.(event);
        }}
        onFocusCapture={(event) => {
          setFocusStopped(true);
          rest.onFocusCapture?.(event);
        }}
        onClickCapture={(event) => {
          const target = (event.target as HTMLElement).closest(
            '[data-part="prev-trigger"], [data-part="next-trigger"], [data-part="indicator"]',
          );
          if (target && !target.hasAttribute('data-current')) stop();
          rest.onClickCapture?.(event);
        }}
        onTouchStartCapture={(event) => {
          const point = event.touches[0];
          touch.current = point ? { x: point.clientX, y: point.clientY } : null;
          rest.onTouchStartCapture?.(event);
        }}
        onTouchMoveCapture={(event) => {
          const point = event.touches[0],
            origin = touch.current;
          if (
            point &&
            origin &&
            Math.abs(point.clientX - origin.x) > Math.max(8, Math.abs(point.clientY - origin.y))
          )
            stop();
          rest.onTouchMoveCapture?.(event);
        }}
        onWheelCapture={(event) => {
          if (event.deltaX) stop();
          rest.onWheelCapture?.(event);
        }}
        onKeyDownCapture={(event) => {
          if (
            (event.target as HTMLElement).closest('[data-part="indicator-group"]') &&
            ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
          )
            stop();
          rest.onKeyDownCapture?.(event);
        }}
        onDragStatusChange={(details) => {
          if (details.isDragging) stop();
          rest.onDragStatusChange?.(details);
        }}
      >
        <RotationContext
          value={{
            manual: stop,
            stopped: manual,
            requested,
            reduced,
            slidesPerMove:
              typeof rest.slidesPerMove === 'number'
                ? rest.slidesPerMove
                : Math.max(1, Math.floor(rest.slidesPerPage ?? 1)),
            toggle: (pause) => {
              const nextPaused = pause ?? requested;
              setPaused(nextPaused);
              setFocusStopped(false);
              if (!nextPaused && !autoplay) setUserStarted(true);
            },
            visibilityThreshold: Array.isArray(rest.inViewThreshold)
              ? rest.inViewThreshold.length
                ? Math.max(...rest.inViewThreshold)
                : 0.6
              : (rest.inViewThreshold ?? 0.6),
          }}
        >
          <RotationGuard playing={playing} />
          {children}
        </RotationContext>
      </ArkCarousel.Root>
    </LocaleProvider>
  );
};

export const CarouselAutoplayTrigger = (
  props: React.ComponentProps<typeof ArkCarousel.AutoplayTrigger>,
) => {
  const rotation = useContext(RotationContext);
  // Hover and focus can pause Ark before a click. Keep the action the pointer pressed.
  const pointerIntent = useRef<boolean | undefined>(undefined);
  return (
    <ArkCarousel.AutoplayTrigger
      {...props}
      disabled={rotation.stopped || rotation.reduced || props.disabled}
      onPointerDown={(event) => {
        pointerIntent.current = rotation.requested;
        props.onPointerDown?.(event);
      }}
      onKeyDown={(event) => {
        pointerIntent.current = undefined;
        props.onKeyDown?.(event);
      }}
      onClick={(event) => {
        rotation.toggle(pointerIntent.current);
        pointerIntent.current = undefined;
        props.onClick?.(event);
      }}
    />
  );
};

export const CarouselControl = (props: React.ComponentProps<typeof ArkCarousel.Control>) => {
  const { className, ...rest } = props;

  return (
    <ArkCarousel.Control
      className={cn(
        'flex items-center justify-between gap-2',
        'data-[orientation=vertical]:flex-col',
        className,
      )}
      data-slot="carousel-control"
      {...rest}
    />
  );
};

export const CarouselPrevious = (props: React.ComponentProps<typeof ArkCarousel.PrevTrigger>) => {
  const { className, ...rest } = props;
  const copy = useUiCopy();

  return (
    <ArkCarousel.PrevTrigger
      className={cn(
        'absolute',
        'data-[orientation=horizontal]:-inset-s-12 data-[orientation=horizontal]:top-1/2 data-[orientation=horizontal]:-translate-y-1/2',
        'data-[orientation=vertical]:-top-12 data-[orientation=vertical]:left-1/2 data-[orientation=vertical]:-translate-x-1/2 data-[orientation=vertical]:rotate-90',
        className,
      )}
      data-slot="carousel-previous"
      {...rest}
      asChild
    >
      <Button
        aria-label={copy.previous}
        className="shadow-[var(--aura-shadow-card)] transition-all duration-300 hover:scale-105 hover:shadow-[var(--aura-shadow-card-hover)]"
        clickEffect={false}
        pill
        size="icon-md"
        variant="outline"
      >
        <ChevronLeftIcon aria-hidden />
      </Button>
    </ArkCarousel.PrevTrigger>
  );
};

export const CarouselNext = (props: React.ComponentProps<typeof ArkCarousel.NextTrigger>) => {
  const { className, ...rest } = props;
  const copy = useUiCopy();

  return (
    <ArkCarousel.NextTrigger
      className={cn(
        'absolute',
        'data-[orientation=horizontal]:-inset-e-12 data-[orientation=horizontal]:top-1/2 data-[orientation=horizontal]:-translate-y-1/2',
        'data-[orientation=vertical]:-bottom-12 data-[orientation=vertical]:left-1/2 data-[orientation=vertical]:-translate-x-1/2 data-[orientation=vertical]:rotate-90',
        className,
      )}
      {...rest}
      asChild
      data-slot="carousel-next"
    >
      <Button
        aria-label={copy.next}
        className="shadow-[var(--aura-shadow-card)] transition-all duration-300 hover:scale-105 hover:shadow-[var(--aura-shadow-card-hover)]"
        clickEffect={false}
        pill
        size="icon-md"
        variant="outline"
      >
        <ChevronRightIcon aria-hidden />
      </Button>
    </ArkCarousel.NextTrigger>
  );
};

export const CarouselIndicatorGroup = (
  props: React.ComponentProps<typeof ArkCarousel.IndicatorGroup>,
) => {
  const { className, ...rest } = props;

  return (
    <ArkCarousel.IndicatorGroup
      className={cn('flex justify-center gap-2', 'data-[orientation=vertical]:flex-col', className)}
      data-slot="carousel-indicator-group"
      {...rest}
    />
  );
};

export const CarouselIndicator = (props: React.ComponentProps<typeof ArkCarousel.Indicator>) => {
  const { className, ...rest } = props;
  const api = useCarousel();

  return (
    <ArkCarousel.Indicator
      className={cn(
        'size-2',
        'shrink-0',
        'bg-foreground',
        'opacity-64 data-current:opacity-100',
        'overflow-hidden',
        '[&_img]:size-full [&_img]:rounded-xl [&_img]:object-cover',
        'rounded-full',
        className,
      )}
      data-slot="carousel-indicator"
      {...rest}
      onClick={(event) => {
        rest.onClick?.(event);
        if (event.defaultPrevented || rest.readOnly) return;
        // Prevent Ark's default smooth scroll when the reader requests reduced motion.
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
          event.preventDefault();
          api.scrollTo(rest.index, true);
        }
      }}
    />
  );
};

export const CarouselContent = (props: React.ComponentProps<typeof ArkCarousel.ItemGroup>) => {
  const { className, ...rest } = props;

  return (
    <ArkCarousel.ItemGroup
      className={cn(
        'min-w-0',
        '-my-4 py-4',
        'flex flex-1 gap-4',
        'overflow-hidden rounded-xl',
        className,
      )}
      data-slot="carousel-group"
      {...rest}
    />
  );
};

export const CarouselItem = (
  props: React.ComponentProps<typeof ArkCarousel.Item> & { coverImages?: boolean },
) => {
  const { className, coverImages = true, ref, ...rest } = props;
  const api = useCarouselContext();
  const { slidesPerMove, visibilityThreshold } = useContext(RotationContext);
  const item = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = item.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) =>
        setInView(
          entries.some(
            (entry) => entry.isIntersecting && entry.intersectionRatio >= visibilityThreshold,
          ),
        ),
      { root: element.closest('[data-part="item-group"]'), threshold: visibilityThreshold },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visibilityThreshold]);
  // Ark's intersection list starts empty during SSR. The selected page is accessible immediately.
  const visible = inView || rest.index === api.page * slidesPerMove;

  return (
    <ArkCarousel.Item
      className={cn(
        'min-w-0',
        'shrink-0 grow-0 basis-full',
        coverImages && '[&_img]:size-full [&_img]:rounded-xl [&_img]:object-cover',
        className,
      )}
      data-slot="carousel-item"
      {...rest}
      ref={(element) => {
        item.current = element;
        if (typeof ref === 'function') ref(element);
        else if (ref) ref.current = element;
      }}
      aria-hidden={!visible}
      inert={!visible}
    />
  );
};
