import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

// Bilingual shell strings. The cashier's own interior copy is translated in a later phase; this
// covers the navigation shell, section scaffolds, and global chrome so the app frame is fully
// localized and direction-aware from the start.
export type Lang = "en" | "ar";

type Dict = Record<string, string>;

const EN: Dict = {
  "app.name": "Commerce POS",
  "app.tagline": "Retail workspace",
  "nav.pos": "Point of Sale",
  "nav.orders": "Orders",
  "nav.inventory": "Inventory",
  "nav.customers": "Customers",
  "nav.reports": "Reports",
  "nav.vouchers": "Vouchers",
  "nav.suppliers": "Suppliers",
  "nav.staff": "Staff",
  "nav.activity": "Activity log",
  "nav.settings": "Settings",
  "nav.signOut": "Sign out",
  "chrome.theme.toDark": "Dark mode",
  "chrome.theme.toLight": "Light mode",
  "chrome.language": "العربية",
  "section.comingSoon": "Coming soon",
  "section.orders.desc":
    "Browse every order by number — items, totals, receipt, customer, and returns.",
  "section.inventory.desc":
    "Manage stock across storage units, create storage, and add or edit products.",
  "section.customers.desc": "Customer directory with profiles, purchase history, and totals.",
  "section.reports.desc": "Rich analytics and reports across the whole business.",
  "section.vouchers.desc": "Create and manage vouchers and discounts.",
  "section.suppliers.desc": "Manage suppliers, purchases, and supplier profiles.",
  "section.staff.desc": "Manage staff, attendance, worked hours, and payroll.",
  "section.activity.desc": "Every action on the system with who, when, and what.",
  "section.settings.desc": "Configure the system to fit how this business runs.",
};

const AR: Dict = {
  "app.name": "نقطة البيع",
  "app.tagline": "مساحة عمل المتجر",
  "nav.pos": "نقطة البيع",
  "nav.orders": "الطلبات",
  "nav.inventory": "المخزون",
  "nav.customers": "العملاء",
  "nav.reports": "التقارير",
  "nav.vouchers": "القسائم",
  "nav.suppliers": "الموردون",
  "nav.staff": "الموظفون",
  "nav.activity": "سجل النشاط",
  "nav.settings": "الإعدادات",
  "nav.signOut": "تسجيل الخروج",
  "chrome.theme.toDark": "الوضع الداكن",
  "chrome.theme.toLight": "الوضع الفاتح",
  "chrome.language": "English",
  "section.comingSoon": "قريبًا",
  "section.orders.desc": "تصفح كل طلب برقمه — الأصناف، الإجمالي، الإيصال، العميل، والمرتجعات.",
  "section.inventory.desc":
    "إدارة المخزون عبر وحدات التخزين، وإنشاء تخزين، وإضافة أو تعديل المنتجات.",
  "section.customers.desc": "دليل العملاء مع الملفات، وسجل الشراء، والإجماليات.",
  "section.reports.desc": "تحليلات وتقارير غنية عبر النشاط بالكامل.",
  "section.vouchers.desc": "إنشاء وإدارة القسائم والخصومات.",
  "section.suppliers.desc": "إدارة الموردين والمشتريات وملفات الموردين.",
  "section.staff.desc": "إدارة الموظفين والحضور وساعات العمل والرواتب.",
  "section.activity.desc": "كل إجراء على النظام مع مَن ومتى وماذا.",
  "section.settings.desc": "اضبط النظام ليناسب طريقة عمل هذا النشاط.",
};

const DICTS: Record<Lang, Dict> = { en: EN, ar: AR };

interface I18nValue {
  lang: Lang;
  dir: "ltr" | "rtl";
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);
const STORAGE_KEY = "pos.lang";

function initialLang(): Lang {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "ar" ? "ar" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const dir = lang === "ar" ? "rtl" : "ltr";

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
    window.localStorage.setItem(STORAGE_KEY, lang);
  }, [lang, dir]);

  const setLang = useCallback((next: Lang) => setLangState(next), []);
  const toggleLang = useCallback(() => setLangState((l) => (l === "en" ? "ar" : "en")), []);
  const t = useCallback((key: string) => DICTS[lang][key] ?? DICTS.en[key] ?? key, [lang]);

  const value = useMemo<I18nValue>(
    () => ({ lang, dir, setLang, toggleLang, t }),
    [lang, dir, setLang, toggleLang, t],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used within I18nProvider");
  return value;
}

export function useT(): (key: string) => string {
  return useI18n().t;
}
