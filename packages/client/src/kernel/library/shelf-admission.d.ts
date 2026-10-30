import type { Actor } from '../request/access.ts';
import { type ShelfAdmissionDependencies } from './shelf-contract.ts';
export declare function admitShelfRead(deps: ShelfAdmissionDependencies, actor: Actor, deadline: number): Promise<void>;
