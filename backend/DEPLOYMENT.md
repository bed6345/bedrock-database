# Deployment Guide

How to run the sync backend in production and how to let your Bedrock
Dedicated Servers actually reach it.

## 1. Enable `@minecraft/server-net` on each BDS

By default BDS **blocks** the privileged `@minecraft/server-net` module, so
`RemoteDatabase` won't be able to make any HTTP calls until you allow it.

Create (or edit) a `permissions.json` for your script pack on **each** server:

```
<BDS_ROOT>/config/<SCRIPT_MODULE_UUID>/permissions.json
```

`<SCRIPT_MODULE_UUID>` is the UUID of the **script** module in this pack's
`manifest.json` (the one with `"type": "script"`):
`ec8cf691-28e0-40d6-980c-8506cd5a4742`.

```json
{
  "allowed_modules": [
    "@minecraft/server-net",
    "@minecraft/server-admin"
  ]
}
```

> Some BDS versions instead read a global file at
> `<BDS_ROOT>/config/default/permissions.json`. If one location doesn't take
> effect, try the other, and check the server console on boot — it logs which
> modules a pack was allowed to load.

Restart BDS after changing this file.

### Keep the API key out of your code (recommended)

Rather than hardcoding `apiKey` in the pack, store it as a server secret via
`@minecraft/server-admin`. Put a `variables.json` next to `permissions.json`:

```json
{ "db_api_key": "super-secret" }
```

```ts
import { variables } from "@minecraft/server-admin";

const apiKey = variables.get("db_api_key");
new RemoteDatabase("players", { endpoint: "http://10.0.0.5:3000", apiKey });
```

## 2. Run the backend with Docker (Redis + persistence)

From the repo root:

```bash
cd backend
docker compose up -d
```

This starts:

- **redis** — with AOF persistence enabled and a named volume, so data
  survives restarts.
- **backend** — the Redis-backed API (`server.redis.js`), listening on the
  port you set.

Configure via a `.env` file in `backend/` (see `.env.example`):

```env
PORT=3000
API_KEY=super-secret
```

Check it's healthy:

```bash
curl -H "x-api-key: super-secret" http://localhost:3000/tables/players
# -> {"ok":true,"data":{}}
```

Point every BDS at this host's IP/port with the same `API_KEY`, and give each
BDS a unique `serverId`.

## 3. Going over the internet? Add HTTPS

The API key travels in a header, so on an untrusted network put the backend
behind a TLS-terminating reverse proxy (Caddy/Nginx/Traefik) and use an
`https://` endpoint. On a private LAN/VPC between your own servers, plain HTTP
is usually fine.

## 4. Redis persistence sanity check

The compose file already enables AOF (`--appendonly yes`). If you run Redis
yourself instead, make sure persistence is on — otherwise a Redis restart
wipes all player data:

```bash
redis-server --appendonly yes --dir /var/lib/redis
```
