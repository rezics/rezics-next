import { useLayoutEffect, useState } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { AuthShell } from '../../frame';
import { Route } from '../../routes/consent';
import { m } from '../../paraglide/messages.js';
import { authLocale, button, reviewParameters, waitFor } from '../accounts-operations/story';
import '../../styles.css';

export default {
  title: 'Pages/Account/Consent outcome history',
  decorators: [authLocale],
  parameters: reviewParameters,
};
type Mode = 'signed-out' | 'not-found' | 'failed' | 'loading' | 'replacement' | 'acknowledged' | 'approved' | 'declined' | 'pending';
// Presentation responses only; the stories make no native execution claim.
function Visit({ mode, dark = false }: { mode: Mode; dark?: boolean }) {
  const [ready, setReady] = useState(false);
  const [router] = useState(() => {
    const parent = createRootRoute();
    const consent = createRoute({
      getParentRoute: () => parent,
      path: '/consent',
      component: Route.options.component!,
    });
    return createRouter({
      routeTree: parent.addChildren([consent]),
      history: createMemoryHistory({ initialEntries: ['/consent?client_id=story-consent&scope=openid'] }),
    });
  });
  useLayoutEffect(() => {
    const original = globalThis.fetch;
    const marker = `auth.consent.pending:${JSON.stringify(['story-viewer', 'story-consent', 'openid'])}`;
    const retained = window.sessionStorage.getItem(marker);
    window.sessionStorage.removeItem(marker);
    let reads = 0;
    let posts = 0;
    let release: ((response: Response) => void) | undefined;
    const review = {
      client_id: 'story-consent',
      display_name: 'Reading companion',
      scopes: ['openid'],
      requested: ['openid'],
      granted: [],
      pending_reduction: false,
      acting_account: { account_id: 'story-viewer', email: 'reader@example.test' },
      decisions: { allow: true, decline: true, switch_account: true },
    };
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'POST') {
        posts++;
        if (mode === 'pending')
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return mode === 'acknowledged' || (mode === 'approved' && posts > 1)
          ? Response.json({
              client_id: review.client_id,
              account_id: 'story-viewer',
              requested: ['openid'],
              scope: ['openid'],
            })
          : Response.json({ code: 'unavailable' }, { status: 503 });
      }
      if (++reads === 1) return Response.json(review);
      if (mode === 'loading')
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      if (mode === 'approved' || mode === 'declined') return Response.json(review);
      if (mode === 'replacement')
        return Response.json({
          ...review,
          display_name: 'Current application',
          acting_account: { account_id: 'replacement-viewer', email: null },
          pending_reduction: true,
          decisions: { ...review.decisions, allow: false },
        });
      return Response.json(
        { code: 'unavailable' },
        { status: mode === 'signed-out' ? 401 : mode === 'not-found' ? 404 : 503 },
      );
    }) as typeof fetch;
    setReady(true);
    return () => {
      release?.(Response.json({ code: 'unavailable' }, { status: 503 }));
      globalThis.fetch = original;
      if (retained === null) window.sessionStorage.removeItem(marker);
      else window.sessionStorage.setItem(marker, retained);
    };
  }, [mode]);
  return <div className={dark ? 'dark' : ''}><AuthShell>{ready ? <RouterProvider router={router} /> : null}</AuthShell></div>;
}
async function reachHistory(canvas: HTMLElement, pending = false, loading = false) {
  (await waitFor(() => button(canvas, m.auth_consent_approve()))).click();
  if (pending) {
    await waitFor(() => canvas.textContent?.includes(m.auth_consent_sending()));
    canvas.querySelector<HTMLAnchorElement>('a[href^="/login?"]')!.click();
    await waitFor(() => document.querySelector('[role="alertdialog"]'));
    return;
  }
  (await waitFor(() => button(canvas, m.auth_consent_review_current()))).click();
  if (!loading) await waitFor(() => !canvas.textContent?.includes(m.auth_consent_loading()));
}
export const SignedOutUnknown = {
  render: () => <Visit mode="signed-out" />,
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => reachHistory(canvasElement),
};
export const NotFoundUnknown = {
  render: () => <Visit mode="not-found" />,
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => reachHistory(canvasElement),
};
export const ReadFailedUnknown = {
  render: () => <Visit mode="failed" />,
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => reachHistory(canvasElement),
};
export const LoadingUnknown = {
  render: () => <Visit mode="loading" />,
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => reachHistory(canvasElement, false, true),
};
export const ReplacementWithReductionPending = {
  render: () => <Visit mode="replacement" />,
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => reachHistory(canvasElement),
};
export const AcknowledgedThenUnavailable = {
  render: () => <Visit mode="acknowledged" />,
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => reachHistory(canvasElement),
};
export const LeavingPendingDecision = {
  render: () => <Visit mode="pending" />,
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => reachHistory(canvasElement, true),
};

const phone = { viewport: { ...reviewParameters.viewport, defaultViewport: 'phone390' } };
const desktop = { viewport: { ...reviewParameters.viewport, defaultViewport: 'desktop1280' } };
async function latest(canvas: HTMLElement, decision: 'approve' | 'decline') {
  await reachHistory(canvas);
  (await waitFor(() => button(canvas, decision === 'approve' ? m.auth_consent_approve() : m.auth_consent_decline()))).click();
  await waitFor(() => canvas.textContent?.includes(decision === 'approve' ? m.auth_consent_approved() : m.auth_consent_declined_after_submission()));
}
export const UnknownThenApprovedPhoneLight = {
  parameters: phone,
  render: () => <Visit mode="approved" />,
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => latest(canvasElement, 'approve'),
};
export const UnknownThenApprovedDesktopDark = {
  ...UnknownThenApprovedPhoneLight, parameters: desktop, render: () => <Visit mode="approved" dark />,
};
export const UnknownThenDeclinedPhoneDark = {
  parameters: phone,
  render: () => <Visit mode="declined" dark />,
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => latest(canvasElement, 'decline'),
};
export const UnknownCurrentReviewDesktopLight = { ...ReplacementWithReductionPending, parameters: desktop };
