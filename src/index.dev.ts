import { world } from "@minecraft/server";
import { variables } from "@minecraft/server-admin";
import { SessionManager } from "./SessionManager";

/**
 * Two-server demo entry point. Build it with:
 *
 *   ENTRY=src/index.dev.ts npm run build
 *
 * Each BDS reads its own config from `@minecraft/server-admin` variables
 * (a `variables.json` in the script module's config folder), so the SAME
 * built pack behaves as different servers:
 *
 *   { "server_id": "survival-1",
 *     "db_endpoint": "http://backend:3000",
 *     "db_api_key": "super-secret" }
 *
 * Connect to both servers, earn coins by breaking blocks on one, then hop to
 * the other — your coins follow you. That's the cross-server sync working.
 */

function readVar<T>(name: string, fallback: T): T {
  try {
    const v = variables.get(name);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

const serverId = readVar<string>("server_id", "unknown-server");
const endpoint = readVar<string>("db_endpoint", "http://127.0.0.1:3000");
const apiKey = readVar<string | undefined>("db_api_key", undefined);

interface Profile {
  coins: number;
}

const profiles = new SessionManager<Profile>({
  endpoint,
  apiKey,
  serverId,
  tableName: "profiles",
  defaultData: () => ({ coins: 0 }),
  onLoad: (player, data) => {
    player.sendMessage(
      `§a[${serverId}] Loaded your data — §eCoins: ${data.coins}`
    );
  },
});

console.warn(`[DEV]: SessionManager started as "${serverId}" -> ${endpoint}`);

// Earn a coin per block broken; show the running total.
world.afterEvents.playerBreakBlock.subscribe(({ player }) => {
  const updated = profiles.update(player, (p) => ({ coins: p.coins + 1 }));
  if (updated) {
    player.onScreenDisplay.setActionBar(
      `§e${updated.coins} coins §7(${serverId})`
    );
  }
});

// /scriptevent demo:coins -> print current coins so you can verify the value
// matches after switching servers.
world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (initialSpawn) return;
  const p = profiles.get(player);
  if (p) player.sendMessage(`§b[${serverId}] Coins: ${p.coins}`);
});
