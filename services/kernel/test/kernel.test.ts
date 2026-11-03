import { testReceiptKeys } from './support/receipt-keys.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { testReceiptKeys } from './support/receipt-keys.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../src/database/pool.ts';
import { createKernel, type Kernel } from '../src/http/kernel.ts';
import { openApiDocument } from '../src/http/openapi.ts';
import { actionCatalogue } from '../src/http/request.ts';
import { bootstrapRelease } from '../src/semantic/definitions.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
beforeAll(() => bootstrapRelease(pool, bundledRelease));
afterAll(() => pool.end());

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Name<Key extends string, Path extends string> = `${Uppercase<Key>} ${Path extends '' ? '/' : Path}`;
/** Every `METHOD /path` in the route tree Eden builds its client from. */
type TypedRoutes<Tree, Path extends string = ''> = {
  [Key in keyof Tree & string]: Key extends Method ? Name<Key, Path> : TypedRoutes<Tree[Key], `${Path}/${Key}`>;
}[keyof Tree & string];
type Success<Route> = Route extends { response: infer Responses }
  ? Responses[Extract<keyof Responses, 200 | 201 | 202 | 204>]
  : never;
/** Routes whose success response type is an open record: its schema was lost on the way into the route. */
type LooseRoutes<Tree, Path extends string = ''> = {
  [Key in keyof Tree & string]: Key extends Method
    ? [Success<Tree[Key]>] extends [never]
      ? never
      : string extends keyof Success<Tree[Key]>
        ? Name<Key, Path>
        : never
    : LooseRoutes<Tree[Key], `${Path}/${Key}`>;
}[keyof Tree & string];
type Routes = TypedRoutes<Kernel['~Routes']>;

// Type-checking proves that each entry is a typed route, that no typed route is missing, and that every success
// response keeps its schema's type. An error names the offending routes.
const typed = [
  'POST /v1/libraryImports/vndb/$preview',
  'GET /v1/libraryImports/vndb/:uploadId',
  'GET /v1/libraryImports/vndb/:uploadId/source',
  'POST /v1/libraryImports/vndb/:uploadId/$review',
  'POST /v1/libraryImports/vndb/:uploadId/$apply',
  'POST /v1/libraryImports/vndb/:uploadId/$cancel',
  'DELETE /v1/libraryImports/vndb/:uploadId',
