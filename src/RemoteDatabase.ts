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

  /**
   * How many times to retry a failed request (network error or 5xx) before
   * giving up, using exponential backoff. Client errors (4xx) are never
   * retried.
   * @default 3
   */
  maxRetries?: number;

  /**
   * Base delay (ms) for retry backoff: attempt n waits ~`retryBaseMs * 2^n`.
   * @default 300
   */
  retryBaseMs?: number;

  /**
   * If `true`, a `set()` whose write ultimately fails (backend unreachable
   * even after retries) is kept in an in-memory buffer and re-sent
   * automatically once the backend recovers, instead of being lost. The
   * latest value per key wins. Note: this buffer lives in memory, so a
   * server crash while the backend is down still loses those writes.
   * @default true
   */
  bufferWrites?: boolean;
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
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly bufferWrites: boolean;

  /**
   * Local copy of the table. `null` until the first successful fetch.
   */
  private MEMORY: { [key: string]: T } | null = null;

  /**
   * Tasks waiting for the initial load, mirroring the queue system used by
   * the local {@link Database}.
   */
  private QUEUE: Array<() => void> = [];

  /**
   * Writes that failed while the backend was unreachable, keyed by key so
   * the latest value wins. Drained by a background flusher.
   */
  private pendingWrites = new Map<string, T>();
  private flushScheduled = false;

  constructor(public tableName: string, options: RemoteDatabaseOptions) {
    this.tableName = tableName;
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.useCache = options.cache ?? true;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 300;
    this.bufferWrites = options.bufferWrites ?? true;

    // Only pre-load the whole table when caching is on. With caching off
    // every read is a direct single-key fetch, so a full-table download
    // here would be wasted work (and won't scale on large tables).
    if (this.useCache) {
      this.refresh().catch((e) =>
        console.warn(`[REMOTE-DB]: Failed initial load of "${tableName}": ${e}`)
      );
    }

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
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.doRequest<R>(method, path, body);
      } catch (e: any) {
        lastError = e;
        // Don't retry client errors (4xx) — they won't get better.
        if (typeof e?.status === "number" && e.status >= 400 && e.status < 500) {
          throw e;
        }
        if (attempt < this.maxRetries) {
          await this.delay(this.retryBaseMs * Math.pow(2, attempt));
        }
      }
    }
    throw lastError;
  }

  /**
   * Performs a single HTTP attempt. Throws an error carrying the HTTP
   * `status` (when there was a response) so the retry layer can decide
   * whether the failure is worth retrying.
   */
  private async doRequest<R>(
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
      const err: any = new Error(`HTTP ${res.status}: ${res.body}`);
      err.status = res.status;
      throw err;
    }
    return JSON.parse(res.body) as ApiResponse<R>;
  }

  /**
   * Resolves after roughly `ms` milliseconds, using the tick scheduler
   * (1 tick ≈ 50ms). Used for retry backoff.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      system.runTimeout(resolve, Math.max(1, Math.ceil(ms / 50)));
    });
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
   *
   * If the write ultimately fails (backend unreachable even after retries)
   * and {@link RemoteDatabaseOptions.bufferWrites} is on, the value is kept
   * in an in-memory buffer and re-sent automatically once the backend
   * recovers — so a transient outage doesn't lose the write. The error is
   * still thrown so callers can react if they need to.
   * @returns once the backend has acknowledged the write.
   */
  async set(key: string, value: T): Promise<void> {
    if (this.useCache && this.MEMORY) this.MEMORY[key] = value;
    try {
      await this.writeKey(key, value);
    } catch (e) {
      if (!this.bufferWrites) throw e;
      this.pendingWrites.set(key, value);
      this.scheduleFlush();
      throw e;
    }
  }

  /**
   * Sends a single key's value to the backend (no buffering).
   */
  private async writeKey(key: string, value: T): Promise<void> {
    await this.request(
      HttpRequestMethod.Put,
      `/tables/${encodeURIComponent(this.tableName)}/${encodeURIComponent(key)}`,
      { value }
    );
  }

  /**
   * Starts a background loop that keeps retrying buffered writes until the
   * backend accepts them. No-op if already running or nothing is buffered.
   */
  private scheduleFlush(): void {
    if (this.flushScheduled || this.pendingWrites.size === 0) return;
    this.flushScheduled = true;
    const attempt = async () => {
      // Snapshot so concurrent set()s can keep adding to the live buffer.
      for (const [key, value] of [...this.pendingWrites]) {
        try {
          await this.writeKey(key, value);
          // Only clear if no newer value was buffered in the meantime.
          if (this.pendingWrites.get(key) === value)
            this.pendingWrites.delete(key);
        } catch {
          // Backend still down — wait and try the whole buffer again.
          await this.delay(this.retryBaseMs * 10);
          return attempt();
        }
      }
      this.flushScheduled = false;
      // A set() may have buffered more while we were flushing.
      if (this.pendingWrites.size > 0) this.scheduleFlush();
    };
    attempt();
  }

  /**
   * Number of writes currently buffered waiting for the backend to recover.
   * Useful for health checks / metrics.
   */
  pendingWriteCount(): number {
    return this.pendingWrites.size;
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
