const INTERVAL_MS = 15 * 60 * 1000;
const STALE_MS = 20 * 60 * 1000;

// Reject schema changes and partial responses before touching the saved snapshot.
function validateGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) throw new Error("Invalid groups");
  const ids = new Set();
  const numbers = new Set();
  for (const group of groups) {
    if (!Number.isInteger(group.id) || group.id < 1 ||
        !Number.isInteger(group.groupNumber) || group.groupNumber < 1 ||
        group.groupNumber > 12 || ids.has(group.id) || numbers.has(group.groupNumber)) {
      throw new Error("Invalid or duplicate group");
    }
    ids.add(group.id);
    numbers.add(group.groupNumber);
  }
  if (numbers.size !== 12) throw new Error("Incomplete groups");
  return ids;
}

function validate({ groups, schedule }) {
  const ids = validateGroups(groups);
  if (!Array.isArray(schedule) || schedule.length === 0) throw new Error("Empty or invalid schedule");
  const covered = new Set();
  const slots = new Set();
  for (const entry of schedule) {
    const slot = `${entry.groupId}:${entry.dateTime}`;
    if (!ids.has(entry.groupId) || ![0, 1, 2].includes(entry.availability) ||
        typeof entry.isEmergency !== "boolean" || typeof entry.dateTime !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(entry.dateTime) ||
        !Number.isFinite(Date.parse(entry.dateTime)) || slots.has(slot)) {
      throw new Error("Invalid schedule entry");
    }
    covered.add(entry.groupId);
    slots.add(slot);
  }
  if (covered.size !== ids.size) throw new Error("Schedule missing groups");
}

async function upstream(source, path) {
  const response = await fetch(`${source}${path}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${path.split("?")[0]}: HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${path.split("?")[0]}: invalid JSON`);
  }
}

export async function refresh(env) {
  let source;
  try {
    const url = new URL(env.UPSTREAM_BASE_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    source = url.origin;
  } catch {
    throw new Error("UPSTREAM_BASE_URL must be an HTTPS origin");
  }
  const groups = await upstream(source, "/shutdowns/groups");
  // Validate group mapping before constructing the second upstream request.
  validateGroups(groups);
  const schedule = await upstream(source, `/shutdowns/schedule?groupIds=${groups.map(g => g.id).join(",")}`);
  validate({ groups, schedule });
  // Stable ordering avoids rewriting the payload when upstream only changes order.
  groups.sort((a, b) => a.groupNumber - b.groupNumber);
  schedule.sort((a, b) => a.groupId - b.groupId || a.dateTime.localeCompare(b.dateTime));
  const data = JSON.stringify({ groups, schedule });
  const previous = await env.DB.prepare("SELECT data FROM snapshots WHERE id = ?").bind("current").first();
  const updatedAt = new Date().toISOString();
  if (previous?.data === data) {
    // A small heartbeat write is necessary to distinguish successful checks from failures.
    await env.DB.prepare("UPDATE snapshots SET updated_at = ? WHERE id = 'current'").bind(updatedAt).run();
  } else {
    await env.DB.prepare(`INSERT INTO snapshots (id, data, updated_at) VALUES ('current', ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
      .bind(data, updatedAt).run();
  }
  console.log(JSON.stringify({ event: "refresh_success", entries: schedule.length, changed: previous?.data !== data }));
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  } });
}

function metadata(snapshot, updatedAt) {
  const age = snapshot ? Math.max(0, Date.now() - Date.parse(updatedAt)) : null;
  return {
    status: !snapshot ? "waiting" : age > STALE_MS ? "stale" : "ok",
    source: "esvitlo", groups: snapshot?.groups.length ?? 0,
    entries: snapshot?.schedule.length ?? 0, updated_at: updatedAt ?? null,
    age_seconds: age === null ? null : Math.floor(age / 1000),
    // This is the next configured UTC Cron boundary, not a promise of completion.
    next_expected_refresh: new Date((Math.floor(Date.now() / INTERVAL_MS) + 1) * INTERVAL_MS).toISOString(),
  };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env).catch(error => {
      console.error("refresh_failed", error);
      throw error;
    }));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!["/api/status", "/api/groups", "/api/schedule"].includes(url.pathname)) return json({ error: "Not found" }, 404);
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const rawGroup = url.searchParams.get("group");
    if (url.pathname === "/api/schedule" &&
        (url.searchParams.getAll("group").length !== 1 || !/^(?:[1-9]|1[0-2])$/.test(rawGroup ?? ""))) {
      return json({ error: "Invalid group; expected an integer from 1 to 12" }, 400);
    }
    let row;
    let snapshot;
    try {
      row = await env.DB.prepare("SELECT data, updated_at FROM snapshots WHERE id = ?").bind("current").first();
      if (row) {
        snapshot = JSON.parse(row.data);
        validate(snapshot);
        if (!Number.isFinite(Date.parse(row.updated_at))) throw new Error("Invalid snapshot timestamp");
      }
    } catch (error) {
      console.error("snapshot_read_failed", error);
      return json({ ...metadata(null), message: "Cached snapshot unavailable" }, 503);
    }
    const health = metadata(snapshot, row?.updated_at);
    if (!snapshot) return json({ ...health, message: "No data available" }, 503);
    if (url.pathname === "/api/status") return json(health);
    if (url.pathname === "/api/groups") return json({ groups: snapshot.groups, updatedAt: row.updated_at });
    const group = snapshot.groups.find(g => g.groupNumber === Number(rawGroup));
    if (!group) return json({ error: "Group not found" }, 404);
    return json({ group: group.groupNumber, updatedAt: row.updated_at,
      schedule: snapshot.schedule.filter(s => s.groupId === group.id) });
  },
};
