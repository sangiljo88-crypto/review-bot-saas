import { chromium } from "playwright";
import { buildReplyWithAI } from "../ai/replyGenerator.js";

const DEFAULT_CONFIG = {
  smartplace: {
    reviewManageUrl: "https://new.smartplace.naver.com/",
    selectors: {
      reviewCard: "li[class*='Review_pui_review__']",
      replyWriteButtonSelector: 'button[data-area-code="rv.replywrite"]',
      replyToggleButtonByText: "답글 쓰기",
      replyTextarea: "textarea",
      submitButtonByText: "등록",
      submitButtonSelector: 'button[data-area-code="rv.replydone"], button[data-area-code="rv.replyregister"]',
    },
  },
  smartstore: {
    reviewManageUrl: "https://sell.smartstore.naver.com/#/review/search",
    selectors: {
      reviewCard: "tr, article, li, div[class*='review']",
      replyToggleButtonByText: "답글",
      replyTextarea: "textarea",
      submitButtonByText: "등록",
    },
  },
};

const DEFAULT_AI_CONFIG = {
  enabled: true,
  model: "gpt-4o-mini",
  systemPrompt: "역할: 리뷰에 감사 답글을 작성하는 매장 운영자입니다.\n\n규칙:\n1. 리뷰에 적힌 내용만 언급\n2. 2~3문장으로 작성\n3. 마지막에 재방문 기대감\n4. 이모지 마지막에 1개",
  temperature: 0.75,
  maxTokens: 150,
  skipIfNoReviewText: false,
  fallbackToTemplateOnError: true,
  keywords: [],
  noReviewBaseMessage: "방문해 주셔서 감사합니다. 리뷰 남겨주셔서 감사합니다. 더 좋은 서비스를 위해 노력하겠습니다.",
};

function buildLaunchOptions() {
  return {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  };
}

function mergeConfig(userConfig, platform) {
  const base = DEFAULT_CONFIG[platform] || DEFAULT_CONFIG.smartplace;
  return {
    ...base,
    ...userConfig,
    selectors: { ...base.selectors, ...(userConfig.selectors || {}) },
  };
}

function mergeAiConfig(userConfig, apiKey) {
  const userAi = userConfig.ai || {};
  const aiConfig = {
    ...DEFAULT_AI_CONFIG,
    ...userAi,
    // 사용자가 설정한 값이 있으면 우선 적용
    systemPrompt: userAi.systemPrompt || DEFAULT_AI_CONFIG.systemPrompt,
    keywords: Array.isArray(userAi.keywords) && userAi.keywords.length > 0
      ? userAi.keywords
      : DEFAULT_AI_CONFIG.keywords,
    noReviewBaseMessage: userAi.noReviewBaseMessage || DEFAULT_AI_CONFIG.noReviewBaseMessage,
  };
  if (apiKey) {
    process.env.OPENAI_API_KEY = apiKey;
  }
  return aiConfig;
}

export async function executeReplyJob({ run, sessionData, userConfig, apiKey, maxReplies, onLog, onFinish }) {
  let browser;
  const result = { status: "success", scanned: 0, processed: 0, exitCode: 0 };

  try {
    onLog("system", `${run.platform} 답글 작업 시작 (모드: ${run.mode})`);

    const platformConfig = mergeConfig(userConfig, run.platform);
    const aiConfig = mergeAiConfig(userConfig, apiKey);
    const dryRun = run.mode !== "submit";
    const limit = maxReplies && Number.isFinite(maxReplies) ? maxReplies : Infinity;

    browser = await chromium.launch(buildLaunchOptions());
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: sessionData,
    });
    const page = await context.newPage();

    // 리뷰 페이지 이동
    const reviewUrl = platformConfig.reviewManageUrl;
    onLog("system", `리뷰 페이지 이동: ${reviewUrl}`);
    await page.goto(reviewUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    // 리뷰 카드 탐색
    const sel = platformConfig.selectors;
    const cards = page.locator(sel.reviewCard);
    let total = await cards.count();
    onLog("system", `리뷰 카드 ${total}개 발견`);

    if (total === 0) {
      onLog("warn", "리뷰 카드를 찾지 못했습니다. 네이버 세션이 만료되었을 수 있습니다.");
      result.status = "failed";
      result.exitCode = 1;
      await onFinish(result);
      return;
    }

    const ownerPatterns = run.platform === "smartstore"
      ? [/판매자.*답글/i, /답글 완료/i]
      : [/사장님.*답글/i, /답글 완료/i];

    let cursor = 0;
    while (cursor < total && result.processed < limit) {
      if (run.stopRequested) {
        onLog("system", "사용자 중지 요청");
        result.status = "stopped";
        break;
      }

      const card = cards.nth(cursor);
      cursor++;
      result.scanned++;

      try { await card.scrollIntoViewIfNeeded(); } catch { /* */ }

      let cardText = "";
      try { cardText = await card.innerText(); } catch { continue; }

      // 이미 답글 있는지 확인
      if (ownerPatterns.some((p) => p.test(cardText))) {
        continue;
      }

      // AI 답글 생성
      let reply;
      try {
        reply = await buildReplyWithAI({
          rawReviewText: cardText,
          aiConfig,
          replyTemplate: userConfig.replyTemplate || "리뷰 감사합니다.",
        });
      } catch (err) {
        onLog("error", `AI 답글 생성 실패: ${err.message}`);
        continue;
      }

      if (!reply) continue;

      // 답글 버튼 클릭
      let opened = false;
      if (sel.replyWriteButtonSelector) {
        try {
          const btn = card.locator(sel.replyWriteButtonSelector);
          if (await btn.count() > 0) { await btn.first().click({ timeout: 2000 }); opened = true; }
        } catch { /* */ }
      }
      if (!opened) {
        try {
          const btn = card.getByRole("button", { name: new RegExp(sel.replyToggleButtonByText, "i") });
          if (await btn.count() > 0) { await btn.first().click({ timeout: 2000 }); opened = true; }
        } catch { /* */ }
      }
      if (!opened) continue;

      await page.waitForTimeout(300);

      // textarea에 답글 입력
      try {
        const textarea = card.locator(sel.replyTextarea).last();
        await textarea.waitFor({ timeout: 2000, state: "visible" });
        await textarea.fill(reply);
      } catch {
        onLog("warn", `#${cursor} 답글 입력창 없음`);
        continue;
      }

      if (dryRun) {
        result.processed++;
        onLog("dry-run", `#${result.processed} ${reply.slice(0, 60)}...`);
        continue;
      }

      // 등록 버튼 클릭
      let submitted = false;
      if (sel.submitButtonSelector) {
        try {
          const btn = card.locator(sel.submitButtonSelector);
          if (await btn.count() > 0) { await btn.first().click({ timeout: 2000 }); submitted = true; }
        } catch { /* */ }
      }
      if (!submitted) {
        try {
          const btn = card.getByRole("button", { name: new RegExp(`^\\s*${sel.submitButtonByText}\\s*$`, "i") });
          if (await btn.count() > 0) { await btn.first().click({ timeout: 2000 }); submitted = true; }
        } catch { /* */ }
      }

      if (submitted) {
        result.processed++;
        onLog("done", `#${result.processed} 답글 등록 완료`);
        // 랜덤 딜레이
        const delay = 5000 + Math.random() * 10000;
        await page.waitForTimeout(delay);
      }
    }

    onLog("system", `완료: 스캔 ${result.scanned}개, 처리 ${result.processed}개`);
  } catch (err) {
    onLog("error", `실행 오류: ${err.message}`);
    result.status = "failed";
    result.exitCode = 1;
  } finally {
    try { await browser?.close(); } catch { /* */ }
    await onFinish(result);
  }
}
