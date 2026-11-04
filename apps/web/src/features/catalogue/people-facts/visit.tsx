import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { browserObservation } from '../../../session/observation';
import { m } from '../../../paraglide/messages.js';
import { useSubjectCommunityReading } from '../../pages/subject-community-lifetime';
import type { PersonStatement } from '../person-reader/model';
import type { ProfileReading } from '../person-reader/reader';
import { ValueExplanationSession } from '../value-explanation-session';
import type { ValueRead } from '../value-explanation';
import { admitFacts, factAddress, factFieldAnchor, sameFactReading, type FactProjection } from './model';

export const factControl =
  'inline-flex min-h-11 min-w-11 max-w-full items-center px-1 py-2 underline whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
type Visit = { statement: PersonStatement; source: HTMLAnchorElement; field: string };
type Facts = {
  projection: FactProjection | undefined;
  expanded: string | undefined;
  inspecting: boolean;
  inspectable: boolean;
  expand: (field: string | undefined) => void;
  inspect: (visit: Visit) => void;
  stale: ReadonlySet<string>;
};
const Context = createContext<Facts | null>(null);
const unavailable: ValueRead = { kind: 'unavailable' };
export const useFactVisit = () => useContext(Context);

type FactsProps = { reading: ProfileReading; fields: readonly string[]; children: ReactNode };

/** One local visit and one explanation; no per-row readers or candidate caches. */
export function PeopleFacts(props: FactsProps) {
  const client = useContext(QueryClientContext);
  return client ? <ObservedFacts {...props} client={client} /> : <FactsReading {...props} inspectable={false} />;
}

/** Establish the existing shared browser observation before explicit inspection, without a request. */
function ObservedFacts({ client, ...props }: FactsProps & { client: QueryClient }) {
  const observation = browserObservation(client);
  const snapshot = useSyncExternalStore(observation.subscribe, observation.getSnapshot, observation.getServerSnapshot);
  return <FactsReading {...props} inspectable={snapshot.state === 'signed-in' || snapshot.state === 'signed-out'} />;
}

function FactsReading({ reading, fields, children, inspectable }: FactsProps & { inspectable: boolean }) {
  const source = useMemo(() => ({}), [reading.public, reading.release, reading.documents, reading.reader]);
  const lifetime = useSubjectCommunityReading({
    source,
    reader: null,
    descriptor: JSON.stringify([
      reading.public.subject.id,
      reading.public.subject.context,
      reading.locale,
      reading.reader,
    ]),
  });
  return (
    <FactVisit
      key={lifetime.key}
      reading={reading}
      fields={fields}
      current={lifetime.isCurrent}
      available={lifetime.available}
      inspectable={inspectable}
    >
      {children}
    </FactVisit>
  );
}

function FactVisit({
  reading,
  fields,
  children,
  current,
  available,
  inspectable,
}: {
  reading: ProfileReading;
  fields: readonly string[];
  children: ReactNode;
  current: () => boolean;
  available: boolean;
  inspectable: boolean;
}) {
  const ids = JSON.stringify(fields);
  const projection = useMemo(
    () => admitFacts(reading, fields),
    [reading.public, reading.release, reading.documents, reading.locale, ids],
  );
  const [expanded, expand] = useState<string>();
  const [visit, setVisit] = useState<Visit>();
  const [stale, setStale] = useState<ReadonlySet<string>>(new Set());
  const [changed, setChanged] = useState(false);
  const region = useRef<HTMLElement>(null);
  const activeVisit = useRef(visit);
  activeVisit.current = visit;
  const o = { locale: reading.locale as never };
  useLayoutEffect(() => {
    if (visit && current()) region.current?.focus();
  }, [visit]);
  function close() {
    if (!current() || !visit) return;
    const origin = visit.source;
    const field = origin.ownerDocument.getElementById(factFieldAnchor(visit.field));
    setVisit(undefined);
    if (origin.isConnected && !origin.closest('[hidden], [inert]')) origin.focus();
    else {
      setChanged(true);
      field?.focus();
    }
  }
  const address = visit && factAddress(reading, visit.statement);
  return (
    <Context.Provider
      value={{
        projection: available ? projection : undefined,
        expanded,
        inspecting: !!visit,
        inspectable,
        expand(field) {
          if (current()) {
            expand(field);
            setVisit(undefined);
          }
        },
        inspect(next) {
          if (current() && inspectable && projection && !stale.has(next.statement.id)) {
            setChanged(false);
            setVisit(next);
          }
        },
        stale,
      }}
    >
      {children}
      {changed && <p role="status">{m.people_facts_changed({}, o)}</p>}
      {visit && address && available && (
        <section
          ref={region}
          tabIndex={-1}
          aria-label={m.value_why({}, o)}
          data-slot="people-fact-visit"
          className="min-w-0 space-y-4 rounded border p-3 focus-visible:outline-2 focus-visible:outline-ring sm:p-5"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        >
          <button type="button" className={factControl} onClick={close}>
            {m.people_facts_return({}, o)}
          </button>
          <ValueExplanationSession
            id={address.address.id}
            address={address.address}
            locale={reading.locale}
            episode={unavailable}
            embedded
            link={reading.link}
            onRead={(result) => {
              if (!current() || activeVisit.current !== visit) return;
              if (result.kind === 'ready' && !sameFactReading(reading, visit.statement, result.page))
                setStale((old) => new Set([...old, visit.statement.id]));
            }}
          />
          <p className="text-sm text-muted-foreground">{m.people_facts_route_return({}, o)}</p>
          <a
            className={factControl}
            href={`#${factFieldAnchor(visit.field)}`}
            onClick={(event) => {
              event.preventDefault();
              close();
            }}
          >
            {m.people_facts_return({}, o)}
          </a>
        </section>
      )}
    </Context.Provider>
  );
}

/** This entry is mounted inside the assertion's existing native spoiler gate. */
export function FactInspectionEntry({ statement, reading }: { statement: PersonStatement; reading: ProfileReading }) {
  const visit = useFactVisit();
  const address = factAddress(reading, statement);
  const o = { locale: reading.locale as never };
  if (!address) return <p role="status">{m.value_invalid({}, o)}</p>;
  return (
    <>
      <a
        className={factControl}
        href={address.href}
        onClick={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            event.shiftKey ||
            !visit?.projection ||
            !visit.inspectable
          )
            return;
          event.preventDefault();
          visit.inspect({ statement, source: event.currentTarget, field: statement.property.id });
        }}
      >
        {m.value_why({}, o)}
      </a>
      {visit && !visit.projection && <p role="status">{m.people_facts_unavailable({}, o)}</p>}
      <details>
        <summary className={factControl}>{m.catalogue_technical_details({}, o)}</summary>
        <code className="block break-all">{statement.id}</code>
      </details>
    </>
  );
}
