'use client';

import { useEffect } from 'react';

/** A router visit can render this page; only the browser follows the OAuth redirect. */
export default function StartSignIn() {
  useEffect(() => {
    window.location.replace(`/auth/authorize${window.location.search}`);
  }, []);
  return null;
}
