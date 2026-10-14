import type { ReactNode } from "react";

// Minimal, consistent line icons for the navigation shell. Each is a 24x24 stroke glyph that
// inherits `currentColor`, so sidebar active/inactive and theme colors drive their appearance.
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const Icons = {
  pos: () => (
    <Svg>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M7 20h10M9 16v4M15 16v4" />
    </Svg>
  ),
  orders: () => (
    <Svg>
      <path d="M6 2h9l3 3v17H6zM9 2v4" />
      <path d="M9 11h6M9 15h6" />
    </Svg>
  ),
  inventory: () => (
    <Svg>
      <path d="M3 7l9-4 9 4-9 4-9-4z" />
      <path d="M3 7v10l9 4 9-4V7M12 11v10" />
    </Svg>
  ),
  customers: () => (
    <Svg>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3 3-5 6-5s6 2 6 5M17 11a3 3 0 100-6M21 20c0-2-1-3.5-3-4.3" />
    </Svg>
  ),
  reports: () => (
    <Svg>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </Svg>
  ),
  vouchers: () => (
    <Svg>
      <path d="M3 8a2 2 0 012-2h14a2 2 0 012 2v2a2 2 0 000 4v2a2 2 0 01-2 2H5a2 2 0 01-2-2v-2a2 2 0 000-4z" />
      <path d="M12 6v12" strokeDasharray="2 2" />
    </Svg>
  ),
  suppliers: () => (
    <Svg>
      <path d="M1 6h13v9H1zM14 9h4l3 3v3h-7z" />
      <circle cx="5.5" cy="18" r="1.6" />
      <circle cx="17.5" cy="18" r="1.6" />
    </Svg>
  ),
  staff: () => (
    <Svg>
      <circle cx="12" cy="7" r="3.2" />
      <path d="M5 21c0-3.5 3-6 7-6s7 2.5 7 6" />
    </Svg>
  ),
  activity: () => (
    <Svg>
      <path d="M3 12h4l2 6 4-14 2 8h6" />
    </Svg>
  ),
  settings: () => (
    <Svg>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
    </Svg>
  ),
  sun: () => (
    <Svg>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
    </Svg>
  ),
  moon: () => (
    <Svg>
      <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
    </Svg>
  ),
  globe: () => (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </Svg>
  ),
  logout: () => (
    <Svg>
      <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />
    </Svg>
  ),
  edit: () => (
    <Svg>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M14 6l4 4" />
    </Svg>
  ),
  receive: () => (
    <Svg>
      <path d="M12 3v10M8 9l4 4 4-4" />
      <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
    </Svg>
  ),
  adjust: () => (
    <Svg>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="2.2" />
      <circle cx="15" cy="17" r="2.2" />
    </Svg>
  ),
  transfer: () => (
    <Svg>
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </Svg>
  ),
  trash: () => (
    <Svg>
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
    </Svg>
  ),
  eye: () => (
    <Svg>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
  plus: () => (
    <Svg>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
} as const;

export type IconName = keyof typeof Icons;
