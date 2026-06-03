import { Player, system } from "@minecraft/server";
import { TABLES } from "./tables";

system.afterEvents.scriptEventReceive.subscribe(
  ({ sourceEntity, message, id }) => {
    if (!(sourceEntity instanceof Player)) return;
    const player: Player = sourceEntity;
    const table = message.split(" ")[0] as keyof typeof TABLES;
    if (!Object.keys(TABLES).includes(table))
      return player.sendMessage(
        `§cNo Table with the name ${table} Exists!`
      );
    const key = message.split(" ")[1];
    const value = message.split(" ")[2];
    switch (id) {
      case "database:set":
        TABLES[table].set(key, value);
        player.sendMessage(
          `Set Key: "${key}", to value: "${value}" on table: "${table}"`
        );
        break;
      case "database:get":
        const tableData = TABLES[table].get(key);
        if (tableData !== undefined && tableData !== null) {
          player.sendMessage(JSON.stringify(tableData));
        } else {
          player.sendMessage(`§cNo data could be found for key ${key}`);
        }
        break;
      case "database:strain": {
        // `watchdogTerminate` was removed in @minecraft/server 2.x. To avoid
        // tripping the watchdog (which would crash the server), the strain
        // workload is spread across ticks using `system.runJob`.
        const startTime = Date.now();
        function* strain(): Generator<void, void, void> {
          for (let i = 0; i < 1000; i++) {
            let str = "";
            let randomKey = "";
            for (let j = 0; j < 1000; j++) str += "asdfgh";
            for (let j = 0; j < 100; j++) randomKey += Math.random();
            TABLES[table].set(randomKey, str);
            yield;
          }
          player.sendMessage(
            `§aCompleted strain in: ${~~((Date.now() - startTime) / 1000)} Seconds`
          );
        }
        system.runJob(strain());
        break;
      }
      default:
        break;
    }
  },
  {
    namespaces: ["database"],
  }
);
