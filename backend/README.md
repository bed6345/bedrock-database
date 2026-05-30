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

| Method   | Path                                  | Purpose                          |
| -------- | ------------------------------------- | -------------------------------- |
| `GET`    | `/tables/:table`                      | Fetch the whole table.           |
| `DELETE` | `/tables/:table`                      | Clear the whole table.           |
| `GET`    | `/tables/:table/:key`                 | Read a single key.               |
| `PUT`    | `/tables/:table/:key`                 | Set a key (`{ "value": ... }`).  |
| `DELETE` | `/tables/:table/:key`                 | Delete a key.                    |
| `POST`   | `/tables/:table/:key/increment`       | Atomic add (`{ "amount": n }`).  |

Every response is JSON shaped like `{ "ok": true, "data": ... }`.

## Production notes

This is a **reference implementation** meant to be clear, not bulletproof.
For real deployments consider:

- Swapping the JSON file for **Redis / MySQL / MongoDB** for durability and
  concurrent-write safety.
- Putting it behind **HTTPS** (a reverse proxy like Caddy/Nginx) instead of
  plain HTTP, especially if the servers talk over the internet.
- Per-key **locking or transactions** if you do read-modify-write beyond the
  provided atomic `increment`.
