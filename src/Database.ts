import { world } from "@minecraft/server";

/**
 * Tracks whether the world has finished loading.
 *
 * In `@minecraft/server` 2.x, scripts run in an "early execution" phase
 * before the world is available. Reading or writing dynamic properties
 * during that phase throws, so every {@link Database} must defer its
 * initial load until the `worldLoad` event has fired.
 */
let WORLD_HAS_LOADED = false;
world.afterEvents.worldLoad.subscribe(() => {
  WORLD_HAS_LOADED = true;
});

export class Database<T = any> {
  /**
   * Data saved in memory. `null` until the table has loaded from storage.
   */
  private MEMORY: { [key: string]: T } | null;

  /**
   * Queue of tasks waiting for this table to finish loading.
   */
  private QUEUE: Array<() => void>;

  /**
   * Callback to run once the database data has been fetched.
   */
  private onLoadCallback?: (data: { [key: string]: T }) => void;

  /**
   * Creates a new instance of the Database.
   *
   * Loading is deferred until the world is ready so it is safe to construct
   * tables at the top level of a script (during early execution).
   * @param tableName - The name of the table
   */
  constructor(public readonly tableName: string) {
    this.MEMORY = null;
    this.QUEUE = [];

    if (WORLD_HAS_LOADED) {
      // Constructed at runtime, after the world is already available.
      this.load();
    } else {
      // Constructed during early execution; wait for the world to load.
      world.afterEvents.worldLoad.subscribe(() => this.load());
    }
  }

  /**
   * Loads data from storage into memory, runs the onLoad callback, and
   * flushes any tasks that were queued while waiting for the world to load.
   */
  private load(): void {
    if (this.MEMORY) return;
    this.MEMORY = this.fetch();

    this.onLoadCallback?.(this.MEMORY);

    const queue = this.QUEUE;
    this.QUEUE = [];
    for (const resolve of queue) resolve();
  }

  /**
   * Resets this databases key length
   * and resets all corresponding ids.
   */
  private resetStorage(): void {
    const ids = world
      .getDynamicPropertyIds()
      .filter((i) => i.startsWith(`db_${this.tableName}`));
    for (const id of ids) {
      world.setDynamicProperty(id, undefined);
    }
    world.setDynamicProperty(`db_${this.tableName}`, 0); // Reset key length
  }

  /**
   * Fetches this data from the dynamic properties
   * associated with this database.
   */
  private fetch(): { [key: string]: T } {
    let idLength = world.getDynamicProperty(`db_${this.tableName}`) ?? 0;
    if (typeof idLength != "number") {
      console.warn(
        `[DATABASE]: DB: ${this.tableName}, has improper setup! Resetting data.`
      );
      idLength = 0;
      this.resetStorage();
    }
    if (idLength <= 0) return {};

    let collectedData = "";
    for (let i = 0; i < idLength; i++) {
      const data = world.getDynamicProperty(`db_${this.tableName}_${i}`);
      if (typeof data != "string") {
        console.warn(
          `[DATABASE]: When fetching: db_${this.tableName}_${i}, improper data was found.`
        );
        this.resetStorage();
        return {};
      }
      collectedData += data;
    }

    try {
      return JSON.parse(collectedData);
    } catch (error) {
      console.warn(
        `[DATABASE]: DB: ${this.tableName}, contains corrupt JSON and could not be parsed! Resetting data. ${error}`
      );
      this.resetStorage();
      return {};
    }
  }

  /**
   * Adds a queue task to be awaited.
   * @returns once it is this items time to run in queue (i.e. once loaded)
   */
  private addQueueTask(): Promise<void> {
    return new Promise((resolve) => {
      this.QUEUE.push(resolve);
    });
  }

  /**
   * Saves the in-memory data into this database's dynamic properties.
   *
   * Data is chunked because a single dynamic property string is byte
   * limited. Any chunks left over from a previously larger dataset are
   * removed so storage is not leaked after deletions.
   */
  private saveData(): void {
    if (!this.MEMORY) return;

    // `[\s\S]` (not `.`) is used so line/paragraph separators that
    // `JSON.stringify` emits literally (U+2028 / U+2029) are not dropped.
    const chunks = JSON.stringify(this.MEMORY).match(/[\s\S]{1,8000}/g) ?? [];
    const previousLength = world.getDynamicProperty(`db_${this.tableName}`);

    world.setDynamicProperty(`db_${this.tableName}`, chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      world.setDynamicProperty(`db_${this.tableName}_${i}`, chunks[i]);
    }

    // Clean up orphaned chunks left over from a previously larger dataset.
    if (typeof previousLength === "number") {
      for (let i = chunks.length; i < previousLength; i++) {
        world.setDynamicProperty(`db_${this.tableName}_${i}`, undefined);
      }
    }
  }

  /**
   * Sends a callback once this database has loaded its data.
   * @param callback
   */
  onLoad(callback: (data: { [key: string]: T }) => void): void {
    if (this.MEMORY) return callback(this.MEMORY);
    this.onLoadCallback = callback;
  }

  /**
   * Sets the specified `key` to the given `value` in the database table.
   * @param key - Key to store the value in.
   * @param value - The value to store for the specified key.
   * @returns A promise that resolves once the value has been saved in the database table.
   */
  async set(key: string, value: T): Promise<void> {
    if (!this.MEMORY) await this.addQueueTask();
    this.MEMORY![key] = value;
    this.saveData();
  }

  /**
   * Gets a value from this table synchronously.
   *
   * @param key - The key to retrieve the value for.
   * @returns the value associated with the given key, or `undefined` if absent.
   */
  get(key: string): T | undefined {
    if (!this.MEMORY)
      throw new Error("Data not loaded! Consider using `getSync` instead!");
    return this.MEMORY[key];
  }

  /**
   * Gets a value asynchronously, awaiting the table load if necessary.
   * This should be used when data may be requested before the world has loaded.
   * @param key - The key to retrieve the value for.
   * @returns A Promise that resolves to the value associated with the given key.
   */
  async getSync(key: string): Promise<T | undefined> {
    if (!this.MEMORY) await this.addQueueTask();
    return this.MEMORY![key];
  }

  /**
   * Get all the keys in the table
   * @returns the keys on this table
   */
  keys(): string[] {
    if (!this.MEMORY)
      throw new Error("Data not loaded! Consider using `keysSync` instead!");
    return Object.keys(this.MEMORY);
  }

  /**
   * Get all the keys in the table async, this should be used on world load
   * @returns the keys on this table
   */
  async keysSync(): Promise<string[]> {
    if (!this.MEMORY) await this.addQueueTask();
    return Object.keys(this.MEMORY!);
  }

  /**
   * Get all the values in the table
   * @returns values in this table
   */
  values(): T[] {
    if (!this.MEMORY)
      throw new Error("Data not loaded! Consider using `valuesSync` instead!");
    return Object.values(this.MEMORY);
  }

  /**
   * Get all the values in the table async, this should be used on world load
   * @returns the values on this table
   */
  async valuesSync(): Promise<T[]> {
    if (!this.MEMORY) await this.addQueueTask();
    return Object.values(this.MEMORY!);
  }

  /**
   * Check if the key exists in the table.
   * @param key the key to test
   * @returns whether this key exists on this table
   */
  has(key: string): boolean {
    if (!this.MEMORY)
      throw new Error("Data not loaded! Consider using `hasSync` instead!");
    return Object.prototype.hasOwnProperty.call(this.MEMORY, key);
  }

  /**
   * Check if the key exists in the table async.
   * @param key the key to test
   * @returns whether this table contains this key.
   */
  async hasSync(key: string): Promise<boolean> {
    if (!this.MEMORY) await this.addQueueTask();
    return Object.prototype.hasOwnProperty.call(this.MEMORY!, key);
  }

  /**
   * Gets a shallow copy of all the keys and values.
   *
   * A copy is returned so callers cannot mutate the internal state without
   * going through {@link set} (which would otherwise never be persisted).
   * @returns The collection data.
   */
  collection(): { [key: string]: T } {
    if (!this.MEMORY)
      throw new Error(
        "Data not loaded! Consider using `collectionSync` instead!"
      );
    return { ...this.MEMORY };
  }

  /**
   * Gets a shallow copy of all the keys and values async, this should be used on world load.
   * @returns The collection data.
   */
  async collectionSync(): Promise<{ [key: string]: T }> {
    if (!this.MEMORY) await this.addQueueTask();
    return { ...this.MEMORY! };
  }

  /**
   * Delete a key from this table.
   * @param key the key to delete
   * @returns whether the key existed and was deleted
   */
  async delete(key: string): Promise<boolean> {
    if (!this.MEMORY) await this.addQueueTask();
    if (!Object.prototype.hasOwnProperty.call(this.MEMORY, key)) return false;
    delete this.MEMORY![key];
    this.saveData();
    return true;
  }

  /**
   * Clear everything in the table.
   * @returns once this table has been cleared
   */
  async clear(): Promise<void> {
    if (!this.MEMORY) await this.addQueueTask();
    this.MEMORY = {};
    this.saveData();
  }

  /**
   * Gets the first key associated with the given value.
   * @param value
   * @returns the key, or `null` if the value is not found
   */
  getKeyByValue(value: T): string | null {
    if (!this.MEMORY) return null;
    for (const key in this.MEMORY) {
      if (this.MEMORY[key] === value) {
        return key;
      }
    }
    return null; // value not found in object
  }
}
