import type { AnyRouter, RouterHistory } from '@tanstack/react-router';

type PreviewNavigateEvent = Event & {
  canIntercept: boolean;
  destination: { url: string };
  navigationType: string;
  downloadRequest: string | null;
  formData: FormData | null;
};

/** Adapt document navigation to this mounted PageStory's existing router, including location.assign. */
export function bindPreviewNavigation({
  router,
  document,
  deLocalizeUrl,
  onLocation,
  onLimitation,
}: {
  router: AnyRouter;
  document: Document;
  deLocalizeUrl: (url: URL) => URL;
  onLocation: (href: string) => void;
  onLimitation: (message: string | undefined) => void;
}): () => void {
  const window = document.defaultView!;
  const navigation = (window as Window & { navigation?: EventTarget }).navigation;
  const browser = window.history;
  const history: RouterHistory = router.history;
  const frameUrl = window.location.href;
  const originalState = browser.state;
  const nativeLimitation = navigation
    ? undefined
    : 'This browser has no Navigation API; links and GET forms work here, but location.assign leaves the recorded preview.';
  const owner = window.crypto.randomUUID();
  let index = history.location.state.__TSR_index;
  let browserIndex = index;
  let journey = false;
  const stamp = () => ({ ...originalState, rezicsPageStory: { owner, index } });
  browser.replaceState(stamp(), '', frameUrl);

  function destination(href: string): URL | undefined {
    const url = new URL(href, new URL(history.location.href, frameUrl));
    if (url.origin !== window.location.origin || !['http:', 'https:'].includes(url.protocol)) return;
    const [, params, route] = router.getMatchedRoutes(deLocalizeUrl(url).pathname);
    // Keep real page/redirect loaders; server-only byte endpoints have neither after Start's client transform.
    if ((route?.options.component || route?.options.loader || route?.options.beforeLoad) && !params['**']) return url;
  }

  function visit(url: URL, replace = false): void {
    const href = `${url.pathname}${url.search}${url.hash}`;
    // Keep the browser's exact URL encoding and repeated query values; route loaders validate as usual.
    if (replace) history.replace(href);
    else history.push(href);
  }

  function click(event: MouseEvent): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (
      !anchor ||
      (anchor.target && anchor.target !== '_self') ||
      anchor.hasAttribute('download') ||
      anchor.relList.contains('external')
    )
      return;
    const url = destination(anchor.getAttribute('href')!);
    if (!url) return;
    event.preventDefault();
    visit(url);
  }

  function submit(event: SubmitEvent): void {
    if (event.defaultPrevented) return;
    const form = event.target as HTMLFormElement;
    const submitter = event.submitter as HTMLButtonElement | HTMLInputElement | null;
    const method = submitter?.getAttribute('formmethod') ?? form.method;
    const target = submitter?.getAttribute('formtarget') ?? form.target;
    if (method.toLowerCase() !== 'get' || (target && target !== '_self')) return;
    const url = destination(
      submitter?.getAttribute('formaction') ?? form.getAttribute('action') ?? history.location.href,
    );
    if (!url) return;
    const params = new URLSearchParams();
    for (const [name, value] of new FormData(form, submitter))
      params.append(name, typeof value === 'string' ? value : value.name);
    url.search = params.toString();
    event.preventDefault();
    visit(url);
  }

  function navigate(raw: Event): void {
    const event = raw as PreviewNavigateEvent;
    if (
      event.defaultPrevented ||
      !event.cancelable ||
      !event.canIntercept ||
      event.downloadRequest !== null ||
      event.formData !== null ||
      !['push', 'replace'].includes(event.navigationType)
    )
      return;
    const url = destination(event.destination.url);
    if (!url) return;
    event.preventDefault();
    visit(url, event.navigationType === 'replace');
  }

  function popstate(event: PopStateEvent): void {
    const entry = event.state?.rezicsPageStory;
    if (entry?.owner !== owner) return;
    browserIndex = entry.index;
    const delta = browserIndex - index;
    if (!delta) return;
    history.go(delta);
  }

  const unsubscribeHistory = history.subscribe(({ location, action }) => {
    index = location.state.__TSR_index;
    if (action.type === 'PUSH' || action.type === 'REPLACE') {
      browserIndex = index;
      if (action.type === 'PUSH') browser.pushState(stamp(), '', frameUrl);
      else browser.replaceState(stamp(), '', frameUrl);
    } else if (browserIndex !== index) browser.go(index - browserIndex);
  });
  const unsubscribeLoad = router.subscribe('onBeforeLoad', ({ fromLocation, toLocation }) => {
    journey ||= !!fromLocation && fromLocation.publicHref !== toLocation.publicHref;
    onLocation(toLocation.publicHref);
    onLimitation(nativeLimitation);
  });
  const unsubscribeResolved = router.subscribe('onResolved', () => {
    if (!journey) return;
    const failed = router.state.matches.find((match) => match.status === 'error' || match.status === 'notFound');
    if (failed) {
      const reason = failed.error instanceof Error ? failed.error.message : failed.status;
      onLimitation(`Recorded PageStory route preparation for ${history.location.href} returned ${reason}.`);
    }
  });
  onLimitation(nativeLimitation);
  document.addEventListener('click', click);
  document.addEventListener('submit', submit);
  navigation?.addEventListener('navigate', navigate);
  window.addEventListener('popstate', popstate);
  return () => {
    unsubscribeHistory();
    unsubscribeLoad();
    unsubscribeResolved();
    document.removeEventListener('click', click);
    document.removeEventListener('submit', submit);
    navigation?.removeEventListener('navigate', navigate);
    window.removeEventListener('popstate', popstate);
    if (browser.state?.rezicsPageStory?.owner === owner) browser.replaceState(originalState, '', frameUrl);
  };
}
