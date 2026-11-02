import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { statementsHref } from './creator-statements-page';
import type { StatementDetailSearch } from './creator-statements';

type RecoveryProps =
  | { kind: 'list'; locale: string }
  | ({ kind: 'detail'; locale: string; id: string } & StatementDetailSearch);

export function creatorStatementAddressHref(locale: string, id: string, search: StatementDetailSearch): string {
  const query = new URLSearchParams();
  if (search.cursorMalformed) query.set('cursorMalformed', 'true');
  else if (search.cursor) query.set('cursor', search.cursor);
  if (search.fromMalformed) query.set('fromMalformed', 'true');
  else if (search.from) query.set('from', search.from);
  return `/${locale}/creator/statements/${encodeURIComponent(id)}${query.size ? `?${query}` : ''}`;
}

function AddressChoice({
  id,
  message,
  href,
  label,
}: {
  id: string;
  message: string;
  href: string;
  label: string;
}) {
  return (
    <div className="space-y-3">
      <p id={id} className="text-sm leading-relaxed text-muted-foreground">
        {message}
      </p>
      <Button
        variant="outline"
        className="min-h-11"
        nativeButton={false}
        render={<a href={href} aria-describedby={id} />}
      >
        {label}
      </Button>
    </div>
  );
}

export function CreatorStatementAddressRecovery(props: RecoveryProps) {
  const id = props.kind === 'detail' ? props.id : undefined;
  const cursorRestart =
    props.kind === 'detail' &&
    creatorStatementAddressHref(props.locale, props.id, {
      ...(props.fromMalformed ? { fromMalformed: true } : props.from ? { from: props.from } : {}),
    });
  const returnDiscard =
    props.kind === 'detail' &&
    creatorStatementAddressHref(props.locale, props.id, {
      ...(props.cursorMalformed ? { cursorMalformed: true } : props.cursor ? { cursor: props.cursor } : {}),
    });

  return (
    <section
      className="max-w-4xl min-w-0 space-y-6 rounded-xl border bg-card p-5 text-card-foreground"
      role="alert"
      aria-labelledby="creator-statement-address-heading"
    >
      <PageHeading id="creator-statement-address-heading">{m.creator_statement_address_title()}</PageHeading>
      {props.kind === 'list' ? (
        <AddressChoice
          id="creator-statement-address-list"
          message={m.creator_statement_address_list_message()}
          href={statementsHref(props.locale)}
          label={m.creator_statement_address_list_restart()}
        />
      ) : (
        <>
          {props.cursorMalformed && cursorRestart && (
            <AddressChoice
              id="creator-statement-address-evidence"
              message={m.creator_statement_address_evidence_message()}
              href={cursorRestart}
              label={m.creator_statement_address_evidence_restart()}
            />
          )}
          {props.fromMalformed && returnDiscard && (
            <AddressChoice
              id="creator-statement-address-return"
              message={m.creator_statement_address_return_message()}
              href={returnDiscard}
              label={m.creator_statement_address_return_discard()}
            />
          )}
        </>
      )}
    </section>
  );
}
