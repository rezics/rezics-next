'use client';

import { useEffect, useState } from 'react';
import { CONTENT_LANGUAGES_COOKIE, storedContentLanguages } from '../../i18n/display-languages.ts';
import { browserMainApi } from '../api/browser.ts';

// The writer's saved reading languages, which a writing surface offers first
// and starts from. They live in Main (person preferences); the cookie is the
// copy Settings and the setup keep for instant reads.

const reads = new Map<string, Promise<string[] | null>>();

function read(actingSubject: string): Promise<string[] | null> {
  let pending = reads.get(actingSubject);
  if (!pending) {
    pending = browserMainApi().v1.me['person-preferences'].get({ query: { actingSubject } })
      .then(({ data }) => {
        if (!data) { reads.delete(actingSubject); return null; }
        return data.contentLanguages;
      }, () => { reads.delete(actingSubject); return null; });
    reads.set(actingSubject, pending);
  }
  return pending;
}

function cookieLanguages(): string[] {
  const value = document.cookie.split('; ').find(part => part.startsWith(`${CONTENT_LANGUAGES_COOKIE}=`))
    ?.slice(CONTENT_LANGUAGES_COOKIE.length + 1);
  return storedContentLanguages(value);
}

/** Forget what was read, after the writer changes their languages in Settings. */
export function forgetReadingLanguages() { reads.clear(); }

/** The writer's reading languages, first choice first; empty until known or when they keep none. */
export function useReadingLanguages(actingSubject: string | null | undefined): readonly string[] {
  const [languages, setLanguages] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!actingSubject) { setLanguages([]); return; }
    let current = true;
    setLanguages(cookieLanguages());
    void read(actingSubject).then(saved => { if (current && saved) setLanguages(saved); });
    return () => { current = false; };
  }, [actingSubject]);
  return languages;
}
