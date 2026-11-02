import type { ReactElement } from 'react';
import { ContentItem } from '@rezics/ui/content-item';
import { MediaImage } from '@rezics/ui/media-image';
import { Button } from '@rezics/ui/shadcn/button';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import { initials } from '../../threads/initials';
import type { RealmDiscoverySectionProps } from './index';

/** Public presentation only. Placements own loading, replacement, cross-page deduplication and manual retry. */
export function RealmDiscoverySection({
  sort,
  state,
  locale,
  pending = false,
  retry = false,
  restart = false,
  onNext,
  onRetry,
}: RealmDiscoverySectionProps): ReactElement {
  const language = locales.find((value) => value === locale) ?? 'en';
  const options = { locale: language };
  const title = sort === 'popular' ? m.realm_discovery_popular({}, options) : m.realm_discovery_trending({}, options);
  const retryLabel = restart ? m.discovery_restart_action({}, options) : m.realm_discovery_retry({}, options);
  return (
    <section
      data-slot="realm-discovery"
      data-sort={sort}
      tabIndex={-1}
      aria-label={title}
      aria-busy={pending || state.kind === 'loading'}
      className="min-w-0 space-y-3 text-foreground"
    >
      <header className="space-y-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {sort === 'popular'
            ? m.realm_discovery_popular_window({}, options)
            : m.realm_discovery_trending_window({}, options)}
        </p>
      </header>
      {state.kind === 'ready' ? (
        <>
          {state.realms.length > 0 ? (
            <ul className="space-y-1">
              {state.realms.map((realm) => (
                <ContentItem
                  key={realm.realmId}
                  title={realm.name}
                  titleDataSlot="realm-discovery-title"
                  headingLevel={3}
                  href={`/${language}/realms/${encodeURIComponent(realm.realmId)}`}
                  className="items-center"
                  visual={
                    realm.avatar ? (
                      <MediaImage
                        media={realm.avatar.id}
                        width={realm.avatar.width}
                        height={realm.avatar.height}
                        variants={realm.avatar.variants}
                        placeholder={realm.avatar.placeholder}
                        src={({ media, format, width }) => coverSrc(media, format, width)}
                        alt={initials(realm.name)}
                        aria-hidden="true"
                        sizes="44px"
                        frame={1}
                        className="size-11 shrink-0 rounded-full [&_img]:[object-position:inherit]"
                        style={{
                          objectPosition: realm.avatar.focalPoint
                            ? `${realm.avatar.focalPoint.x * 100}% ${realm.avatar.focalPoint.y * 100}%`
                            : undefined,
                        }}
                      />
                    ) : (
                      <span
                        data-slot="realm-discovery-initials"
                        aria-hidden="true"
                        className="grid size-11 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold text-muted-foreground"
                      >
                        {initials(realm.name)}
                      </span>
                    )
                  }
                  preview={
                    realm.description ? (
                      <p className="line-clamp-1 text-xs text-muted-foreground">{realm.description}</p>
                    ) : undefined
                  }
                />
              ))}
            </ul>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {state.next === null ? m.realm_discovery_empty({}, options) : m.realm_discovery_page_empty({}, options)}
            </p>
          )}
          {state.next !== null && onNext && !retry ? (
            <Button variant="outline" className="min-h-11" disabled={pending} onClick={onNext}>
              {m.realm_discovery_continue({}, options)}
            </Button>
          ) : null}
          {pending || retry ? (
            <p role="status" className="text-sm text-muted-foreground">
              {pending ? m.realm_discovery_loading({}, options) : m.realm_discovery_unavailable({}, options)}
            </p>
          ) : null}
          {retry && !pending && onRetry ? (
            <Button variant="outline" className="min-h-11" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
          {state.realms.map((realm) =>
            realm.avatar?.credit ? (
              <p key={realm.realmId} className="text-xs text-muted-foreground">
                {realm.name}: © {realm.avatar.credit.rightsHolder} ·{' '}
                <a href={realm.avatar.credit.via.url} rel="noopener noreferrer nofollow" className="underline">
                  {realm.avatar.credit.via.name}
                </a>{' '}
                · {realm.avatar.credit.license}
              </p>
            ) : null,
          )}
        </>
      ) : (
        <div className="space-y-3">
          <p role="status" className="text-sm text-muted-foreground">
            {state.kind === 'loading'
              ? m.realm_discovery_loading({}, options)
              : state.kind === 'closed'
                ? m.realm_discovery_closed({}, options)
                : m.realm_discovery_unavailable({}, options)}
          </p>
          {state.kind === 'unavailable' && onRetry ? (
            <Button variant="outline" className="min-h-11" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
