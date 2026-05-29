// Central key-value store shared by every BDS instance on the network.
//
// Each Minecraft server talks to this process over HTTP (via the
// @minecraft/server-net module) so that data written on one server is visible
// on the others. Storage is a single JSON file; good enough for player
// profiles on a small private network.
//
// Run it on the same machine as your servers/proxy:
//   DB_TOKEN=your-secret DB_PORT=8080 node backend/server.js
//
// The DB_TOKEN must match API_TOKEN in src/config.ts.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.DB_PORT || 8080);
const HOST = process.env.DB_HOST || "127.0.0.1";
const TOKEN = process.env.DB_TOKEN || "change-me-please";
const DATA_FILE = path.join(__dirname, "data.json");

/** @type {{ [table: string]: { [key: string]: any } }} */
let store = {};

// ---- Persistence -----------------------------------------------------------

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) || {};
    }
  } catch (err) {
    console.error(`[backend] Failed to read ${DATA_FILE}, starting empty:`, err);
    store = {};
  }
}

let saveTimer = null;
let saving = false;
let dirtyWhileSaving = false;

// Debounce writes so a burst of sets only triggers one disk write.
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 250);
}

function flush() {
  saveTimer = null;
  if (saving) {
    dirtyWhileSaving = true;
    return;
  }
  saving = true;
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFile(tmp, JSON.stringify(store), (err) => {
    if (err) {
      console.error("[backend] Save failed:", err);
      saving = false;
      return;
    }
    fs.rename(tmp, DATA_FILE, (renameErr) => {
      saving = false;
      if (renameErr) console.error("[backend] Atomic rename failed:", renameErr);
      if (dirtyWhileSaving) {
        dirtyWhileSaving = false;
        scheduleSave();
      }
    });
  });
}

// ---- Operations ------------------------------------------------------------

function table(name) {
  if (!store[name]) store[name] = {};
  return store[name];
}

function handleOp({ op, table: tableName, key, value }) {
  if (typeof tableName !== "string" || !tableName) {
    throw new Error("Missing 'table'");
  }
  const t = table(tableName);
  switch (op) {
    case "get":
      return key in t ? t[key] : null;
    case "set":
      t[key] = value;
      scheduleSave();
      return null;
    case "has":
      return key in t;
    case "delete": {
      const existed = key in t;
      delete t[key];
      scheduleSave();
      return existed;
    }
    case "keys":
      return Object.keys(t);
    case "values":
      return Object.values(t);
    case "collection":
      return t;
    case "clear":
      store[tableName] = {};
      scheduleSave();
      return null;
    default:
      throw new Error(`Unknown op '${op}'`);
  }
}

// ---- HTTP server -----------------------------------------------------------

const server = http.createServer((req, res) => {
  // Simple health check.
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("bedrock-database backend ok");
    return;
  }

  if (req.method !== "POST" || req.url !== "/db") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
    return;
  }

  if (req.headers["x-api-token"] !== TOKEN) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 20 * 1024 * 1024) req.destroy(); // 20MB guard
  });
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    try {
      const result = handleOp(JSON.parse(body || "{}"));
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
    }
  });
});

load();
server.listen(PORT, HOST, () => {
  console.log(`[backend] bedrock-database listening on http://${HOST}:${PORT}`);
  if (TOKEN === "change-me-please") {
    console.warn("[backend] WARNING: using the default DB_TOKEN. Set DB_TOKEN to a secret value.");
  }
});

// Persist once more on shutdown so the latest writes are not lost.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    flush();
    setTimeout(() => process.exit(0), 300);
  });
}
