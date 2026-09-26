import { accessOwner } from './access.ts';
import { contentOwner } from './content.ts';
import { graphOwner } from './graph.ts';
import { objectsOwner } from './objects.ts';
import type { FixtureOwner } from './types.ts';

/** Load order: offline graph first, then object and PostgreSQL owners online. */
export const fixtureOwners: readonly FixtureOwner[] = [graphOwner, objectsOwner, accessOwner, contentOwner];
