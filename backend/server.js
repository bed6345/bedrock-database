// Reference backend for the RemoteDatabase class.
//
// A tiny zero-dependency HTTP server that both Bedrock Dedicated Servers
// point at, so they share the same data. Data is persisted to a JSON file
// so it survives restarts.
//
// Run with:   node backend/server.js
// Configure via environment variables:
//   PORT     - port to listen on            (default 3000)
//   API_KEY  - shared secret, matched against the `x-api-key` header
//   DB_FILE  - path to the JSON storage file (default ./backend/data.json)

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY || "";
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data.json");

/**
 * In-memory store, shape: { [tableName]: { [key]: value } }.
 * Loaded from disk on boot.
 */
let store = {};
try {
  if (fs.existsSync(DB_FILE)) store = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
} catch (e) {
  console.warn(`Could not read ${DB_FILE}, starting empty:`, e.message);
}

// Debounced write-to-disk so bursts of writes don't thrash the filesystem.
let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DB_FILE, JSON.stringify(store), (e) => {
      if (e) console.error("Failed to persist store:", e.message);
    });
  }, 200);
}

function table(name) {
  if (!store[name]) store[name] = {};
  return store[name];
}

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
  // Simple shared-secret auth.
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return send(res, 401, { ok: false, error: "Unauthorized" });
  }

  // Path: /tables/:table            -> whole table  (GET, DELETE)
  //       /tables/:table/:key       -> single key   (GET, PUT, DELETE)
  //       /tables/:table/:key/increment -> atomic +n (POST)
  const parts = decodeURIComponent(req.url.split("?")[0])
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));

  try {
    if (parts[0] !== "tables" || !parts[1]) {
      return send(res, 404, { ok: false, error: "Not found" });
    }
    const tableName = parts[1];
    const key = parts[2];
    const action = parts[3];

    // ---- Whole-table operations -------------------------------------
    if (!key) {
      if (req.method === "GET") {
        return send(res, 200, { ok: true, data: table(tableName) });
      }
      if (req.method === "DELETE") {
        store[tableName] = {};
        persist();
        return send(res, 200, { ok: true });
      }
    }

    // ---- Atomic increment -------------------------------------------
    if (key && action === "increment" && req.method === "POST") {
      const { amount = 1 } = await readBody(req);
      const t = table(tableName);
      const current = typeof t[key] === "number" ? t[key] : 0;
      t[key] = current + amount;
      persist();
      return send(res, 200, { ok: true, data: { value: t[key] } });
    }

    // ---- Single-key operations --------------------------------------
    if (key && !action) {
      const t = table(tableName);
      if (req.method === "GET") {
        const value = key in t ? t[key] : null;
        return send(res, 200, { ok: true, data: { value } });
      }
      if (req.method === "PUT") {
        const { value } = await readBody(req);
        t[key] = value;
        persist();
        return send(res, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        const deleted = delete t[key];
        persist();
        return send(res, 200, { ok: true, data: { deleted } });
      }
    }

    return send(res, 405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    return send(res, 400, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`RemoteDatabase backend listening on http://0.0.0.0:${PORT}`);
  console.log(`Storage file: ${DB_FILE}`);
  if (!API_KEY) console.log("WARNING: no API_KEY set — auth is disabled.");
});
