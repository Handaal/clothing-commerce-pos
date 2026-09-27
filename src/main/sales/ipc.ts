import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { SalesBridge } from "../../shared/sales";
import { SALES_IPC_CHANNELS } from "../../shared/sales";
import { isAllowedRendererNavigation } from "../renderer-origin";
import { parseConnectedSaleIntent, parseConnectedSaleSession } from "./input";

function boundedId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

export function assertSaleSender(event: IpcMainInvokeEvent, rendererUrl: string): void {
  if (
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    !isAllowedRendererNavigation(event.senderFrame.url, rendererUrl)
  )
    throw new Error("Connected sale IPC rejected an untrusted frame.");
}

export function registerSalesIpc(resolve: () => SalesBridge, rendererUrl: string): void {
  const handle = (name: string, operation: (...args: unknown[]) => unknown) =>
    ipcMain.handle(name, (event, ...args) => {
      assertSaleSender(event, rendererUrl);
      return operation(...args);
    });
  handle(SALES_IPC_CHANNELS.hasPending, () => resolve().hasPending());
  handle(SALES_IPC_CHANNELS.submit, (session, intent) =>
    resolve().submit(parseConnectedSaleSession(session), parseConnectedSaleIntent(intent)),
  );
  handle(SALES_IPC_CHANNELS.recover, (session) =>
    resolve().recover(parseConnectedSaleSession(session)),
  );
  handle(SALES_IPC_CHANNELS.acknowledge, (session, workflowId) =>
    resolve().acknowledge(parseConnectedSaleSession(session), boundedId(workflowId, "workflowId")),
  );
}
