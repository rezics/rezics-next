import { NextResponse } from 'next/server';

/** The framework parses Set-Cookie attributes; expired cookies may omit a
 * value, while cookies().set must receive the explicit empty value. */
export function authCookies(headers: Headers) {
  return new NextResponse(null, { headers }).cookies.getAll().map((cookie) => ({
    ...cookie,
    value: cookie.value ?? '',
  }));
}
