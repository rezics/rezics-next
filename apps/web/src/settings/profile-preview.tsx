import { useId, useState } from 'react';
import { UserRound } from 'lucide-react';
import { Button } from '@rezics/ui/shadcn/button';
import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/shadcn/avatar';
import { MediaImage } from '@rezics/ui/media-image';
import { m } from '../paraglide/messages.js';
import type { ProfileValues } from './profile-model';

type ProfilePreviewAvatar = ProfileValues['avatar'];

export type ProfilePreviewLink = { label: string; url: string; valid: boolean };

function safePreviewLink({ url, valid }: ProfilePreviewLink): boolean {
  // Keep rejected draft rows inert even when their supplied validity is stale.
  if (
    !valid ||
    Array.from(url).length > 2048 ||
    /[\u0000-\u0020\u007f]/.test(url) ||
    !/^https:\/\/[^/@\s]+(?:[/?#]|$)/i.test(url)
  )
    return false;
  try {
    const destination = new URL(url);
    return (
      destination.protocol === 'https:' && !!destination.hostname && !destination.username && !destination.password
    );
  } catch {
    return false;
  }
}

function PreviewAvatar({
  avatar,
  localUrl,
  mediaSource,
}: {
  avatar: ProfilePreviewAvatar;
  localUrl: string | null;
  mediaSource: (media: string, format: 'avif' | 'webp', width: number) => string;
}) {
  if (!localUrl && avatar && 'variants' in avatar) {
    return (
      <div className="size-16 shrink-0 overflow-hidden rounded-full bg-muted">
        <MediaImage
          {...avatar}
          className="rounded-full"
          frame={1}
          sizes="64px"
          alt=""
          src={({ media, format, width }) => mediaSource(media, format, width)}
        />
      </div>
    );
  }

  return (
    <Avatar className="size-16 shrink-0">
      {localUrl ? <AvatarImage src={localUrl} alt="" /> : null}
      <AvatarFallback>
        <UserRound className="size-7" aria-hidden="true" />
      </AvatarFallback>
    </Avatar>
  );
}

/** A local-only view of the editor's current values; it owns no profile or avatar state. */
export function ProfilePreview({
  displayName,
  biography,
  avatar,
  localAvatarUrl,
  mediaSource,
  links,
  hasUnsavedChanges,
}: {
  displayName: string | null;
  biography: string | null;
  avatar: ProfilePreviewAvatar;
  localAvatarUrl: string | null;
  mediaSource: (media: string, format: 'avif' | 'webp', width: number) => string;
  links: ProfilePreviewLink[];
  hasUnsavedChanges: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const regionId = `${id}-region`;
  const headingId = `${id}-heading`;
  const name = displayName?.trim() ? displayName : m.settings_profile_preview_empty_name();

  return (
    <div className="min-w-0 space-y-3">
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? m.settings_profile_preview_close() : m.settings_profile_preview_open()}
      </Button>
      <section
        id={regionId}
        role="region"
        aria-labelledby={headingId}
        hidden={!open}
        className="min-w-0 rounded-2xl border border-border/60 bg-card p-4 shadow-(--aura-shadow-card) sm:p-6"
      >
        <div className="min-w-0 space-y-4 font-sans text-foreground">
          <header className="min-w-0 space-y-2">
            <h3 id={headingId} className="font-sans text-xl font-semibold tracking-tight wrap-anywhere">
              {m.settings_profile_preview_heading()}
            </h3>
            <p className="text-sm text-muted-foreground">{m.settings_profile_preview_description()}</p>
            <p role="status" className="text-sm font-medium">
              {hasUnsavedChanges ? m.settings_profile_preview_draft() : m.settings_profile_preview_saved()}
            </p>
          </header>

          <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-4 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-x-5">
            <div className="sm:row-span-2">
              <PreviewAvatar avatar={avatar} localUrl={localAvatarUrl} mediaSource={mediaSource} />
            </div>
            <div className="min-w-0 space-y-2">
              <h4 className="min-w-0 font-sans text-2xl font-semibold tracking-tight wrap-anywhere text-balance">
                {name}
              </h4>
            </div>
            <div className="col-span-full min-w-0 space-y-4 wrap-anywhere sm:col-span-1 sm:col-start-2">
              {biography ? (
                <p className="max-w-prose text-base leading-7 text-pretty whitespace-pre-line">{biography}</p>
              ) : null}
              {links.length ? (
                <nav aria-label={m.settings_profile_preview_links()} className="min-w-0">
                  <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
                    {links.slice(0, 5).map((link, index) => {
                      const label = link.label.trim() || m.settings_profile_link_row({ number: index + 1 });
                      const valid = safePreviewLink(link);
                      return (
                        <li key={`${index}:${link.url}`} className="min-w-0 rounded-xl border border-border/60 p-3">
                          {valid ? (
                            <a
                              href={link.url}
                              target="_blank"
                              rel="nofollow noopener noreferrer ugc"
                              className="inline-flex min-h-11 max-w-full items-center text-primary underline underline-offset-4 wrap-anywhere"
                            >
                              {label}
                            </a>
                          ) : (
                            <span className="inline-flex min-h-11 max-w-full items-center wrap-anywhere">{label}</span>
                          )}
                          {link.url ? (
                            <p className="max-w-full break-all text-xs text-muted-foreground">{link.url}</p>
                          ) : null}
                          {!valid ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {m.settings_profile_preview_invalid_link()}
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </nav>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
