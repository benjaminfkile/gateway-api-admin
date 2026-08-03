import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient from "./apiClient";
import instancesApi from "./instancesApi";
import type { InstanceInfo } from "./types";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
});

afterEach(() => {
  mock.restore();
});

const sampleInstance: InstanceInfo = {
  instanceId: "i-0abc",
  privateIp: "10.0.0.5",
  publicIp: "3.3.3.3",
  gatewayVer: "1.4.0",
  isLeader: true,
  stale: false,
  heartbeatAt: "2026-08-03T00:00:00Z",
  services: [
    {
      name: "web",
      digest: "sha256:abc",
      state: "running",
      startedAt: "2026-08-03T00:00:00Z",
      restarts: 0,
    },
  ],
};

describe("instancesApi", () => {
  it("list() GETs /mgmt/instances and returns the array", async () => {
    mock.onGet("/mgmt/instances").reply(200, [sampleInstance]);

    const result = await instancesApi.list();

    expect(result).toEqual([sampleInstance]);
    expect(mock.history.get).toHaveLength(1);
    expect(mock.history.get[0].url).toBe("/mgmt/instances");
  });
});
