import { Player, system } from "@minecraft/server";
import { TABLES } from "./tables";

// Subscribe once so the strain test can survive a watchdog terminate without
// stacking a new listener every time it runs.
system.beforeEvents.watchdogTerminate.subscribe((data) => {
  data.cancel = true;
  console.warn("[DATABASE]: Watchdog terminate cancelled during strain test.");
});

system.afterEvents.scriptEventReceive.subscribe(
  ({ sourceEntity, message, id }) => {
    if (!(sourceEntity instanceof Player)) return;
    const table = message.split(" ")[0] as keyof typeof TABLES;
    if (!Object.keys(TABLES).includes(table))
      return sourceEntity.sendMessage(
        `§cNo Table with the name ${table} Exists!`
      );
    const key = message.split(" ")[1];
    const value = message.split(" ")[2];
    switch (id) {
      case "database:set":
        TABLES[table].set(key, value);
        sourceEntity.sendMessage(
          `Set Key: "${key}", to value: "${value}" on table: "${table}"`
        );
        break;
      case "database:get":
        const tableData = TABLES[table].get(key);
        if (tableData) {
          sourceEntity.sendMessage(JSON.stringify(tableData));
        } else {
          sourceEntity.sendMessage(`§cNo data could be found for key ${key}`);
        }
        break;
      case "database:strain":
        let startTime = Date.now();
        for (let i = 0; i < 1000; i++) {
          let str = "";
          let randomKey = "";
          for (let i = 0; i < 1000; i++) str += "asdfgh";
          for (let i = 0; i < 100; i++) randomKey += Math.random();
          TABLES[table].set(randomKey, str);
        }
        sourceEntity.sendMessage(
          `§aCompleted strain in: ${~~(
            (Date.now() - startTime) /
            1000
          )} Seconds`
        );
        break;
      default:
        break;
    }
  },
  {
    namespaces: ["database"],
  }
);
