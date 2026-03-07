import express from "express";
import path from "node:path";
import process from "node:process";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "node:url";
import { initDatabase } from "./db/database.js";
import authRoutes from "./routes/auth.js";
import naverRoutes from "./routes/naver.js";
import replyRoutes from "./routes/reply.js";
import configRoutes from "./routes/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 8080);

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "..", "public")));

// API 라우트
app.use("/api/auth", authRoutes);
app.use("/api/naver", naverRoutes);
app.use("/api/reply", replyRoutes);
app.use("/api/config", configRoutes);

// SPA 폴백
app.get("/{path}", (req, res) => s
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// 서버 시작
async function start() {
  await initDatabase();
  app.listen(port, "0.0.0.0", () => {
    console.log(`Smart Review SaaS 서버 실행: http://0.0.0.0:${port}`);
  });
}

start().catch((err) => {
  console.error("서버 시작 실패:", err.message);
  process.exit(1);
});
