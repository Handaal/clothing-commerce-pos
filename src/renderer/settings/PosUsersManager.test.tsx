// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiHttpError, type TenantCommerceClient } from "@shifted/clothing-commerce-sdk";

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

describe("PosUsersManager offline-PIN provisioning", () => {
  it("provisions the offline PIN with the same PIN on create", async () => {
    const client = makeClient();
    const { container } = renderManager(client);

    const form = await openCreateForm(container);
    fillText(form, "Omar", "omar");
    fillPin(form, "1234");
    fireEvent.submit(form);

    await waitFor(() => expect(client.createPosLogin).toHaveBeenCalledTimes(1));
    expect(client.setStaffOfflinePin).toHaveBeenCalledTimes(1);
    expect(client.setStaffOfflinePin).toHaveBeenCalledWith(
      expect.objectContaining({ membershipId: "mem_new", pin: "1234" }),
    );
  });

  it("provisions the offline PIN when a new PIN is set on edit", async () => {
    const client = makeClient({
      listPosLogins: vi.fn().mockResolvedValue({ items: [EXISTING_USER] }),
    });
    const { container } = renderManager(client);

    // Row renders an Edit button first; open it, type a new PIN, save.
    await waitFor(() => expect(container.querySelector(".staff-table button")).not.toBeNull());
    fireEvent.click(container.querySelector(".staff-table button") as HTMLButtonElement);
    const form = container.querySelector("form") as HTMLFormElement;
    fillPin(form, "5678");
    fireEvent.submit(form);

    await waitFor(() => expect(client.setPosLoginPin).toHaveBeenCalledTimes(1));
    expect(client.setStaffOfflinePin).toHaveBeenCalledWith(
      expect.objectContaining({ membershipId: "mem_1", pin: "5678" }),
    );
  });

  it("does not touch the offline PIN when editing without changing the PIN", async () => {
    const client = makeClient({
      listPosLogins: vi.fn().mockResolvedValue({ items: [EXISTING_USER] }),
    });
    const { container } = renderManager(client);

    await waitFor(() => expect(container.querySelector(".staff-table button")).not.toBeNull());
    fireEvent.click(container.querySelector(".staff-table button") as HTMLButtonElement);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(client.updatePosLogin).toHaveBeenCalledTimes(1));
    expect(client.setPosLoginPin).not.toHaveBeenCalled();
    expect(client.setStaffOfflinePin).not.toHaveBeenCalled();
  });

  it("swallows the dormant-KEK case as a non-blocking note (status 503)", async () => {
    const client = makeClient({
      setStaffOfflinePin: vi
        .fn()
        .mockRejectedValue(
          new ApiHttpError("offline pin unavailable", 503, "SERVICE_UNAVAILABLE", null),
        ),
    });
    const { container } = renderManager(client);

    const form = await openCreateForm(container);
    fillText(form, "Omar", "omar");
    fillPin(form, "1234");
    fireEvent.submit(form);

    // Online login still succeeded; the form closes and a warning note shows instead of an error.
    await waitFor(() => expect(container.querySelector(".notice--warning")).not.toBeNull());
    expect(container.querySelector(".notice--error")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });

  it("swallows the dormant-KEK case by error code too", async () => {
    const client = makeClient({
      setStaffOfflinePin: vi
        .fn()
        .mockRejectedValue(
          new ApiHttpError("offline pin not configured", 400, "OFFLINE_PIN_NOT_CONFIGURED", null),
        ),
    });
    const { container } = renderManager(client);

    const form = await openCreateForm(container);
    fillText(form, "Omar", "omar");
    fillPin(form, "1234");
    fireEvent.submit(form);

    await waitFor(() => expect(container.querySelector(".notice--warning")).not.toBeNull());
    expect(container.querySelector(".notice--error")).toBeNull();
  });

  it("rethrows any other offline-PIN failure as a blocking error", async () => {
    const client = makeClient({
      setStaffOfflinePin: vi
        .fn()
        .mockRejectedValue(new ApiHttpError("boom", 500, "INTERNAL", null)),
    });
    const { container } = renderManager(client);

    const form = await openCreateForm(container);
    fillText(form, "Omar", "omar");
    fillPin(form, "1234");
    fireEvent.submit(form);

    // The create itself succeeded, but the offline failure surfaces as an error and the form stays open.
    await waitFor(() => expect(container.querySelector(".notice--error")).not.toBeNull());
    expect(container.querySelector(".notice--warning")).toBeNull();
    expect(container.querySelector("form")).not.toBeNull();
  });
});
