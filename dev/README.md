# Two-Server Dev Stack

Run **Redis + the sync backend + two Bedrock Dedicated Servers** locally to
test cross-server data sync end-to-end. Both BDS run the same behavior pack
but identify as different servers (`survival-1` / `survival-2`) via
`@minecraft/server-admin` variables.

```
┌─────────┐   ┌─────────┐
│  bds-1  │   │  bds-2  │   :19132 / :19133
│survival-1│  │survival-2│
└────┬────┘   └────┬────┘
     └──────┬──────┘
         ┌──▼──┐    ┌───────┐
         │backend│──▶│ redis │
         └─────┘    └───────┘
```

## Steps

1. **Build the demo pack** (needs esbuild installed locally — it isn't in the
   cloud container):

   ```bash
   npm install
   npm run build:server      # ENTRY=src/index.dev.ts -> scripts/index.js
   ```

2. **Start the stack** from the repo root:

   ```bash
   docker compose -f docker-compose.dev.yml up
   ```

3. **Connect** Minecraft Bedrock to both servers (Add Server):
   - `127.0.0.1` port `19132` → survival-1
   - `127.0.0.1` port `19133` → survival-2

4. **Test the sync**: break some blocks on survival-1 (you'll see a coin
   counter), then disconnect and join survival-2 — your coins follow you.

## What's mounted where

| Host path                         | In container                                                        |
| --------------------------------- | ------------------------------------------------------------------- |
| `manifest.json`, `scripts/`       | `/data/behavior_packs/bedrock-database/`                            |
| `dev/world_behavior_packs.json`   | `/data/worlds/world/world_behavior_packs.json` (activates the pack) |
| `dev/bds{1,2}/permissions.json`   | script module config (allows `server-net` + `server-admin`)         |
| `dev/bds{1,2}/variables.json`     | per-server `server_id` / endpoint / api key                         |
| `dev/bds{1,2}/data`               | the world + server files (gitignored)                               |

## ⚠️ Important caveats

These are inherent to BDS, not the stack:

1. **EULA** — by starting the stack you accept the
   [Minecraft EULA](https://www.minecraft.net/en-us/eula) (`EULA: "TRUE"`).
   The BDS binary is downloaded by the image; it is **not** committed here.

2. **Beta APIs experiment** — `@minecraft/server-net`/`server-admin` are beta
   modules, so the world must have the **"Beta APIs"** experiment enabled or
   the script won't load. A freshly generated world has it off. Easiest fix:
   create the world once with the toggle on (e.g. generate locally in-game
   with "Beta APIs" enabled and drop it into `dev/bds1/data/worlds/world`), or
   enable it on first boot. Watch the server log — it prints why a script
   module failed to load.

3. **Version match** — the BDS `VERSION` in `docker-compose.dev.yml` must
   provide the `@minecraft/server` API version your `manifest.json` requests
   (`1.7.0-beta`). If the pack fails to load with a module-version error,
   align `VERSION` with the pack (or bump the manifest module versions to
   match a newer BDS).

4. **First boot generates the world**, so the `world_behavior_packs.json`
   activation should apply on a fresh `dev/bds{1,2}/data`. If you started once
   before adding it, delete `dev/bds{1,2}/data` and bring the stack back up.
