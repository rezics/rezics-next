import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Supplies one measured phone-navigation offset to fixed selection surfaces in this shell. */
export function PhoneNavigationClearance({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = root.current;
    const navigation = element?.querySelector<HTMLElement>('[data-phone-navigation]');
    if (!element || !navigation) return;

    const phone = window.matchMedia('(max-width: 767px)');
    const standalone = window.matchMedia('(display-mode: standalone)');
    let previous = '';
    const update = () => {
      const browserStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
      const isStandalone = standalone.matches || browserStandalone;
      const value =
        !phone.matches || isStandalone ? '0px' : `${Math.ceil(navigation.getBoundingClientRect().height)}px`;
      if (isStandalone) element.dataset.standalone = 'true';
      else delete element.dataset.standalone;
      if (value !== previous) {
        previous = value;
        element.style.setProperty('--bottom-nav-height', value);
      }
    };

    const observer = new ResizeObserver(update);
    observer.observe(navigation);
    phone.addEventListener('change', update);
    standalone.addEventListener('change', update);
    update();

    return () => {
      observer.disconnect();
      phone.removeEventListener('change', update);
      standalone.removeEventListener('change', update);
      element.style.removeProperty('--bottom-nav-height');
      delete element.dataset.standalone;
    };
  }, []);

  return (
    <>
      <style>{`
        [data-phone-navigation-clearance] { --bottom-nav-height: calc(5rem + env(safe-area-inset-bottom, 0px)); }
        @media (min-width: 768px), (display-mode: standalone) {
          [data-phone-navigation-clearance] { --bottom-nav-height: 0px; }
        }
        [data-phone-navigation-clearance][data-standalone] [data-phone-navigation] {
          display: none !important;
        }
        @media (display-mode: standalone) {
          [data-phone-navigation] { display: none !important; }
        }
      `}</style>
      <div ref={root} data-phone-navigation-clearance className="contents">
        {children}
      </div>
    </>
  );
}
