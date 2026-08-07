import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient from "./apiClient";
import logsApi from "./logsApi";
import type { LogLine } from "./types";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
});

afterEach(() => {
  mock.restore();
});

const sampleLines: LogLine[] = [
  { ts: "2026-08-03T00:00:00Z", message: "started" },
  { ts: "2026-08-03T00:00:01Z", message: "listening on :8080" },
];

describe("logsApi", () => {
  it("tail() GETs the service logs with instance and tail params", async () => {
    mock.onGet("/mgmt/services/web/logs").reply(200, { lines: sampleLines });

    const result = await logsApi.tail("web", "i-0abc", 200);

    expect(result).toEqual(sampleLines);
    expect(mock.history.get).toHaveLength(1);
    expect(mock.history.get[0].url).toBe("/mgmt/services/web/logs");
    expect(mock.history.get[0].params).toEqual({ instance: "i-0abc", tail: 200 });
  });
});
