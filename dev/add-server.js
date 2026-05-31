#!/usr/bin/env node
// Generate config for an additional Bedrock server in the dev stack.
//
// Usage:
//   node dev/add-server.js <serverId> [--port <hostPort>]
//                                     [--endpoint <url>] [--api-key <key>]
//
// Example:
//   node dev/add-server.js minigames
//   node dev/add-server.js skyblock --port 19134
//
// It creates dev/<serverId>/permissions.json and variables.json, then prints
// the docker-compose service block and the WaterdogPE server entry to paste
// into docker-compose.dev.yml and dev/waterdog/config.yml.

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const serverId = args._[0];

if (!serverId) {
  console.error("Usage: node dev/add-server.js <serverId> [--port <hostPort>] [--endpoint <url>] [--api-key <key>]");
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(serverId)) {
  console.error(`Invalid serverId "${serverId}". Use lowercase letters, numbers and dashes.`);
  process.exit(1);
}

const endpoint = args.endpoint || "http://backend:3000";
const apiKey = args["api-key"] || "super-secret";
const hostPort = args.port; // optional: expose the BDS directly for debugging

// Pull the script module UUID from the manifest so the config path is correct.
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8")
);
const scriptModule = manifest.modules.find((m) => m.type === "script");
if (!scriptModule) {
  console.error("No script module found in manifest.json");
  process.exit(1);
}
const scriptUuid = scriptModule.uuid;

// --- Write the per-server config files --------------------------------------
const dir = path.join(root, "dev", serverId);
fs.mkdirSync(dir, { recursive: true });

const permissions = {
  allowed_modules: ["@minecraft/server-net", "@minecraft/server-admin"],
};
const variables = {
  server_id: serverId,
  db_endpoint: endpoint,
  db_api_key: apiKey,
};

fs.writeFileSync(
  path.join(dir, "permissions.json"),
  JSON.stringify(permissions, null, 2) + "\n"
);
fs.writeFileSync(
  path.join(dir, "variables.json"),
  JSON.stringify(variables, null, 2) + "\n"
);

// --- Print the snippets to paste --------------------------------------------
const svc = `bds-${serverId}`;
const portLine = hostPort
  ? `    ports:\n      - "${hostPort}:19132/udp"`
  : `    # Reached through the WaterdogPE proxy; no host port.\n    expose:\n      - "19132/udp"`;

const composeBlock = `  ${svc}:
    image: itzg/minecraft-bedrock-server
    environment:
      EULA: "TRUE"
      VERSION: "1.20.81"
      SERVER_NAME: ${serverId}
      LEVEL_NAME: world
      GAMEMODE: survival
      ONLINE_MODE: "false"
${portLine}
    volumes:
      - ./dev/${serverId}/data:/data
      - ./manifest.json:/data/behavior_packs/bedrock-database/manifest.json:ro
      - ./scripts:/data/behavior_packs/bedrock-database/scripts:ro
      - ./dev/world_behavior_packs.json:/data/worlds/world/world_behavior_packs.json
      - ./dev/${serverId}/permissions.json:/data/config/${scriptUuid}/permissions.json:ro
      - ./dev/${serverId}/variables.json:/data/config/${scriptUuid}/variables.json:ro
    stdin_open: true
    tty: true
    depends_on:
      - backend`;

const waterdogEntry = `  ${serverId}:
    address: ${svc}:19132
    server_type: bedrock`;

console.log(`\n✅ Created dev/${serverId}/permissions.json and dev/${serverId}/variables.json (serverId: "${serverId}")\n`);
console.log("─".repeat(70));
console.log("1) Add this service to docker-compose.dev.yml (under services:):\n");
console.log(composeBlock);
console.log("\n   ...and add the service name to waterdog's depends_on list.\n");
console.log("─".repeat(70));
console.log("2) Add this entry under `servers:` in dev/waterdog/config.yml:\n");
console.log(waterdogEntry);
console.log("\n   (Optionally add it to `listener.priorities` if it should be a landing server.)");
console.log("─".repeat(70));
