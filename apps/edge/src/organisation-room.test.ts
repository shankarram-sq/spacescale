/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_ORGANISATION_TEMPLATE_ITEMS } from "./organisation-room";
import type { Env } from "./types";

const organisationId = `o_${"A".repeat(22)}`;
const actorId = `a_${"B".repeat(21)}A`;
const collectionPath = `/__internal/organisations/${organisationId}/templates`;

afterEach(async () => reset());

function templateItem(id = "018f0000-0000-7000-8000-000000000301", z = 1) {
  return {
    id,
    kind: "sticky",
    z,
    version: 7,
    createdBy: actorId,
    style: {
      kind: "sticky",
      fill: "#fde68a",
      textColor: "#20201e",
      fontSize: 20,
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 12, 18],
    geometry: { x: 40, y: 55, width: 220, height: 160, text: "Reflect" },
  };
}

function request(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://organisation.test${path}`, {
    method,
    headers: {
      "x-whiteboard-internal-request-id": crypto.randomUUID(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("OrganisationRoom templates", () => {
  it("persists canonical templates across hibernation and deletes them", async () => {
    const stub = (env as unknown as Env).ORGANISATION_ROOMS.getByName(organisationId);
    const item = templateItem();
    const createdResponse = await stub.fetch(
      request(collectionPath, "POST", {
        name: "  Exit reflection  ",
        description: "   ",
        items: [item],
        createdBy: actorId,
      }),
    );
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
    const created = (await createdResponse.json()) as {
      id: string;
      name: string;
      description: string | null;
      items: unknown[];
      createdBy: string;
      createdAt: number;
      updatedAt: number;
    };
    expect(created).toEqual({
      id: expect.stringMatching(/^tpl_[A-Za-z0-9_-]{22}$/u),
      name: "Exit reflection",
      description: null,
      items: [item],
      createdBy: actorId,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });

    await evictDurableObject(stub);
    const listed = await stub.fetch(request(collectionPath));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([created]);
    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      migrations: durableState.storage.sql
        .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations")
        .toArray()
        .map(({ version }) => version),
      organisationId: durableState.storage.sql
        .exec<{ organisation_id: string }>("SELECT organisation_id FROM organisation")
        .one().organisation_id,
      templates: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM templates")
        .one().count,
    }));
    expect(state).toEqual({ migrations: [1], organisationId, templates: 1 });

    const deleted = await stub.fetch(request(`${collectionPath}/${created.id}`, "DELETE"));
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    const missing = await stub.fetch(request(`${collectionPath}/${created.id}`, "DELETE"));
    expect(missing.status).toBe(404);
    expect(await (await stub.fetch(request(collectionPath))).json()).toEqual([]);
  });

  it("rejects malformed, image-backed, excessive, duplicate, and cross-scope input", async () => {
    const stub = (env as unknown as Env).ORGANISATION_ROOMS.getByName(organisationId);
    const post = (body: unknown) => stub.fetch(request(collectionPath, "POST", body));

    expect((await post({ name: "Empty", items: [], createdBy: actorId })).status).toBe(400);
    expect(
      (
        await post({
          name: "Too many",
          items: Array.from({ length: MAX_ORGANISATION_TEMPLATE_ITEMS + 1 }, () => templateItem()),
          createdBy: actorId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          name: "Duplicate",
          items: [templateItem(), templateItem()],
          createdBy: actorId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          name: "Image",
          items: [
            {
              ...templateItem(),
              kind: "image",
              style: { kind: "image", opacity: 1, radius: 12 },
              geometry: {
                x: 0,
                y: 0,
                width: 200,
                height: 100,
                assetId: `asset_${"d".repeat(43)}`,
                mimeType: "image/png",
                intrinsicWidth: 200,
                intrinsicHeight: 100,
              },
            },
          ],
          createdBy: actorId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          name: "Malformed",
          items: [{ ...templateItem(), geometry: { x: Number.NaN } }],
          createdBy: actorId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          name: "N".repeat(101),
          items: [templateItem()],
          createdBy: actorId,
        })
      ).status,
    ).toBe(400);

    const otherOrganisationId = `o_${"C".repeat(21)}A`;
    const conflict = await stub.fetch(
      request(`/__internal/organisations/${otherOrganisationId}/templates`),
    );
    expect(conflict.status).toBe(409);

    const otherStub = (env as unknown as Env).ORGANISATION_ROOMS.getByName(otherOrganisationId);
    const isolated = await otherStub.fetch(
      request(`/__internal/organisations/${otherOrganisationId}/templates`),
    );
    expect(isolated.status).toBe(200);
    expect(await isolated.json()).toEqual([]);
  });
});
