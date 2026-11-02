import { recipientRequest } from './request';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { m } from '../../paraglide/messages.js';
import type { AccessIO, AccessSnapshot, Grant, Identity } from './data';
import { transferableOwner, type OwnerTransfer } from './owner-transfer.ts';

export function resourceLabel(type: string) {
  if (type === 'library.collection') return m.library_following_kind_collection();
  if (type === 'community.realm') return m.space_realm_heading();
  if (type === 'community.space') return m.library_following_kind_space();
  return m.access_resource();
}

/** Exact references are supplied by the current DTO, never resolved by this presentation. */
export function IdentityFacts({ entries }: { entries: ReadonlyArray<readonly [string, string | number]> }) {
  return (
    <dl className="grid min-w-0 gap-3 text-sm">
      {entries.map(([name, value]) => (
        <div key={name} className="min-w-0">
          <dt className="text-muted-foreground">{name}</dt>
          <dd
            tabIndex={0}
            className="min-w-0 select-all break-all whitespace-normal font-mono text-xs focus-visible:outline-2 focus-visible:outline-ring"
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function IdentityDetails({ entries }: { entries: ReadonlyArray<readonly [string, string | number]> }) {
  return (
    <details className="min-w-0" aria-label={m.access_identity_details()}>
      <summary className="min-h-11 cursor-pointer content-center py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
        {m.access_identity_details()}
      </summary>
      <IdentityFacts entries={entries} />
    </details>
  );
}

function label(identity: Identity | undefined) {
  if (identity?.state === 'deleted') return m.access_deleted_account();
  if (identity?.state !== 'active') return m.access_unknown_account();
  return identity.displayName
    ? `${identity.displayName}${identity.handle ? ` (@${identity.handle})` : ''}`
    : identity.handle
      ? `@${identity.handle}`
      : m.access_unknown_account();
}

type TransferSelection = Omit<OwnerTransfer, 'key' | 'kind'>;
type TransferFormProps = {
  page: AccessSnapshot;
  grant: Grant;
  io: AccessIO;
  onConfirm(input: TransferSelection): void;
  onCancel(): void;
};

/** A changed authority, resource or source grant starts a new form lifetime, including across A/B/A. */
export function OwnerTransferForm(props: TransferFormProps) {
  const { page, grant, io } = props;
  const identity = JSON.stringify([page.resource, page.authority, grant, transferableOwner(page, grant)]);
  const [lifetime, setLifetime] = useState({ identity, io, version: 0 });
  if (lifetime.identity !== identity || lifetime.io !== io) {
    setLifetime({ identity, io, version: lifetime.version + 1 });
    return null;
  }
  if (!transferableOwner(page, grant) || grant.subject.kind !== 'account' || !io.transfer) return null;
  return <OwnerTransferReview key={lifetime.version} {...props} fromAccountId={grant.subject.id} />;
}

type Review = {
  input: TransferSelection;
  source: string;
  target: string;
  facts: ReadonlyArray<readonly [string, string | number]>;
};

function OwnerTransferReview({
  page,
  grant,
  io,
  onConfirm,
  onCancel,
  fromAccountId,
}: TransferFormProps & { fromAccountId: string }) {
  const [handle, setHandle] = useState('');
  const [recipient, setRecipient] = useState<Identity | null>(null);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const active = useRef(true);
  const request = useRef(0);
  const requestAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current++;
      requestAbort.current?.abort();
    };
  }, []);
  const source = label(page.identities.find((item) => item.id === fromAccountId));
  const target = recipient ? label(recipient) : '';
  const facts: Review['facts'] = [
    [m.access_resource(), resourceLabel(page.resource.type)],
    [m.access_identity_resource_id(), page.resource.id],
    [m.access_identity_type(), page.resource.type],
    [m.access_identity_route(), page.resource.route],
    [m.access_identity_from_id(), fromAccountId],
    ...(recipient ? [[m.access_identity_to_id(), recipient.id] as const] : []),
    [m.access_identity_valid(), grant.valid],
  ];
  const discard = () => {
    request.current++;
    requestAbort.current?.abort();
    setRecipient(null);
    setReview(null);
    setFinding(false);
    setError(false);
  };
  const lookup = async () => {
    if (!active.current) return;
    const current = ++request.current;
    requestAbort.current?.abort();
    const caller = (requestAbort.current = new AbortController());
    const isCurrent = () => active.current && request.current === current;
    setFinding(true);
    setRecipient(null);
    setReview(null);
    setError(false);
    try {
      const found = await recipientRequest((signal) => io.lookup(handle, signal), caller.signal);
      if (!isCurrent()) return;
      if (!found || found.state !== 'active' || found.id === fromAccountId) setError(true);
      else setRecipient({ ...found });
    } catch {
      if (isCurrent()) setError(true);
    } finally {
      if (isCurrent()) setFinding(false);
    }
  };
  return (
    <section className="space-y-4 rounded-xl bg-muted/40 p-4 sm:p-6" aria-labelledby="owner-transfer-heading">
      <h2 id="owner-transfer-heading" className="text-lg font-semibold">
        {m.access_transfer_owner()}
      </h2>
      <p className="break-words [overflow-wrap:anywhere]">{m.access_transfer_source({ name: source })}</p>
      <p className="font-medium">{resourceLabel(page.resource.type)}</p>
      <p className="text-sm text-muted-foreground">{m.access_transfer_responsibility()}</p>
      <Field>
        <FieldLabel htmlFor="owner-transfer-handle">{m.access_handle()}</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <Input
            id="owner-transfer-handle"
            value={handle}
            autoComplete="off"
            maxLength={64}
            onChange={(event) => {
              setHandle(event.target.value);
              discard();
            }}
          />
          <Button type="button" variant="outline" disabled={finding || !handle.trim()} onClick={() => void lookup()}>
            {m.access_find_account()}
          </Button>
        </div>
        <FieldDescription className="[overflow-wrap:anywhere]">
          {recipient ? target : m.access_confirm_identity()}
        </FieldDescription>
      </Field>
      <IdentityDetails entries={facts} />
      {error ? <p role="alert">{m.access_transfer_lookup_failed()}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={!recipient || finding}
          onClick={() => {
            if (!active.current || !recipient) return;
            setReview({
              source,
              target,
              facts,
              input: {
                resource: { id: page.resource.id, route: page.resource.route },
                fromAccountId,
                toAccountId: recipient.id,
                previousValid: grant.valid,
              },
            });
          }}
        >
          {m.access_transfer_owner()}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            active.current = false;
            discard();
            onCancel();
          }}
        >
          {m.access_cancel()}
        </Button>
      </div>
      <AlertDialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
      >
        {review ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{m.access_transfer_owner()}</AlertDialogTitle>
              <AlertDialogDescription>
                {m.access_transfer_confirm({ source: review.source, recipient: review.target })}{' '}
                {m.access_transfer_responsibility()}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <IdentityFacts entries={review.facts} />
            <AlertDialogFooter>
              <AlertDialogCancel>{m.access_cancel()}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (!active.current) return;
                  active.current = false;
                  setReview(null);
                  onConfirm(review.input);
                }}
              >
                {m.access_transfer_owner()}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </section>
  );
}
