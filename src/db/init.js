import { initDatabase, getPool } from "./database.js";

initDatabase()
  .then(() => {
    console.log("[db:init] 완료");
    return getPool().end();
  })
  .catch((err) => {
    console.error("[db:init] 실패:", err.message);
    process.exit(1);
  });
