# RemoteDatabase Backend

A tiny zero-dependency HTTP server that lets **multiple Bedrock Dedicated
Servers share the same data**. Both servers point their `RemoteDatabase`
instances at this backend, so a write on one server is instantly readable on
the other.

```
   BDS Server A ──┐
                  ├──►  this backend  ──►  data.json
   BDS Server B ──┘
```

> **Note:** This only works on **Bedrock Dedicated Server (BDS)**, because the
> `@minecraft/server-net` module that `RemoteDatabase` relies on is not
> available on Realms or normal Minecraft clients.

## Two backends, same API

| File              | Storage        | Use for                                    |
| ----------------- | -------------- | ------------------------------------------ |
| `server.js`       | JSON file      | Quick start / small servers (zero deps).   |
| `server.redis.js` | Redis          | **100-200 players / production.**          |

Both speak the **exact same HTTP API**, so you can switch between them
without changing any Minecraft-side code.

## Running

```bash
# JSON file backend (zero dependencies)
node backend/server.js          # or: npm run backend

# Redis backend (needs Redis running + `npm install redis`)
node backend/server.redis.js    # or: npm run backend:redis
```

Configure it with environment variables:

| Variable    | Backend | Default                  | Description                              |
| ----------- | ------- | ------------------------ | ---------------------------------------- |
| `PORT`      | both    | `3000`                   | Port to listen on.                       |
| `API_KEY`   | both    | _(empty)_                | Shared secret. Sent as `x-api-key`.      |
| `DB_FILE`   | JSON    | `backend/data.json`      | Path to the JSON storage file.           |
| `REDIS_URL` | Redis   | `redis://127.0.0.1:6379` | Redis connection string.                 |

```bash
PORT=8080 API_KEY=super-secret node backend/server.js
```

## Using it from a behavior pack

```ts
import { RemoteDatabase } from "./RemoteDatabase";

const money = new RemoteDatabase<number>("money", {
  endpoint: "http://127.0.0.1:3000",
  apiKey: "super-secret",
  pollInterval: 5, // refresh cache from the backend every 5 seconds
});

// Works the same on Server A and Server B:
await money.set(player.id, 100);
const coins = await money.getSync(player.id);

// Use increment() for shared counters to avoid lost updates when both
// servers change the same key at the same time:
await money.increment(player.id, 10);
```

## HTTP API

| Method   | Path                                  | Purpose                                  |
| -------- | ------------------------------------- | ---------------------------------------- |
| `GET`    | `/tables/:table`                      | Fetch the whole table.                   |
| `DELETE` | `/tables/:table`                      | Clear the whole table.                   |
| `GET`    | `/tables/:table/:key`                 | Read a single key.                       |
| `PUT`    | `/tables/:table/:key`                 | Set a key (`{ "value": ... }`).          |
| `DELETE` | `/tables/:table/:key`                 | Delete a key.                            |
| `POST`   | `/tables/:table/:key/increment`       | Atomic add (`{ "amount": n }`).          |
| `PUT`    | `/locks/:owner`                       | Acquire/refresh a lock (`{ "holder", "ttl" }`). |
| `DELETE` | `/locks/:owner`                       | Release a lock (`{ "holder" }`).         |

Every response is JSON shaped like `{ "ok": true, "data": ... }`.

## Syncing player data across servers (Session Handoff)

The recommended way to share **per-player** data (coins, rank, inventory…)
across servers is the *session handoff* pattern, implemented by
`SessionManager`:

```
On join  ──► acquire lock(player) ──► load data into memory
During play ──► read/write in memory (instant) + lock heartbeat
On leave ──► save data ──► release lock(player)
```

By default, data is saved **when the player switches servers (leaves)** and
whenever you call `save(player)` — there is no periodic auto-save. A separate
lightweight heartbeat keeps the lock alive while they play, so locks never
expire mid-session. If you want an extra crash-safety net, set
`autoSaveSeconds` to e.g. `60`.

Because a player only holds their lock on **one server at a time**, you avoid
the lost-update races of naive live syncing. Locks have a **TTL**, so if a
server crashes the lock frees itself automatically.

```ts
import { SessionManager } from "./SessionManager";

const profiles = new SessionManager<{ coins: number; rank: string }>({
  endpoint: "http://127.0.0.1:3000",
  apiKey: "super-secret",
  serverId: "survival-1", // unique per server
  defaultData: () => ({ coins: 0, rank: "Newbie" }),
  onLoad: (player, data) => player.sendMessage(`Coins: ${data.coins}`),
});

// During play — instant, in-memory:
profiles.update(player, (p) => ({ ...p, coins: p.coins + 1 }));

// Important change you can't lose — flush immediately:
await profiles.save(player);
```

See [`src/sessionExample.ts`](../src/sessionExample.ts) for a fuller example.

> **Give each server a unique `serverId`.** That's how the backend knows who
> currently owns a player's lock.

## Scaling to 100-200 players

`SessionManager` is built to scale: it only ever touches **a single player's
key** on join/leave/save — never the whole table — so cost grows linearly
with online players, not quadratically.

Per-player request volume:

| When           | Requests                                  |
| -------------- | ----------------------------------------- |
| Join           | 1 lock + 1 read (+1 write for new players)|
| During play    | 1 lock heartbeat every `lockTtlSeconds/2` |
| Save (on leave)| 1 write + 1 lock release                  |

At 200 players that's roughly **200 heartbeat requests per minute** (~3-4/s)
plus join/leave traffic. The reference backend handles a 200-player join
burst (600 requests) in under a second.

The likely ceiling is **not** the backend but Minecraft's `@minecraft/server-net`,
which throttles outbound HTTP. To stay well under it:

- Keep auto-save off (the default) — save on leave + `save()` only.
- Don't lower `lockTtlSeconds` too far; a larger TTL means fewer heartbeats.
- Avoid whole-table calls (`keysSync`/`valuesSync`/`collectionSync`) on hot
  paths — they download everything.
- For a big restart (everyone reconnecting at once), the join burst is the
  heaviest moment; the lock TTL ensures stale locks from the old session
  expire so reconnects succeed.

## Production notes

This is a **reference implementation** meant to be clear, not bulletproof.
For real deployments at 100-200 players consider:

- Using the **Redis backend** (`server.redis.js`) instead of the JSON file —
  it uses native atomic `HINCRBYFLOAT` and `SET NX PX`-style locks (via Lua),
  avoids rewriting a whole file on each change, and handles concurrent writes
  safely. In a 200-player join-burst test it completed in ~0.6s.
- Putting it behind **HTTPS** (a reverse proxy like Caddy/Nginx) instead of
  plain HTTP, especially if the servers talk over the internet.
- Per-key **locking or transactions** if you do read-modify-write beyond the
  provided atomic `increment`.

This is a **reference implementation** meant to be clear, not bulletproof.
For real deployments consider:

- Swapping the JSON file for **Redis / MySQL / MongoDB** for durability and
  concurrent-write safety.
- Putting it behind **HTTPS** (a reverse proxy like Caddy/Nginx) instead of
  plain HTTP, especially if the servers talk over the internet.
- Per-key **locking or transactions** if you do read-modify-write beyond the
  provided atomic `increment`.
