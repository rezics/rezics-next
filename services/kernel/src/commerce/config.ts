import type { StripePortConfig } from './stripe.ts';

export class ConfigError extends Error {
  constructor(variable: string) {
    super(`Invalid or missing ${variable}`);
    this.name = 'ConfigError';
  }
}

export type CommerceConfig = {
  stripe: Omit<StripePortConfig, 'clock'>;
  webhookSecrets: readonly string[];
  successUrl: string;
  cancelUrl: string;
};

function required(env: NodeJS.ProcessEnv, variable: string): string {
  const value = env[variable];
  if (!value || value.trim() !== value) throw new ConfigError(variable);
  return value;
}

function absoluteUrl(value: string, variable: string, protocols: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(variable);
  }
  if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new ConfigError(variable);
  return url;
}

export function readCommerceConfig(env: NodeJS.ProcessEnv): CommerceConfig {
  const apiKey = required(env, 'STRIPE_SECRET_KEY');
  if (!/^sk_(?:test|live)_[A-Za-z0-9_]+$/.test(apiKey)) throw new ConfigError('STRIPE_SECRET_KEY');
  const webhookSecrets = required(env, 'STRIPE_WEBHOOK_SECRETS')
    .split(',')
    .map((value) => value.trim());
  if (webhookSecrets.some((value) => !/^whsec_[A-Za-z0-9_]+$/.test(value)))
    throw new ConfigError('STRIPE_WEBHOOK_SECRETS');
  const managed = required(env, 'STRIPE_MANAGED_PAYMENTS');
  if (managed !== 'true' && managed !== 'false') throw new ConfigError('STRIPE_MANAGED_PAYMENTS');
  const stripe: CommerceConfig['stripe'] = { apiKey, managedPayments: managed === 'true' };
  if (env.STRIPE_API_HOST !== undefined) {
    const value = required(env, 'STRIPE_API_HOST');
    const url = absoluteUrl(value, 'STRIPE_API_HOST', ['http:', 'https:']);
    if (url.pathname !== '/' || url.search || url.hash) throw new ConfigError('STRIPE_API_HOST');
    stripe.host = url.hostname;
    stripe.port = url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443;
    stripe.protocol = url.protocol === 'http:' ? 'http' : 'https';
  }
  const successUrl = required(env, 'CHECKOUT_SUCCESS_URL');
  const cancelUrl = required(env, 'CHECKOUT_CANCEL_URL');
  absoluteUrl(successUrl, 'CHECKOUT_SUCCESS_URL', ['https:']);
  absoluteUrl(cancelUrl, 'CHECKOUT_CANCEL_URL', ['https:']);
  return { stripe, webhookSecrets, successUrl, cancelUrl };
}
