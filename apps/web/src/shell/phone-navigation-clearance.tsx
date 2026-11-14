import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Measures this shell's chrome so wrapped labels never cover navigation or reading controls. */
export function PhoneNavigationClearance({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = root.current!;
    const navigation = element.querySelector<HTMLElement>('[data-phone-navigation]')!;
    const header = element.querySelector<HTMLElement>('[data-shell-header]')!;
    const phone = window.matchMedia('(max-width: 767px)');
    const standalone = window.matchMedia('(display-mode: standalone)');
    let previousNavigation = '';
    let previousHeader = '';
    const update = () => {
      const browserStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
      const isStandalone = standalone.matches || browserStandalone;
      const navigationHeight =
        !phone.matches || isStandalone ? '0px' : `${Math.ceil(navigation.getBoundingClientRect().height)}px`;
      const headerHeight = `${Math.ceil(header.getBoundingClientRect().height)}px`;
      if (isStandalone) element.dataset.standalone = 'true';
      else delete element.dataset.standalone;
      if (navigationHeight !== previousNavigation) {
        previousNavigation = navigationHeight;
        element.style.setProperty('--bottom-nav-height', navigationHeight);
      }
      if (headerHeight !== previousHeader) {
        previousHeader = headerHeight;
        element.style.setProperty('--shell-header-height', headerHeight);
      }
    };

    const observer = new ResizeObserver(update);
    observer.observe(navigation);
    observer.observe(header);
    phone.addEventListener('change', update);
    standalone.addEventListener('change', update);
    update();

    return () => {
      observer.disconnect();
      phone.removeEventListener('change', update);
      standalone.removeEventListener('change', update);
      element.style.removeProperty('--bottom-nav-height');
      element.style.removeProperty('--shell-header-height');
      delete element.dataset.standalone;
    };
  }, []);

  return (
    <div
      ref={root}
      data-phone-navigation-clearance
      className="contents [--shell-header-height:7.5rem] lg:[--shell-header-height:4rem]"
    >
      {children}
    </div>
  );
}
