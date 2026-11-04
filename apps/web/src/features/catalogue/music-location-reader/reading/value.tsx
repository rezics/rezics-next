import type { ComponentProps } from 'react';
import { CandidateValue } from '../../../pages/data';
import { timePresentation } from '../../../../subject/time-presentation';
import { m } from '../../../../paraglide/messages.js';

type Props = ComponentProps<typeof CandidateValue>;

/** Keep the shared presentation and the exact native time evidence together. */
export function ReadingValue(props: Props) {
  if (props.snak.property.data_type !== 'time') return <CandidateValue {...props} />;
  const presentation = timePresentation(props.snak.value, props.locale);
  return (
    <div className="min-w-0 space-y-1" data-time-state={presentation.state}>
      <CandidateValue {...props} />
      {props.snak.value.type === 'value' ? (
        <details className="min-w-0 text-sm">
          <summary className="min-h-11 cursor-pointer py-3 focus-visible:outline-2 focus-visible:outline-ring">
            {m.music_location_time_evidence({}, { locale: props.locale as never })}
          </summary>
          <pre className="max-w-full whitespace-pre-wrap font-mono [overflow-wrap:anywhere]">
            {JSON.stringify(props.snak.value.content, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
