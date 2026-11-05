import { useLayoutEffect, useRef } from 'react';
import { m } from '../../../paraglide/messages.js';
import { PlainLink, type PageLink } from '../../pages/shared';
import { NamesHandoff, type NamesReturnStatus, type NamesWindow } from '../work-names/navigation';
import { useNamesAdvice, type NamesAdviceLoader } from '../work-names/advice';
import type { useNamesLifetime } from '../work-names/lifetime';
import type { PeopleNamesReading } from './entry';
import type { PeopleNames, NamesAdvice } from './model';
import { installPeopleNamesReturn, type peopleNamesAddress } from './navigation';
import { PeopleNamesView } from './view';

type Visit = {
  names: PeopleNames;
  reading: PeopleNamesReading;
  lifetime: ReturnType<typeof useNamesLifetime>;
  adviceLoader: NamesAdviceLoader;
  address: ReturnType<typeof peopleNamesAddress>;
};

/** Consume the original handoff; keep native Sources and Terms policy with their destinations. */
export function PeopleNamesVisit(props: Visit) {
  const { reading, lifetime, address } = props;
  const { subject } = reading.public;
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (host.current) installPeopleNamesReturn(host.current, address.returnHref, reading.locale);
  });
  const binding = lifetime.caller
    ? JSON.stringify([
        subject.id,
        subject.type,
        subject.context,
        reading.locale,
        subject.release,
        subject.revision,
        lifetime.caller,
      ])
    : undefined;
  return (
    <div ref={host} className="min-w-0 space-y-3">
      <NamesHandoff {...{ binding }} returnHref={address.returnHref} locale={reading.locale} current={lifetime.current}>
        {(restored, returnStatus) => <AdvisedVisit {...props} {...{ restored, returnStatus }} />}
      </NamesHandoff>
    </div>
  );
}

type Restoration = { restored: NamesWindow | undefined; returnStatus: NamesReturnStatus };
function AdvisedVisit(props: Visit & Restoration) {
  const { lifetime, adviceLoader } = props;
  const advice = useNamesAdvice(lifetime.observation, lifetime.current, adviceLoader);
  return <CurrentNames {...props} {...advice} />;
}

function CurrentNames({
  names,
  reading,
  lifetime,
  address,
  restored,
  returnStatus,
  advice,
  retryAdvice,
}: Visit & Restoration & { advice: NamesAdvice; retryAdvice?: (() => void) | undefined }) {
  const Link = reading.link ?? PlainLink;
  // Unsupported destinations stay visible without silently making a different Context reading.
  const UnavailableLink: PageLink = ({ children, className }) => (
    <span aria-disabled="true" className={className}>
      {children}
    </span>
  );
  return (
    <>
      {!lifetime.retired && !address.supported && (
        <p role="status">{m.people_names_context_unsupported({}, { locale: reading.locale as never })}</p>
      )}
      {!lifetime.retired && address.supported && (
        <p className="text-sm text-muted-foreground">
          {m.people_names_destination_scope({}, { locale: reading.locale as never })}
        </p>
      )}
      <PeopleNamesView
        key={restored ? 'returned' : returnStatus}
        {...{ names, restored, returnStatus, advice, retryAdvice }}
        locale={reading.locale}
        retired={lifetime.retired}
        current={lifetime.current}
        sourcesHref={address.sourcesHref}
        termsHref={address.termsHref}
        captureSourcesVisit
        link={address.supported ? Link : UnavailableLink}
      />
    </>
  );
}
