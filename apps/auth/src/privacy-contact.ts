import { createServerFn } from '@tanstack/react-start';

export const readPrivacyContact = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('cloudflare:workers');
  const contact = (env as { PRIVACY_CONTACT_URL?: string }).PRIVACY_CONTACT_URL?.trim();
  try {
    const url = new URL(contact ?? '');
    if (
      (url.protocol === 'https:' && url.hostname) ||
      (url.protocol === 'mailto:' && /^[^\s@]+@[^\s@]+$/.test(url.pathname))
    )
      return contact!;
  } catch {}
  console.error('PRIVACY_CONTACT_URL must be an https: URL with a host or a mailto: URL with an address.');
  return null;
});
