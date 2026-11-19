/**
 * Pointer targets for bordered official Mira controls.
 * The visible box stays `sm` (24px) or default (28px) on every pointer.
 * A phone or coarse pointer extends the hitbox from the padding edge, one pixel
 * inside the border, so the hit target reaches 44px without growing the control.
 */
export const miraSmPointerTarget =
  'max-md:hitbox-y-[11px] pointer-coarse:hitbox-y-[11px] max-md:before:min-w-11 pointer-coarse:before:min-w-11';

export const miraDefaultPointerTarget =
  'max-md:hitbox-y-[9px] pointer-coarse:hitbox-y-[9px] max-md:before:min-w-11 pointer-coarse:before:min-w-11';
