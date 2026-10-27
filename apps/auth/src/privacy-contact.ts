import { createServerFn } from '@tanstack/react-start';

export const readPrivacyContact = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('cloudflare:workers');
  return (env as { PRIVACY_CONTACT_URL: string }).PRIVACY_CONTACT_URL;
});
