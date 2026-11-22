import { type Exposure } from '@rezics/access';
import type { MountedRoute } from '../../http/request.ts';
export type { Exposure } from '@rezics/access';
/** Parse trusted route metadata once, when the production kernel is composed. */
export declare function parseExposure(detail: unknown): Exposure;
/** The only fixed authority anchor is the native Global Context. */
export declare function fixedGlobalResourceId(detail: Readonly<Record<string, unknown>>, route: Pick<MountedRoute, 'method' | 'path'>): string | undefined;
