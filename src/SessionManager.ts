import { Player, system, world } from "@minecraft/server";
import { RemoteDatabase, RemoteDatabaseOptions } from "./RemoteDatabase";

/**
 * Options for a {@link SessionManager}.
 */
export interface SessionManagerOptions<T> extends RemoteDatabaseOptions {
  /**
   * A unique id for THIS server (e.g. "lobby", "survival-1"). Used as the
   * lock holder so we can tell which server currently owns a player.
   */
  serverId: string;

  /**
   * Name of the backend table that holds player data.
   * @default "players"
   */
  tableName?: string;

  /**
   * Produces fresh data for a player who has never been seen before.
   */
  defaultData: (player: Player) => T;

  /**
   * How often (seconds) to also save every online player's data back to the
   * backend as a crash-safety net, on top of the guaranteed save when they
   * switch servers (leave). `0` means only save on leave and on explicit
   * {@link SessionManager.save} calls — note that a server crash would then
   * lose any unsaved progress for that session.
   *
   * This does NOT affect lock keep-alive: locks are always refreshed by a
   * separate lightweight heartbeat (see {@link lockTtlSeconds}).
   * @default 0
   */
  autoSaveSeconds?: number;

  /**
   * How long (seconds) a player lock survives without a refresh. A separate
   * heartbeat refreshes it roughly every `lockTtlSeconds / 2`, so a player
   * who stays online never loses their lock. If a server crashes, the lock
   * frees itself after this long.
   * @default 120
   */
  lockTtlSeconds?: number;

  /**
   * Called when the player's lock is held by another server — meaning they
   * are (or recently were) on a different server and we can't safely load
   * their data yet. Default behaviour: warn them and kick.
   */
  onLockBusy?: (player: Player, heldBy: string) => void;

  /**
   * Called once a player's data has loaded and is ready to use, e.g. to
   * apply their saved state to the in-game player.
   */
  onLoad?: (player: Player, data: T) => void;
}

/**
 * Implements the recommended "session handoff" pattern for syncing player
 * data across multiple Bedrock Dedicated Servers:
 *
 *   - On join: acquire a per-player lock, then load their data from the
 *     central backend into memory.
 *   - During play: read/write that data instantly from memory.
 *   - Periodically: auto-save online players (and refresh their locks).
 *   - On leave: save their data, then release the lock.
 *
 * Because a player only holds a lock on one server at a time, this avoids
 * the lost-update races you'd get from naive live syncing.
 */
export class SessionManager<T> {
  private readonly db: RemoteDatabase<T>;
  private readonly serverId: string;
  private readonly defaultData: (player: Player) => T;
  private readonly lockTtlSeconds: number;
  private readonly onLockBusy: (player: Player, heldBy: string) => void;
  private readonly onLoadCallback?: (player: Player, data: T) => void;

  /**
   * Live, in-memory data for players currently on THIS server.
   */
  private readonly sessions = new Map<string, T>();

  constructor(options: SessionManagerOptions<T>) {
    this.serverId = options.serverId;
    this.defaultData = options.defaultData;
    this.lockTtlSeconds = options.lockTtlSeconds ?? 120;
    this.onLoadCallback = options.onLoad;
    this.onLockBusy =
      options.onLockBusy ??
      ((player, heldBy) => {
        console.warn(
          `[SESSION]: ${player.name}'s data is locked by "${heldBy}". Kicking.`
        );
        player.sendMessage(
          "§cYour data is still in use on another server. Please try again in a moment."
        );
        // No direct kick API across all versions; /kick by name is reliable.
        try {
          world
            .getDimension("overworld")
            .runCommand(`kick "${player.name}" Data is loading on another server`);
        } catch {}
      });

    // SessionManager keeps its own per-player `sessions` map, so the
    // underlying RemoteDatabase must NOT cache the whole table — every
    // load/save touches only a single player's key. This is what lets it
    // scale to hundreds of players without O(n) downloads on each join.
    this.db = new RemoteDatabase<T>(options.tableName ?? "players", {
      ...options,
      cache: false,
      pollInterval: 0,
    });

    this.registerEvents(options.autoSaveSeconds ?? 0);
  }

  private registerEvents(autoSaveSeconds: number) {
    // Load on (initial) join.
    world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
      if (!initialSpawn) return;
      this.load(player).catch((e) =>
        console.warn(`[SESSION]: Failed to load ${player.name}: ${e}`)
      );
    });

    // Save + release on leave. afterEvents gives us the id even though the
    // Player object is already gone — and our authoritative data lives in
    // `sessions`, so that's all we need.
    world.afterEvents.playerLeave.subscribe(({ playerId, playerName }) => {
      this.unload(playerId, playerName).catch((e) =>
        console.warn(`[SESSION]: Failed to save ${playerName}: ${e}`)
      );
    });

    // Lightweight lock heartbeat — always on. Refreshes each online
    // player's lock TTL without writing data, so locks never expire while
    // someone is still playing (independent of whether auto-save is on).
    const heartbeatSeconds = Math.max(1, this.lockTtlSeconds / 2);
    system.runInterval(() => {
      this.heartbeat().catch((e) =>
        console.warn(`[SESSION]: Lock heartbeat failed: ${e}`)
      );
    }, Math.max(1, Math.floor(heartbeatSeconds * 20)));

    // Optional periodic data save as a crash-safety net. Off by default —
    // data is otherwise saved on leave (server switch) and via save().
    if (autoSaveSeconds > 0) {
      system.runInterval(() => {
        this.saveAll().catch((e) =>
          console.warn(`[SESSION]: Auto-save failed: ${e}`)
        );
      }, Math.max(1, Math.floor(autoSaveSeconds * 20)));
    }
  }

  /**
   * Acquires the player's lock and loads their data into memory.
   */
  private async load(player: Player): Promise<void> {
    const id = player.id;
    const lock = await this.db.acquireLock(
      id,
      this.serverId,
      this.lockTtlSeconds
    );
    if (!lock.acquired) {
      this.onLockBusy(player, lock.heldBy);
      return;
    }

    // Fetch only THIS player's key (cache is off), not the whole table.
    let data = await this.db.getSync(id);
    if (data === null) {
      data = this.defaultData(player);
      await this.db.set(id, data);
    }
    this.sessions.set(id, data);
    this.onLoadCallback?.(player, data);
  }

  /**
   * Saves the player's data and releases their lock.
   */
  private async unload(playerId: string, _playerName: string): Promise<void> {
    const data = this.sessions.get(playerId);
    if (data !== undefined) await this.db.set(playerId, data);
    this.sessions.delete(playerId);
    await this.db.releaseLock(playerId, this.serverId);
  }

  /**
   * Refreshes the lock TTL for every online player without writing data.
   * Cheap keep-alive so locks don't expire mid-session.
   */
  private async heartbeat(): Promise<void> {
    for (const id of this.sessions.keys()) {
      // Re-acquiring as the same holder just bumps the TTL.
      await this.db.acquireLock(id, this.serverId, this.lockTtlSeconds);
    }
  }

  /**
   * Saves every online player's data back to the backend (crash-safety net).
   */
  private async saveAll(): Promise<void> {
    for (const [id, data] of this.sessions) {
      await this.db.set(id, data);
    }
  }

  /**
   * Gets a player's in-memory session data. Returns `null` if their data
   * hasn't loaded yet (e.g. called too early, or the lock was busy).
   */
  get(player: Player): T | null {
    return this.sessions.get(player.id) ?? null;
  }

  /**
   * Replaces a player's in-memory session data. Persisted on the next
   * auto-save or when they leave. Use {@link SessionManager.save} to flush
   * immediately for important changes.
   */
  set(player: Player, data: T): void {
    this.sessions.set(player.id, data);
  }

  /**
   * Mutates a player's data in place via an updater, then keeps it in
   * memory. Convenient for the common read-modify-write on the same server.
   * @returns the updated data, or `null` if not loaded yet.
   */
  update(player: Player, updater: (data: T) => T): T | null {
    const current = this.sessions.get(player.id);
    if (current === undefined) return null;
    const next = updater(current);
    this.sessions.set(player.id, next);
    return next;
  }

  /**
   * Immediately flushes a single player's data to the backend. Use this for
   * changes you can't afford to lose if the server crashes before the next
   * auto-save (e.g. a completed purchase).
   */
  async save(player: Player): Promise<void> {
    const data = this.sessions.get(player.id);
    if (data !== undefined) await this.db.set(player.id, data);
  }
}
