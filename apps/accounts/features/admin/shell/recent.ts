'use client';

// The users this operator opened in this tab, newest first, for the command
// palette. Session storage: it ends with the tab, so names and emails don't
// outlive the operator's session on a shared computer.

export interface RecentUser { id: string; name: string; email: string }
const key = 'rezics-admin-recent-users';
const limit = 6;

export function recentUsers(): RecentUser[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((item): item is RecentUser => typeof item === 'object' && item !== null
      && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.email === 'string').slice(0, limit) : [];
  } catch { return []; }
}

export function rememberUser(user: RecentUser) {
  try {
    sessionStorage.setItem(key, JSON.stringify([{ id: user.id, name: user.name, email: user.email },
      ...recentUsers().filter(item => item.id !== user.id)].slice(0, limit)));
  } catch { /* storage may be full or disabled; recents are a convenience */ }
}
