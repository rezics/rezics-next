import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import type { UiLocale } from '../../i18n/resources.ts';
import type { shell as EnglishShell } from '../../i18n/en.ts';

export function SiteHeader({ authenticated, locale, messages }: { authenticated: boolean;
  locale: UiLocale; messages: typeof EnglishShell }) {
  return <header className="site-header"><div className="page-width site-header__inner">
    <a className="wordmark" href="/" aria-label={messages.home}>REZICS</a>
    <form className="header-search" action="/search" method="get" role="search">
      <Input name="q" type="search" placeholder={messages.searchPlaceholder} aria-label={messages.searchLabel}
        minLength={2} maxLength={80} />
      <Button type="submit">{messages.search}</Button>
    </form>
    <nav className="header-actions" aria-label={messages.navigation}>
      <a href="/studio">{messages.studio}</a><span className="header-divider" aria-hidden="true" />
      <a href={authenticated ? '/identity?next=/studio' : '/sign-in'}>
        {authenticated ? messages.identity : messages.signIn}</a>
    </nav>
    <form className="locale-switch" method="post" action="/locale/select"
      aria-label={messages.language}>
      <button type="submit" name="locale" value="en" aria-pressed={locale === 'en'}
        lang="en">EN</button>
      <button type="submit" name="locale" value="zh-CN" aria-pressed={locale === 'zh-CN'}
        lang="zh-CN">简体中文</button>
    </form>
  </div></header>;
}
