import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db/database.js";
import { signToken, authRequired, COOKIE_NAME } from "../middleware/auth.js";

const router = Router();
const SALT_ROUNDS = 10;
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: "/",
};

// 회원가입
router.post("/signup", async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "이메일과 비밀번호는 필수입니다." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "비밀번호는 6자 이상이어야 합니다." });
    }

    const existing = await query("SELECT id FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "이미 가입된 이메일입니다." });
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await query(
      "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name",
      [email.toLowerCase().trim(), hash, (name || "").trim()]
    );
    const user = result.rows[0];
    const token = signToken(user.id);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error("[auth] signup error:", err.message);
    res.status(500).json({ error: "회원가입 처리 중 오류가 발생했습니다." });
  }
});

// 로그인
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "이메일과 비밀번호를 입력해주세요." });
    }

    const result = await query("SELECT id, email, name, password_hash FROM users WHERE email = $1", [
      email.toLowerCase().trim(),
    ]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "이메일 또는 비밀번호가 맞지 않습니다." });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "이메일 또는 비밀번호가 맞지 않습니다." });
    }

    const token = signToken(user.id);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error("[auth] login error:", err.message);
    res.status(500).json({ error: "로그인 처리 중 오류가 발생했습니다." });
  }
});

// 로그아웃
router.post("/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

// 현재 사용자 정보
router.get("/me", authRequired, async (req, res) => {
  try {
    const result = await query("SELECT id, email, name, created_at FROM users WHERE id = $1", [req.userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
    }
    const user = result.rows[0];

    // 네이버 세션 연결 상태도 함께 반환
    const sessions = await query(
      "SELECT id, platform, label, updated_at FROM naver_sessions WHERE user_id = $1",
      [req.userId]
    );
    res.json({
      user: { id: user.id, email: user.email, name: user.name, createdAt: user.created_at },
      naverSessions: sessions.rows,
    });
  } catch (err) {
    console.error("[auth] me error:", err.message);
    res.status(500).json({ error: "사용자 정보 조회 실패" });
  }
});

export default router;
