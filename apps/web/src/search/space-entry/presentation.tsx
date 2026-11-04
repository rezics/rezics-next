import { useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import { coverSrc } from '../../media/cover-src';
import type { SpaceEntryPresentation } from './contract';

export function SpaceEntryAvatar({ presentation, locale }: { presentation: SpaceEntryPresentation; locale: string }) {
  const [failed, setFailed] = useState(false);
  const image = presentation.avatar;
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  return (
    <div className="w-[72px] space-y-1 sm:w-24">
      <div
        className="flex aspect-square items-center justify-center overflow-hidden rounded-full bg-muted"
        aria-hidden="true"
      >
        {image.state === 'available' && !failed ? (
          <img
            alt=""
            src={coverSrc(image.mediaId, image.format, image.width)}
            className="size-full object-cover"
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="text-2xl">{[...presentation.identity.name].slice(0, 2).join('')}</span>
        )}
      </div>
      {failed || image.state === 'unavailable' || image.state === 'withheld' ? (
        <span className="text-xs text-muted-foreground">{m.search_space_image_unavailable({}, options)}</span>
      ) : null}
    </div>
  );
}
