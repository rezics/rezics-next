import type { AuditPage, Operators, TimelineCategory } from '../api/types.ts';

// Shared by the server page (which reads a tab's data) and the client page;
// a 'use client' module cannot hand plain values to the server.
export const userTabs = ['overview', 'security', 'apps', 'roles', 'audit'] as const;
export type UserTab = typeof userTabs[number];
export const timelineShows: readonly TimelineCategory[] = ['all', 'sign-ins', 'credentials', 'apps', 'staff'];
/** Data a tab needs beyond the user's detail, read by the page on the server.
 * The overview's timeline may start filtered (`?show=`). */
export type TabData = { tab: 'audit'; page: AuditPage } | { tab: 'roles'; permissions: Operators['permissions'] | null }
  | { tab: 'overview'; show: TimelineCategory } | { tab: 'security' | 'apps' };
