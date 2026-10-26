import type { MediaSrc, MediaSummary } from '../components/media-image-sources.ts';
import type { CoverSummary } from '../components/cover-model.ts';

// Two 30×45 gradients, encoded once with sharp, so stories load real AVIF and WebP bytes without a network.
const avif =
  'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAADUAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAB4AAAAtAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAA9bWRhdBIACgk4EXtjSAhoNIAyJhxCYuThBBBBY4AA3Y9wwDlB/2BTSeiHMw7taUdryU6jU6ePHElM';
const webp =
  'UklGRmIAAABXRUJQVlA4IFYAAACwAwCdASoeAC0APxGAuFYsJ6UypWmaUCIJZACdOY2+AAUzg2m5eAD+2I64CTjGVx6UShS2E5rnEH3mw6Uof9G04DxfQPBC2VcSnnAOD8Q/wmpXnp0AAA==';

/** Builds the URL of a published variant; every width resolves to the same small image. */
export const fixtureSrc: MediaSrc = ({ format }) => `data:image/${format};base64,${format === 'avif' ? avif : webp}`;

/** Builds a URL that never decodes, as a deleted or corrupt object does. */
export const brokenSrc: MediaSrc = ({ format }) => `data:image/${format};base64,AAAA`;

/** A cover summary as the kernel returns it, with the variants the kernel publishes. */
export const summary = (media: string, overrides: Partial<MediaSummary> = {}): MediaSummary => ({
  media,
  width: 1200,
  height: 1800,
  placeholder: { color: '#5a4632' },
  variants: [320, 640, 960].flatMap((width) => [
    { format: 'avif' as const, width },
    { format: 'webp' as const, width },
  ]),
  ...overrides,
});

/** The same builder in the argument order `Cover` calls it with. */
export const coverSrc = (media: string, format: 'avif' | 'webp', width: number) => fixtureSrc({ media, format, width });

/** A cover summary as `Cover` takes it: the media summary with its ThumbHash, crop point and credit. */
export const coverSummary = (media: string, overrides: Partial<CoverSummary> = {}): CoverSummary => ({
  ...summary(media),
  variants: [...summary(media).variants],
  placeholder: { thumbhash: '3OcRJYB4d3h/iIeHeEh3eIhw+j3A', color: '#5a4632' },
  focalPoint: null,
  credit: null,
  ...overrides,
});
