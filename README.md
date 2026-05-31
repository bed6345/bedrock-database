# Bedrock Database

A Minecraft Bedrock data layer for Script API add-ons — from a single-world
key/value store all the way up to **syncing player data across multiple
Bedrock Dedicated Servers**.

It comes in two layers you can mix and match:

| Layer | Class | Stores data in | Use it for |
| ----- | ----- | -------------- | ---------- |
| **Local** | `Database` | World **Dynamic Properties** | Single world. Fast, offline, unlimited storage via chunking. |
| **Networked** | `RemoteDatabase` | A central **HTTP backend** | Sharing data across servers (economies, ranks, stats). |
| **Player sync** | `SessionManager` | `RemoteDatabase` + locks | The "lobby + survival" network model: data follows the player. |

---

## Which one do I need?

```
Do you have more than one server that must share data?
│
├─ No  ──▶ use `Database`        (src/Database.ts)   — nothing else needed
│
└─ Yes ──▶ run the backend, then:
            ├─ syncing arbitrary keys?   use `RemoteDatabase`  (src/RemoteDatabase.ts)
            └─ syncing per-player data?  use `SessionManager`  (src/SessionManager.ts)
```

> The networked layers require `@minecraft/server-net`, which only exists on
> **Bedrock Dedicated Server (BDS)** — not Realms or normal clients.

---

## Cross-server architecture

```
        client ──▶ ┌────────────┐  (optional WaterdogPE proxy)
                   └─────┬──────┘
              ┌──────────┴──────────┐
        ┌─────▼────┐           ┌─────▼────┐
        │  BDS A   │           │  BDS B   │   each runs the behavior pack
        │survival-1│           │survival-2│   with a unique serverId
        └─────┬────┘           └─────┬────┘
              │   @minecraft/server-net (HTTP)   │
              └──────────┬──────────┬────────────┘
                     ┌───▼───┐  ┌───▼───┐
                     │backend│─▶│ Redis │   single source of truth
                     └───────┘  └───────┘
```

**Session-handoff pattern** (recommended, used by `SessionManager`):

```
On join  ──▶ acquire lock(player) ──▶ load their data into memory
During play ─▶ read/write in memory (instant) + lock heartbeat
On leave ──▶ save data ──▶ release lock(player)
```

A player only holds their lock on one server at a time, so there are no
lost-update races. Locks have a TTL, so a crashed server's locks free
themselves automatically.

---

## Quick start

### 1. Local database (single world)

```ts
import { Database } from "./Database";

const coins = new Database<number>("coins");
await coins.set("player-id", 100);
const value = coins.get("player-id"); // 100
```

Full API in [Local Database API](#local-database-api) below.

### 2. Cross-server player sync

Run the backend (see [`backend/README.md`](backend/README.md)):

```bash
npm run backend          # JSON file backend (quick start)
npm run backend:redis    # Redis backend (production, 100-200 players)
```

Then in your pack, give **each server a unique `serverId`**:

```ts
import { SessionManager } from "./SessionManager";

const profiles = new SessionManager<{ coins: number; rank: string }>({
  endpoint: "http://10.0.0.5:3000",
  apiKey: "super-secret",
  serverId: "survival-1",            // different on every server
  defaultData: () => ({ coins: 0, rank: "Newbie" }),
  onLoad: (player, data) => player.sendMessage(`Coins: ${data.coins}`),
});

// Instant in-memory during play; saved on leave + flushed on demand:
profiles.update(player, (p) => ({ ...p, coins: p.coins + 1 }));
await profiles.save(player); // for changes you can't afford to lose
```

See [`src/sessionExample.ts`](src/sessionExample.ts) for a fuller example.

---

## Project layout

```
src/
├── Database.ts          Local key/value store on Dynamic Properties
├── RemoteDatabase.ts    HTTP-backed store (retry + offline write buffer)
├── SessionManager.ts    Lock + load/save player data across servers
├── sessionExample.ts    Economy/rank usage example
└── index.dev.ts         Demo entry for the two-server dev stack

backend/
├── server.js            JSON-file backend (zero dependencies)
├── server.redis.js      Redis backend (production-scale)
├── docker-compose.yml   Production stack (Redis + backend)
├── README.md            Backend API, scaling notes
└── DEPLOYMENT.md        BDS server-net allow-list, Docker, HTTPS

dev/                     Local two-server test stack (+ WaterdogPE proxy)
docker-compose.dev.yml   Proxy + 2× BDS + backend + Redis
```

## Documentation

- **[backend/README.md](backend/README.md)** — backend API, the two backends,
  and scaling to 100-200 players.
- **[backend/DEPLOYMENT.md](backend/DEPLOYMENT.md)** — enabling
  `@minecraft/server-net` on BDS, Docker Compose, secrets, and HTTPS.
- **[dev/README.md](dev/README.md)** — run two BDS locally behind a WaterdogPE
  proxy to test sync end-to-end.

## Building

```bash
npm install
npm run build            # production build  -> scripts/index.js
npm run dev              # watch build
npm run build:server     # build the two-server demo entry (src/index.dev.ts)
```

---

# Local Database API

The original single-world database. It stores data in world Dynamic
Properties, chunked so there's effectively no size limit, with a built-in
queue so calls made before the world finishes loading are handled safely.

## Getting started

Create a table by adding a key to the `TABLES` object in
[tables.ts](src/tables.ts), or just construct a `Database` directly. It's
fully type-safe — you can predefine the key/value types.

```ts
import { Database } from "./Database";

const table = new Database<any>("test");
```

## Setting data

Returns a promise that resolves once the data is saved.

```ts
table.set("someRandomKey", "someRandomValue");
```

```ts
async function saveSomeData() {
  await table.set("someRandomKey", "someRandomValue");
  console.warn("Data has been set");
}
```

## Grabbing data

Asynchronous calls work any time (including on world load); synchronous calls
read straight from memory.

```ts
table.getSync("someRandomKey").then((v) => {
  console.warn(v); // "someRandomValue"
});
```

Or, from memory:

> **Warning**: This can throw if data is read before world load.

```ts
const value = table.get("someRandomKey");
```

## Other methods

Each read has a synchronous form (reads memory, throws before load) and an
async `...Sync` form (safe on world load).

### Keys

Returns the list of keys in this table.

```ts
table.keys(): string[]
table.keysSync(): Promise<string[]>
```

### Values

Returns the list of all values in this table.

```ts
table.values(): T[]
table.valuesSync(): Promise<T[]>
```

### Has

Checks whether a key exists.

```ts
table.has(key): boolean
table.hasSync(key): Promise<boolean>
```

### Collection

Returns an object of all keys and values.

```ts
table.collection(): { [key: string]: T }
table.collectionSync(): Promise<{ [key: string]: T }>
```

### Delete

Deletes a key; resolves to whether it was removed.

```ts
table.delete(key): Promise<boolean>
```

### Clear

Clears the entire table back to an empty object.

```ts
table.clear(): Promise<void>
```
