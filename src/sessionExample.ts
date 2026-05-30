import { world } from "@minecraft/server";
import { SessionManager } from "./SessionManager";

/**
 * Example: syncing a simple economy + rank across two Bedrock Dedicated
 * Servers using the session-handoff pattern.
 *
 * This file is documentation only — it is NOT imported by `index.ts`, so it
 * won't be bundled unless you wire it in yourself. To use it, point both
 * servers at the same backend and give each a unique `serverId`.
 */

interface PlayerProfile {
  coins: number;
  rank: string;
}

const profiles = new SessionManager<PlayerProfile>({
  endpoint: "http://127.0.0.1:3000",
  apiKey: "super-secret",
  serverId: "survival-1", // <-- change per server, e.g. "lobby", "survival-2"
  tableName: "profiles",
  autoSaveSeconds: 60,
  lockTtlSeconds: 120,

  // First-time players start here.
  defaultData: () => ({ coins: 0, rank: "Newbie" }),

  // Runs once their saved data has loaded — apply it to the player.
  onLoad: (player, data) => {
    player.sendMessage(
      `§aWelcome back! Coins: §e${data.coins}§a, Rank: §b${data.rank}`
    );
    player.nameTag = `[${data.rank}] ${player.name}`;
  },
});

// Give coins for breaking blocks — reads/writes happen instantly in memory,
// and sync across servers because the data is loaded/saved on join/leave.
world.afterEvents.playerBreakBlock.subscribe(({ player }) => {
  const updated = profiles.update(player, (p) => ({ ...p, coins: p.coins + 1 }));
  if (updated) player.onScreenDisplay.setActionBar(`§eCoins: ${updated.coins}`);
});

// A purchase is important — flush it to the backend immediately rather than
// waiting for the next auto-save.
async function buyRank(player: Parameters<typeof profiles.set>[0]) {
  const profile = profiles.get(player);
  if (!profile || profile.coins < 100) {
    player.sendMessage("§cYou need 100 coins to buy VIP.");
    return;
  }
  profiles.set(player, { coins: profile.coins - 100, rank: "VIP" });
  player.nameTag = `[VIP] ${player.name}`;
  await profiles.save(player); // persist now — don't risk losing a purchase
  player.sendMessage("§aYou are now §bVIP§a!");
}

export { profiles, buyRank };
