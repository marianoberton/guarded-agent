import { copyFileSync, mkdirSync } from "node:fs";

// schema.sql is read at runtime by PostgresStore.migrate(), so it has to ship
// next to the compiled store rather than only living in src/.
mkdirSync("dist/stores/postgres", { recursive: true });
copyFileSync("src/stores/postgres/schema.sql", "dist/stores/postgres/schema.sql");
console.log("copied schema.sql -> dist/stores/postgres/schema.sql");
