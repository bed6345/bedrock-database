import {
  HttpHeader,
  HttpRequest,
  HttpRequestMethod,
  http,
} from "@minecraft/server-net";
import { API_TOKEN, BACKEND_URL } from "./config";

/**
 * A drop-in, network-backed counterpart to {@link Database}. Instead of storing
 * data in this world's Dynamic Properties, every operation is sent to the
 * shared backend over HTTP, so all servers pointed at the same backend see the
 * same data.
 *
 * Every method is asynchronous because the value lives on another process.
 *
 * NOTE: `@minecraft/server-net` only works on Bedrock Dedicated Server, and the
 * module must be allow-listed in the server's permissions.json.
 */
export class NetworkDatabase<T = any> {
  /**
   * @param tableName - The logical table this instance reads from / writes to.
   */
  constructor(public tableName: string) {}

  private async call<R>(op: string, key?: string, value?: T): Promise<R> {
    const request = new HttpRequest(`${BACKEND_URL}/db`);
    request.method = HttpRequestMethod.POST;
    request.headers = [
      new HttpHeader("Content-Type", "application/json"),
      new HttpHeader("x-api-token", API_TOKEN),
    ];
    request.body = JSON.stringify({ op, table: this.tableName, key, value });

    const response = await http.request(request);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `[NetworkDatabase] ${op} failed: HTTP ${response.status} ${response.body}`
      );
    }

    const parsed = JSON.parse(response.body) as
      | { ok: true; result: R }
      | { ok: false; error: string };
    if (!parsed.ok) {
      throw new Error(`[NetworkDatabase] ${op} error: ${parsed.error}`);
    }
    return parsed.result;
  }

  /** Stores `value` under `key` on the shared backend. */
  set(key: string, value: T): Promise<void> {
    return this.call<void>("set", key, value);
  }

  /** Reads `key` from the shared backend, or `null` if it does not exist. */
  get(key: string): Promise<T | null> {
    return this.call<T | null>("get", key);
  }

  /** Whether `key` exists on the shared backend. */
  has(key: string): Promise<boolean> {
    return this.call<boolean>("has", key);
  }

  /** Deletes `key`, resolving to whether it previously existed. */
  delete(key: string): Promise<boolean> {
    return this.call<boolean>("delete", key);
  }

  /** All keys in this table. */
  keys(): Promise<string[]> {
    return this.call<string[]>("keys");
  }

  /** All values in this table. */
  values(): Promise<T[]> {
    return this.call<T[]>("values");
  }

  /** The full table as a plain object. */
  collection(): Promise<{ [key: string]: T }> {
    return this.call<{ [key: string]: T }>("collection");
  }

  /** Empties this table. */
  clear(): Promise<void> {
    return this.call<void>("clear");
  }
}
