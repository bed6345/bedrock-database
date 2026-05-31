# Two-Server Dev Stack (with WaterdogPE proxy)

Run a **WaterdogPE proxy + two Bedrock Dedicated Servers + sync backend +
Redis** locally to test cross-server data sync end-to-end. Players connect to
the **proxy** (one address) and are transferred seamlessly between the two
downstream BDS. Both BDS run the same behavior pack but identify as different
servers (`survival-1` / `survival-2`) via `@minecraft/server-admin` variables.

```
        client ──▶ ┌───────────┐  :19132 (only public port)
                   │ WaterdogPE │
                   └─────┬─────┘
              ┌──────────┴──────────┐
        ┌─────▼────┐           ┌─────▼────┐
        │  bds-1   │           │  bds-2   │   (internal only)
        │survival-1│           │survival-2│
        └─────┬────┘           └─────┬────┘
              └──────────┬──────────┘
                     ┌───▼───┐   ┌───────┐
                     │backend│──▶│ redis │
                     └───────┘   └───────┘
```

## Steps

1. **Build the demo pack** (needs esbuild installed locally — it isn't in the
   cloud container):

   ```bash
   npm install
   npm run build:server      # builds src/index.dev.ts -> scripts/index.js
   ```

2. **Start the stack** from the repo root:

   ```bash
   docker compose -f docker-compose.dev.yml up
   ```

3. **Connect** Minecraft Bedrock to the **proxy** (Add Server):
   - `127.0.0.1` port `19132` → lands on `lobby` (survival-1 by default)

   The downstream BDS are not exposed directly — everything goes through the
   proxy.

4. **Switch servers** to the second BDS. WaterdogPE routes between downstream
   servers; depending on your WaterdogPE version/plugins you transfer with a
   command such as the vanilla `/transfer` or a Waterdog server-switch
   command/NPC. (Any plugin that moves the player between the `lobby` and
   `survival` entries works.)

5. **Test the sync**: break some blocks on survival-1 (you'll see a coin
   counter), switch to survival-2 — your coins follow you. That's the
   cross-server sync working through the proxy.

## Stopping / restarting a server safely

Bedrock has no reliable in-script "server stopping" event, so to avoid losing
unsaved data or leaving locks stuck, **save and release before you stop**:

1. Drain players off the server (transfer them to the lobby via the proxy).
2. In-game (as op) run **`/scriptevent admin:shutdown`** — this saves every
   online player and releases their locks. Wait for the
   `Saved + unlocked all players` log line.
3. Then stop the container: `docker compose -f docker-compose.dev.yml stop bds-1`.

`/scriptevent admin:flush` saves everyone *without* disconnecting — a safe
snapshot you can run any time. For unattended crash safety, also set
`autoSaveSeconds` on the `SessionManager` (e.g. `30`).

> Restarting with the **same `serverId`** is safe: the restarted server
> re-acquires its own locks, and `@minecraft/server-net` retries + the offline
> write buffer ride out a brief backend/Redis restart.

## What's mounted where

| Host path                         | In container                                                        |
| --------------------------------- | ------------------------------------------------------------------- |
| `manifest.json`, `scripts/`       | `/data/behavior_packs/bedrock-database/`                            |
| `dev/world_behavior_packs.json`   | `/data/worlds/world/world_behavior_packs.json` (activates the pack) |
| `dev/bds{1,2}/permissions.json`   | script module config (allows `server-net` + `server-admin`)         |
| `dev/bds{1,2}/variables.json`     | per-server `server_id` / endpoint / api key                         |
| `dev/bds{1,2}/data`               | the world + server files (gitignored)                               |
| `dev/waterdog/config.yml`         | WaterdogPE proxy config (listener + downstream servers)             |
| `dev/waterdog/` (rest)            | downloaded `Waterdog.jar` + generated files (gitignored)            |

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

## Adding more servers (3, 4, 5 …)

The stack is N-server by design — every BDS just needs a unique `serverId` and
points at the same backend. Use the generator instead of copy-pasting blocks:

```bash
node dev/add-server.js minigames            # internal-only (behind proxy)
node dev/add-server.js skyblock --port 19134 # also exposed directly for debug
# or: npm run add-server -- minigames
```

It creates `dev/<serverId>/permissions.json` + `variables.json` and prints:

1. a `docker-compose.dev.yml` service block to paste under `services:` (then
   add the service name to the `waterdog` service's `depends_on`), and
2. a `dev/waterdog/config.yml` entry to paste under `servers:`.

Options: `--endpoint <url>` (default `http://backend:3000`) and
`--api-key <key>` (default `super-secret`).

### WaterdogPE notes

- **Downstream BDS must be offline-mode** (`ONLINE_MODE: "false"`, already
  set) because the proxy handles Xbox auth. Don't expose the BDS ports
  publicly — only the proxy.
- **Config schema may vary by version.** The official docs were unreachable
  when this was written, so `dev/waterdog/config.yml` is a best-effort
  starting point. WaterdogPE merges defaults on first start; if it complains
  about a key, let it generate a fresh `config.yml` (start the `waterdog`
  service once with an empty `dev/waterdog/`), then copy the `servers` and
  `priorities` blocks into the generated file.
- **The jar is downloaded at runtime** from the WaterdogPE Jenkins
  (`Waterdog.jar`) into `dev/waterdog/` — it is not committed.
- **Java 17+** is required (the image is `eclipse-temurin:17-jre-alpine`).
- **Server switching** between `lobby` and `survival` depends on your
  WaterdogPE plugins/commands; the sync itself works regardless, because each
  downstream join/leave triggers `SessionManager` the same way.
