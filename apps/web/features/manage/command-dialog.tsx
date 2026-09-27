'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { CircleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * A dialog that sends one management command. It stays open while the command
 * is in flight and shows Main's refusal inline, keeping everything typed.
 */
export function CommandDialog({ open, title, description, confirm, destructive, pending, error, disabled, cancel,
  onConfirm, onClose, children, initialFocus }: {
  open: boolean; title: string; description?: string; confirm: string; destructive?: boolean; pending: boolean;
  error: string | null; disabled?: boolean; cancel: string; onConfirm: () => void; onClose: () => void;
  children?: ReactNode; initialFocus?: () => HTMLElement | null;
}) {
  return <Dialog open={open} pending={pending} onOpenChange={details => { if (!details.open) onClose(); }}
    {...initialFocus ? { initialFocusEl: initialFocus } : {}}>
    <DialogContent size="md">
      <form noValidate className="contents" onSubmit={event => { event.preventDefault(); if (!disabled) onConfirm(); }}>
        <DialogHeader title={title} description={description} />
        <DialogBody className="grid gap-4">
          {children}
          {error ? <Alert variant="destructive" role="alert">
            <CircleAlertIcon aria-hidden="true" />
            <AlertDescription>{error}</AlertDescription>
          </Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>{cancel}</Button>
          <Button type="submit" variant={destructive ? 'destructive' : 'default'} isLoading={pending}
            disabled={disabled}>{confirm}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
