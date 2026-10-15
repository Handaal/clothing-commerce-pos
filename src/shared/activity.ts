// Client-only activity log contract. Every meaningful interaction on the POS — each click, every
// navigation, and the domain events around selling, returns, inventory and offline operation — is
// recorded locally with who did it, when, and a comprehensive description. There is no server audit
// endpoint; this ledger lives entirely in the local SQLite database and never leaves the device.

export type ActivitySeverity = "info" | "warning" | "alert";

// Coarse grouping so the Activity desk can filter by the kind of thing that happened.
export type ActivityCategory =
  | "interaction"
  | "navigation"
  | "session"
  | "sale"
  | "return"
  | "inventory"
  | "supplier"
  | "offline"
  | "system";

export interface ActivityActor {
  readonly id: string | null;
  readonly name: string | null;
}

// What the renderer sends for each recorded event. The main process stamps an event id.
export interface ActivityEventInput {
  readonly occurredAt: string; // ISO-8601 instant
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly tenantId: string | null;
  readonly section: string | null; // active workspace section id when the event happened
  readonly category: ActivityCategory;
  readonly action: string; // short machine key, e.g. "click", "navigate", "sale_completed"
  readonly description: string; // comprehensive human-readable sentence
  readonly severity: ActivitySeverity;
  readonly details: Record<string, unknown> | null;
}

export interface ActivityEvent extends ActivityEventInput {
  readonly id: number; // monotonic local row id (ordering tiebreaker)
  readonly eventId: string; // uuid assigned by the main process
}

export interface ActivityListQuery {
  readonly from?: string; // inclusive local date (YYYY-MM-DD) or ISO instant
  readonly to?: string; // inclusive local date (YYYY-MM-DD) or ISO instant
  readonly severity?: ActivitySeverity;
  readonly category?: ActivityCategory;
  readonly search?: string;
  readonly limit?: number;
}

export interface ActivityListResult {
  readonly items: readonly ActivityEvent[];
}

export interface ActivityBridge {
  // Fire-and-forget append. Failures never surface to the cashier; a lost audit line must not
  // interrupt selling.
  append(event: ActivityEventInput): Promise<void>;
  list(query: ActivityListQuery): Promise<ActivityListResult>;
}

export const ACTIVITY_CATEGORIES: readonly ActivityCategory[] = [
  "interaction",
  "navigation",
  "session",
  "sale",
  "return",
  "inventory",
  "supplier",
  "offline",
  "system",
];

export const ACTIVITY_SEVERITIES: readonly ActivitySeverity[] = ["info", "warning", "alert"];
