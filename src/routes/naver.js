import { Router } from "express";
import crypto from "node:crypto";
import { query } from "../db/database.js";
import { authRequired } from "../middleware/auth.js";
import { launchLoginBrowser, getLoginStatus, destroyLoginBrowser } from "../services/naverLogin.js";

const router = Router();

const ENCRYPT_KEY = process.env.SESSION_ENCRYPT_KEY || "0123456789abcdef0123456789abcdef"; // 32 bytes
const IV_LENGTH = 16;

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPT_KEY, "utf8"), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(text) {
  const [ivHex, encrypted] = text.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPT_KEY, "utf8"), iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// 네이버 로그인 세션 시작 (서버에서 headless 브라우저 열고 로그인 대기)
router.post("/start-login", authRequired, async (req, res) => {
  try {
    const { platform } = req.body || {};
    const safePlatform = platform === "smartstore" ? "smartstore" : "smartplace";
    const sessionId = await launchLoginBrowser(req.userId, safePlatform);
    res.json({ sessionId, message: "로그인 창이 준비되었습니다. 로그인을 완료해주세요." });
  } catch (err) {
    console.error("[naver] start-login error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 로그인 상태 확인 (폴링)
router.get("/login-status/:sessionId", authRequired, async (req, res) => {
  try {
    const status = getLoginStatus(req.params.sessionId);
    if (!status) {
      return res.status(404).json({ error: "로그인 세션을 찾을 수 없습니다." });
    }
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 로그인 취소
router.post("/cancel-login/:sessionId", authRequired, async (req, res) => {
  try {
    await destroyLoginBrowser(req.params.sessionId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 사용자의 네이버 세션 목록
router.get("/sessions", authRequired, async (req, res) => {
  try {
    const result = await query(
      "SELECT id, platform, label, updated_at FROM naver_sessions WHERE user_id = $1 ORDER BY platform",
      [req.userId]
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 세션 삭제
router.delete("/sessions/:id", authRequired, async (req, res) => {
  try {
    await query("DELETE FROM naver_sessions WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// (내부용) 세션 저장 — naverLogin 서비스에서 호출
export async function saveNaverSession(userId, platform, sessionData, label) {
  const encrypted = encrypt(JSON.stringify(sessionData));
  await query(
    `INSERT INTO naver_sessions (user_id, platform, session_data, label, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, platform)
     DO UPDATE SET session_data = $3, label = $4, updated_at = NOW()`,
    [userId, platform, encrypted, label || ""]
  );
}

// (내부용) 세션 복호화 로드
export async function loadNaverSession(userId, platform) {
  const result = await query(
    "SELECT session_data FROM naver_sessions WHERE user_id = $1 AND platform = $2",
    [userId, platform]
  );
  if (result.rows.length === 0) return null;
  try {
    return JSON.parse(decrypt(result.rows[0].session_data));
  } catch {
    return null;
  }
}

export default router;
