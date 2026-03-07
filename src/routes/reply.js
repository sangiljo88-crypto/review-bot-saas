import { Router } from "express";
import crypto from "node:crypto";
import { query } from "../db/database.js";
import { authRequired } from "../middleware/auth.js";
import { loadNaverSession } from "./naver.js";
import { executeReplyJob } from "../services/replyRunner.js";

const router = Router();
const activeRuns = new Map();

// 리뷰 답글 실행
router.post("/start", authRequired, async (req, res) => {
  try {
    const { platform, mode, apiKey, max } = req.body || {};
    const safePlatform = platform === "smartstore" ? "smartstore" : "smartplace";
    const safeMode = mode === "submit" ? "submit" : "dry-run";

    // 이미 실행 중인 작업 확인
    for (const [, run] of activeRuns) {
      if (run.userId === req.userId && run.status === "running") {
        return res.status(409).json({ error: "이미 실행 중인 작업이 있습니다." });
      }
    }

    // 네이버 세션 확인
    const sessionData = await loadNaverSession(req.userId, safePlatform);
    if (!sessionData) {
      return res.status(400).json({ error: "네이버 로그인이 필요합니다. 먼저 네이버 계정을 연결해주세요." });
    }

    // 사용자 설정 로드
    const configResult = await query(
      "SELECT config_json FROM configs WHERE user_id = $1 AND platform = $2",
      [req.userId, safePlatform]
    );
    const userConfig = configResult.rows[0]?.config_json || {};

    // 실행 로그 DB 기록
    const logResult = await query(
      "INSERT INTO run_logs (user_id, platform, mode) VALUES ($1, $2, $3) RETURNING id",
      [req.userId, safePlatform, safeMode]
    );
    const runId = logResult.rows[0].id;

    const run = {
      id: runId,
      jobId: crypto.randomUUID(),
      userId: req.userId,
      platform: safePlatform,
      mode: safeMode,
      status: "running",
      logs: [],
      clients: new Set(),
    };
    activeRuns.set(run.jobId, run);

    // 비동기 실행
    executeReplyJob({
      run,
      sessionData,
      userConfig,
      apiKey: apiKey || process.env.OPENAI_API_KEY,
      maxReplies: max ? Number(max) : undefined,
      onLog: (type, message) => appendLog(run, type, message),
      onFinish: async (result) => {
        run.status = result.status;
        await query(
          "UPDATE run_logs SET status=$1, scanned=$2, processed=$3, exit_code=$4, ended_at=NOW(), log_text=$5 WHERE id=$6",
          [result.status, result.scanned || 0, result.processed || 0, result.exitCode || 0, run.logs.map((l) => `[${l.type}] ${l.message}`).join("\n"), run.id]
        );
        emitDone(run, result);
        setTimeout(() => activeRuns.delete(run.jobId), 10 * 60 * 1000);
      },
    }).catch((err) => {
      console.error("[reply] job error:", err.message);
    });

    res.json({ jobId: run.jobId, runId: run.id });
  } catch (err) {
    console.error("[reply] start error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 실행 상태 SSE 스트림
router.get("/stream/:jobId", authRequired, (req, res) => {
  const run = activeRuns.get(req.params.jobId);
  if (!run || run.userId !== req.userId) {
    return res.status(404).end();
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  run.clients.add(res);

  // 스냅샷 전송
  emitSse(res, "snapshot", { status: run.status, logs: run.logs });
  if (run.status !== "running") {
    emitSse(res, "done", { status: run.status });
  }

  req.on("close", () => run.clients.delete(res));
});

// 실행 중지
router.post("/stop/:jobId", authRequired, (req, res) => {
  const run = activeRuns.get(req.params.jobId);
  if (!run || run.userId !== req.userId) {
    return res.status(404).json({ error: "작업을 찾을 수 없습니다." });
  }
  run.stopRequested = true;
  run.status = "stopping";
  res.json({ status: run.status });
});

// 실행 이력 조회
router.get("/history", authRequired, async (req, res) => {
  try {
    const result = await query(
      "SELECT id, platform, mode, status, scanned, processed, started_at, ended_at FROM run_logs WHERE user_id = $1 ORDER BY started_at DESC LIMIT 20",
      [req.userId]
    );
    res.json({ runs: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function emitSse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function appendLog(run, type, message) {
  const record = { ts: Date.now(), type, message };
  run.logs.push(record);
  for (const client of run.clients) {
    emitSse(client, "log", record);
  }
}

function emitDone(run, result) {
  for (const client of run.clients) {
    emitSse(client, "done", { status: result.status, scanned: result.scanned, processed: result.processed });
  }
}

export default router;
