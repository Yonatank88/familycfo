import type { ReactNode, SVGProps } from 'react';

/** 24×24 stroke icons, drawn at 1.75px so they sit at the same visual weight as 14px text. */
function Svg({ children, size = 18, ...rest }: SVGProps<SVGSVGElement> & { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

type P = SVGProps<SVGSVGElement> & { size?: number };

export const IconOverview = (p: P) => <Svg {...p}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></Svg>;
export const IconTransactions = (p: P) => <Svg {...p}><path d="m16 3 4 4-4 4" /><path d="M20 7H4" /><path d="m8 21-4-4 4-4" /><path d="M4 17h16" /></Svg>;
export const IconFixed = (p: P) => <Svg {...p}><rect x="3" y="4.5" width="18" height="16.5" rx="2" /><path d="M16 2.5v4M8 2.5v4M3 10h18" /><path d="m9 15.5 2 2 4-4" /></Svg>;
export const IconBudget = (p: P) => <Svg {...p}><path d="M21.2 15.9A10 10 0 1 1 8 2.8" /><path d="M22 12A10 10 0 0 0 12 2v10z" /></Svg>;
export const IconCashflow = (p: P) => <Svg {...p}><path d="M22 7 13.5 15.5l-5-5L2 17" /><path d="M16 7h6v6" /></Svg>;
export const IconClose = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9.5" /><path d="m8.5 12 2.5 2.5 4.5-5" /></Svg>;
export const IconInsights = (p: P) => <Svg {...p}><path d="M15 14c.2-1 .7-1.7 1.5-2.5A5.5 5.5 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" /><path d="M9 18h6M10 22h4" /></Svg>;
export const IconTag = (p: P) => <Svg {...p}><path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" /><circle cx="7.5" cy="7.5" r="1" fill="currentColor" stroke="none" /></Svg>;
export const IconSavings = (p: P) => <Svg {...p}><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" /><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" /></Svg>;
export const IconCategories = (p: P) => <Svg {...p}><path d="m12 2.5 9.5 4.8L12 12 2.5 7.3z" /><path d="m2.5 16.7 9.5 4.8 9.5-4.8" /><path d="m2.5 12 9.5 4.8 9.5-4.8" /></Svg>;
export const IconSettings = (p: P) => <Svg {...p}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5" /></Svg>;
export const IconMenu = (p: P) => <Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>;
export const IconX = (p: P) => <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>;
