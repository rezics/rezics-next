'use client';

import { Button } from '@rezics/ui/button';
import type { ZoneModule } from '@rezics/zone-sdk';
import { RotateCwIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react';
import { ModuleFrame } from './module-frame.tsx';

class Boundary extends Component<{ slot: string; fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Reported, not shown: the reader sees the platform rendering of the same slot.
    console.error(`Zone slot ${this.props.slot} failed; showing the platform rendering`, error, info.componentStack);
  }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/**
 * Runs one package slot. If the slot throws while rendering, on the server
 * or in the browser, the reader gets the platform's rendering of that slot
 * instead; the rest of the Zone keeps its design.
 */
export function SlotBoundary({ slot, fallback, children }: { slot: string; fallback: ReactNode; children: ReactNode }) {
  return <Suspense fallback={fallback}><Boundary slot={slot} fallback={fallback}>{children}</Boundary></Suspense>;
}

/** A module whose read failed: its title stays, with a way to try again. */
export function ModuleFailed({ module, title, retry }: { module: ZoneModule; title: string; retry: string }) {
  const router = useRouter();
  return <ModuleFrame module={module}>
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3
      text-muted-foreground text-sm">
      <p>{title}</p>
      <Button size="sm" variant="outline" onClick={() => router.refresh()}>
        <RotateCwIcon aria-hidden="true" />{retry}</Button>
    </div>
  </ModuleFrame>;
}
