import type { TurnstileAPI } from './turnstile.tsx';

/** Story-only provider double. Real Cloudflare rendering and Siteverify are
 * covered separately by the enrollment browser journey. */
export function turnstileFixture(mode: 'success' | 'pending' | 'error' = 'success') {
  const previous = window.turnstile;
  const widgets = new Map<string, HTMLElement>();
  let serial = 0;
  window.turnstile = {
    render(container, options) {
      const id = `story-${++serial}`;
      const widget = document.createElement('div');
      widget.style.cssText = 'height:65px;border:1px solid #aaa;background:#fafafa;color:#222;display:flex;align-items:center;padding:12px;font:14px system-ui';
      widget.textContent = mode === 'success' ? '✓ Security check complete' : 'Security check';
      container.append(widget);
      widgets.set(id, widget);
      if (mode === 'success') options.callback('story-turnstile-token');
      if (mode === 'error') options['error-callback']();
      return id;
    },
    remove(id) { widgets.get(id)?.remove(); widgets.delete(id); },
  } satisfies TurnstileAPI;
  return () => { for (const widget of widgets.values()) widget.remove(); window.turnstile = previous; };
}
