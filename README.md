# Bedrock Database 3.0

A Minecraft Bedrock asynchronous database with large-scale storage. This database works on Dynamic Properties.
The database is designed for optimal performance and has a built in queue system for async calls.

> **Compatibility**: Built for `@minecraft/server` `2.7.0` (Minecraft Bedrock `1.26.20`+).
> Tables load lazily on the `worldLoad` event, so they are safe to create at the top level
> of a script during early execution.

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

## Storing values larger than 32 KB:

A single dynamic property string is limited to **32767 bytes**. Writing more
throws:

```
ArgumentOutOfBoundsError: Unsupported or out of bounds value passed to function
argument [0]: String length for dynamic property 'allPlayers', Value: 32838,
Argument max: 32767
```

This database avoids that limit by automatically splitting every table across
as many dynamic properties as needed, so you never have to think about it:

```ts
import { Database } from "./Database";

// Recommended: one key per player. The table is chunked transparently.
const players = new Database<PlayerData>("players");
await players.set(player.id, data);
```

If you just need a chunked drop-in replacement for a single oversized
`world.setDynamicProperty(...)` call, use the helpers:

```ts
import { setLargeProperty, getLargeProperty } from "./DynamicProperty";

// Before (throws when the JSON exceeds 32767 bytes):
// world.setDynamicProperty("allPlayers", JSON.stringify(allPlayers));

// After (safe for any size):
setLargeProperty("allPlayers", allPlayers);
const allPlayers = getLargeProperty<PlayerData[]>("allPlayers");
```

Chunking is measured in UTF-8 bytes, so multi-byte content (emoji, CJK, etc.)
is handled correctly and never split mid-character.

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
