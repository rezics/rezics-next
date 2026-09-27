import type { AuditPage, Operators } from '../api/types.ts';

// Shared by the server page (which reads a tab's data) and the client page;
// a 'use client' module cannot hand plain values to the server.
export const userTabs = ['overview', 'security', 'roles', 'sanctions', 'apps', 'audit'] as const;
export type UserTab = typeof userTabs[number];
/** Data a tab needs beyond the user's detail, read by the page on the server. */
export type TabData = { tab: 'sanctions'; page: AuditPage } | { tab: 'audit'; page: AuditPage }
  | { tab: 'roles'; permissions: Operators['permissions'] | null } | { tab: 'overview' | 'security' | 'apps' };
