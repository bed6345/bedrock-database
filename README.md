# Bedrock Database 3.0

A Minecraft Bedrock asynchronous database with unlimited storage. This database works on Dynamic Properties.
The database is designed for optimal performance and has a built in queue system for async calls.

> **Requirements:** Minecraft Bedrock / BDS **1.26.0 or newer** and the stable
> `@minecraft/server` `2.7.0` module. No experiments need to be enabled.

## Installation & Updating

The behavior pack only needs three things at runtime: **`manifest.json`**,
**`scripts/index.js`**, and the **`texts/`** folder. The bundle in
`scripts/index.js` is committed to the repo, so you do **not** need to build
anything yourself just to run it — pulling the latest commit already gives you
the built script.

### 1. Get the files once

Clone the repository (e.g. with **GitHub Desktop**: `File → Clone repository →`
`bed6345/bedrock-database`), or with git:

```bash
git clone https://github.com/bed6345/bedrock-database.git
```

### 2. Point your server/game at the pack (do this once)

Instead of copying files on every change, link the cloned folder into your
behavior packs directory so updates apply automatically:

```bash
# Linux / macOS BDS
ln -s /path/to/bedrock-database /path/to/bds/behavior_packs/bedrock-database
```

```powershell
# Windows BDS (PowerShell as Administrator)
New-Item -ItemType Junction `
  -Path "C:\bds\behavior_packs\bedrock-database" `
  -Target "C:\path\to\bedrock-database"
```

Then add the pack to your world's `world_behavior_packs.json` using the
`uuid` and `version` from [`manifest.json`](manifest.json), and restart the
server. (Extra files like `src/`, `node_modules/`, and `build.js` are ignored
by the game — only what `manifest.json` references is loaded.)

For the Minecraft client, zip the pack folder, rename it to `*.mcpack`, and
open it to import.

### 3. Pull updates later

Whenever there's a new version, just **Fetch → Pull** in GitHub Desktop (or
`git pull`) and restart the server. Because the built `scripts/index.js` is
committed, the new code is live immediately — no rebuild required.

### Editing the source yourself

If you change the TypeScript in `src/`, rebuild the bundle before committing,
since the game runs `scripts/index.js`, not the `.ts` files:

```bash
npm install   # first time only
npm run build # regenerates scripts/index.js
```

## Getting started:

First you will need to make a table, you can do this by either adding a key to the `TABLES` object in [tables.ts](src/tables.ts) or
creating a variable assigned to a `Database` instance. A Cool thing about this database is that it supports full type safety and
you can predefine the types of the keys and values of the database.

```ts
import { Database } from "./Database.ts";

const table = new Database<any>("test");
```

## Setting Data:

Setting data is very simple and will send back a promise that can be awaited to let you know when the data is successfully saved in the entities.

```ts
table.set("someRandomKey", "someRandomValue");
```

```ts
async function saveSomeData() {
  await table.set("someRandomKey", "someRandomValue");
  console.warn("Data has been set");
}
```

## Grabbing Data:

This database supports Asynchronous calls that can be used for grabbing data at any time (which includes on world load), or you simply
can grab data from memory.

```ts
table.getSync("someRandomKey").then((v) => {
  console.warn(v); // "someRandomValue"
});
```

Or you can simply call from memory using:

> **Warning**: This can throw errors if data is tried to grab before world load.

```ts
const value = table.get("someRandomKey");
```

## Other Supported Methods:

### Keys:

Returns a iterable list of keys that are stored in this table.

> **Warning**: This can throw errors if data is tried to grab before world load.

```ts
table.keys(): any[]
```

```ts
table.keysSync(): Promise<any[]>
```

### Values:

Returns a iterable list of all values that are stored in this table.

> **Warning**: This can throw errors if data is tried to grab before world load.

```ts
table.values(): any[]
```

```ts
table.valuesSync(): Promise<any[]>
```

### Has:

Checks if a key exists on this table and returns boolean.

> **Warning**: This can throw errors if data is tried to grab before world load.

```ts
table.has(key: any): boolean
```

```ts
table.hasSync(key: any): Promise<boolean>
```

### Collection:

Returns a Object of all keys and values on this table.

> **Warning**: This can throw errors if data is tried to grab before world load.

```ts
table.collection(): { [any]: any }
```

```ts
table.collectionSync(): Promise<{ [any]: any }>
```

### Delete:

Deletes a key on this table and returns a boolean if it successfully deleted the key.

```ts
table.delete(key: any): Promise<boolean>
```

### Clear

Clears the entire table and sets it back to a empty object, then returns once finished.

```ts
table.clear(): Promise<void>
```
