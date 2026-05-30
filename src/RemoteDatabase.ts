import { system } from "@minecraft/server";
import {
  http,
  HttpRequest,
  HttpRequestMethod,
  HttpHeader,
} from "@minecraft/server-net";

/**
 * Options used to configure a {@link RemoteDatabase} instance.
 */
export interface RemoteDatabaseOptions {
  /**
   * The base URL of the central backend that both servers talk to.
   * @example "http://127.0.0.1:3000"
   */
  endpoint: string;

  /**
   * A shared secret sent in the `x-api-key` header on every request.
   * The backend should reject requests that don't match.
   */
  apiKey?: string;

  /**
   * Keep a local in-memory copy of the table so that the synchronous
   * {@link RemoteDatabase.get} style helpers work and reads are instant.
   * @default true
   */
  cache?: boolean;

  /**
   * If set (in seconds), the local cache is automatically refreshed from
   * the backend on this interval, so changes made on the *other* server
   * eventually show up here. Set to `0` to disable polling.
   * @default 0
   */
  pollInterval?: number;
}

/**
 * The shape of every response coming back from the reference backend.
 */
interface ApiResponse<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/**
 * A drop-in alternative to {@link Database} that stores its data on a
 * central HTTP backend instead of in world Dynamic Properties.
 *
 * Because the data lives outside of the world, multiple Bedrock Dedicated
 * Servers pointed at the same backend will share the same data — letting
 * you sync players, economies, etc. across servers.
 *
 * > Requires the `@minecraft/server-net` module, which is only available on
 * > Bedrock Dedicated Server (BDS), not on Realms or normal clients.
 */
export class RemoteDatabase<T extends any> {
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly useCache: boolean;

  /**
   * Local copy of the table. `null` until the first successful fetch.
   */
  private MEMORY: { [key: string]: T } | null = null;

  /**
   * Tasks waiting for the initial load, mirroring the queue system used by
   * the local {@link Database}.
   */
  private QUEUE: Array<() => void> = [];

  constructor(public tableName: string, options: RemoteDatabaseOptions) {
    this.tableName = tableName;
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.useCache = options.cache ?? true;

    // Kick off the initial load. Unlike the local Database this is genuinely
    // asynchronous, so the queue actually does work here.
    this.refresh().catch((e) =>
      console.warn(`[REMOTE-DB]: Failed initial load of "${tableName}": ${e}`)
    );

    const pollInterval = options.pollInterval ?? 0;
    if (this.useCache && pollInterval > 0) {
      system.runInterval(() => {
        this.refresh().catch((e) =>
          console.warn(`[REMOTE-DB]: Poll failed for "${tableName}": ${e}`)
        );
      }, Math.max(1, Math.floor(pollInterval * 20)));
    }
  }

  /**
   * Performs an HTTP request to the backend and parses the JSON response.
   * @param method - The HTTP verb to use.
   * @param path - Path appended to the configured endpoint.
   * @param body - Optional JSON body to send.
   */
  private async request<R>(
    method: HttpRequestMethod,
    path: string,
    body?: unknown
  ): Promise<ApiResponse<R>> {
    const req = new HttpRequest(`${this.endpoint}${path}`);
    req.method = method;
    const headers = [new HttpHeader("Content-Type", "application/json")];
    if (this.apiKey) headers.push(new HttpHeader("x-api-key", this.apiKey));
    req.headers = headers;
    if (body !== undefined) req.body = JSON.stringify(body);

    const res = await http.request(req);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}: ${res.body}`);
    }
    return JSON.parse(res.body) as ApiResponse<R>;
  }

  /**
   * Adds a queue task that resolves once the initial load has completed.
   */
  private addQueueTask(): Promise<void> {
    return new Promise((resolve) => {
      this.QUEUE.push(resolve);
    });
  }

  /**
   * Pulls the entire table down from the backend and refreshes the local
   * cache. Resolves the load queue on first success.
   * @returns the freshly fetched collection.
   */
  async refresh(): Promise<{ [key: string]: T }> {
    const res = await this.request<{ [key: string]: T }>(
      HttpRequestMethod.Get,
      `/tables/${encodeURIComponent(this.tableName)}`
    );
    const data = res.data ?? {};
    if (this.useCache) {
      this.MEMORY = data;
      // Release anyone waiting for the first load.
      const queue = this.QUEUE;
      this.QUEUE = [];
      queue.forEach((resolve) => resolve());
    }
    return data;
  }

  /**
   * Sets `key` to `value` on the backend (and updates the local cache).
   * @returns once the backend has acknowledged the write.
   */
  async set(key: string, value: T): Promise<void> {
    await this.request(
      HttpRequestMethod.Put,
      `/tables/${encodeURIComponent(this.tableName)}/${encodeURIComponent(key)}`,
      { value }
    );
    if (this.useCache && this.MEMORY) this.MEMORY[key] = value;
  }

  /**
   * Reads a value from the local cache. Throws if the cache is disabled or
   * not yet loaded — use {@link RemoteDatabase.getSync} in those cases.
   */
  get(key: string): T | null {
    if (!this.MEMORY)
      throw new Error(
        "Cache not loaded! Consider using `getSync` instead, or enable caching."
      );
    return this.MEMORY[key] ?? null;
  }

  /**
   * Reads a value, going to the backend if the cache isn't ready.
   * This is always safe to call, including on world load.
   */
  async getSync(key: string): Promise<T | null> {
    if (this.useCache && this.MEMORY) return this.MEMORY[key] ?? null;
    if (this.useCache) await this.addQueueTask();
    if (this.MEMORY) return this.MEMORY[key] ?? null;
    // Cache disabled — fetch this single key directly.
    const res = await this.request<{ value: T | null }>(
      HttpRequestMethod.Get,
      `/tables/${encodeURIComponent(this.tableName)}/${encodeURIComponent(key)}`
    );
    return res.data?.value ?? null;
  }

  /**
   * Deletes a key from the backend (and the local cache).
   * @returns `true` if the backend reports the key was removed.
   */
  async delete(key: string): Promise<boolean> {
    const res = await this.request<{ deleted: boolean }>(
      HttpRequestMethod.Delete,
      `/tables/${encodeURIComponent(this.tableName)}/${encodeURIComponent(key)}`
    );
    if (this.useCache && this.MEMORY) delete this.MEMORY[key];
    return res.data?.deleted ?? false;
  }

  /**
   * Checks if a key exists, asking the backend if the cache isn't ready.
   */
  async hasSync(key: string): Promise<boolean> {
    return (await this.getSync(key)) !== null;
  }

  /**
   * Returns every key in the table from the backend.
   */
  async keysSync(): Promise<string[]> {
    const data = this.useCache && this.MEMORY ? this.MEMORY : await this.refresh();
    return Object.keys(data);
  }

  /**
   * Returns every value in the table from the backend.
   */
  async valuesSync(): Promise<T[]> {
    const data = this.useCache && this.MEMORY ? this.MEMORY : await this.refresh();
    return Object.values(data);
  }

  /**
   * Returns the whole table as a plain object, refreshing from the backend
   * when the cache isn't ready.
   */
  async collectionSync(): Promise<{ [key: string]: T }> {
    if (this.useCache && this.MEMORY) return this.MEMORY;
    return this.refresh();
  }

  /**
   * Atomically adds `amount` to a numeric key on the backend without a
   * read-modify-write round trip, avoiding the classic lost-update race
   * when two servers touch the same key at once.
   * @returns the new value after incrementing.
   */
  async increment(key: string, amount = 1): Promise<number> {
    const res = await this.request<{ value: number }>(
      HttpRequestMethod.Post,
      `/tables/${encodeURIComponent(this.tableName)}/${encodeURIComponent(
        key
      )}/increment`,
      { amount }
    );
    const value = res.data?.value ?? 0;
    if (this.useCache && this.MEMORY) (this.MEMORY as any)[key] = value;
    return value;
  }

  /**
   * Tries to acquire a lock for `owner` (e.g. a player id) on behalf of
   * `holder` (e.g. this server's id). Re-acquiring with the same holder
   * refreshes the TTL, so it doubles as a heartbeat.
   * @param owner - The resource being locked, usually a player id.
   * @param holder - Who is taking the lock, usually this server's id.
   * @param ttlSeconds - How long the lock survives without a refresh. The
   *   TTL means a crashed server's locks free themselves automatically.
   * @returns `{ acquired, heldBy }` — `acquired` is `false` if another
   *   holder currently owns the lock.
   */
  async acquireLock(
    owner: string,
    holder: string,
    ttlSeconds = 120
  ): Promise<{ acquired: boolean; heldBy: string }> {
    const res = await this.request<{ acquired: boolean; heldBy: string }>(
      HttpRequestMethod.Put,
      `/locks/${encodeURIComponent(owner)}`,
      { holder, ttl: ttlSeconds }
    );
    return res.data ?? { acquired: false, heldBy: "" };
  }

  /**
   * Releases a lock previously taken by `holder`. A no-op if someone else
   * holds it.
   * @returns `true` if the lock was actually released.
   */
  async releaseLock(owner: string, holder: string): Promise<boolean> {
    const res = await this.request<{ released: boolean }>(
      HttpRequestMethod.Delete,
      `/locks/${encodeURIComponent(owner)}`,
      { holder }
    );
    return res.data?.released ?? false;
  }

  /**
   * Clears every key in the table on the backend (and the local cache).
   */
  async clear(): Promise<void> {
    await this.request(
      HttpRequestMethod.Delete,
      `/tables/${encodeURIComponent(this.tableName)}`
    );
    if (this.useCache) this.MEMORY = {};
  }
}
