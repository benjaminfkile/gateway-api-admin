import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MockAdapter from "axios-mock-adapter";

// apiClient's request interceptor reaches into Cognito for a bearer token; there
// is no Cognito in the test container, so stub it to a no-op token source.
vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient, {
  NETWORK_ERROR_MESSAGE,
  setUnauthorizedHandler,
} from "./apiClient";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
});

afterEach(() => {
  mock.restore();
  setUnauthorizedHandler(null);
  vi.clearAllMocks();
});

describe("apiClient response interceptor", () => {
  it("invokes the unauthorized handler on a 401 and still rejects", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mock.onGet("/mgmt/services").reply(401);

    await expect(apiClient.get("/mgmt/services")).rejects.toBeTruthy();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the handler on non-401 HTTP errors", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mock.onGet("/mgmt/services").reply(500);

    await expect(apiClient.get("/mgmt/services")).rejects.toBeTruthy();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("normalizes a network error into a readable message", async () => {
    mock.onGet("/mgmt/services").networkError();

    await expect(apiClient.get("/mgmt/services")).rejects.toThrow(
      NETWORK_ERROR_MESSAGE,
    );
  });

  it("leaves a successful response untouched", async () => {
    mock.onGet("/mgmt/services").reply(200, [{ name: "web" }]);

    const res = await apiClient.get("/mgmt/services");
    expect(res.data).toEqual([{ name: "web" }]);
  });
});
