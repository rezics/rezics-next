import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { requestCsrfToken } from '../session/request';
import { loadSettingsPage, type ShelfPreferences } from './preferences';

export type ShelfPreferenceSnapshot = {
  generation: string;
  accountId: string | null;
  csrfToken: string | null;
  shelf: ShelfPreferences | null;
};

/** Private, bounded preference read for the current Library route visit. */
export const readCurrentShelfPreferences = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ShelfPreferenceSnapshot> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const page = await loadSettingsPage(kernelClient(), request, env as Partial<SessionEnv>);
    return {
      generation: crypto.randomUUID(),
      accountId: page.signedIn ? (page.accountId ?? null) : null,
      csrfToken: page.signedIn ? requestCsrfToken(request) : null,
      shelf: page.signedIn && 'preferences' in page ? (page.preferences.shelf ?? {}) : null,
    };
  },
);

/** A loader snapshot can only affect the viewer who produced its current session read. */
export function shelfForCurrentViewer(
  snapshot: ShelfPreferenceSnapshot | undefined,
  viewer: { state: string; subject?: string | null; csrfToken: string | null },
): ShelfPreferences {
  if (
    !snapshot ||
    viewer.state !== 'signed-in' ||
    !viewer.subject ||
    snapshot.accountId !== viewer.subject ||
    snapshot.csrfToken !== viewer.csrfToken ||
    !snapshot.shelf
  )
    return {};
  return snapshot.shelf;
}

/** Sticky custody retires one loader snapshot as soon as its observed viewer or token changes. */
export class ShelfPreferenceSnapshotOwner {
  private generation: string | undefined;
  private viewer: string | undefined;
  private retired = false;

  observe(viewer: { state: string; subject?: string | null; csrfToken: string | null }) {
    if (viewer.state === 'unknown') {
      if (this.viewer !== undefined) this.retired = true;
      return;
    }
    const identity = JSON.stringify([viewer.state, viewer.subject ?? null, viewer.csrfToken]);
    if (this.viewer !== undefined && this.viewer !== identity) this.retired = true;
    this.viewer = identity;
    if (
      this.generation &&
      (viewer.state !== 'signed-in' ||
        !viewer.subject ||
        !this.matchesSnapshot(viewer))
    )
      this.retired = true;
  }

  retire() {
    this.retired = true;
  }

  private matchesSnapshot(viewer: { state: string; subject?: string | null; csrfToken: string | null }) {
    return this.snapshotAccountId === viewer.subject && this.snapshotCsrfToken === viewer.csrfToken;
  }

  private snapshotAccountId: string | null = null;
  private snapshotCsrfToken: string | null = null;

  resolve(
    snapshot: ShelfPreferenceSnapshot | undefined,
    viewer: { state: string; subject: string | null | undefined; csrfToken: string | null },
  ): ShelfPreferences {
    if (snapshot && snapshot.generation !== this.generation) {
      this.generation = snapshot.generation;
      this.snapshotAccountId = snapshot.accountId;
      this.snapshotCsrfToken = snapshot.csrfToken;
    }
    if (snapshot) this.observe(viewer);
    else if (viewer.state !== 'unknown') this.retire();
    return this.retired ? {} : shelfForCurrentViewer(snapshot, viewer);
  }
}
