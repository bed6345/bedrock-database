import {
  EnchantmentType,
  EnchantmentTypes,
  ItemStack,
  Player,
  system,
  world,
  type Container,
  type EntityInventoryComponent,
} from "@minecraft/server";
import { NetworkDatabase } from "./NetworkDatabase";
import { AUTOSAVE_INTERVAL_TICKS } from "./config";

/**
 * Cross-server player sync.
 *
 * Player profiles (level, XP, health, inventory) are stored on the shared
 * backend keyed by gamertag, so when a player moves between servers their data
 * follows them. Profiles are autosaved on an interval because a player's
 * inventory can no longer be read once they have left.
 */

interface SerializedItem {
  slot: number;
  typeId: string;
  amount: number;
  nameTag?: string;
  lore?: string[];
  durability?: number;
  enchantments?: { id: string; level: number }[];
}

interface PlayerProfile {
  level: number;
  /** XP progress within the current level. */
  xp: number;
  health?: number;
  items: SerializedItem[];
  updatedAt: number;
}

const profiles = new NetworkDatabase<PlayerProfile>("profiles");

/**
 * Players whose profile is still being loaded. We skip autosaving them so a
 * default/empty state can't overwrite their real profile before it is applied.
 */
const loading = new Set<string>();

function getContainer(player: Player): Container | undefined {
  const inventory = player.getComponent(
    "minecraft:inventory"
  ) as EntityInventoryComponent | undefined;
  return inventory?.container ?? undefined;
}

// ---- Serialization ---------------------------------------------------------

function serializeItem(slot: number, item: ItemStack): SerializedItem {
  const out: SerializedItem = {
    slot,
    typeId: item.typeId,
    amount: item.amount,
  };

  if (item.nameTag) out.nameTag = item.nameTag;

  const lore = item.getLore();
  if (lore.length) out.lore = lore;

  const durability = item.getComponent("minecraft:durability");
  if (durability) out.durability = durability.damage;

  const enchantable = item.getComponent("minecraft:enchantable");
  if (enchantable) {
    const list = enchantable.getEnchantments();
    if (list.length) {
      out.enchantments = list.map((e) => ({ id: e.type.id, level: e.level }));
    }
  }

  return out;
}

function serialize(player: Player): PlayerProfile {
  const items: SerializedItem[] = [];
  const container = getContainer(player);
  if (container) {
    for (let slot = 0; slot < container.size; slot++) {
      const item = container.getItem(slot);
      if (item) items.push(serializeItem(slot, item));
    }
  }

  return {
    level: player.level,
    xp: player.xpEarnedAtCurrentLevel,
    health: player.getComponent("minecraft:health")?.currentValue,
    items,
    updatedAt: Date.now(),
  };
}

// ---- Deserialization -------------------------------------------------------

function deserializeItem(s: SerializedItem): ItemStack {
  const item = new ItemStack(s.typeId, s.amount);

  if (s.nameTag) item.nameTag = s.nameTag;
  if (s.lore) item.setLore(s.lore);

  if (s.durability != null) {
    const durability = item.getComponent("minecraft:durability");
    if (durability) durability.damage = s.durability;
  }

  if (s.enchantments) {
    const enchantable = item.getComponent("minecraft:enchantable");
    if (enchantable) {
      for (const e of s.enchantments) {
        const type: EnchantmentType | undefined = EnchantmentTypes.get(e.id);
        if (type) enchantable.addEnchantment({ type, level: e.level });
      }
    }
  }

  return item;
}

function apply(player: Player, profile: PlayerProfile): void {
  // Level + XP.
  player.resetLevel();
  if (profile.level > 0) player.addLevels(profile.level);
  if (profile.xp > 0) player.addExperience(profile.xp);

  // Health.
  if (profile.health != null) {
    player.getComponent("minecraft:health")?.setCurrentValue(profile.health);
  }

  // Inventory.
  const container = getContainer(player);
  if (container) {
    container.clearAll();
    for (const s of profile.items) {
      try {
        container.setItem(s.slot, deserializeItem(s));
      } catch (err) {
        console.warn(`[PlayerSync] Could not restore slot ${s.slot}: ${err}`);
      }
    }
  }
}

// ---- Save / load -----------------------------------------------------------

async function save(player: Player): Promise<void> {
  const name = player.name;
  if (loading.has(name)) return;
  try {
    await profiles.set(name, serialize(player));
  } catch (err) {
    console.warn(`[PlayerSync] Failed to save ${name}: ${err}`);
  }
}

function load(player: Player): void {
  const name = player.name;
  loading.add(name);
  profiles
    .get(name)
    .then((profile) => {
      if (profile) {
        // Apply on a fresh tick so we're never inside a read-only context.
        system.run(() => {
          if (player.isValid) apply(player, profile);
        });
      }
    })
    .catch((err) => console.warn(`[PlayerSync] Failed to load ${name}: ${err}`))
    .finally(() => loading.delete(name));
}

// ---- Wiring ----------------------------------------------------------------

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (initialSpawn) load(player);
});

// Autosave every online player on an interval. This is the snapshot that
// transfers when they switch servers.
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    void save(player);
  }
}, AUTOSAVE_INTERVAL_TICKS);
