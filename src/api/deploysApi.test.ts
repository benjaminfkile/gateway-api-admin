import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient from "./apiClient";
import deploysApi from "./deploysApi";
import type { DeployDetail, DeploySummary } from "./types";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
});

afterEach(() => {
  mock.restore();
});

const sampleSummary: DeploySummary = {
  id: "d-1",
  service: "web",
  fromDigest: "sha256:old",
  toDigest: "sha256:new",
  actor: "alice",
  action: "deploy",
  status: "done",
  startedAt: "2026-08-03T00:00:00Z",
  finishedAt: "2026-08-03T00:01:00Z",
};

const sampleDetail: DeployDetail = {
  ...sampleSummary,
  instances: [
    {
      instanceId: "i-0abc",
      status: "converged",
      detail: null,
      updatedAt: "2026-08-03T00:01:00Z",
    },
  ],
};

describe("deploysApi", () => {
  it("list() GETs /mgmt/deploys and returns the array", async () => {
    mock.onGet("/mgmt/deploys").reply(200, [sampleSummary]);

    const result = await deploysApi.list();

    expect(result).toEqual([sampleSummary]);
    expect(mock.history.get[0].url).toBe("/mgmt/deploys");
  });

  it("get() GETs /mgmt/deploys/{id} and returns the detail", async () => {
    // The gateway nests the summary under `deploy`; get() flattens it.
    const { instances, ...summary } = sampleDetail;
    mock.onGet("/mgmt/deploys/d-1").reply(200, { deploy: summary, instances });

    const result = await deploysApi.get("d-1");

    expect(result).toEqual(sampleDetail);
    expect(mock.history.get).toHaveLength(1);
    expect(mock.history.get[0].url).toBe("/mgmt/deploys/d-1");
  });
});
