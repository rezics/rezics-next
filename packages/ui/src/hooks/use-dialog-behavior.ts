'use client';

import * as React from 'react';

type OpenChangeDetails = { open: boolean };

/** Keep Ark controlled so a pending action can reject every close request, including a swipe. */
export function useDialogOpen({
  open,
  defaultOpen,
  onOpenChange,
  pending,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (details: OpenChangeDetails) => void;
  pending: boolean;
}) {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen ?? false);

  return {
    open: open ?? localOpen,
    onOpenChange(details: OpenChangeDetails) {
      if (!details.open && pending) return;
      if (open === undefined) setLocalOpen(details.open);
      onOpenChange?.(details);
    },
  };
}

export function initialDialogFocus(content: HTMLElement | null) {
  if (!content) return null;

  for (const selector of [
    '[data-autofocus]',
    'input:not([type="hidden"]), select, textarea',
    '[data-slot="dialog-close-trigger"], [data-slot="alert-dialog-close"], [data-slot="alert-dialog-cancel"], [data-slot="sheet-close"], [data-slot="drawer-close"]',
  ]) {
    const candidate = [...content.querySelectorAll<HTMLElement>(selector)].find(
      (element) => !element.matches(':disabled') && element.getClientRects().length > 0,
    );
    if (candidate) return candidate;
  }

  return null;
}

export function useDialogContentRef(
  contentRef: React.RefObject<HTMLDivElement | null>,
  forwardedRef: React.Ref<HTMLDivElement> | undefined,
) {
  return React.useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [contentRef, forwardedRef],
  );
}
