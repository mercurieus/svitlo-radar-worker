import { env } from "cloudflare:test";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import worker, { refresh } from "../src/index.js";

const groups = Array.from({ length: 12 }, (_, i) => ({ id: i + 3, groupNumber: i + 1 }));
const schedule = groups.map(g => ({ groupId: g.id, dateTime: "2026-11-13T00:00:00.000Z", availability: 1, isEmergency: false }));
const data = JSON.stringify({ groups, schedule });
const request = path => worker.fetch(new Request(`https://example.com${path}`), env);
async function seed(age = 0) {
  await env.DB.prepare("INSERT INTO snapshots VALUES ('current', ?, ?)")
    .bind(data, new Date(Date.now() - age).toISOString()).run();
}
beforeEach(async () => {
  await env.DB.exec("CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)");
  await env.DB.exec("DELETE FROM snapshots");
});
afterEach(() => vi.restoreAllMocks());

describe("cached API", () => {
  it("reports waiting with no snapshot", async () => {
    const response = await request("/api/status");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "waiting", groups: 0, entries: 0, age_seconds: null });
  });
  it("reports stale after 20 minutes and continues serving schedules using actual IDs", async () => {
    await seed(21 * 60000);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch upstream"));
    expect(await (await request("/api/status")).json()).toMatchObject({ status: "stale", entries: 12 });
    expect(await (await request("/api/schedule?group=1")).json()).toMatchObject({ group: 1, schedule: [schedule[0]] });
    expect(await (await request("/api/groups")).json()).toMatchObject({ groups });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("reports fresh data", async () => {
    await seed();
    expect(await (await request("/api/status")).json()).toMatchObject({ status: "ok", groups: 12 });
  });
  it.each(["", "0", "13", "1.5", "1e0", "1&group=2", "abc"])("rejects invalid group %s", async group => {
    expect((await request(`/api/schedule?group=${group}`)).status).toBe(400);
  });
  it("handles corrupt saved data", async () => {
    await env.DB.prepare("INSERT INTO snapshots VALUES ('current', 'broken', 'bad')").run();
    expect((await request("/api/status")).status).toBe(503);
  });
});

describe("refresh", () => {
  it("rejects missing or unsafe upstream configuration before making requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const value of [undefined, "http://upstream.example.com", "https://user:pass@upstream.example.com", "https://upstream.example.com/path"]) {
      await expect(refresh({ ...env, UPSTREAM_BASE_URL: value })).rejects.toThrow("UPSTREAM_BASE_URL");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["http", "json", "groups", "empty", "entry", "partial", "timeout"])("preserves snapshot on %s failure", async failure => {
    await seed();
    const before = await env.DB.prepare("SELECT * FROM snapshots").first();
    vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
      if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError");
      if (failure === "http") return new Response("bad", { status: 502 });
      if (failure === "json") return new Response("not json");
      if (url.endsWith("/groups")) return Response.json(failure === "groups" ? {} : groups);
      return Response.json(failure === "empty" ? [] : failure === "partial" ? schedule.slice(1) : [{ ...schedule[0], availability: 9 }]);
    });
    await expect(refresh({ ...env, UPSTREAM_BASE_URL: "https://upstream.example.com" })).rejects.toThrow();
    expect(await env.DB.prepare("SELECT * FROM snapshots").first()).toEqual(before);
  });
  it("stores a valid response and updates freshness without replacing unchanged data", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async url => Response.json(url.endsWith("/groups") ? groups : schedule));
    await refresh({ ...env, UPSTREAM_BASE_URL: "https://upstream.example.com" });
    const before = await env.DB.prepare("SELECT * FROM snapshots").first();
    expect(before.data).toBe(data);
    await env.DB.prepare("UPDATE snapshots SET updated_at = '2000-01-01T00:00:00Z'").run();
    await refresh({ ...env, UPSTREAM_BASE_URL: "https://upstream.example.com" });
    const after = await env.DB.prepare("SELECT * FROM snapshots").first();
    expect(after.data).toBe(before.data);
    expect(Date.parse(after.updated_at)).toBeGreaterThan(Date.parse("2000-01-01"));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
