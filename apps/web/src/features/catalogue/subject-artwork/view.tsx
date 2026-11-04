import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { NativeDocumentImage, type DocumentImagePresentation } from '../../../threads/document-media';
import type { Reader } from '../../../subject/reader';
import type { Stmt } from '../../pages/shared';
import { ArtworkReaderContext } from './session';
import { canonicalMediaId, type ArtworkResult, type ArtworkTransport } from './read';

type Selection = { key: string; id: string };
type Reading = { selection: Selection; result: ArtworkResult | { kind: 'loading' } };
const ArtworkContext = createContext<{
  incarnation?: number;
  reading?: Reading | undefined;
  select?: ((selection: Selection) => void) | undefined;
  fallback?: RefObject<HTMLDivElement | null> | undefined;
}>({});

/** One caller incarnation and one explicitly selected media window; A → B → A never restores state. */
export function SubjectArtworkBoundary({
  source,
  identity,
  label,
  children,
}: {
  source: object;
  identity: string;
  label: string;
  children: ReactNode;
}) {
  const reader = useContext(ArtworkReaderContext);
  const previous = useRef<{ source: object; identity: string; reader: unknown; generation: number } | null>(null);
  if (
    !previous.current ||
    previous.current.source !== source ||
    previous.current.identity !== identity ||
    previous.current.reader !== reader.incarnation
  ) {
    previous.current = {
      source,
      identity,
      reader: reader.incarnation,
      generation: (previous.current?.generation ?? 0) + 1,
    };
  }
  const admission = useRef<{ source: object; reader: unknown; retired: boolean }>({
    source,
    reader: reader.incarnation,
    retired: false,
  });
  if (admission.current.source !== source) admission.current = { source, reader: reader.incarnation, retired: false };
  else if (admission.current.reader === null && !admission.current.retired)
    admission.current.reader = reader.incarnation;
  else if (admission.current.reader !== reader.incarnation) admission.current.retired = true;
  const fallback = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={fallback}
      tabIndex={-1}
      role="group"
      aria-label={label}
      className="min-w-0 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
    >
      <ArtworkVisit
        generation={previous.current.generation}
        read={admission.current.retired ? undefined : reader.read}
        current={reader.current}
        fallback={fallback}
      >
        {children}
      </ArtworkVisit>
    </div>
  );
}

function ArtworkVisit({
  generation,
  read,
  current,
  fallback,
  children,
}: {
  generation: number;
  read?: ArtworkTransport | undefined;
  current?: (() => boolean) | undefined;
  fallback: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const [reading, setReading] = useState<Reading>();
  const request = useRef(0);
  const previous = useRef(generation);
  if (previous.current !== generation) {
    previous.current = generation;
    request.current++;
    if (reading) setReading(undefined);
  }
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);
  const select = async (selection: Selection) => {
    if (previous.current !== generation || reading?.result.kind === 'loading' || current?.() === false) return;
    const attempt = ++request.current;
    setReading({ selection, result: { kind: 'loading' } });
    let result: ArtworkResult;
    try {
      result = (await read?.(selection.id)) ?? { kind: 'unavailable' };
    } catch {
      result = { kind: 'unavailable' };
    }
    if (mounted.current && previous.current === generation && request.current === attempt && current?.() !== false)
      setReading({ selection, result });
  };
  return (
    <ArtworkContext.Provider value={{ incarnation: generation, reading, select, fallback }}>
      {children}
    </ArtworkContext.Provider>
  );
}

/** Only the ordinary fact branch supplies this exact original assertion, after its statement spoiler gate. */
export function SubjectArtwork({
  subject,
  statement,
  title,
  propertyLabel,
  locale,
  suitability,
}: {
  subject: string;
  statement: Stmt;
  title: string;
  propertyLabel: string;
  locale: string;
  suitability: Reader['suitability'];
}) {
  const { incarnation } = useContext(ArtworkContext);
  const identity = JSON.stringify([incarnation, subject, statement, title, propertyLabel, locale, suitability]);
  return (
    <ArtworkFact
      key={identity}
      identity={identity}
      statement={statement}
      title={title}
      propertyLabel={propertyLabel}
      locale={locale}
      suitability={suitability}
    />
  );
}

function ArtworkFact({
  identity,
  statement,
  title,
  propertyLabel,
  locale,
  suitability,
}: {
  identity: string;
  statement: Stmt;
  title: string;
  propertyLabel: string;
  locale: string;
  suitability: Reader['suitability'];
}) {
  const { reading, select, fallback } = useContext(ArtworkContext);
  const [revealed, setRevealed] = useState(suitability === 'show');
  const options = { locale: locale as never };
  const content = statement.value.type === 'value' ? statement.value.content : undefined;
  if (!canonicalMediaId(content)) return <p>{m.subject_artwork_unsupported({}, options)}</p>;
  const selected = reading?.selection.key === identity;
  const result = selected ? reading.result : undefined;
  const busy = reading?.result.kind === 'loading';
  const choose = () => {
    setRevealed(true);
    select?.({ key: identity, id: content });
  };
  const alt = m.subject_artwork_alt({ title, property: propertyLabel }, options);
  return (
    <div
      data-slot="subject-artwork"
      data-statement={statement.id}
      className="min-w-0 space-y-2 [overflow-wrap:anywhere]"
    >
      {!revealed ? <p className="text-sm text-muted-foreground">{m.subject_artwork_withheld({}, options)}</p> : null}
      {revealed && result?.kind === 'loading' ? <p role="status">{m.candidate_loading({}, options)}</p> : null}
      {revealed && result?.kind === 'unavailable' ? (
        <p role="status">
          {result.reason === 'oversized'
            ? m.subject_artwork_oversized({}, options)
            : result.reason === 'timeout'
              ? m.subject_artwork_timeout({}, options)
              : m.content_edition_image_unavailable({}, options)}
        </p>
      ) : null}
      {revealed && result?.kind === 'ready' ? (
        <ArtworkImage image={result.image} alt={alt} locale={locale} fallback={fallback} />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || !select}
          className="min-h-11 max-w-full whitespace-normal text-left"
          onClick={choose}
        >
          {result?.kind === 'unavailable'
            ? m.document_image_retry({}, options)
            : !revealed
              ? m.subject_artwork_reveal({}, options)
              : m.subject_artwork_view({}, options)}
        </Button>
      )}
      {revealed && suitability === 'blur' ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11 whitespace-normal"
          onClick={() => setRevealed(false)}
        >
          {m.subject_artwork_hide({}, options)}
        </Button>
      ) : null}
    </div>
  );
}

function ArtworkImage({
  image,
  alt,
  locale,
  fallback,
}: {
  image: DocumentImagePresentation;
  alt: string;
  locale: string;
  fallback?: RefObject<HTMLDivElement | null> | undefined;
}) {
  useLayoutEffect(
    () => () => {
      // The shared inspector restores a surviving trigger on ordinary close. A retired caller has
      // no trigger; move focus only when this image's own portalled dialog was still open.
      const dialog = document.activeElement?.closest('[role="dialog"]');
      if (
        dialog &&
        [...dialog.querySelectorAll('img')].some((img) => img.getAttribute('src')?.startsWith(`/media/${image.id}/`))
      )
        queueMicrotask(() => fallback?.current?.focus());
    },
    [fallback, image.id],
  );
  return <NativeDocumentImage image={image} alt={alt} locale={locale} />;
}
