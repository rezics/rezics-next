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
    <section className={style.separator} aria-label={heading}>
      {candidates.length > 1 && (
        <nav aria-label={heading}>
          <ul className="divide-y divide-border">
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
                  className="min-w-0 py-1"
                >
                  <a
                    href={hrefFor(native, current)}
                    aria-current={current ? 'page' : undefined}
                    aria-label={`${m.literary_grain_stream_read({}, o)}: ${label.text}, ${directionLabel}`}
                    className={`${style.link} flex flex-wrap gap-x-3 gap-y-1`}
                  >
                    <span lang={label.lang}>{label.text || m.subject_relations({}, o)}</span>
                    <span className="text-muted-foreground">{directionLabel}</span>
                    {current && <span className="text-foreground">{m.literary_grain_stream_selected({}, o)}</span>}
                  </a>
                  {state !== 'ready' && <LiteraryStatus state={state} locale={locale} />}
                </li>
              );
            })}
          </ul>
        </nav>
      )}
      {!candidates.length && (
        <p role="status" className={style.muted}>
          {m.literary_reader_no_stream({}, o)}
        </p>
      )}
      {children}
    </section>
  );
}
