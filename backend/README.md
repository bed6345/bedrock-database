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

## Running

```bash
# from the repo root
node backend/server.js
```

Configure it with environment variables:

| Variable  | Default              | Description                                  |
| --------- | -------------------- | -------------------------------------------- |
| `PORT`    | `3000`               | Port to listen on.                           |
| `API_KEY` | _(empty)_            | Shared secret. Sent as the `x-api-key` header. |
| `DB_FILE` | `backend/data.json`  | Path to the JSON storage file.               |

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

## Production notes

This is a **reference implementation** meant to be clear, not bulletproof.
For real deployments consider:

- Swapping the JSON file for **Redis / MySQL / MongoDB** for durability and
  concurrent-write safety.
- Putting it behind **HTTPS** (a reverse proxy like Caddy/Nginx) instead of
  plain HTTP, especially if the servers talk over the internet.
- Per-key **locking or transactions** if you do read-modify-write beyond the
  provided atomic `increment`.
