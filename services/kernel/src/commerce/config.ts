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

export type CommerceWorkerConfig = Omit<CommerceConfig, 'webhookSecrets'>;

export type CheckoutUrls = Pick<CommerceWorkerConfig, 'successUrl' | 'cancelUrl'>;

type Environment = Readonly<Record<string, string | undefined>>;
/** A deployment's one direct account. Neither credentials nor provider payloads configure routing. */
export function readCommerceProviderConfig(env: Environment) {
  const accountNamespace = env.STRIPE_ACCOUNT_NAMESPACE ?? 'direct';
  const mode = env.STRIPE_LIVEMODE ?? 'false';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountNamespace)) throw new ConfigError('STRIPE_ACCOUNT_NAMESPACE');
  if (mode !== 'true' && mode !== 'false') throw new ConfigError('STRIPE_LIVEMODE');
  return { accountNamespace, livemode: mode === 'true' };
}
const commerceVariables = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRETS',
  'STRIPE_MANAGED_PAYMENTS',
  'STRIPE_API_HOST',
  'CHECKOUT_SUCCESS_URL',
  'CHECKOUT_CANCEL_URL',
] as const;

function isCommerceConfigured(env: Environment): boolean {
  return commerceVariables.some((variable) => env[variable] !== undefined);
}

function required(env: Environment, variable: string): string {
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

/** Resolve the order placeholder consistently for the HTTP attempt and its workflow retry. */
export function checkoutUrlsForOrder(urls: CheckoutUrls, orderId: string): CheckoutUrls {
  return {
    successUrl: urls.successUrl.replaceAll('{ORDER_ID}', orderId),
    cancelUrl: urls.cancelUrl.replaceAll('{ORDER_ID}', orderId),
  };
}

function checkoutUrl(value: string, variable: string): void {
  const withoutKnownPlaceholders = value.replaceAll('{ORDER_ID}', '').replaceAll('{CHECKOUT_SESSION_ID}', '');
  if (/[{}]/.test(withoutKnownPlaceholders)) throw new ConfigError(variable);

  const withSampleValues = value
    .replaceAll('{ORDER_ID}', '00000000-0000-4000-8000-000000000000')
    .replaceAll('{CHECKOUT_SESSION_ID}', 'cs_test_checkout_session_id');
  absoluteUrl(withSampleValues, variable, ['https:']);
}

function readStripeApiKey(env: Environment): string {
  const apiKey = required(env, 'STRIPE_SECRET_KEY');
  if (!/^sk_(?:test|live)_[A-Za-z0-9_]+$/.test(apiKey)) throw new ConfigError('STRIPE_SECRET_KEY');
  return apiKey;
}

function readWebhookSecrets(env: Environment): readonly string[] {
  const webhookSecrets = required(env, 'STRIPE_WEBHOOK_SECRETS')
    .split(',')
    .map((value) => value.trim());
  if (webhookSecrets.some((value) => !/^whsec_[A-Za-z0-9_]+$/.test(value)))
    throw new ConfigError('STRIPE_WEBHOOK_SECRETS');
  return webhookSecrets;
}

function readStripeConfig(env: Environment, apiKey = readStripeApiKey(env)): CommerceConfig['stripe'] {
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
  return stripe;
}

function readCheckoutConfig(env: Environment): Pick<CommerceWorkerConfig, 'successUrl' | 'cancelUrl'> {
  const successUrl = required(env, 'CHECKOUT_SUCCESS_URL');
  const cancelUrl = required(env, 'CHECKOUT_CANCEL_URL');
  checkoutUrl(successUrl, 'CHECKOUT_SUCCESS_URL');
  checkoutUrl(cancelUrl, 'CHECKOUT_CANCEL_URL');
  return { successUrl, cancelUrl };
}

/** Configuration shared by the worker's durable commerce workflows and the HTTP server. */
export function readCommerceWorkerConfig(env: Environment): CommerceWorkerConfig | null {
  if (!isCommerceConfigured(env)) return null;
  return { stripe: readStripeConfig(env), ...readCheckoutConfig(env) };
}

/** HTTP-only configuration adds webhook verification secrets to the worker's shared settings. */
export function readCommerceConfig(env: Environment): CommerceConfig | null {
  if (!isCommerceConfigured(env)) return null;
  const apiKey = readStripeApiKey(env);
  const webhookSecrets = readWebhookSecrets(env);
  return {
    stripe: readStripeConfig(env, apiKey),
    ...readCheckoutConfig(env),
    webhookSecrets,
  };
}
