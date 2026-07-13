import { describe, expect, it } from "vitest";
import { fetchWithRetry, isRetryableStatus, type FetchLike, type ResponseLike } from "../src/index";

function response(status: number): ResponseLike {
  return { ok: status < 400, status, body: null, text: async () => `status ${status}` };
}

const noSleep = async () => {};

describe("isRetryableStatus", () => {
  it("retries 429/408/5xx and not other 4xx", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe("fetchWithRetry", () => {
  it("retries a transient 503 then returns the 200", async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls += 1;
      return response(calls < 3 ? 503 : 200);
    };
    const result = await fetchWithRetry(fetchFn, "u", { method: "POST", headers: {}, body: "" }, { sleep: noSleep });
    expect(calls).toBe(3);
    expect(result.status).toBe(200);
  });

  it("does not retry a 400", async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls += 1;
      return response(400);
    };
    const result = await fetchWithRetry(fetchFn, "u", { method: "POST", headers: {}, body: "" }, { sleep: noSleep });
    expect(calls).toBe(1);
    expect(result.status).toBe(400);
  });

  it("returns the last retryable response after exhausting attempts", async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls += 1;
      return response(429);
    };
    const result = await fetchWithRetry(fetchFn, "u", { method: "POST", headers: {}, body: "" }, { maxAttempts: 2, sleep: noSleep });
    expect(calls).toBe(2);
    expect(result.status).toBe(429);
  });

  it("retries thrown network errors, then rethrows if they persist", async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    };
    await expect(
      fetchWithRetry(fetchFn, "u", { method: "POST", headers: {}, body: "" }, { maxAttempts: 3, sleep: noSleep }),
    ).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(3);
  });
});
