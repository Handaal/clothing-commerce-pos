import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { isAllowedRendererNavigation } from "../renderer-origin";
import type { ReturnsBridge } from "../../shared/returns";
import { boundedText, parseReturnIntent, parseReturnSession, uuid } from "./input";

export function assertReturnSender(event: IpcMainInvokeEvent, rendererUrl: string): void {
  if (
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    !isAllowedRendererNavigation(event.senderFrame.url, rendererUrl)
  )
    throw new Error("Return IPC rejected an untrusted frame.");
}
export function registerReturnIpc(resolve: () => ReturnsBridge, rendererUrl: string): void {
  const handle = (name: string, operation: (...args: unknown[]) => unknown) =>
    ipcMain.handle(name, (event, ...args) => {
      assertReturnSender(event, rendererUrl);
      return operation(...args);
    });
  handle("returns:has-pending", () => resolve().hasPending());
  handle("returns:inspect", (session) => resolve().inspect(parseReturnSession(session)));
  handle("returns:start", (session, intent) =>
    resolve().start(parseReturnSession(session), parseReturnIntent(intent)),
  );
  handle("returns:recover", (session) => resolve().recover(parseReturnSession(session)));
  handle("returns:settle", (session, id, reference) =>
    resolve().settle(parseReturnSession(session), uuid(id), boundedText(reference)),
  );
  handle("returns:finish", (session, id) =>
    resolve().finish(parseReturnSession(session), uuid(id)),
  );
}
