import type { ReactNode } from 'react';
import type { LiteraryWindow } from './model';
type ProfileRelationWindow = LiteraryWindow['native'];
import { pageText } from '../../pages/shared';
import { m } from '../../../paraglide/messages.js';
import type { LiteraryDefinitions, LiteraryState } from './model';
import { LiteraryStatus } from './sections';
import { literaryStyle as style } from './style';

/** Ordinary links expose native stream choice without an extra tab system or a select. */
export function LiteraryStreams({
  candidates,
  active,
  definitions,
  locale,
  heading,
  stateFor,
  hrefFor,
  children,
}: {
  candidates: readonly ProfileRelationWindow[];
  active: ProfileRelationWindow | undefined;
  definitions: LiteraryDefinitions;
  locale: string;
  heading: string;
  stateFor: (native: ProfileRelationWindow) => LiteraryState;
  hrefFor: (native: ProfileRelationWindow, current: boolean) => string;
  children: ReactNode;
}) {
  const o = { locale: locale as never };
  return (
    <section data-slot="literary-streams" className="min-w-0 space-y-5 sm:space-y-6" aria-label={heading}>
      {candidates.length > 1 && (
        <nav aria-label={heading}>
          <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
            {candidates.map((native) => {
              const property = definitions.properties[native.property];
              const label = pageText(
                native.direction === 'inverse' ? property?.relation?.inverseLabels : property?.labels,
                locale,
              );
              const directionLabel =
                native.direction === 'inverse'
                  ? m.literary_grain_direction_inverse({}, o)
                  : m.literary_grain_direction_forward({}, o);
              const current =
                active?.node === native.node &&
                active.property === native.property &&
                active.direction === native.direction;
              const state = stateFor(native);
              return (
                <li
                  key={`${native.node}:${native.property}:${native.direction}`}
                  data-stream-node={native.node}
                  data-stream-property={native.property}
                  data-stream-direction={native.direction}
                  className="min-w-0 rounded-lg border border-border p-2"
                >
                  <a
                    href={hrefFor(native, current)}
                    aria-current={current ? 'page' : undefined}
                    aria-label={`${m.literary_grain_stream_read({}, o)}: ${label.text}, ${directionLabel}`}
                    className={`${style.link} w-full flex-wrap justify-start gap-x-3 gap-y-1 rounded-md px-3 ${current ? 'bg-muted text-foreground' : ''}`}
                  >
                    <span lang={label.lang}>{label.text || m.subject_relations({}, o)}</span>
                    <span className="text-muted-foreground">{directionLabel}</span>
                    {current && <span className="text-foreground">{m.literary_grain_stream_selected({}, o)}</span>}
                  </a>
                  {state !== 'ready' && (
                    <div className="px-3 pt-1">
                      <LiteraryStatus state={state} locale={locale} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
      )}
      {!candidates.length && (
        <p role="status" className={`${style.muted} py-2`}>
          {m.literary_reader_no_stream({}, o)}
        </p>
      )}
      {children}
    </section>
  );
}
