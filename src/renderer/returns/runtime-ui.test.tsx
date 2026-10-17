// @vitest-environment jsdom
/// <reference types="node" />
import process from "node:process";
import { createCommerceClient } from "@shifted/clothing-commerce-sdk";
import {
  cleanup,
  configure,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../shell/i18n";
import { ReturnDesk } from "./ReturnDesk";
import { ReturnService } from "../../main/returns/service";
import { ReturnStore } from "../../main/returns/store";
import { makeHarness, type OfflineHarness } from "../../../tests/offline/fixtures";

function render(ui: ReactElement, options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: I18nProvider, ...options });
}

let local: OfflineHarness | undefined;
afterEach(() => {
  cleanup();
  local?.dispose();
  local = undefined;
});
configure({ asyncUtilTimeout: 15000 });
const url = process.env.POS_RETURNS_TEST_URL;
describe.skipIf(!url)("return screen with real API", () => {
  it("looks up a real sale, accepts a return, shows canonical money, records cash and disables offline submission", async () => {
    const sdk = createCommerceClient({
      baseUrl: url!,
      getToken: () => process.env.POS_RETURNS_TEST_TOKEN,
      client: { type: "pos-desktop", version: "0.1.0" },
    });
    const client = sdk.withTenant("2a000001-0000-4000-8000-000000000001");
    const register = (await client.getPosContext()).registers.find(
      (item) => item.registerId === "2a000005-0000-4000-8000-000000000001",
    )!;
    const sale = await client.createPosSale({
      registerId: register.registerId,
      lines: [{ variantId: "2a000007-0000-4000-8000-000000000001", quantity: 2 }],
      expectedTotalMinor: 5000,
      cashReceivedMinor: 5000,
      idempotencyKey: crypto.randomUUID(),
    });
    render(
      <ReturnDesk
        client={client}
        health={sdk.getHealth}
        register={register}
        onLocked={vi.fn()}
        getToken={async () => process.env.POS_RETURNS_TEST_TOKEN ?? null}
        bridge={new ReturnService(new ReturnStore((local = makeHarness()).database), url!)}
      />,
    );
    await screen.findByText("Connected · Returns available");
    await waitFor(() =>
      expect(
        (screen.getByText("Load connected orders").closest("fieldset") as HTMLFieldSetElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByText("Load connected orders"));
    const orderButton = await screen.findByText(new RegExp(`^Order ${sale.order.orderNumber} ·`));
    await waitFor(() =>
      expect((orderButton.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false),
    );
    fireEvent.click(orderButton);
    const line = await screen.findByLabelText(
      `${sale.order.lines[0].productName} · ${sale.order.lines[0].sku}`,
    );
    await waitFor(() =>
      expect((line.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false),
    );
    fireEvent.click(line);
    fireEvent.change(screen.getByLabelText("Reason for line 1"), {
      target: { value: "Runtime size check" },
    });
    fireEvent.change(screen.getByLabelText("Disposition for line 1"), {
      target: { value: "restock" },
    });
    fireEvent.click(screen.getByText("Review return"));
    fireEvent(window, new Event("offline"));
    expect((screen.getByText("Confirm return") as HTMLButtonElement).disabled).toBe(true);
    expect((await client.listReturns(sale.order.id)).items).toHaveLength(0);
    fireEvent(window, new Event("online"));
    await waitFor(() =>
      expect((screen.getByText("Confirm return") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText("Confirm return"));
    await screen.findByText(/Refund:.*25\.00.*pending/);
    // The create operation stays pending until its post-acknowledgement order/eligibility refresh
    // settles, which disables the settlement controls. Wait for that to clear before recording cash.
    const referenceInput = screen.getByLabelText("Settlement reference") as HTMLInputElement;
    await waitFor(() => expect(referenceInput.disabled).toBe(false));
    fireEvent.change(referenceInput, { target: { value: "Disposable UI cash attestation" } });
    fireEvent.click(screen.getByLabelText("I have handed back the displayed cash amount."));
    const settleButton = screen.getByText("Record cash refund", {
      selector: "button",
    }) as HTMLButtonElement;
    await waitFor(() => expect(settleButton.disabled).toBe(false));
    fireEvent.click(settleButton);
    await screen.findByText(/Refund:.*25\.00.*succeeded/);
    const returns = await client.listReturns(sale.order.id);
    expect(returns.items).toHaveLength(1);
    expect(returns.items[0].refund.status).toBe("succeeded");
    expect(document.body.textContent).not.toContain(returns.items[0].id);
  });
});
