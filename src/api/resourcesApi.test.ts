import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient from "./apiClient";
import resourcesApi, {
  cacheNodeTypes,
  databaseClassOptions,
  databaseClasses,
  formatAuditDetail,
  fleetClasses,
  isRefreshInFlight,
  resourcesErrorMessage,
} from "./resourcesApi";
import type { ResourcesState } from "./types";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
});

afterEach(() => {
  mock.restore();
});

function axiosError(status: number, data: unknown) {
  return { response: { status, data } };
}

describe("resourcesApi", () => {
  it("GETs the resources", async () => {
    const state: ResourcesState = { fleet: null, generators: null, cache: null, database: null };
    mock.onGet("/mgmt/resources").reply(200, state);
    expect(await resourcesApi.get()).toEqual(state);
  });

  it("PUTs fleet size, class and rollback", async () => {
    mock.onPut("/mgmt/resources/fleet/size").reply(202, {});
    mock.onPut("/mgmt/resources/fleet/class").reply(202, { templateVersion: 5, refreshId: "r" });
    mock.onPut("/mgmt/resources/fleet/class/rollback").reply(202, {});
    await resourcesApi.setFleetSize(3);
    expect(await resourcesApi.setFleetClass("m-large")).toEqual({ templateVersion: 5, refreshId: "r" });
    await resourcesApi.rollbackFleetClass(4);
    expect(mock.history.put.map((r) => JSON.parse(r.data))).toEqual([
      { size: 3 },
      { instanceClass: "m-large" },
      { templateVersion: 4 },
    ]);
  });

  it("reads the refresh, which may be null", async () => {
    mock.onGet("/mgmt/resources/fleet/refresh").replyOnce(200, null);
    expect(await resourcesApi.fleetRefresh()).toBeNull();
  });

  it("PUTs the cache node type and the database class with its confirm", async () => {
    mock.onPut("/mgmt/resources/cache/node-type").reply(202, { note: "degraded" });
    mock
      .onPut("/mgmt/resources/database/class")
      .reply(202, { services: ["svc-a"], note: "reboots" });
    expect(await resourcesApi.setCacheNodeType("cache-medium")).toEqual({ note: "degraded" });
    expect(await resourcesApi.setDatabaseClass("db-large", "sample-db")).toEqual({
      services: ["svc-a"],
      note: "reboots",
    });
    expect(JSON.parse(mock.history.put[1].data)).toEqual({
      instanceClass: "db-large",
      confirm: "sample-db",
    });
  });

  it("GETs the audit with a limit", async () => {
    mock.onGet("/mgmt/resources/audit").reply(200, []);
    await resourcesApi.audit(20);
    expect(mock.history.get[0].params).toEqual({ limit: 20 });
  });
});

describe("resources helpers", () => {
  it("maps every documented error", () => {
    for (const code of [
      "class_not_allowed",
      "confirm_mismatch",
      "run_active",
      "refresh_in_progress",
      "downgrade_unsafe",
      "resource_unconfigured",
    ]) {
      const message = resourcesErrorMessage(axiosError(409, { error: code }), "x");
      expect(message).not.toBe(code);
      expect(message).not.toBe("x");
    }
    expect(resourcesErrorMessage(axiosError(502, { error: "aws_error" }), "x")).toBe("aws_error");
  });

  it("reads allow lists from the blocks, else from the allowed block", () => {
    const state: ResourcesState = {
      fleet: { classes: ["a"] } as ResourcesState["fleet"],
      generators: null,
      cache: null,
      database: null,
      allowed: { fleetClasses: ["z"], cacheNodeTypes: ["c"], databaseClasses: ["d"] },
    };
    expect(fleetClasses(state)).toEqual(["a"]);
    expect(cacheNodeTypes(state)).toEqual(["c"]);
    expect(databaseClasses(state)).toEqual(["d"]);
  });

  it("formats an audit detail whether it is a string or the gateway's object", () => {
    expect(formatAuditDetail(null)).toBe("");
    expect(formatAuditDetail("plain")).toBe("plain");
    expect(formatAuditDetail({ id: "db", services: ["a", "b"], note: "Reboots the database." })).toBe("Reboots the database. Services: a, b id: db");
    expect(formatAuditDetail({ id: "cache", note: "Replaces the node." })).toBe("Replaces the node. id: cache");
  });

  it("reads the gateway's database class objects as names with their documented connections", () => {
    const state = {
      fleet: null,
      generators: null,
      cache: null,
      database: {
        id: "db",
        instanceClass: "db.small",
        status: null,
        maxConnections: null,
        connectionsInUse: null,
        classes: [{ instanceClass: "db.small", documentedMaxConnections: 112 }, { instanceClass: "db.medium", documentedMaxConnections: null }, "db.large"],
      },
    } as ResourcesState;
    expect(databaseClasses(state)).toEqual(["db.small", "db.medium", "db.large"]);
    expect(databaseClassOptions(state)).toEqual([
      { value: "db.small", label: "db.small (112 connections documented)" },
      { value: "db.medium", label: "db.medium" },
      { value: "db.large", label: "db.large" },
    ]);
  });

  it("isRefreshInFlight prefers inProgress and falls back to the status", () => {
    expect(isRefreshInFlight(null)).toBe(false);
    expect(isRefreshInFlight({ status: "Successful", percentComplete: 100, inProgress: true })).toBe(true);
    expect(isRefreshInFlight({ status: "InProgress", percentComplete: 40 })).toBe(true);
    expect(isRefreshInFlight({ status: "Successful", percentComplete: 100 })).toBe(false);
  });
});
