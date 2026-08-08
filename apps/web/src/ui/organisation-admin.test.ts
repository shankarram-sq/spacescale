import { describe, expect, it, vi } from "vitest";
import {
  buildOrganisationAdminViewModel,
  type OrganisationAdminSnapshot,
  takeOrganisationAdminLaunch,
  validateOrganisationWebhookUrl,
} from "./organisation-admin";

const snapshot: OrganisationAdminSnapshot = {
  organisation: { id: "org-acme", name: "Acme Learning" },
  settings: {
    webhookUrl: "https://partner.example/webhooks/spacescale",
    details: [
      { key: "owners", label: "Multiple owners", value: true },
      { key: "contact", label: "Contact", value: "coach@example.com" },
    ],
  },
  boards: [
    {
      id: "b_geometry",
      name: "Geometry lesson",
      owners: [
        { displayName: "Coach Mira", identifierHash: "ownerHash_1ABCDEF" },
        { displayName: "backup@example.com", identifierHash: "ownerHash_2ABCDEF" },
      ],
      participants: [
        { displayName: "Asha Patel", identifierHash: "studentHash_1ABCDE" },
        { displayName: "child@example.com", identifierHash: "studentHash_2ABCDE" },
      ],
      viewerUrl: "https://spacescale.example/viewer#launch=signed-token",
    },
  ],
};

describe("Organisation admin launch", () => {
  it("takes an opaque signed launch token from the admin URL and removes the fragment", () => {
    const replaceState = vi.fn();
    const launch = takeOrganisationAdminLaunch(
      {
        pathname: "/organisation/admin",
        search: "?source=partner",
        hash: "#launch=el1.payload.sig",
      },
      { state: { preserved: true }, replaceState },
    );

    expect(launch).toEqual({ launchToken: "el1.payload.sig" });
    expect(replaceState).toHaveBeenCalledWith(
      { preserved: true },
      "",
      "/organisation/admin?source=partner",
    );
  });

  it("does not consume launch fragments on another route", () => {
    const replaceState = vi.fn();
    expect(
      takeOrganisationAdminLaunch(
        { pathname: "/embed", search: "", hash: "#launch=el1.payload.sig" },
        { state: null, replaceState },
      ),
    ).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe("Organisation admin privacy view model", () => {
  it("shows stable hashed hints while redacting raw email addresses", () => {
    const view = buildOrganisationAdminViewModel(snapshot, "https://spacescale.example/");
    const rendered = JSON.stringify(view);

    expect(rendered).not.toContain("coach@example.com");
    expect(rendered).not.toContain("backup@example.com");
    expect(rendered).not.toContain("child@example.com");
    expect(view.boards[0]?.owners).toEqual([
      { label: "Coach Mira", identifierHint: "#ownerHash_1ABCDE" },
      { label: "Participant ownerH", identifierHint: "#ownerHash_2ABCDE" },
    ]);
    expect(view.boards[0]?.participants[1]).toEqual({
      label: "Participant studen",
      identifierHint: "#studentHash_2ABC",
    });
    expect(view.details[1]?.displayValue).toBe("[private identifier]");
    expect(view.ownerCount).toBe(2);
    expect(view.participantCount).toBe(2);
  });

  it("keeps only HTTPS or same-origin development viewer links", () => {
    const secure = buildOrganisationAdminViewModel(snapshot, "https://spacescale.example/");
    expect(secure.boards[0]?.viewerUrl).toBe(
      "https://spacescale.example/viewer#launch=signed-token",
    );

    const board = snapshot.boards[0];
    expect(board).toBeDefined();
    if (board === undefined) throw new Error("Expected the test Space fixture.");
    const unsafe = buildOrganisationAdminViewModel(
      {
        ...snapshot,
        boards: [{ ...board, viewerUrl: "javascript:alert(1)" }],
      },
      "https://spacescale.example/",
    );
    expect(unsafe.boards[0]?.viewerUrl).toBeNull();
  });

  it("represents an Organisation with no Spaces without inventing rows", () => {
    const view = buildOrganisationAdminViewModel({ ...snapshot, boards: [] });
    expect(view.boards).toEqual([]);
    expect(view.ownerCount).toBe(0);
    expect(view.participantCount).toBe(0);
  });
});

describe("Organisation webhook form validation", () => {
  it("normalizes HTTPS URLs and uses an empty value to remove the webhook", () => {
    expect(validateOrganisationWebhookUrl("  ")).toBeNull();
    expect(validateOrganisationWebhookUrl("https://partner.example/hook")).toBe(
      "https://partner.example/hook",
    );
  });

  it("rejects non-HTTPS receivers", () => {
    expect(() => validateOrganisationWebhookUrl("http://partner.example/hook")).toThrow(
      "Webhook URLs must use HTTPS.",
    );
  });
});
