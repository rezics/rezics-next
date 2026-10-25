import { createServerFn } from '@tanstack/react-start';

export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type TurnstileBindings = {
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SCRIPT_URL?: string;
};

export const readTurnstileConfig = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('cloudflare:workers');
  const bindings = env as TurnstileBindings;
  const override = import.meta.env.DEV ? (bindings.TURNSTILE_SCRIPT_URL ?? '').trim() : '';
  return {
    siteKey: bindings.TURNSTILE_SITE_KEY ?? '',
    scriptUrl: override || TURNSTILE_SCRIPT_URL,
  };
});
