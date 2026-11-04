export const OPERATION_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type OperationMethod = (typeof OPERATION_METHODS)[number];

export type OperationSecurityScheme = 'anonymous' | 'bearerAuth';
export type OperationSecurity = Readonly<{ scheme: OperationSecurityScheme }>;
export type OperationAudience = 'account' | 'public';
export type OperationRateLimit =
  | 'kernel.write.single'
  | 'kernel.write.commands'
  | 'kernel.provider.single';

export type OperationContractReferences = Readonly<{
  params?: string;
  query?: string;
  headers?: string;
  body?: string;
  response: string;
}>;

export type OperationAuthority = Readonly<{
  anchor: 'own-account';
  resourceTypes: readonly string[];
}>;

/** Framework-free mounted contract. It describes a route and never contains a handler or policy decision. */
export type OperationDescriptor = Readonly<{
  operationId: string;
  method: OperationMethod;
  path: string;
  action: string;
  audience: OperationAudience;
  security: readonly OperationSecurity[];
  exposure: string;
  resourceTypes: readonly string[];
  replayAuthorization?: 'self-account-read';
  authority?: OperationAuthority;
  rateLimit?: OperationRateLimit;
  contracts: OperationContractReferences;
}>;

export type OperationCatalogue = Readonly<{
  get(operationId: string): OperationDescriptor | undefined;
  all(): readonly OperationDescriptor[];
}>;

const OPERATION_ID = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const ACTION = /^[a-z][a-z_]*:[a-z][a-z_]*$/;
const RESOURCE_TYPE = /^[A-Za-z][A-Za-z0-9_.-]*(?::[A-Za-z][A-Za-z0-9_.-]*)?$/;
const CONTRACT_REFERENCE = /^[a-z][A-Za-z0-9_.-]*$/;
const PATH_PARAMETER = /^:[A-Za-z_][A-Za-z0-9_]*$/;
const EXPOSURE_GATE = /^gate:[a-z][a-z0-9_]*$/;
const RATE_LIMITS: readonly OperationRateLimit[] = [
  'kernel.write.single',
  'kernel.write.commands',
  'kernel.provider.single',
];
const DESCRIPTOR_KEYS = [
  'operationId',
  'method',
  'path',
  'action',
  'audience',
  'security',
  'exposure',
  'resourceTypes',
  'replayAuthorization',
  'authority',
  'rateLimit',
  'contracts',
];
const CONTRACT_KEYS = ['params', 'query', 'headers', 'body', 'response'];
const AUTHORITY_KEYS = ['anchor', 'resourceTypes'];

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(label: string, reason: string): never {
  throw new TypeError(label + ': ' + reason);
}

function labelOf(value: Record<string, unknown>): string {
  const method = typeof value.method === 'string' ? value.method.toUpperCase() : 'UNKNOWN';
  const path = typeof value.path === 'string' ? value.path : '<missing path>';
  const id = typeof value.operationId === 'string' ? value.operationId : '<missing operationId>';
  return method + ' ' + path + ' [' + id + ']';
}

function isMethod(value: unknown): value is OperationMethod {
  return typeof value === 'string' && OPERATION_METHODS.some((method) => method === value);
}

function isReference(value: unknown): value is string {
  return typeof value === 'string' && CONTRACT_REFERENCE.test(value);
}

function isRateLimit(value: unknown): value is OperationRateLimit {
  return typeof value === 'string' && RATE_LIMITS.some((reference) => reference === value);
}

function readResourceTypes(value: unknown, label: string, name: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !RESOURCE_TYPE.test(item)) ||
    new Set(value).size !== value.length
  )
    return invalid(label, name + ' must be a list of distinct resource type names');
  return Object.freeze([...value]);
}

function snapshotDescriptor(input: unknown): OperationDescriptor {
  if (!isRecord(input)) return invalid('operation', 'descriptor must be an object');
  const label = labelOf(input);
  if (!hasOnlyKeys(input, DESCRIPTOR_KEYS)) return invalid(label, 'descriptor contains an unsupported field');
  const operationId = input.operationId;
  const method = input.method;
  const path = input.path;
  const action = input.action;
  const audience = input.audience;
  const exposure = input.exposure;
  if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId))
    return invalid(label, 'operationId must be <resource>.<verb>');
  if (!isMethod(method)) return invalid(label, 'method must be a supported uppercase HTTP method');
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.includes('?') ||
    path.includes('#') ||
    path.endsWith('/')
  )
    return invalid(label, 'path must be an absolute route template without query, fragment, or trailing slash');
  if (typeof action !== 'string' || !ACTION.test(action)) return invalid(label, 'action must be <resource>:<verb>');
  if (audience !== 'account' && audience !== 'public') return invalid(label, 'audience must be account or public');
  if (
    typeof exposure !== 'string' ||
    (exposure !== 'public' && !EXPOSURE_GATE.test(exposure))
  )
    return invalid(label, 'exposure must be public or a named gate');

  const pathSegments = path.split('/');
  for (const segment of pathSegments) {
    if (segment.startsWith(':') && !PATH_PARAMETER.test(segment))
      return invalid(label, 'path parameters must use a complete :name segment');
  }

  if (!Array.isArray(input.security) || input.security.length === 0)
    return invalid(label, 'security must contain at least one alternative');
  const security: OperationSecurity[] = [];
  for (const requirement of input.security) {
    if (
      !isRecord(requirement) ||
      !hasOnlyKeys(requirement, ['scheme']) ||
      (requirement.scheme !== 'anonymous' && requirement.scheme !== 'bearerAuth')
    )
      return invalid(label, 'security alternatives must be anonymous or bearerAuth');
    security.push(Object.freeze({ scheme: requirement.scheme }));
  }
  const securityNames = security.map(({ scheme }) => scheme);
  if (new Set(securityNames).size !== securityNames.length)
    return invalid(label, 'security alternatives must be distinct');
  if (
    (audience === 'account' && (security.length !== 1 || security[0]?.scheme !== 'bearerAuth')) ||
    (audience === 'public' && !security.some(({ scheme }) => scheme === 'anonymous'))
  )
    return invalid(label, 'audience conflicts with security alternatives');

  const resourceTypes = readResourceTypes(input.resourceTypes, label, 'resourceTypes');
  const replayAuthorization = input.replayAuthorization;
  if (replayAuthorization !== undefined && replayAuthorization !== 'self-account-read')
    return invalid(label, 'unsupported replay authorization');

  let authority: OperationAuthority | undefined;
  if (input.authority !== undefined) {
    if (
      !isRecord(input.authority) ||
      !hasOnlyKeys(input.authority, AUTHORITY_KEYS) ||
      input.authority.anchor !== 'own-account'
    )
      return invalid(label, 'authority anchor must be own-account');
    authority = Object.freeze({
      anchor: 'own-account',
      resourceTypes: readResourceTypes(input.authority.resourceTypes, label, 'authority resourceTypes'),
    });
  }

  const rateLimit = input.rateLimit;
  if (rateLimit !== undefined && !isRateLimit(rateLimit))
    return invalid(label, 'rateLimit must reference a supported rate contract');
  if (
    !isRecord(input.contracts) ||
    !hasOnlyKeys(input.contracts, CONTRACT_KEYS) ||
    !isReference(input.contracts.response)
  )
    return invalid(label, 'contracts.response must reference a response contract');
  const contracts: {
    params?: string;
    query?: string;
    headers?: string;
    body?: string;
    response: string;
  } = { response: input.contracts.response };
  for (const key of ['params', 'query', 'headers', 'body'] as const) {
    const reference = input.contracts[key];
    if (reference !== undefined) {
      if (!isReference(reference)) return invalid(label, 'contracts.' + key + ' must be a contract reference');
      contracts[key] = reference;
    }
  }

  return Object.freeze({
    operationId,
    method,
    path,
    action,
    audience,
    security: Object.freeze(security),
    exposure,
    resourceTypes,
    ...(replayAuthorization === undefined ? {} : { replayAuthorization }),
    ...(authority === undefined ? {} : { authority }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
    contracts: Object.freeze(contracts),
  });
}

/** Takes an immutable snapshot of owner declarations; composition performs cross-declaration checks. */
export function defineOperationDescriptors(input: readonly unknown[]): readonly OperationDescriptor[] {
  return Object.freeze(input.map(snapshotDescriptor));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDescriptors(left: OperationDescriptor, right: OperationDescriptor): number {
  return (
    compareText(left.operationId, right.operationId) ||
    compareText(left.method, right.method) ||
    compareText(left.path, right.path)
  );
}

function descriptorLabel(descriptor: OperationDescriptor): string {
  return descriptor.method + ' ' + descriptor.path + ' [' + descriptor.operationId + ']';
}

function securitySignature(descriptor: OperationDescriptor): string {
  const alternatives = descriptor.security.map(({ scheme }) => scheme).sort(compareText);
  return descriptor.audience + ':' + alternatives.join(',');
}

function validateParameterNames(descriptors: readonly OperationDescriptor[]): void {
  const names = new Map<string, { name: string; descriptor: OperationDescriptor; position: number }>();
  for (const descriptor of descriptors) {
    const segments = descriptor.path.split('/');
    for (const [position, segment] of segments.entries()) {
      if (!segment.startsWith(':')) continue;
      const key = JSON.stringify(
        segments.slice(0, position).map((prefixSegment) => (prefixSegment.startsWith(':') ? ':' : prefixSegment)),
      );
      const previous = names.get(key);
      if (previous && previous.name !== segment.slice(1))
        throw new Error(
          descriptorLabel(previous.descriptor) +
            ' and ' +
            descriptorLabel(descriptor) +
            ': inconsistent path parameter name at position ' +
            position,
        );
      if (!previous) names.set(key, { name: segment.slice(1), descriptor, position });
    }
  }
}

/** Validates and composes pure declarations without a database or process-global registration order. */
export function createOperationCatalogue(input: readonly unknown[]): OperationCatalogue {
  const descriptors = input.map(snapshotDescriptor).sort(compareDescriptors);
  const ids = new Map<string, OperationDescriptor>();
  const routes = new Map<string, OperationDescriptor>();
  const actions = new Map<string, OperationDescriptor>();

  for (const descriptor of descriptors) {
    const idPrior = ids.get(descriptor.operationId);
    if (idPrior)
      throw new Error(
        descriptorLabel(idPrior) + ' and ' + descriptorLabel(descriptor) + ': duplicate operationId',
      );
    ids.set(descriptor.operationId, descriptor);

    const routeKey = descriptor.method + ' ' + descriptor.path;
    const routePrior = routes.get(routeKey);
    if (routePrior)
      throw new Error(
        descriptorLabel(routePrior) + ' and ' + descriptorLabel(descriptor) + ': duplicate mounted route',
      );
    routes.set(routeKey, descriptor);

    const actionPrior = actions.get(descriptor.action);
    if (actionPrior && securitySignature(actionPrior) !== securitySignature(descriptor))
      throw new Error(
        descriptorLabel(actionPrior) +
          ' and ' +
          descriptorLabel(descriptor) +
          ': conflicting security for action ' +
          descriptor.action,
      );
    if (!actionPrior) actions.set(descriptor.action, descriptor);
  }

  validateParameterNames(descriptors);
  const ordered = Object.freeze(descriptors);
  const byId = new Map(ordered.map((descriptor) => [descriptor.operationId, descriptor]));
  return Object.freeze({
    get(operationId: string) {
      return byId.get(operationId);
    },
    all() {
      return ordered;
    },
  });
}
