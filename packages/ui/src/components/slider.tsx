'use client';

import { Slider as ArkSlider, useSliderContext } from '@ark-ui/react/slider';
import React from 'react';
import { cn } from '../utils.ts';
import { FieldLabel } from './field.tsx';

export const useSlider = useSliderContext;

interface SliderProps extends React.ComponentProps<typeof ArkSlider.Root> {
  /**
   * The interval between markers.
   *
   * @default 1
   */
  markerInterval?: number;
  /**
   * The labels to show on the markers.
   *
   * @default []
   */
  markerLabels?: string[];
  /**
   * Whether to show markers.
   *
   * @default false
   */
  showMarkers?: boolean;
}

export const Slider = (props: SliderProps) => {
  const {
    value,
    defaultValue,
    min = 0,
    max = 100,
    markerInterval = 1,
    showMarkers = false,
    markerLabels = [],
    tabIndex,
    className,
    children,
    ...rest
  } = props;

  const _values = React.useMemo(() => {
    if (Array.isArray(value)) {
      return value;
    }
    if (Array.isArray(defaultValue)) {
      return defaultValue;
    }
    // One thumb unless a value says otherwise; SharkUI rendered two by default.
    return [min];
  }, [value, defaultValue, min]);

  return (
    <ArkSlider.Root
      className={cn(
        'flex flex-col gap-3',
        'data-[orientation=horizontal]:w-full',
        'data-[orientation=vertical]:h-full',
        className,
      )}
      data-slot="slider"
      defaultValue={defaultValue}
      max={max}
      min={min}
      value={value}
      {...rest}
    >
      {children}

      <ArkSlider.Control
        className={cn(
          'relative',
          'w-full',
          'flex items-center',
          'touch-none select-none',
          'data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
          'data-disabled:pointer-events-none data-disabled:opacity-64',
        )}
        data-slot="slider-control"
      >
        <ArkSlider.Track
          className={cn(
            'grow',
            'bg-input',
            'rounded-full',
            'select-none overflow-hidden',
            'data-[orientation=horizontal]:h-2 data-[orientation=horizontal]:w-full',
            'data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2',
          )}
          data-slot="slider-track"
        >
          <ArkSlider.Range
            className={cn(
              'absolute',
              'bg-primary',
              'select-none',
              'data-[orientation=horizontal]:h-full',
              "data-[orientation=vertical]:w-full data-[orientation=vertical]:not-[[class^='h-']]:not-[[class*='_h-']]:self-stretch",
            )}
            data-slot="slider-range"
          />
        </ArkSlider.Track>

        {Array.from({ length: _values.length }, (_, index) => {
          const key = `slider-thumb-${index}`;

          return (
            <ArkSlider.Thumb
              // Aura's thumb: page-colored with a 2px primary ring and a soft halo on focus.
              className={cn(
                'relative',
                'shrink-0',
                'size-5',
                'bg-background',
                'rounded-full border-2 border-primary shadow-md',
                'cursor-grab select-none',
                'transition-[color,box-shadow,transform]',
                'hover:ring-4 hover:ring-primary/20',
                'focus-visible:outline-hidden focus-visible:ring-4 focus-visible:ring-primary/30',
                'data-dragging:scale-110 data-dragging:cursor-grabbing data-dragging:ring-4 data-dragging:ring-primary/30',
                'pointer-coarse:after:absolute pointer-coarse:after:h-full pointer-coarse:after:min-h-11',
                'motion-reduce:transition-none!',
              )}
              data-slot="slider-thumb"
              index={index}
              key={key}
              tabIndex={tabIndex ?? undefined}
            >
              <ArkSlider.HiddenInput />
            </ArkSlider.Thumb>
          );
        })}
      </ArkSlider.Control>

      {showMarkers && (
        <ArkSlider.MarkerGroup
          className={cn(
            'w-full',
            'flex items-center justify-between gap-1',
            'mt-3 px-2.5',
            'font-medium text-muted-foreground text-xs',
            'data-[orientation=vertical]:hidden',
            'pointer-events-none',
          )}
        >
          {Array.from({ length: Math.floor(max - min) + 1 }, (_, index) => (
            <ArkSlider.Marker
              className={cn(
                'group/marker',
                'flex w-0 flex-col items-center justify-center gap-2',
                'data-[state=at-value]:text-foreground data-[state=under-value]:text-foreground',
              )}
              data-interval={index % markerInterval === 0 ? undefined : ''}
              data-slot="slider-marker"
              key={String(index)}
              value={min + index}
            >
              <span
                className={cn(
                  'h-1 w-px',
                  'bg-muted-foreground/70 group-data-[state=at-value]/marker:bg-foreground group-data-[state=under-value]/marker:bg-foreground',
                  'group-data-interval/marker:h-0.5',
                )}
              />

              <span className={cn('group-data-interval/marker:opacity-0')}>
                {markerLabels?.[index] ?? min + index}
              </span>
            </ArkSlider.Marker>
          ))}
        </ArkSlider.MarkerGroup>
      )}
    </ArkSlider.Root>
  );
};

// FieldLabel is a <label>; wrapping Ark's label in it nested two labels.
export const SliderLabel = (props: React.ComponentProps<typeof ArkSlider.Label>) => (
  <FieldLabel asChild>
    <ArkSlider.Label data-slot="slider-label" {...props} />
  </FieldLabel>
);

export const SliderValue = (props: React.ComponentProps<typeof ArkSlider.ValueText>) => {
  const { className, children, ...rest } = props;
  const { value } = useSliderContext();

  return (
    <FieldLabel asChild>
      <ArkSlider.ValueText
        className={cn('ms-auto tabular-nums', className)}
        data-slot="slider-value"
        {...rest}
      >
        {/* Ark joins range values with a comma; a dash reads as a range. */}
        {children ?? value.join(' – ')}
      </ArkSlider.ValueText>
    </FieldLabel>
  );
};
