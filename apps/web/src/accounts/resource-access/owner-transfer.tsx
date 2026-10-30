import { useState } from 'react';
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

function label(identity: Identity | undefined, id: string) {
  if (!identity || identity.state !== 'active') return id;
  return `${identity.displayName || identity.handle || id}${identity.handle ? ` (@${identity.handle})` : ''} · ${id}`;
}

export function OwnerTransferForm({
  page,
  grant,
  io,
  onConfirm,
  onCancel,
}: {
  page: AccessSnapshot;
  grant: Grant;
  io: AccessIO;
  onConfirm(input: Omit<OwnerTransfer, 'key' | 'kind'>): void;
  onCancel(): void;
}) {
  const [handle, setHandle] = useState('');
  const [recipient, setRecipient] = useState<Identity | null>(null);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (!transferableOwner(page, grant) || grant.subject.kind !== 'account' || !io.transfer) return null;
  const fromAccountId = grant.subject.id;
  const source = label(
    page.identities.find((item) => item.id === fromAccountId),
    fromAccountId,
  );
  const target = recipient ? label(recipient, recipient.id) : '';
  const lookup = async () => {
    setFinding(true);
    setRecipient(null);
    setError(false);
    try {
      const found = await io.lookup(handle);
      if (!found || found.state !== 'active' || found.id === fromAccountId) setError(true);
      else setRecipient(found);
    } catch {
      setError(true);
    } finally {
      setFinding(false);
    }
  };
  return (
    <section className="space-y-4 rounded-xl bg-muted/40 p-4 sm:p-6" aria-labelledby="owner-transfer-heading">
      <h2 id="owner-transfer-heading" className="text-lg font-semibold">
        {m.access_transfer_owner()}
      </h2>
      <p>{m.access_transfer_source({ name: source })}</p>
      <p className="text-sm text-muted-foreground">{m.access_transfer_responsibility()}</p>
      <Field>
        <FieldLabel htmlFor="owner-transfer-handle">{m.access_handle()}</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <Input
            id="owner-transfer-handle"
            value={handle}
            disabled={finding}
            autoComplete="off"
            maxLength={64}
            onChange={(event) => {
              setHandle(event.target.value);
              setRecipient(null);
              setError(false);
            }}
          />
          <Button type="button" variant="outline" disabled={finding || !handle.trim()} onClick={() => void lookup()}>
            {m.access_find_account()}
          </Button>
        </div>
        <FieldDescription>{recipient ? target : m.access_confirm_identity()}</FieldDescription>
      </Field>
      {error ? <p role="alert">{m.access_transfer_lookup_failed()}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!recipient || finding} onClick={() => setConfirming(true)}>
          {m.access_transfer_owner()}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {m.access_cancel()}
        </Button>
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.access_transfer_owner()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.access_transfer_confirm({ source, recipient: target })} {m.access_transfer_responsibility()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.access_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!recipient) return;
                onConfirm({
                  resource: { id: page.resource.id, route: page.resource.route },
                  fromAccountId,
                  toAccountId: recipient.id,
                  previousValid: grant.valid,
                });
              }}
            >
              {m.access_transfer_owner()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
