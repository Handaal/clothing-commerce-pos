import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { assertReturnSender, registerReturnIpc } from "../../src/main/returns/ipc";
import type { ReturnsBridge } from "../../src/shared/returns";

const handle = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ ipcMain: { handle } }));
const origin = "http://127.0.0.1:4173/index.html";
function event(url = origin, child = false): IpcMainInvokeEvent {
  const frame = { url };
  return {
    senderFrame: frame,
    sender: { mainFrame: child ? { url } : frame },
  } as unknown as IpcMainInvokeEvent;
}
describe("connected return IPC", () => {
  it("accepts only the trusted top frame", () => {
    expect(() => assertReturnSender(event(), origin)).not.toThrow();
    expect(() => assertReturnSender(event("https://example.com"), origin)).toThrow();
    expect(() => assertReturnSender(event(origin, true), origin)).toThrow();
    expect(() =>
      assertReturnSender({ senderFrame: null } as unknown as IpcMainInvokeEvent, origin),
    ).toThrow();
  });
  it("registers six named operations and rejects untrusted callers before resolving persistence", () => {
    handle.mockClear();
    const resolve = vi.fn<() => ReturnsBridge>();
    registerReturnIpc(resolve, origin);
    expect(handle.mock.calls.map((call) => call[0])).toEqual([
      "returns:has-pending",
      "returns:inspect",
      "returns:start",
      "returns:recover",
      "returns:settle",
      "returns:finish",
    ]);
    for (const call of handle.mock.calls)
      expect(() => call[1](event("https://example.com"))).toThrow();
    expect(resolve).not.toHaveBeenCalled();
  });
});
