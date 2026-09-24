import type { ReactNode } from 'react';
import { SiteHeader } from '../features/shell/site-header.tsx';
import './styles.css';

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><head><meta charSet="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>REZICS</title></head><body><SiteHeader />{children}</body></html>;
}
