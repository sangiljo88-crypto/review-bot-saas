import { Router } from "express";
import { query } from "../db/database.js";
import { authRequired } from "../middleware/auth.js";

const router = Router();

// 사용자 설정 조회
router.get("/", authRequired, async (req, res) => {
  try {
    const result = await query(
      "SELECT config_json FROM configs WHERE user_id = $1 AND platform = $2",
      [req.userId, req.query.platform || "smartplace"]
    );
    const config = result.rows[0]?.config_json || {};
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 사용자 설정 저장
router.put("/", authRequired, async (req, res) => {
  try {
    const { platform, config } = req.body || {};
    const safePlatform = platform === "smartstore" ? "smartstore" : "smartplace";

    if (!config || typeof config !== "object") {
      return res.status(400).json({ error: "설정 데이터가 올바르지 않습니다." });
    }

    await query(
      `INSERT INTO configs (user_id, platform, config_json, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, platform)
       DO UPDATE SET config_json = $3, updated_at = NOW()`,
      [req.userId, safePlatform, JSON.stringify(config)]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
