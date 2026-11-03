import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { catalogueEntries } from '../catalogue/catalogue-entry';
import type { MusicContextKind, MusicContextRead } from '../catalogue/music-context-profile';
import { ViewHeading } from './view-heading';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export type MusicContextTransport = {
  read: (input: { stream?: string | undefined; cursor?: string | undefined; session?: string | undefined }) => Promise<MusicContextRead>;
};

function kindLabel(kind: MusicContextKind, locale: string) {
  const o = { locale: locale as never };
  if (kind === 'place') return m.music_context_place({}, o);
  if (kind === 'event') return m.music_context_event({}, o);
  if (kind === 'area') return m.music_context_area({}, o);
  if (kind === 'instrument') return m.music_context_instrument({}, o);
  return m.music_context_unavailable({}, o);
}

export function MusicContextProfile({
  id,
  locale,
  returnTo,
  transport,
  initial,
}: {
  id: string;
  locale: string;
  returnTo?: string | undefined;
  transport: MusicContextTransport;
  initial?: MusicContextRead | undefined;
}) {
  const o = { locale: locale as never };
  const failureRef = useRef<HTMLParagraphElement>(null);
  const [page, setPage] = useState<Extract<MusicContextRead, { ok: true }>>();
  const query = useQuery({
    queryKey: ['music-context', id, locale],
    queryFn: () => transport.read({}),
    initialData: initial,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const read = page ?? (query.data?.ok ? query.data : undefined);
  const error = !read && query.data && !query.data.ok ? query.data : undefined;
  const title = pickText(read?.public.subject.labels ?? {}, locale);
  const origin = returnTo || subjectHref({ id, label: title.text }, locale).href;
  return (
    <article className="mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]" aria-busy={query.isPending}>
      <ViewHeading label={m.music_context_title({}, o)} headingClassName="font-sans" />
      <p className="max-w-prose text-muted-foreground">{m.music_context_intro({}, o)}</p>
      {query.isPending && <p role="status">{m.music_context_loading({}, o)}</p>}
      {error && (
        <p ref={failureRef} role="alert" tabIndex={-1}>
          {error.reason === 'denied' ? m.music_context_denied({}, o) : m.music_context_unavailable({}, o)}
        </p>
      )}
      {read?.kind === 'unsupported' && <p>{m.music_context_unavailable({}, o)}</p>}
      {read && read.kind !== 'unsupported' && (
        <div className="space-y-4">
          <p>{kindLabel(read.kind, locale)}</p>
          <ul className="space-y-1">
            {read.facts.map((fact) => (
              <li key={`${fact.property}:${fact.text}`}>
                {fact.label}:{' '}
                {fact.unknown
                  ? fact.property.match(/coord|globe/i)
                    ? m.music_context_coordinates_unsupported({}, o)
                    : m.music_context_unknown_date({}, o)
                  : fact.precision && fact.precision !== '11'
                    ? m.music_context_partial_date({ date: fact.text }, o)
                    : fact.text}
              </li>
            ))}
          </ul>
          <ul className="space-y-2">
            {read.links.map((link) => (
              <li key={`${link.property}:${link.id}:${link.date ?? ''}`}>
                {link.unreadable ? (
                  m.music_context_unreadable_artist({}, o)
                ) : (
                  <a className={linkClass} href={subjectHref({ id: link.id, label: link.label }, locale).href}>
                    {link.label}
                    {link.date ? ` · ${link.date}` : ''}
                    {link.role ? ` · ${link.role}` : ''}
                  </a>
                )}
              </li>
            ))}
          </ul>
          {read.next && (
            <Button
              type="button"
              variant="outline"
              className={actionClass}
              onClick={() => void transport.read({ stream: read.stream, cursor: read.next ?? undefined, session: read.session }).then((value) => value.ok && setPage(value))}
            >
              {m.music_context_more({}, o)}
            </Button>
          )}
          <a className={linkClass} href={`${catalogueEntries.facts({ id, label: title.text, locale }).href}?${new URLSearchParams({ returnTo: origin })}`}>
            {m.music_context_correct({}, o)}
          </a>
          <a className={linkClass} href={origin}>
            {m.music_context_return({}, o)}
          </a>
        </div>
      )}
    </article>
  );
}
