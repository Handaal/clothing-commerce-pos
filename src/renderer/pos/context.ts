import type { PosContextResponse } from "@shifted/clothing-commerce-sdk";

export type PosRegister = PosContextResponse["registers"][number];

export type RegisterResolution =
  | { kind: "none" }
  | { kind: "selected"; registers: readonly PosRegister[]; registerId: string }
  | { kind: "choose"; registers: readonly PosRegister[] };

export function resolveRegisters(context: PosContextResponse): RegisterResolution {
  const registers = context.registers.filter((register) => register.canSell);
  if (registers.length === 0) return { kind: "none" };
  if (registers.length === 1) {
    return { kind: "selected", registers, registerId: registers[0].registerId };
  }
  return { kind: "choose", registers };
}
