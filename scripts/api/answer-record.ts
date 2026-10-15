import { repositoryGlob } from '../lib/repository-files.ts';
import { Compile, type Validator, type XSchema } from 'typebox/schema';
import { Settings } from 'typebox/system';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Application answers, shared by outcome records and the interactive persona probe. */
export const answerPersonas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
export type AnswerPersona = typeof answerPersonas[number];
export interface AnswerCall {
  operationId: string;
  method: string;
  /** Service-relative path, including the query exactly as requested. */
  path: string;
  body?: unknown;
}
export interface RecordedAnswer extends AnswerCall {
  status: number;
  answer: unknown;
  headers: Record<string, string>;
  binary?: { source: string; byteLength: number; sha256: string };
}
export interface AnswerSample extends RecordedAnswer { label: string }
export interface AnswerViolation {
  operationId: string;
  status: number;
  /** JSON pointer relative to the sample, including /answer for body members. */
  path: string;
  expected: string;
  received: string;
  message: string;
}
export interface AnswerRecord {
  version: 1;
  row: string;
  personas: Record<AnswerPersona, AnswerSample[]>;
}

export const clientResponseHeaders = ['content-type', 'location', 'retry-after', 'etag', 'cache-control'] as const;
const credentialKey = /^(?:authorization|bearer|cookies?|setcookie|xsessionkey|sessionkey|sessiontoken|accesstoken|refreshtoken|idtoken|password|clientsecret|apikey|credentials?|idempotencykey|idempotencysecret)$/;
function secretKey(key: string): boolean {
  return credentialKey.test(key.toLowerCase().replace(/[-_\s]/g, ''));
}

/** Remove secrets without rewriting resource IDs, times or opaque continuations. */
export function redactAnswer(value: unknown): unknown {
  if (typeof value === 'string') return value
    .replace(/\bBearer\s+[^\s"'<>;,]+/gi, '[redacted]')
    .replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (field, separator: string, key: string) => {
      try { return secretKey(decodeURIComponent(key)) ? `${separator}redacted` : field; }
      catch { return field; }
    })
    .replace(/\b(?:authorization|(?:set-)?cookie|x-session-key|session[-_]?key|idempotency[-_]?key|idempotency[-_]?secret)\s*[:=]\s*[^\r\n]*/gi, '[redacted]');
  if (Array.isArray(value)) return value.map(redactAnswer);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !secretKey(key)).map(([key, field]) => [key, redactAnswer(field)]));
  return value;
}

export function recordAnswer(call: RecordedAnswer): RecordedAnswer {
  const headers = Object.fromEntries(Object.entries(call.headers)
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .filter(([key]) => clientResponseHeaders.some(header => header === key)));
  return redactAnswer({ operationId: call.operationId, method: call.method, path: call.path,
    ...(Object.hasOwn(call, 'body') ? { body: call.body } : {}), status: call.status,
    answer: call.answer, headers, ...(call.binary ? { binary: call.binary } : {}) }) as RecordedAnswer;
}

export function answerRecord(row: string, personas: Record<AnswerPersona, AnswerSample[]>): AnswerRecord {
  return { version: 1, row, personas: Object.fromEntries(answerPersonas.map(persona => [persona,
    personas[persona].map(sample => ({ label: sample.label, ...recordAnswer(sample) })),
  ])) as AnswerRecord['personas'] };
}

interface Reference { $ref: string }
interface Parameter { name: string; in: string; required?: boolean; schema?: XSchema }
interface ApiResponse { content?: Record<string, { schema?: XSchema }> }
interface ApiOperation {
  operationId?: string;
  parameters?: (Parameter | Reference)[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: XSchema }> } | Reference;
  responses?: Record<string, ApiResponse | Reference>;
}
export interface AnswerContract {
  paths: Record<string, { parameters?: (Parameter | Reference)[] } & Record<string, unknown>>;
  components?: unknown;
}
const sampleSchema = {
  type: 'object', additionalProperties: false,
  required: ['label', 'operationId', 'method', 'path', 'status', 'answer', 'headers'],
  properties: {
    label: { type: 'string', minLength: 1 }, operationId: { type: 'string', minLength: 1 },
    method: { type: 'string', pattern: '^[A-Z]+$' }, path: { type: 'string', minLength: 1 },
    body: {}, status: { type: 'integer', minimum: 100, maximum: 599 }, answer: {},
    binary: { type: 'object', additionalProperties: false, required: ['source', 'byteLength', 'sha256'], properties: {
      source: { type: 'string', pattern: '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9_./-]+$' },
      byteLength: { type: 'integer', minimum: 0 }, sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    } },
    headers: { type: 'object', additionalProperties: false,
      properties: Object.fromEntries(clientResponseHeaders.map(header => [header, { type: 'string' }])) },
  },
};
const envelope = Compile({ type: 'object', additionalProperties: false,
  required: ['version', 'row', 'personas'], properties: {
    version: { const: 1 }, row: { type: 'string', pattern: '^[a-z0-9-]+/[a-z0-9-]+$' },
    personas: { type: 'object', additionalProperties: false, required: [...answerPersonas],
      properties: Object.fromEntries(answerPersonas.map(persona => [persona,
        // A production journey may stop at sign-in before it sends any API request.
        { type: 'array', items: sampleSchema }])) },
  },
});

/** JSON Schema validation uses the complete document as the reference root. */
export class AnswerRecordValidator {
  private readonly schemas = new Map<XSchema, Validator>();
  private readonly operations: { path: string; method: string; operation: ApiOperation; parameters: (Parameter | Reference)[] }[];
  constructor(private readonly contract: AnswerContract) {
    this.operations = Object.entries(contract.paths).flatMap(([path, item]) =>
      Object.entries(item).filter(([method]) => /^(get|post|put|patch|delete|head|options|trace)$/.test(method))
        .map(([method, operation]) => ({ path, method: method.toUpperCase(), operation: operation as ApiOperation,
          parameters: item.parameters ?? [] })));
  }

  private resolved<T>(value: T | Reference): T {
    const seen = new Set<string>();
    while (value && typeof value === 'object' && '$ref' in value) {
      const ref = (value as Reference).$ref;
      if (!ref.startsWith('#/') || seen.has(ref)) throw new Error(`Unresolvable contract reference ${ref}`);
      seen.add(ref);
      let target: unknown = this.contract;
      for (const part of ref.slice(2).split('/')) {
        const key = decodeURIComponent(part).replaceAll('~1', '/').replaceAll('~0', '~');
        if (!target || typeof target !== 'object' || !Object.hasOwn(target, key))
          throw new Error(`Unresolvable contract reference ${ref}`);
        target = (target as Record<string, unknown>)[key];
      }
      value = target as T;
    }
    return value as T;
  }

  private validator(schema: XSchema): Validator {
    let validator = this.schemas.get(schema);
    if (!validator) {
      // Only a schema that holds a reference needs the document as its root; a root costs its whole size at every compile.
      const root = JSON.stringify(schema).includes('"$ref"') ? this.contract : {};
      validator = Compile({ ...root, allOf: [schema] });
      this.schemas.set(schema, validator);
    }
    return validator;
  }

  private route(method: string, path: string) {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\s#]/.test(path)) return undefined;
    const segments = path.split('?')[0]!.split('/');
    let decoded: string[];
    try {
      decoded = segments.map(segment => decodeURIComponent(segment));
      if (decoded.some(segment => /^(?:\.|\.\.)$|\\/.test(segment))) return undefined;
    } catch { return undefined; }
    // Literal routes take precedence over parameter routes.
    return this.operations.filter(entry => entry.method === method && entry.path.split('/').length === segments.length)
      .sort((a, b) => (a.path.includes('{') ? 1 : 0) - (b.path.includes('{') ? 1 : 0))
      .find(entry => entry.path.split('/').every((part, index) => {
        if (!/^\{[^}]+\}$/.test(part)) return part === segments[index];
        if (!segments[index]) return false;
        // An encoded slash remains inside one router parameter. Only its
        // declared schema can authorize that decoded value, such as a native IRI.
        if (!decoded[index]!.includes('/')) return true;
        const parameter = [...(entry.operation.parameters ?? []), ...entry.parameters]
          .map(ref => this.resolved<Parameter>(ref))
          .find(parameter => parameter.in === 'path' && parameter.name === part.slice(1, -1));
        return parameter?.schema !== undefined && this.validator(parameter.schema).Check(decoded[index]);
      }));
  }

  operationId(method: string, path: string): string {
    const id = this.route(method, path)?.operation.operationId;
    if (!id) throw new Error(`No public API operation for ${method} ${path.split('?')[0]}`);
    return id;
  }

  /** Check only the response, including refusals; never validate a proof's request. */
  responseViolations(sample: AnswerSample): AnswerViolation[] {
    const violation = (path: string, expected: string, value: unknown, message: string): AnswerViolation => ({
      operationId: sample.operationId, status: sample.status, path, expected, received: answerType(value), message,
    });
    const entry = this.route(sample.method, sample.path);
    if (!entry || entry.operation.operationId !== sample.operationId)
      return [violation('/operationId', 'operation at method/path', sample.operationId, 'Operation does not exist at this method/path')];
    const operation = entry.operation;
    const response = operation.responses?.[String(sample.status)]
      ?? operation.responses?.[`${Math.floor(sample.status / 100)}XX`] ?? operation.responses?.default;
    if (!response) return [violation('/status', `declared status (${Object.keys(operation.responses ?? {}).join(', ')})`,
      sample.status, 'Status is not declared by the operation')];
    const content = this.resolved<ApiResponse>(response).content;
    if (!content) return sample.answer === null ? [] :
      [violation('/answer', 'null', sample.answer, 'Bodyless response must have a null answer')];
    const mediaType = sample.headers['content-type']?.split(';')[0]?.trim();
    const schema = (content[mediaType ?? 'application/json'] ?? content[`${mediaType?.split('/')[0]}/*`] ?? content['*/*'])?.schema;
    if (schema === undefined) return [violation('/headers/content-type', 'declared media type', mediaType,
      'Response has no declared schema for this media type')];
    if (sample.binary) {
      const binarySchema = this.resolved<{ type?: string; format?: string }>(schema);
      if (binarySchema.type !== 'string' || binarySchema.format !== 'binary')
        return [violation('/binary', 'declared binary response', sample.binary, 'Binary metadata cannot replace a JSON answer')];
      return sample.answer === null ? [] : [violation('/answer', 'null', sample.answer, 'Binary bytes belong to the source asset, never record JSON')];
    }
    const validator = this.validator(schema);
    if (validator.Check(sample.answer)) return [];
    // A suppressed first error must not hide later members behind TypeBox's default
    // eight-error diagnostic cap. This synchronous pass restores process settings.
    const maxErrors = Settings.Get().maxErrors;
    let errors: ReturnType<Validator['Errors']>[1];
    try { Settings.Set({ maxErrors: Infinity }); errors = validator.Errors(sample.answer)[1]; }
    finally { Settings.Set({ maxErrors }); }
    const violations = errors.flatMap(error => {
      const value = pointerValue(sample.answer, error.instancePath);
      const path = '/answer' + error.instancePath;
      // TypeBox reports extra and missing members at their parent object. Expand them
      // so a debt cannot silence errors in the parent's other members.
      if (error.keyword === 'additionalProperties') return error.params.additionalProperties.map(key =>
        violation(`${path}/${pointerKey(key)}`, 'absent (closed schema)', pointerValue(value, `/${pointerKey(key)}`), error.message));
      if (error.keyword === 'required') return error.params.requiredProperties.map(key => {
        const property = pointerValue(validator.Schema(), error.schemaPath.replace(/^#/, '') + `/properties/${pointerKey(key)}`) as { type?: string | string[] } | undefined;
        return violation(`${path}/${pointerKey(key)}`, property?.type ? [property.type].flat().join(' | ') : 'required member', undefined, error.message);
      });
      const expected = error.keyword === 'type' ? [error.params.type].flat().join(' | ') : error.message;
      return [violation(path, expected, value, error.message)];
    });
    // A false additionalProperties schema also emits a redundant boolean error.
    const closedMembers = new Set(violations.filter(item => item.expected === 'absent (closed schema)').map(item => item.path));
    return violations.filter(item => item.message !== 'schema is false' || !closedMembers.has(item.path));
  }

  validate(value: unknown, allowResponseViolation: (violation: AnswerViolation) => boolean = () => false): AnswerRecord {
    const candidate = value as Partial<AnswerRecord> | null;
    const row = candidate?.row ?? '<unknown>';
    const fail = (persona: string, label: string, pointer: string, message: string): never => {
      throw new Error(`row ${row}, persona ${persona}, sample ${label}, ${pointer || '/'}: ${message}`);
    };
    if (!envelope.Check(value)) {
      const error = envelope.Errors(value)[1][0]!;
      const parts = error.instancePath.split('/');
      const persona = parts[1] === 'personas' ? parts[2] ?? '<unknown>' : '<unknown>';
      const label = candidate?.personas?.[persona as AnswerPersona]?.[Number(parts[3])]?.label ?? '<unknown>';
      fail(persona, label, error.instancePath, error.message);
    }
    const record = value as AnswerRecord;
    for (const persona of answerPersonas) {
      const labels = new Set<string>();
      for (const [index, sample] of record.personas[persona].entries()) {
        const base = `/personas/${persona}/${index}`;
        const reject = (pointer: string, message: string) => fail(persona, sample.label, base + pointer, message);
        if (labels.has(sample.label)) reject('/label', 'Duplicate sample label');
        labels.add(sample.label);
        if (JSON.stringify(redactAnswer(sample)) !== JSON.stringify(sample)) reject('', 'Record contains credentials');
        const entry = this.route(sample.method, sample.path);
        if (!entry || entry.operation.operationId !== sample.operationId)
          reject('/operationId', 'Operation does not exist at this method/path');
        const operation = entry!.operation;
        for (const violation of this.responseViolations(sample)) {
          if (!allowResponseViolation(violation)) reject(violation.path,
            `${violation.message}; operation ${sample.operationId}, status ${sample.status}, expected ${violation.expected}, received ${violation.received}`);
        }
        const check = (schema: XSchema, data: unknown, pointer: string) => {
          const validator = this.validator(schema);
          if (validator.Check(data)) return;
          const error = validator.Errors(data)[1][0]!;
          reject(pointer + error.instancePath, error.message);
        };
        // Refusal samples deliberately exercise invalid requests; their problem answer is still checked.
        if (sample.status >= 400) continue;
        const url = new URL(sample.path, 'https://record.invalid');
        const pathValues = Object.fromEntries(entry!.path.split('/').flatMap((part, position) =>
          /^\{[^}]+\}$/.test(part) ? [[part.slice(1, -1), decodeURIComponent(url.pathname.split('/')[position]!)]] : []));
        for (const ref of [...entry!.parameters, ...(operation.parameters ?? [])]) {
          const parameter = this.resolved<Parameter>(ref);
          if (parameter.in !== 'query' && parameter.in !== 'path') continue;
          const values = parameter.in === 'query' ? url.searchParams.getAll(parameter.name) :
            pathValues[parameter.name] === undefined ? [] : [pathValues[parameter.name]!];
          const name = `${parameter.in} parameter ${parameter.name}`;
          if (!values.length) { if (parameter.required) reject('/path', `${name} is required`); continue; }
          if (parameter.schema === undefined) continue;
          const validator = this.validator(parameter.schema);
          const raw = values.length === 1 ? values[0]! : values;
          // URL numbers and booleans are strings on the wire; coerce only for contract checking.
          const coerce = (value: string) => /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
            ? Number(value) : value === 'true' ? true : value === 'false' ? false : value;
          const coerced = typeof raw === 'string' ? coerce(raw) : raw;
          // Form/explode array parameters remain arrays even when only one value is on the wire.
          if (![raw, coerced, values, values.map(coerce)].some(candidate => validator.Check(candidate))) {
            const error = validator.Errors(coerced)[1][0]!;
            reject('/path', `${name}${error.instancePath}: ${error.message}`);
          }
        }
        if (operation.requestBody) {
          const request = this.resolved(operation.requestBody);
          if (!Object.hasOwn(sample, 'body')) { if (request.required) reject('/body', 'Required body is missing'); }
          else {
            const schema = request.content?.['application/json']?.schema;
            if (schema !== undefined) check(schema, sample.body, '/body');
          }
        }
      }
    }
    return record;
  }
}

function pointerKey(key: string): string { return key.replaceAll('~', '~0').replaceAll('/', '~1'); }
function pointerValue(value: unknown, pointer: string): unknown {
  for (const part of pointer.split('/').slice(1)) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  }
  return value;
}
function answerType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

/** Inventory validation must receive a contract freshly generated from the candidate tree. */
export function answerRecordViolations(root: string, contract: AnswerContract): string[] {
  const validator = new AnswerRecordValidator(contract);
  return [...repositoryGlob(root, 'tests/qa/fixtures/outcomes/**/*.json')].sort().flatMap(file => {
    try {
      const record = validator.validate(JSON.parse(readFileSync(resolve(root, file), 'utf8')) as unknown);
      const row = file.slice('tests/qa/fixtures/outcomes/'.length, -'.json'.length);
      if (row !== record.row) throw new Error(`row ${record.row}, persona <all>, sample <all>, /row: Record path names ${row}`);
      return [];
    } catch (error) { return [`${file}: ${error instanceof Error ? error.message : String(error)}`]; }
  });
}
