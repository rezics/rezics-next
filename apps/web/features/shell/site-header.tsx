import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';

export function SiteHeader({ authenticated }: { authenticated: boolean }) {
  return <header className="site-header"><div className="page-width site-header__inner">
    <a className="wordmark" href="/" aria-label="REZICS home">REZICS</a>
    <form className="header-search" action="/search" method="get" role="search">
      <Input name="q" type="search" placeholder="Search works…" aria-label="Search works" minLength={2} maxLength={80} />
      <Button type="submit">Search</Button>
    </form>
    <nav className="header-actions" aria-label="Main navigation">
      <a href="/studio">Studio</a><span className="header-divider" aria-hidden="true" />
      <a href={authenticated ? '/identity?next=/studio' : '/sign-in'}>
        {authenticated ? 'Identity' : 'Sign in'}</a>
    </nav>
  </div></header>;
}
