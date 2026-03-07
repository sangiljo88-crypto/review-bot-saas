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
const REQUIRED_ENV_VARS = ["DATABASE_URL", "JWT_SECRET", "SESSION_ENCRYPT_KEY"];

function validateEnvironment() {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`필수 환경변수 누락: ${missing.join(", ")}`);
  }
  if (Buffer.byteLength(process.env.SESSION_ENCRYPT_KEY, "utf8") !== 32) {
    throw new Error("SESSION_ENCRYPT_KEY는 정확히 32바이트 문자열이어야 합니다.");
  }
}

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "..", "public")));

// API 라우트
app.use("/api/auth", authRoutes);
app.use("/api/naver", naverRoutes);
app.use("/api/reply", replyRoutes);
app.use("/api/config", configRoutes);

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

// SPA 폴백
app.get("/{*path}", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// 서버 시작
async function start() {
  validateEnvironment();
  await initDatabase();
  app.listen(port, "0.0.0.0", () => {
    console.log(`Smart Review SaaS 서버 실행: http://0.0.0.0:${port}`);
  });
}

start().catch((err) => {
  console.error("서버 시작 실패:", err.stack || err.message || err);
  process.exit(1);
});
