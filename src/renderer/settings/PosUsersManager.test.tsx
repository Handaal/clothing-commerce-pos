// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TenantCommerceClient } from "@shifted/clothing-commerce-sdk";

import { I18nProvider } from "../shell/i18n";
import { PosUsersManager } from "./PosUsersManager";

// These tests pin down the offline-PIN wiring in PosUsersManager.save(): one PIN entered in the Team
// desk must be provisioned for BOTH online sign-in and offline unlock. The screen is normally reached
// only after owner provisioning + a live API, so it is exercised here directly against a mock SDK
// client. The app defaults to Arabic, so the form is driven through stable DOM attributes and the
// assertions read the mock calls / notice classes rather than localized copy.

// A role carrying a `pos.*` permission (so pickRole selects it) and a tenant-mode scope (pickScope).
const ROLES = { items: [{ roleId: "role_1", roleName: "POS", permissionKeys: ["pos.sell"] }] };
const SCOPES = { items: [{ accessScopeId: "scope_1", scopeName: "All", scopeMode: "tenant" }] };

function makeClient(overrides: Record<string, unknown> = {}) {
  const base = {
    listPosLogins: vi.fn().mockResolvedValue({ items: [] }),
    listAssignableStaffRoles: vi.fn().mockResolvedValue(ROLES),
    listAssignableStaffScopes: vi.fn().mockResolvedValue(SCOPES),
    createPosLogin: vi.fn().mockResolvedValue({ membershipId: "mem_new" }),
    updatePosLogin: vi.fn().mockResolvedValue({ membershipId: "mem_1" }),
    setPosLoginPin: vi.fn().mockResolvedValue({ membershipId: "mem_1" }),
    setStaffOfflinePin: vi.fn().mockResolvedValue({ membershipId: "mem_new", keyVersion: 1 }),
    updateStaffStatus: vi.fn().mockResolvedValue({ membershipId: "mem_1" }),
    ...overrides,
  };
  return base as unknown as TenantCommerceClient & typeof base;
}

const EXISTING_USER = {
  membershipId: "mem_1",
  username: "dana",
  displayName: "Dana",
  posRole: "cashier",
  status: "active",
  posPermissions: ["inventory"],
};

function renderManager(client: TenantCommerceClient) {
  return render(
    <I18nProvider>
      <PosUsersManager client={client} operator={null} />
    </I18nProvider>,
  );
}

async function openCreateForm(container: HTMLElement) {
  // Wait for the initial server read to resolve, then open the draft form via the header "add" button.
  await waitFor(() => expect(container.querySelector(".staff-card__head button")).not.toBeNull());
  fireEvent.click(container.querySelector(".staff-card__head button") as HTMLButtonElement);
  return container.querySelector("form") as HTMLFormElement;
}

function fillText(form: HTMLFormElement, name: string, username: string) {
  const textInputs = Array.from(form.querySelectorAll("input")).filter(
    (input) => input.type !== "checkbox" && input.inputMode !== "numeric",
  );
  fireEvent.change(textInputs[0], { target: { value: name } });
  if (username !== "") fireEvent.change(textInputs[1], { target: { value: username } });
}

function fillPin(form: HTMLFormElement, pin: string) {
  fireEvent.change(form.querySelector('input[inputmode="numeric"]') as HTMLInputElement, {
    target: { value: pin },
  });
}

afterEach(cleanup);

// Offline PIN v2: server-sealed (manager-set) offline PINs are retired. Creating a POS login or changing its PIN
// must NEVER send the PIN to the offline-PIN endpoint; each person enrols their own offline PIN on the till.
describe("PosUsersManager — no server-side offline PIN provisioning (v2)", () => {
  it("never sends the PIN to the retired offline-PIN endpoint on create, and notes self-enrollment", async () => {
    const client = makeClient();
    const { container } = renderManager(client);
    const form = await openCreateForm(container);
    fillText(form, "Omar", "omar");
    fillPin(form, "1234");
    fireEvent.submit(form);
    await waitFor(() => expect(client.createPosLogin).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector(".notice--warning")).not.toBeNull());
    expect(container.querySelector(".notice--warning")!.textContent).toContain(
      "enrols their own offline PIN",
    );
    expect(container.querySelector(".notice--error")).toBeNull();
    expect(client.setStaffOfflinePin).not.toHaveBeenCalled();
  });

  it("never sends a changed PIN to the retired offline-PIN endpoint on edit", async () => {
    const client = makeClient({
      listPosLogins: vi.fn().mockResolvedValue({ items: [EXISTING_USER] }),
    });
    const { container } = renderManager(client);
    await waitFor(() => expect(container.querySelector(".staff-table button")).not.toBeNull());
    fireEvent.click(container.querySelector(".staff-table button") as HTMLButtonElement);
    const form = container.querySelector("form") as HTMLFormElement;
    fillPin(form, "5678");
    fireEvent.submit(form);
    await waitFor(() => expect(client.setPosLoginPin).toHaveBeenCalledTimes(1));
    expect(client.setStaffOfflinePin).not.toHaveBeenCalled();
  });
});
