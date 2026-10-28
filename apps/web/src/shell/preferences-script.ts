import { createElement } from 'react';
import { useRouter } from '@tanstack/react-router';

// Runs synchronously in the head, before styles or body content can paint.
const preferences = `(()=>{try{const c=document.cookie,h=document.documentElement,t=/(?:^|;\\s*)rezics_theme=(system|light|dark)(?:;|$)/.exec(c)?.[1]||'system';h.classList.remove('light','dark');h.classList.add(t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t);if(/(?:^|;\\s*)rezics_nav=collapsed(?:;|$)/.test(c))h.dataset.nav='collapsed';else delete h.dataset.nav}catch{}})()`;

export function PreferencesScript() {
  const nonce = useRouter().options.ssr?.nonce;
  return createElement('script', { nonce, 'data-preferences': '', dangerouslySetInnerHTML: { __html: preferences } });
}
