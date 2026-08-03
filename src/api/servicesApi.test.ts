import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MockAdapter from "axios-mock-adapter";

// The apiClient request interceptor pulls a bearer token from Cognito; there is
// no Cognito in the test container, so stub it to a no-op token source.
vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient from "./apiClient";
import servicesApi from "./servicesApi";
import type { ServiceSummary, ServiceUpsert } from "./types";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
});

afterEach(() => {
  mock.restore();
});

const sampleService: ServiceSummary = {
  name: "web",
  image: "registry/web",
  tag: "v1.2.3",
  digest: "sha256:abc",
  port: 8080,
  desiredStatus: "running",
  includeInHealth: true,
  updatedBy: "alice",
  updatedAt: "2026-08-03T00:00:00Z",
  rollup: { runningOn: 2, totalInstances: 3, digests: { "sha256:abc": 2 } },
};

describe("servicesApi", () => {
  it("list() GETs /mgmt/services and returns the array", async () => {
    mock.onGet("/mgmt/services").reply(200, [sampleService]);

    const result = await servicesApi.list();

    expect(result).toEqual([sampleService]);
    expect(mock.history.get).toHaveLength(1);
    expect(mock.history.get[0].url).toBe("/mgmt/services");
  });

  it("stop() POSTs to /stop without force by default", async () => {
    mock.onPost("/mgmt/services/web/stop").reply(204);

    await servicesApi.stop("web");

    expect(mock.history.post).toHaveLength(1);
    expect(mock.history.post[0].url).toBe("/mgmt/services/web/stop");
    expect(mock.history.post[0].params).toBeUndefined();
  });

  it("stop() passes force=true as a query param", async () => {
    mock.onPost("/mgmt/services/web/stop").reply(204);

    await servicesApi.stop("web", true);

    expect(mock.history.post[0].params).toEqual({ force: true });
  });

  it("start() POSTs to /start", async () => {
    mock.onPost("/mgmt/services/web/start").reply(204);

    await servicesApi.start("web");

    expect(mock.history.post[0].url).toBe("/mgmt/services/web/start");
  });

  it("restart() POSTs to /restart", async () => {
    mock.onPost("/mgmt/services/web/restart").reply(204);

    await servicesApi.restart("web");

    expect(mock.history.post[0].url).toBe("/mgmt/services/web/restart");
  });

  it("deploy() POSTs the tag to /deploy", async () => {
    mock.onPost("/mgmt/services/web/deploy").reply(202);

    await servicesApi.deploy("web", "v2.0.0");

    expect(mock.history.post[0].url).toBe("/mgmt/services/web/deploy");
    expect(JSON.parse(mock.history.post[0].data)).toEqual({ tag: "v2.0.0" });
  });

  it("rollback() POSTs to /rollback", async () => {
    mock.onPost("/mgmt/services/web/rollback").reply(202);

    await servicesApi.rollback("web");

    expect(mock.history.post[0].url).toBe("/mgmt/services/web/rollback");
  });

  it("upsert() PUTs the service payload and returns the body", async () => {
    const payload: ServiceUpsert = {
      name: "web",
      image: "registry/web",
      tag: "v1.2.3",
      port: 8080,
    };
    mock.onPut("/mgmt/services/web").reply(200, sampleService);

    const result = await servicesApi.upsert(payload);

    expect(result).toEqual(sampleService);
    expect(mock.history.put[0].url).toBe("/mgmt/services/web");
    expect(JSON.parse(mock.history.put[0].data)).toEqual(payload);
  });

  it("encodes service names with special characters", async () => {
    mock.onPost("/mgmt/services/my%2Fsvc/start").reply(204);

    await servicesApi.start("my/svc");

    expect(mock.history.post[0].url).toBe("/mgmt/services/my%2Fsvc/start");
  });
});
