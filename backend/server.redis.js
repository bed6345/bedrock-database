// Redis-backed version of the RemoteDatabase backend.
//
// Exposes the EXACT same HTTP API as server.js, so it's a drop-in
// replacement — your behavior packs don't change at all. Use this one for
// real 100-200 player deployments: Redis gives atomic counters, atomic
// locks, and safe concurrent writes without rewriting a whole file.
//
// Storage layout in Redis:
//   db:<table>          -> a Hash of { key: JSON(value) }
//   db:lock:<owner>     -> a string holding the lock holder, with a PX TTL
//
// Run with:   node backend/server.redis.js
//   (needs a running Redis and `npm install redis`)
//
// Configure via environment variables:
//   PORT       - port to listen on             (default 3000)
//   API_KEY    - shared secret (x-api-key)      (default none)
//   REDIS_URL  - redis connection string        (default redis://127.0.0.1:6379)

const http = require("http");
const { createClient } = require("redis");

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY || "";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const redis = createClient({ url: REDIS_URL });
redis.on("error", (e) => console.error("Redis error:", e.message));

const tableKey = (t) => `db:${t}`;
const lockKey = (o) => `db:lock:${o}`;

/**
 * Acquire-or-refresh a lock atomically. Sets the lock only if it's free or
 * already held by the same holder (refreshing the TTL).
 * Returns { acquired, heldBy }.
 */
const ACQUIRE_LOCK = `
local cur = redis.call('GET', KEYS[1])
if cur == false or cur == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
  return {1, ARGV[1]}
else
  return {0, cur}
end`;

/**
 * Release a lock only if the caller still holds it. Returns 1 or 0.
 */
const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 5_000_000) reject(new Error("Body too large")); // 5 MB cap
    });
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return send(res, 401, { ok: false, error: "Unauthorized" });
  }

  const parts = decodeURIComponent(req.url.split("?")[0])
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));

  try {
    // ---- Locks ------------------------------------------------------
    if (parts[0] === "locks" && parts[1]) {
      const owner = parts[1];
      if (req.method === "PUT") {
        const { holder, ttl = 120 } = await readBody(req);
        if (!holder)
          return send(res, 400, { ok: false, error: "holder required" });
        const [acquired, heldBy] = await redis.eval(ACQUIRE_LOCK, {
          keys: [lockKey(owner)],
          arguments: [String(holder), String(ttl * 1000)],
        });
        return send(res, 200, {
          ok: true,
          data: { acquired: acquired === 1, heldBy },
        });
      }
      if (req.method === "DELETE") {
        const { holder } = await readBody(req);
        const released = await redis.eval(RELEASE_LOCK, {
          keys: [lockKey(owner)],
          arguments: [String(holder)],
        });
        return send(res, 200, { ok: true, data: { released: released === 1 } });
      }
      return send(res, 405, { ok: false, error: "Method not allowed" });
    }

    if (parts[0] !== "tables" || !parts[1]) {
      return send(res, 404, { ok: false, error: "Not found" });
    }
    const tableName = parts[1];
    const key = parts[2];
    const action = parts[3];
    const tKey = tableKey(tableName);

    // ---- Whole-table operations -------------------------------------
    if (!key) {
      if (req.method === "GET") {
        const raw = await redis.hGetAll(tKey);
        const data = {};
        for (const [k, v] of Object.entries(raw)) data[k] = JSON.parse(v);
        return send(res, 200, { ok: true, data });
      }
      if (req.method === "DELETE") {
        await redis.del(tKey);
        return send(res, 200, { ok: true });
      }
    }

    // ---- Atomic increment -------------------------------------------
    if (key && action === "increment" && req.method === "POST") {
      const { amount = 1 } = await readBody(req);
      // HINCRBYFLOAT works because numbers are stored as plain JSON numbers
      // ("5"), which are valid Redis numeric strings.
      const value = Number(await redis.hIncrByFloat(tKey, key, amount));
      return send(res, 200, { ok: true, data: { value } });
    }

    // ---- Single-key operations --------------------------------------
    if (key && !action) {
      if (req.method === "GET") {
        const raw = await redis.hGet(tKey, key);
        const value = raw === null || raw === undefined ? null : JSON.parse(raw);
        return send(res, 200, { ok: true, data: { value } });
      }
      if (req.method === "PUT") {
        const { value } = await readBody(req);
        await redis.hSet(tKey, key, JSON.stringify(value));
        return send(res, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        const removed = await redis.hDel(tKey, key);
        return send(res, 200, { ok: true, data: { deleted: removed > 0 } });
      }
    }

    return send(res, 405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    return send(res, 400, { ok: false, error: e.message });
  }
});

(async () => {
  await redis.connect();
  server.listen(PORT, () => {
    console.log(`RemoteDatabase Redis backend listening on http://0.0.0.0:${PORT}`);
    console.log(`Redis: ${REDIS_URL}`);
    if (!API_KEY) console.log("WARNING: no API_KEY set — auth is disabled.");
  });
})().catch((e) => {
  console.error("Failed to start:", e.message);
  process.exit(1);
});
