// @vitest-environment jsdom
/// <reference types="node" />
import process from "node:process";
import { createCommerceClient } from "@shifted/clothing-commerce-sdk";
import { cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReturnDesk } from "./ReturnDesk";

afterEach(cleanup);
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
      <ReturnDesk client={client} health={sdk.getHealth} register={register} onLocked={vi.fn()} />,
    );
    await screen.findByText("Connected · Returns available");
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
    fireEvent.change(screen.getByLabelText("Settlement reference"), {
      target: { value: "Disposable UI cash attestation" },
    });
    fireEvent.click(screen.getByLabelText("I have handed back the displayed cash amount."));
    fireEvent.click(screen.getByText("Record cash refund", { selector: "button" }));
    await screen.findByText(/Refund:.*25\.00.*succeeded/);
    const returns = await client.listReturns(sale.order.id);
    expect(returns.items).toHaveLength(1);
    expect(returns.items[0].refund.status).toBe("succeeded");
    expect(document.body.textContent).not.toContain(returns.items[0].id);
  });
});
