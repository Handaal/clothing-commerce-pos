import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ActivityEvent, ActivityEventInput, ActivityListQuery } from "../../shared/activity";

// Hard cap on retained events. The ledger is unbounded in principle (every click is recorded), so it
// is trimmed to the most recent N rows. The cap is generous enough to cover a long shift history while
// keeping the table small and the database healthy.
const MAX_RETAINED_EVENTS = 50_000;
// Trimming scans the whole table, so it runs only once every TRIM_INTERVAL appends rather than on each.
const TRIM_INTERVAL = 250;

interface ActivityRow {
  id: number;
  eventId: string;
  occurredAt: string;
  actorId: string | null;
  actorName: string | null;
  tenantId: string | null;
  section: string | null;
  category: string;
  action: string;
  description: string;
  severity: string;
  detailsJson: string | null;
}

export class ActivityStore {
  private appendsSinceTrim = 0;

  constructor(private readonly connection: DatabaseSync) {}

  append(input: ActivityEventInput): void {
    const eventId = randomUUID();
    this.connection
      .prepare(
        `INSERT INTO activity_log
           (event_id, occurred_at, actor_id, actor_name, tenant_id, section, category, action, description, severity, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        input.occurredAt,
        input.actorId,
        input.actorName,
        input.tenantId,
        input.section,
        input.category,
        input.action,
        input.description,
        input.severity,
        input.details != null ? JSON.stringify(input.details) : null,
      );
    if (++this.appendsSinceTrim >= TRIM_INTERVAL) {
      this.trim();
      this.appendsSinceTrim = 0;
    }
  }

  list(query: ActivityListQuery): ActivityEvent[] {
    const where: string[] = [];
    const params: string[] = [];
    if (query.from) {
      where.push("occurred_at >= ?");
      params.push(query.from);
    }
    if (query.to) {
      // A plain date bound (YYYY-MM-DD) includes the whole day; an explicit instant is used verbatim.
      where.push("occurred_at <= ?");
      params.push(query.to.length === 10 ? `${query.to}T23:59:59.999Z` : query.to);
    }
    if (query.severity) {
      where.push("severity = ?");
      params.push(query.severity);
    }
    if (query.category) {
      where.push("category = ?");
      params.push(query.category);
    }
    if (query.search) {
      where.push(
        "(description LIKE ? OR action LIKE ? OR actor_name LIKE ? OR details_json LIKE ?)",
      );
      const needle = `%${query.search}%`;
      params.push(needle, needle, needle, needle);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(query.limit ?? 500, 1), 5_000);
    const rows = this.connection
      .prepare(
        `SELECT rowid AS id, event_id AS eventId, occurred_at AS occurredAt, actor_id AS actorId,
                actor_name AS actorName, tenant_id AS tenantId, section, category, action,
                description, severity, details_json AS detailsJson
         FROM activity_log
         ${clause}
         ORDER BY occurred_at DESC, rowid DESC
         LIMIT ${limit}`,
      )
      .all(...params) as unknown as ActivityRow[];
    return rows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      occurredAt: row.occurredAt,
      actorId: row.actorId,
      actorName: row.actorName,
      tenantId: row.tenantId,
      section: row.section,
      category: row.category as ActivityEvent["category"],
      action: row.action,
      description: row.description,
      severity: row.severity as ActivityEvent["severity"],
      details: row.detailsJson ? (safeParse(row.detailsJson) ?? null) : null,
    }));
  }

  private trim(): void {
    this.connection
      .prepare(
        `DELETE FROM activity_log
         WHERE rowid NOT IN (
           SELECT rowid FROM activity_log ORDER BY rowid DESC LIMIT ?
         )`,
      )
      .run(MAX_RETAINED_EVENTS);
  }
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
