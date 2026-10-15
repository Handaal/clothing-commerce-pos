import type { ActivityCategory, ActivityEventInput, ActivitySeverity } from "../../shared/activity";

// Renderer-side activity capture. A small ambient context (who is signed in, which tenant, which
// section is open) is kept here and stamped onto every recorded event, so individual call sites only
// need to describe *what* happened. Writes go through the preload `window.activity` bridge and are
// fire-and-forget: a dropped audit line must never interrupt the cashier.

interface AmbientContext {
  actorId: string | null;
  actorName: string | null;
  tenantId: string | null;
  section: string | null;
}

const ambient: AmbientContext = {
  actorId: null,
  actorName: null,
  tenantId: null,
  section: null,
};

export function setActivityActor(actor: { id: string | null; name: string | null }): void {
  ambient.actorId = actor.id;
  ambient.actorName = actor.name;
}

export function setActivityTenant(tenantId: string | null): void {
  ambient.tenantId = tenantId;
}

export function setActivitySection(section: string | null): void {
  ambient.section = section;
}

function bridge() {
  return typeof window === "undefined" ? undefined : window.activity;
}

export interface LogInput {
  category: ActivityCategory;
  action: string;
  description: string;
  severity?: ActivitySeverity;
  details?: Record<string, unknown> | null;
}

export function logActivity(input: LogInput): void {
  const api = bridge();
  if (!api) return;
  const event: ActivityEventInput = {
    occurredAt: new Date().toISOString(),
    actorId: ambient.actorId,
    actorName: ambient.actorName,
    tenantId: ambient.tenantId,
    section: ambient.section,
    category: input.category,
    action: input.action,
    description: input.description,
    severity: input.severity ?? "info",
    details: input.details ?? null,
  };
  void api.append(event).catch(() => {
    // Best-effort: ignore persistence failures.
  });
}

const MAX_LABEL_LENGTH = 80;

function truncate(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_LABEL_LENGTH
    ? `${collapsed.slice(0, MAX_LABEL_LENGTH - 1)}…`
    : collapsed;
}

interface TargetDescription {
  label: string;
  role: string;
}

// Climb from the clicked node to the nearest meaningful control and describe it richly: its visible
// text or accessible label, and what kind of control it is. Falls back to the raw element so even a
// click on plain layout is recorded with *some* context.
function describeTarget(start: EventTarget | null): TargetDescription | null {
  let node = start instanceof Element ? start : null;
  while (node && node !== document.body && node !== document.documentElement) {
    const tag = node.tagName.toLowerCase();
    const role = node.getAttribute("role");
    const aria = node.getAttribute("aria-label");
    if (tag === "button" || role === "button" || node.classList.contains("shell-nav__item")) {
      return { label: truncate(aria ?? node.textContent ?? "button"), role: "button" };
    }
    if (tag === "a") {
      return { label: truncate(aria ?? node.textContent ?? "link"), role: "link" };
    }
    if (tag === "select") {
      return {
        label: truncate(aria ?? labelFor(node) ?? node.getAttribute("name") ?? "dropdown"),
        role: "dropdown",
      };
    }
    if (tag === "input" || tag === "textarea") {
      const type = node.getAttribute("type") ?? "text";
      const label =
        aria ??
        labelFor(node) ??
        node.getAttribute("name") ??
        node.getAttribute("placeholder") ??
        type;
      return {
        label: truncate(label),
        role: type === "checkbox" || type === "radio" ? type : "field",
      };
    }
    node = node.parentElement;
  }
  const fallback = start instanceof Element ? start.textContent : null;
  if (fallback && fallback.trim().length > 0) {
    return {
      label: truncate(fallback),
      role: start instanceof Element ? start.tagName.toLowerCase() : "element",
    };
  }
  return null;
}

// Resolve the visible label text associated with a form control (wrapping <label> or for= target).
function labelFor(node: Element): string | null {
  const id = node.getAttribute("id");
  if (id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (explicit?.textContent) return explicit.textContent;
  }
  const wrapping = node.closest("label");
  if (wrapping?.textContent) return wrapping.textContent;
  return null;
}

let clickCaptureInstalled = false;

// Capture every click on the window. Runs in the capture phase so it sees the event regardless of
// stopPropagation in component handlers. Human click rates are low, so one audit line per click is
// comfortably within budget.
export function installActivityClickCapture(): void {
  if (clickCaptureInstalled || typeof window === "undefined") return;
  clickCaptureInstalled = true;
  window.addEventListener(
    "click",
    (event) => {
      const target = describeTarget(event.target);
      if (!target) return;
      logActivity({
        category: "interaction",
        action: "click",
        description: `Clicked ${target.role} "${target.label}"`,
        details: { role: target.role, label: target.label },
      });
    },
    { capture: true },
  );
}
