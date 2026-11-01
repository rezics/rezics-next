import { useId } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Slider } from '@rezics/ui/shadcn/slider';
import { m } from '../paraglide/messages.js';
import { avatarCropBounds, avatarCropMaxZoom } from './profile-avatar-crop.ts';
import type { ProfileAvatarUpload } from './profile-avatar-upload';

type CropState = ReturnType<ProfileAvatarUpload['snapshot']>;

function sliderValue(value: number | readonly number[], fallback: number): number {
  return typeof value === 'number' ? value : (value[0] ?? fallback);
}

export function ProfileAvatarCrop({
  controller,
  state,
  disabled,
}: {
  controller: ProfileAvatarUpload;
  state: CropState;
  disabled: boolean;
}) {
  const horizontalId = useId();
  const verticalId = useId();
  const zoomId = useId();
  if (!state.url || !state.crop || (state.phase !== 'crop' && state.phase !== 'exporting')) return null;
  const { width, height, position } = state.crop;
  const bounds = avatarCropBounds({ width, height }, position);
  const zoomLimit = avatarCropMaxZoom({ width, height });
  const controlsDisabled = disabled || state.phase === 'exporting';

  return (
    <section aria-labelledby={`${horizontalId}-heading`} className="min-w-0 space-y-4 rounded-md border p-3">
      <div className="space-y-1">
        <h3 id={`${horizontalId}-heading`} className="text-sm font-medium">
          {m.settings_profile_crop_heading()}
        </h3>
        <p className="text-sm text-muted-foreground">{m.settings_profile_crop_help()}</p>
      </div>
      <div
        role="img"
        aria-label={m.settings_profile_crop_preview()}
        className="relative aspect-square w-full max-w-64 overflow-hidden rounded-md bg-muted"
      >
        <img
          src={state.url}
          alt=""
          draggable={false}
          className="absolute max-w-none select-none"
          style={{
            width: `${(width / bounds.side) * 100}%`,
            height: `${(height / bounds.side) * 100}%`,
            left: `${(-bounds.x / bounds.side) * 100}%`,
            top: `${(-bounds.y / bounds.side) * 100}%`,
          }}
        />
      </div>
      <div className="min-w-0 space-y-3">
        <div>
          <div className="flex justify-between gap-2 text-sm">
            <span id={horizontalId}>{m.settings_profile_crop_horizontal()}</span>
            <output aria-hidden="true" className="tabular-nums text-muted-foreground">
              {position.horizontal}%
            </output>
          </div>
          <Slider
            aria-labelledby={horizontalId}
            className="w-full [&>div]:min-h-11 **:data-[slot=slider-thumb]:size-5"
            disabled={controlsDisabled}
            min={0}
            max={100}
            step={1}
            value={[position.horizontal]}
            onValueChange={(value) => controller.setCrop({ horizontal: sliderValue(value, position.horizontal) })}
          />
        </div>
        <div>
          <div className="flex justify-between gap-2 text-sm">
            <span id={verticalId}>{m.settings_profile_crop_vertical()}</span>
            <output aria-hidden="true" className="tabular-nums text-muted-foreground">
              {position.vertical}%
            </output>
          </div>
          <Slider
            aria-labelledby={verticalId}
            className="w-full [&>div]:min-h-11 **:data-[slot=slider-thumb]:size-5"
            disabled={controlsDisabled}
            min={0}
            max={100}
            step={1}
            value={[position.vertical]}
            onValueChange={(value) => controller.setCrop({ vertical: sliderValue(value, position.vertical) })}
          />
        </div>
        <div>
          <div className="flex justify-between gap-2 text-sm">
            <span id={zoomId}>{m.settings_profile_crop_zoom()}</span>
            <output aria-hidden="true" className="tabular-nums text-muted-foreground">
              {position.zoom}%
            </output>
          </div>
          <Slider
            aria-labelledby={zoomId}
            className="w-full [&>div]:min-h-11 **:data-[slot=slider-thumb]:size-5"
            disabled={controlsDisabled || zoomLimit <= 100}
            min={100}
            max={zoomLimit}
            step={10}
            value={[position.zoom]}
            onValueChange={(value) => controller.setCrop({ zoom: sliderValue(value, position.zoom) })}
          />
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap gap-3">
        <Button
          type="button"
          className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
          disabled={controlsDisabled}
          onClick={controller.applyCrop}
        >
          {state.phase === 'exporting' ? m.settings_profile_crop_preparing() : m.settings_profile_crop_apply()}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
          disabled={controlsDisabled}
          onClick={controller.useOriginal}
        >
          {m.settings_profile_crop_use_original()}
        </Button>
      </div>
    </section>
  );
}
