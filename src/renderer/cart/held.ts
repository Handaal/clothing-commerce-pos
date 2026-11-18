import type { CartLine } from "./cart";

export interface HeldCart {
  readonly id: string;
  readonly heldAt: string;
  readonly lines: readonly CartLine[];
}

const PREFIX = "zee-held-carts-v1";

function key(registerId: string): string {
  return `${PREFIX}:${registerId}`;
}

export function listHeldCarts(registerId: string): HeldCart[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(registerId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is HeldCart =>
        typeof item === "object" &&
        item !== null &&
        typeof item.id === "string" &&
        typeof item.heldAt === "string" &&
        Array.isArray(item.lines) &&
        item.lines.every(
          (line: unknown) =>
            typeof line === "object" &&
            line !== null &&
            typeof (line as CartLine).variantId === "string" &&
            Number.isSafeInteger((line as CartLine).quantity) &&
            (line as CartLine).quantity > 0,
        ),
    );
  } catch {
    return [];
  }
}

function save(registerId: string, carts: readonly HeldCart[]): void {
  localStorage.setItem(key(registerId), JSON.stringify(carts));
}

export function holdCart(registerId: string, lines: readonly CartLine[]): HeldCart {
  if (lines.length === 0) throw new Error("The cart is empty.");
  const held: HeldCart = {
    id: crypto.randomUUID(),
    heldAt: new Date().toISOString(),
    lines: [...lines],
  };
  save(registerId, [held, ...listHeldCarts(registerId)]);
  return held;
}

export function removeHeldCart(registerId: string, id: string): void {
  save(
    registerId,
    listHeldCarts(registerId).filter((cart) => cart.id !== id),
  );
}
