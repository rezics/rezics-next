import { afterAll } from 'bun:test';
import { closeCommunityDrivers } from './community-driver.ts';

process.env.COMMUNITY_DRIVER = new URL('./community-driver.ts', import.meta.url).href;

afterAll(closeCommunityDrivers);

await import('../../../../specs/community-outcomes.test.ts');
