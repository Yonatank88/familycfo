import {
  Baby, Banknote, BookOpen, Briefcase, Car, CircleDollarSign, Coffee, CreditCard, Dumbbell, Fuel, Gift, GraduationCap,
  HandCoins, HeartPulse, Home, Landmark, Laptop, Lightbulb, type LucideIcon, Package, PawPrint, Pill, PiggyBank, Plane,
  Receipt, Repeat, Scissors, Shield, Shirt, ShoppingBasket, ShoppingCart, Smartphone, Sparkles, Tag, Ticket, TrainFront,
  TrendingUp, Tv, Utensils, Wallet, Wifi, Wrench, Zap,
} from 'lucide-react';

/**
 * A recognisable icon for a category from its (Hebrew or English) name. Purely visual — the
 * category itself is unchanged; unknown names get a neutral tag.
 */
const CATEGORY_ICONS: [RegExp, LucideIcon][] = [
  [/סופר|מכולת|מזון|grocer/i, ShoppingBasket],
  [/מסעד|בתי קפה|קפה|אוכל בחוץ|משלוח|food|restaurant/i, Utensils],
  [/קפה|coffee/i, Coffee],
  [/דלק|fuel|gas station/i, Fuel],
  [/רכב|חניה|חניון|טסט|car|parking/i, Car],
  [/תחבורה|רכבת|אוטובוס|מונית|transport/i, TrainFront],
  [/משכנת|דירה|שכירות|ארנונה|ועד בית|בית|mortgage|rent|home/i, Home],
  [/הלווא|loan/i, Landmark],
  [/חשמל|electric/i, Zap],
  [/מים|גז|water/i, Lightbulb],
  [/תקשורת|סלולר|טלפון|phone|mobile/i, Smartphone],
  [/אינטרנט|internet|wifi/i, Wifi],
  [/מנוי|סטרימינג|streaming|subscription|דיגיטלי/i, Tv],
  [/ביטוח|insurance/i, Shield],
  [/בריאות|רופא|קופ[תה] חולים|health|medical/i, HeartPulse],
  [/פארם|תרופ|pharm/i, Pill],
  [/חינוך|גן|בית ספר|צהרון|school|kindergarten/i, GraduationCap],
  [/חוג|ספורט|כושר|טניס|sport|gym|fitness/i, Dumbbell],
  [/ילד|תינוק|baby|kids/i, Baby],
  [/ביגוד|הנעלה|אופנה|cloth|fashion/i, Shirt],
  [/קוסמטיק|טיפוח|מספר|beauty|hair/i, Scissors],
  [/חופש|טיס|נופש|מלון|travel|flight|hotel/i, Plane],
  [/בילוי|פנאי|תרבות|קולנוע|הופע|entertain/i, Ticket],
  [/מתנ|תרומ|gift|donat/i, Gift],
  [/חיות|וטרינר|pet/i, PawPrint],
  [/אלקטרוניק|מחשב|תוכנה|software|electronic/i, Laptop],
  [/שיפוץ|תחזוק|תיקון|repair|maint/i, Wrench],
  [/ספר|לימוד|book/i, BookOpen],
  [/קניות|shopping/i, ShoppingCart],
  [/עמל|בנק|fee/i, Receipt],
  [/חיסכון|השקע|פנסי|saving|invest/i, PiggyBank],
  [/משכורת|הכנס|salary|income/i, Banknote],
  [/העבר|transfer/i, Repeat],
  [/עסק|business/i, Briefcase],
  [/משלוח|חבילה|package/i, Package],
  [/החזר|זיכוי|refund/i, HandCoins],
];

export function categoryIcon(name: string | null | undefined): LucideIcon {
  if (!name) return Tag;
  return CATEGORY_ICONS.find(([re]) => re.test(name))?.[1] ?? Tag;
}

/** Stable colour for a label (charts, avatars): one of the theme's chart hues. */
export function hueFor(key: string | number | null | undefined, offset = 0): string {
  const s = String(key ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `var(--chart-${((h + offset) % 8) + 1})`;
}

export const CHART_COLORS = Array.from({ length: 8 }, (_, i) => `var(--chart-${i + 1})`);

export const accountIcon = (kind: 'bank' | 'card' | string | undefined): LucideIcon =>
  kind === 'card' ? CreditCard : kind === 'bank' ? Landmark : Wallet;

export { CircleDollarSign, Sparkles, TrendingUp };

/** Round avatar with the member's initial, in their colour. */
export function MemberAvatar({ name, color, size = 22 }: { name: string; color?: string | null; size?: number }) {
  const c = color ?? hueFor(name);
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold leading-none text-white shadow-sm"
      style={{ width: size, height: size, fontSize: size * 0.46, background: `linear-gradient(145deg, color-mix(in oklab, ${c} 80%, white), ${c})` }}>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
