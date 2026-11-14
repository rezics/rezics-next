import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { ReadingDisclosureScope, useIncarnationState } from '@rezics/ui/cover';
import { Button } from '@rezics/ui/shadcn/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/shadcn/collapsible';
import { Eye } from 'lucide-react';
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
  retire?: ((key: string) => void) | undefined;
  fallback?: RefObject<HTMLDivElement | null> | undefined;
}>({});

/** One caller incarnation and one explicitly selected media window; A → B → A never restores state. */
export function SubjectArtworkBoundary({
  source,
  identity,
  preferences,
  label,
  children,
}: {
  source: object;
  identity: string;
  preferences?: Reader | undefined;
  label: string;
  children: ReactNode;
}) {
  const reader = useContext(ArtworkReaderContext);
  const admission = useRef<{ source: object; reader: unknown; retired: boolean }>({
    source,
    reader: reader.incarnation,
    retired: false,
  });
  if (admission.current.source !== source) admission.current = { source, reader: reader.incarnation, retired: false };
  else if (admission.current.reader === null && !admission.current.retired)
    admission.current.reader = reader.incarnation;
  else if (admission.current.reader !== reader.incarnation) admission.current.retired = true;
  const preferenceIdentity = preferences && JSON.stringify([preferences.spoilerLevel, preferences.suitability]);
  const previous = useRef<{
    source: object;
    identity: string;
    reader: unknown;
    preferences: string | undefined;
    prepared: boolean;
    generation: number;
  } | null>(null);
  const before = previous.current;
  const sameVisit = before?.source === source && before.identity === identity;
  const firstPreferences = sameVisit && !before.prepared && preferences !== undefined;
  const firstAuthority = sameVisit && before.reader === null && !admission.current.retired;
  const replaced =
    !sameVisit ||
    (!firstAuthority && before.reader !== reader.incarnation) ||
    (!firstPreferences && before.preferences !== preferenceIdentity);
  previous.current = {
    source,
    identity,
    reader: reader.incarnation,
    preferences: preferenceIdentity,
    prepared: (sameVisit && before.prepared) || preferences !== undefined,
    generation: (before?.generation ?? 0) + Number(replaced),
  };
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
  const selected = useRef<string | undefined>(undefined);
  const previous = useRef(generation);
  if (previous.current !== generation) {
    previous.current = generation;
    request.current++;
    selected.current = undefined;
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
  const retire = useCallback((key: string) => {
    if (selected.current !== key) return;
    selected.current = undefined;
    request.current++;
    setReading(undefined);
  }, []);
  const select = async (selection: Selection) => {
    if (previous.current !== generation || reading?.result.kind === 'loading' || current?.() === false) return;
    const attempt = ++request.current;
    selected.current = selection.key;
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
    <ArtworkContext.Provider value={{ incarnation: generation, reading, select, retire, fallback }}>
      {children}
    </ArtworkContext.Provider>
  );
}

/** Keep the fact's position while preparation changes its threshold; native disclosure still decides admission. */
export function SubjectArtworkDisclosure({ identity, ...props }: { identity: string } & ArtworkDisclosureProps) {
  return <ArtworkDisclosure key={identity} {...props} />;
}

type ArtworkDisclosureProps = {
  spoilerLevel: Reader['spoilerLevel'];
  gated: boolean;
  label: string;
  hideLabel?: string | undefined;
  children: ReactNode;
};

function ArtworkDisclosure({ spoilerLevel, gated, label, hideLabel, children }: ArtworkDisclosureProps) {
  const disclosure = useContext(ReadingDisclosureScope);
  const { value, setValue } = useIncarnationState(JSON.stringify([disclosure, spoilerLevel]), () => false);
  const open = !gated || value;
  return (
    <Collapsible open={open} onOpenChange={setValue} className="space-y-2">
      {gated ? (
        <CollapsibleTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 min-w-11 whitespace-normal text-left focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4"
            />
          }
        >
          <Eye aria-hidden="true" className="size-4" />
          {open ? (hideLabel ?? m.subject_spoiler_hide()) : label}
        </CollapsibleTrigger>
      ) : null}
      <CollapsibleContent className="space-y-2">{open ? children : null}</CollapsibleContent>
    </Collapsible>
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
  const identity = JSON.stringify([incarnation, subject, statement, title, propertyLabel, locale]);
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
  const { reading, select, retire, fallback } = useContext(ArtworkContext);
  const [disclosure, setDisclosure] = useState<'default' | 'revealed' | 'hidden'>('default');
  const revealed = disclosure === 'revealed' || (disclosure === 'default' && suitability === 'show');
  useLayoutEffect(() => () => retire?.(identity), [identity, retire]);
  const options = { locale: locale as never };
  const content = statement.value.type === 'value' ? statement.value.content : undefined;
  if (!canonicalMediaId(content)) return <p>{m.subject_artwork_unsupported({}, options)}</p>;
  const selected = reading?.selection.key === identity;
  const result = selected ? reading.result : undefined;
  const busy = reading?.result.kind === 'loading';
  const choose = () => {
    setDisclosure('revealed');
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
          onClick={() => setDisclosure('hidden')}
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
