import { chromium } from "playwright";
import { buildReplyWithAI } from "../ai/replyGenerator.js";

const DEFAULT_CONFIG = {
  smartplace: {
    reviewManageUrl: "https://new.smartplace.naver.com/",
    selectors: {
      reviewCard: "li[class*='Review_pui_review__'], li[class*='review'], article[class*='review'], div[class*='review-card'], div[class*='Review']",
      replyWriteButtonSelector: 'button[data-area-code="rv.replywrite"]',
      replyToggleButtonByText: "답글 쓰기",
      replyTextarea: "textarea#replyWrite, textarea",
      submitButtonByText: "등록",
      submitButtonSelector: 'button[data-area-code="rv.replydone"], button[data-area-code="rv.replyregister"], button[data-area-code="rv.replysubmit"]',
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

const DEFAULT_REPLY_DELAY_RANGE = {
  min: 5000,
  max: 15000,
};
const SKIP_DELAY_MS = 500;

function buildLaunchOptions() {
  const explicit = process.env.PLAYWRIGHT_HEADLESS;
  const runningOnServer = Boolean(
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.CI
  );
  const headless = explicit == null
    ? runningOnServer
    : String(explicit).toLowerCase() !== "false";
  return {
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  };
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseSmartplaceIdFromUrl(url) {
  const text = String(url || "");
  const match = text.match(/\/bizes\/place\/(\d+)/);
  return match ? match[1] : null;
}

function asVisibleSelector(selector) {
  return String(selector || "")
    .split(",")
    .map((part) => {
      const s = part.trim();
      if (!s) return "";
      return s.includes(":visible") ? s : `${s}:visible`;
    })
    .filter(Boolean)
    .join(", ");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDelayRangeMs(range) {
  const min = Number(range?.min);
  const max = Number(range?.max);
  const safeMin = Number.isFinite(min) && min >= 0 ? Math.floor(min) : DEFAULT_REPLY_DELAY_RANGE.min;
  const safeMax = Number.isFinite(max) && max >= 0 ? Math.floor(max) : DEFAULT_REPLY_DELAY_RANGE.max;
  if (safeMin <= safeMax) return { min: safeMin, max: safeMax };
  return { min: safeMax, max: safeMin };
}

function randomIntBetween(min, max) {
  if (min === max) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function clickFirstVisible(locator, timeoutMs = 1500) {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const target = locator.nth(i);
    try {
      if (!(await target.isVisible())) continue;
      await target.click({ timeout: timeoutMs });
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function safeClick(locator, timeoutMs = 2200) {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const target = locator.nth(i);
    try {
      if (!(await target.isVisible())) continue;
      await target.click({ timeout: timeoutMs });
      return true;
    } catch {
      // try next
    }
  }
  if (count > 0) {
    try {
      await locator.first().click({ timeout: timeoutMs });
      return true;
    } catch {
      // ignore
    }
  }
  return false;
}

const menuTriggerNamePattern = /더보기|메뉴|옵션|more/i;
const menuReplyActionPattern = /^(답글|답글달기|답글 달기|답변|답변작성|답변 작성|댓글달기|댓글 달기)$/i;
const genericReplyActionPattern = /답글|답변|댓글/i;

async function clickReplyActionInFloatingMenu(page) {
  const candidates = [
    page.getByRole("menuitem", { name: menuReplyActionPattern }),
    page.getByRole("button", { name: menuReplyActionPattern }),
    page.locator("[role='menu'] [role='menuitem'], [role='menu'] button, [role='menu'] a").filter({
      hasText: genericReplyActionPattern,
    }),
    page.locator("button,a,li,div,span").filter({ hasText: menuReplyActionPattern }),
  ];

  for (const locator of candidates) {
    if (await safeClick(locator, 1800)) {
      await page.waitForTimeout(250);
      return true;
    }
  }
  return false;
}

async function hasTopRightMenuLikeButton(card) {
  try {
    return await card.evaluate((root) => {
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const rootRect = root.getBoundingClientRect();
      const candidates = Array.from(root.querySelectorAll("button,[role='button']")).filter((el) => {
        if (!isVisible(el)) return false;
        const rect = el.getBoundingClientRect();
        const nearTop = rect.top - rootRect.top < 160;
        const nearRight = rootRect.right - rect.right < 160;
        const iconLike = rect.width <= 64 && rect.height <= 64;
        return nearTop && nearRight && iconLike;
      });
      return candidates.length > 0;
    });
  } catch {
    return false;
  }
}

async function clickTopRightMenuLikeButton(card) {
  try {
    return await card.evaluate((root) => {
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const rootRect = root.getBoundingClientRect();
      const candidates = Array.from(root.querySelectorAll("button,[role='button']")).filter((el) => {
        if (!isVisible(el)) return false;
        const rect = el.getBoundingClientRect();
        const nearTop = rect.top - rootRect.top < 160;
        const nearRight = rootRect.right - rect.right < 160;
        const iconLike = rect.width <= 64 && rect.height <= 64;
        return nearTop && nearRight && iconLike;
      });
      if (!candidates.length) return false;
      const target = candidates[0];
      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      if (typeof target.click === "function") target.click();
      return true;
    });
  } catch {
    return false;
  }
}

async function openReplyEditor(card, page, selectors) {
  if (selectors.replyWriteButtonSelector) {
    const bySelector = card.locator(selectors.replyWriteButtonSelector);
    if (await safeClick(bySelector)) return { ok: true, method: "direct-selector" };
  }

  const byRole = card.getByRole("button", { name: new RegExp(selectors.replyToggleButtonByText, "i") });
  if (await safeClick(byRole)) return { ok: true, method: "direct-role" };

  const byText = card.getByText(new RegExp(selectors.replyToggleButtonByText, "i"));
  if (await safeClick(byText)) return { ok: true, method: "direct-text" };

  const menuTriggers = [
    card.locator('[aria-haspopup="menu"]'),
    card.getByRole("button", { name: menuTriggerNamePattern }),
    card.locator("button[class*='menu'],button[class*='Menu'],button[class*='more'],button[class*='More']"),
  ];
  for (const trigger of menuTriggers) {
    if (await safeClick(trigger, 1600)) {
      if (await clickReplyActionInFloatingMenu(page)) return { ok: true, method: "menu-trigger" };
      try {
        await page.keyboard.press("Escape");
      } catch {
        // ignore
      }
    }
  }

  if (await clickTopRightMenuLikeButton(card)) {
    if (await clickReplyActionInFloatingMenu(page)) return { ok: true, method: "menu-top-right" };
  }

  return { ok: false };
}

async function hasReplyActionButton(card, selectors) {
  if (selectors.replyWriteButtonSelector) {
    const bySelector = card.locator(selectors.replyWriteButtonSelector);
    if ((await bySelector.count().catch(() => 0)) > 0) return true;
  }

  const pattern = new RegExp(selectors.replyToggleButtonByText, "i");
  const byRole = card.getByRole("button", { name: pattern });
  if ((await byRole.count().catch(() => 0)) > 0) return true;

  const byLocator = card.locator(`button:has-text("${selectors.replyToggleButtonByText}")`);
  if ((await byLocator.count().catch(() => 0)) > 0) return true;

  const byText = card.getByText(pattern);
  if ((await byText.count().catch(() => 0)) > 0) return true;

  const menuByRole = card.getByRole("button", { name: menuTriggerNamePattern });
  if ((await menuByRole.count().catch(() => 0)) > 0) return true;

  const menuByAria = card.locator('[aria-haspopup="menu"]');
  if ((await menuByAria.count().catch(() => 0)) > 0) return true;

  const menuByClass = card.locator(
    "button[class*='menu'],button[class*='Menu'],button[class*='more'],button[class*='More']"
  );
  if ((await menuByClass.count().catch(() => 0)) > 0) return true;

  return hasTopRightMenuLikeButton(card);
}

async function fillReplyInCard(card, page, selectors, message) {
  const opened = await openReplyEditor(card, page, selectors);
  if (!opened.ok) {
    return { ok: false, reason: "답글 버튼을 찾지 못함" };
  }
  await page.waitForTimeout(opened.method?.startsWith("menu") ? 350 : 220);

  const visibleTextareaSelector = asVisibleSelector(selectors.replyTextarea);
  let textarea = card.locator(visibleTextareaSelector).last();
  try {
    await textarea.waitFor({ timeout: 2000, state: "visible" });
    await textarea.fill(message);
  } catch {
    textarea = page.locator(visibleTextareaSelector).last();
    try {
      await textarea.waitFor({ timeout: 2500, state: "visible" });
      await textarea.fill(message);
    } catch {
      return { ok: false, reason: "답글 입력창을 찾지 못함" };
    }
  }

  return { ok: true };
}

async function clickConfirmIfPresent(page) {
  const confirmButtons = page
    .locator(
      [
        "[role='dialog'] button",
        "[role='alertdialog'] button",
        ".modal button",
        ".popup button",
        ".layer_popup button",
      ].join(",")
    )
    .filter({ hasText: /확인|예|완료|닫기/i });
  if (await safeClick(confirmButtons, 1500)) {
    await page.waitForTimeout(220);
    return true;
  }
  return false;
}

function hasOwnerReply(text, ownerReplyRegexes) {
  if (!text) return false;
  return ownerReplyRegexes.some((regex) => regex.test(text));
}

async function verifySubmitPersisted(card, page, selectors, ownerReplyRegexes) {
  for (let i = 0; i < 20; i += 1) {
    try {
      const cardText = await card.innerText();
      if (hasOwnerReply(cardText, ownerReplyRegexes)) return true;
    } catch {
      // ignore
    }

    try {
      const editDelete = card.getByRole("button", { name: /수정|삭제/ });
      if ((await editDelete.count().catch(() => 0)) > 0) return true;
    } catch {
      // ignore
    }

    try {
      const successToast = page.getByText(/등록되었습니다|답글이 등록|저장되었습니다/i);
      if ((await successToast.count().catch(() => 0)) > 0) return true;
    } catch {
      // ignore
    }

    if (selectors.replyWriteButtonSelector) {
      try {
        const writeButtons = card.locator(asVisibleSelector(selectors.replyWriteButtonSelector));
        if ((await writeButtons.count().catch(() => 0)) === 0) return true;
      } catch {
        // ignore
      }
    }

    try {
      const visibleTextarea = card.locator(`${selectors.replyTextarea}:visible`);
      const textareaCount = await visibleTextarea.count().catch(() => 0);
      if (textareaCount === 0) {
        const exactSubmit = card.getByRole("button", {
          name: new RegExp(`^\\s*${escapeRegExp(selectors.submitButtonByText)}\\s*$`, "i"),
        });
        if ((await exactSubmit.count().catch(() => 0)) === 0) return true;
      }
    } catch {
      // ignore
    }

    await page.waitForTimeout(500);
  }
  return false;
}

async function submitReplyInCard(card, page, selectors, ownerReplyRegexes) {
  const exactSubmitPattern = new RegExp(`^\\s*${escapeRegExp(selectors.submitButtonByText)}\\s*$`, "i");
  let clicked = false;

  if (selectors.submitButtonSelector) {
    const submitBySelector = card.locator(asVisibleSelector(selectors.submitButtonSelector));
    if (await safeClick(submitBySelector)) clicked = true;
  }

  if (!clicked) {
    const submitByRole = card.getByRole("button", { name: exactSubmitPattern });
    if (await safeClick(submitByRole)) clicked = true;
  }

  if (!clicked) {
    const submitByButtonText = card.locator("button").filter({ hasText: exactSubmitPattern });
    if (await safeClick(submitByButtonText)) clicked = true;
  }

  if (!clicked) {
    const textarea = card.locator(selectors.replyTextarea).last();
    const nearbySubmit = textarea
      .locator("xpath=ancestor::*[self::form or self::section or self::div][1]//button")
      .filter({ hasText: exactSubmitPattern });
    if (await safeClick(nearbySubmit)) clicked = true;
  }

  if (!clicked) {
    const pageSubmit = page.getByRole("button", { name: exactSubmitPattern });
    if (await safeClick(pageSubmit)) clicked = true;
  }

  if (!clicked) {
    const pageFallback = page.locator("button").filter({ hasText: exactSubmitPattern });
    if (await safeClick(pageFallback)) clicked = true;
  }

  if (!clicked) {
    return { ok: false, reason: "등록 버튼을 찾지 못함" };
  }

  await page.waitForTimeout(300);
  await clickConfirmIfPresent(page);
  const persisted = await verifySubmitPersisted(card, page, selectors, ownerReplyRegexes);
  if (!persisted) {
    return { ok: false, reason: "등록 클릭 후 저장 확인 실패" };
  }

  return { ok: true };
}

async function hasSmartplaceReviewSignals(scope, selectors) {
  try {
    const keywordCount = await scope.getByText(/방문자리뷰|답글여부|작성일순|방문일순|추천순/).count();
    if (keywordCount > 0) return true;

    let replyButtonCount = await scope.locator(`button:has-text("${selectors.replyToggleButtonByText}")`).count();
    if (selectors.replyWriteButtonSelector) {
      replyButtonCount += await scope.locator(selectors.replyWriteButtonSelector).count();
    }
    if (replyButtonCount > 0) return true;

    const textareaCount = await scope.locator(selectors.replyTextarea).count();
    return textareaCount > 0;
  } catch {
    return false;
  }
}

async function scoreReviewSurface(scope, selectors) {
  let score = 0;
  try {
    const scopeUrl = normalizeText(typeof scope.url === "function" ? scope.url() : "");
    if (scopeUrl.includes("smartplace")) score += 20;
    if (scopeUrl.includes("review")) score += 10;

    const keywordCount = await scope.getByText(/방문자리뷰|답글여부|작성일순|방문일순|추천순/).count();
    score += Math.min(keywordCount, 30) * 2;

    const cardCount = await scope.locator(selectors.reviewCard).count();
    score += Math.min(cardCount, 300);

    let replyWriteCount = 0;
    if (selectors.replyWriteButtonSelector) {
      replyWriteCount = await scope.locator(selectors.replyWriteButtonSelector).count();
      score += Math.min(replyWriteCount, 200) * 25;
    }

    let replyButtonCount = await scope.locator(`button:has-text("${selectors.replyToggleButtonByText}")`).count();
    if (selectors.replyWriteButtonSelector) {
      replyButtonCount += replyWriteCount;
    }
    score += Math.min(replyButtonCount, 200) * 4;

    const filterMarkers = await scope.locator('[data-area-code="rv.replyfilter"], [data-area-code="rv.replyno"]').count();
    score += Math.min(filterMarkers, 20) * 6;
  } catch {
    return -1;
  }
  return score;
}

async function chooseReviewScope(page, selectors, { preferFrames = false } = {}) {
  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  const candidates = preferFrames && frames.length > 0 ? [...frames, page] : [page, ...frames];
  let bestScope = page;
  let bestScore = -1;
  for (const scope of candidates) {
    const score = await scoreReviewSurface(scope, selectors);
    if (preferFrames && scope === page && frames.length > 0) {
      // 스마트플레이스에서 메인 페이지의 generic 엘리먼트가 과대평가되는 것 방지
      if (score <= 0) continue;
    }
    if (score > bestScore) {
      bestScore = score;
      bestScope = scope;
    }
  }
  return bestScope;
}

async function clickMyPlaceFromBizList(page, platformConfig) {
  const placeId = parseSmartplaceIdFromUrl(platformConfig.reviewManageUrl);
  const placeName = normalizeText(platformConfig.placeName || "");

  if (placeName) {
    const rows = page.locator("li,article,div").filter({ hasText: placeName });
    const rowCount = Math.min(await rows.count(), 8);
    for (let i = 0; i < rowCount; i += 1) {
      const row = rows.nth(i);
      if (await clickFirstVisible(row.getByRole("button", { name: /내 플레이스 보기/ }), 1500)) return "name-button";
      if (await clickFirstVisible(row.locator("a").filter({ hasText: /내 플레이스 보기/ }), 1500)) return "name-link";
    }
  }

  if (placeId) {
    const byId = page.locator(`a[href*="/bizes/place/${placeId}"], button[onclick*="${placeId}"]`);
    if (await clickFirstVisible(byId, 1500)) return "place-id";
  }

  if (await clickFirstVisible(page.getByRole("button", { name: /내 플레이스 보기/ }), 1500)) return "first-button";
  if (await clickFirstVisible(page.locator("a").filter({ hasText: /내 플레이스 보기/ }), 1500)) return "first-link";

  return null;
}

async function ensureSmartplaceReviewPage(page, platformConfig, selectors, onLog) {
  const reviewUrl = platformConfig.reviewManageUrl;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    onLog("system", `리뷰 페이지 이동: ${reviewUrl}`);
    await page.goto(reviewUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {
      // ignore
    }
    await page.waitForTimeout(1500);

    const scope = await chooseReviewScope(page, selectors, { preferFrames: true });
    if (await hasSmartplaceReviewSignals(scope, selectors)) {
      return scope;
    }

    const currentUrl = normalizeText(page.url());
    const looksLikeBizList = currentUrl.includes("/bizes") && !currentUrl.includes("/reviews");
    if (looksLikeBizList) {
      onLog("warn", "리뷰 화면 대신 내 업체 목록이 열렸습니다. '내 플레이스 보기' 자동 진입을 시도합니다.");
      const entry = await clickMyPlaceFromBizList(page, platformConfig);
      if (entry) {
        onLog("system", `내 플레이스 진입 성공(${entry}). 리뷰 페이지를 다시 엽니다.`);
        await page.goto(reviewUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1500);
        const retriedScope = await chooseReviewScope(page, selectors, { preferFrames: true });
        if (await hasSmartplaceReviewSignals(retriedScope, selectors)) {
          return retriedScope;
        }
      }
    }
  }

  throw new Error("스마트플레이스 리뷰 화면 진입에 실패했습니다. 리뷰 관리 URL/매장 계정을 확인해주세요.");
}

async function scoreCardLocator(locator, selectors) {
  const count = await locator.count().catch(() => 0);
  if (count === 0) {
    return { count: 0, replyButtons: 0, reviewHints: 0, score: 0 };
  }

  let replyButtons = 0;
  try {
    replyButtons = await locator.locator(`button:has-text("${selectors.replyToggleButtonByText}")`).count();
    if (selectors.replyWriteButtonSelector) {
      replyButtons += await locator.locator(selectors.replyWriteButtonSelector).count();
    }
  } catch {
    replyButtons = 0;
  }

  const reviewHints = await locator.filter({ hasText: /방문일|작성일|리뷰|답글/ }).count().catch(() => 0);
  const density = count > 0 ? replyButtons / count : 0;
  const score =
    Math.min(replyButtons, 300) * 12 +
    Math.min(reviewHints, 500) * 2 +
    Math.min(count, 500) +
    Math.round(density * 500);
  return { count, replyButtons, reviewHints, score };
}

async function selectReviewCardsLocator(scope, selectors) {
  const candidates = [];

  if (selectors.replyWriteButtonSelector) {
    const visibleReplyWrite = asVisibleSelector(selectors.replyWriteButtonSelector);
    const replyWriteButtons = scope.locator(visibleReplyWrite);
    candidates.push({
      label: "reply-write-ancestor",
      locator: replyWriteButtons.locator("xpath=ancestor::*[self::li or self::article or self::div][1]"),
    });

    const strictReviewCards = replyWriteButtons.locator(
      "xpath=ancestor::li[contains(@class,'Review_pui_review__')][1]"
    );
    candidates.push({
      label: "reply-write-strict",
      locator: strictReviewCards,
    });
  }

  if (selectors.reviewCard) {
    const visibleReviewCard = asVisibleSelector(selectors.reviewCard);
    candidates.push({
      label: "configured",
      locator: scope.locator(visibleReviewCard),
    });
    if (selectors.replyWriteButtonSelector) {
      const visibleReplyWrite = asVisibleSelector(selectors.replyWriteButtonSelector);
      candidates.push({
        label: "configured-with-reply-write",
        locator: scope.locator(visibleReviewCard).filter({ has: scope.locator(visibleReplyWrite) }),
      });
    }
  }

  candidates.push({
    label: "generic",
    locator: scope.locator("li[class*='Review_pui_review__']:visible, article:visible, li:visible, div[class*='review']:visible, div[class*='Review']:visible, tr:visible"),
  });

  let best = { label: "generic", locator: candidates[candidates.length - 1].locator, stats: { score: 0, count: 0 } };
  for (const candidate of candidates) {
    const stats = await scoreCardLocator(candidate.locator, selectors);
    if (stats.score > best.stats.score) {
      best = { ...candidate, stats };
    }
  }

  return best;
}

async function chooseBestCardSource(page, preferredScope, selectors) {
  if (preferredScope && preferredScope !== page && selectors.replyWriteButtonSelector) {
    const preferredActionCount = await preferredScope
      .locator(asVisibleSelector(selectors.replyWriteButtonSelector))
      .count()
      .catch(() => 0);
    if (preferredActionCount > 0) {
      const selected = await selectReviewCardsLocator(preferredScope, selectors);
      return {
        target: preferredScope,
        label: "scope",
        selected,
        count: Number(selected?.stats?.count || 0),
        rank: Number(selected?.stats?.score || 0) + preferredActionCount * 30,
        actionCount: preferredActionCount,
      };
    }
  }

  const sources = [];

  const pushSource = (target, label) => {
    if (!target) return;
    if (sources.some((s) => s.target === target)) return;
    sources.push({ target, label });
  };

  pushSource(preferredScope, "scope");
  pushSource(page, "page");

  let best = null;
  for (const source of sources) {
    const selected = await selectReviewCardsLocator(source.target, selectors);
    const stats = selected.stats || { count: 0, score: 0 };
    const count = Number(stats.count) || 0;
    const score = Number(stats.score) || 0;
    let actionCount = 0;
    if (selectors.replyWriteButtonSelector) {
      actionCount = await source.target.locator(asVisibleSelector(selectors.replyWriteButtonSelector)).count().catch(() => 0);
    }
    const rank = score + Math.min(count, 200) + actionCount * 30;

    if (!best || rank > best.rank) {
      best = { ...source, selected, count, rank, actionCount };
    }
  }

  return best || {
    target: preferredScope || page,
    label: "scope",
    selected: { label: "generic", locator: (preferredScope || page).locator("article:visible,li:visible") },
    count: 0,
    rank: 0,
  };
}

async function isUnrepliedFilterSelected(scope) {
  const selectedByFilterText = await scope
    .locator('[data-area-code="rv.replyfilter"]')
    .filter({ hasText: /^미등록$/ })
    .count()
    .catch(() => 0);
  if (selectedByFilterText > 0) return true;

  const selectedByFilterClass = await scope
    .locator('[data-area-code="rv.replyfilter"] .Select_active__Mj9Uk')
    .filter({ hasText: /^미등록$/ })
    .count()
    .catch(() => 0);
  if (selectedByFilterClass > 0) return true;

  const quickSelectors = [
    '[data-area-code="rv.replyno"].Select_active__Mj9Uk',
    '[data-area-code="rv.replyno"][aria-selected="true"]',
    '[data-area-code="rv.replyno"][aria-pressed="true"]',
    "[role='option'][aria-selected='true']",
    "[role='menuitemradio'][aria-checked='true']",
    "[role='radio'][aria-checked='true']",
    "[data-selected='true']",
    "[data-state='checked']",
  ];

  for (const selector of quickSelectors) {
    const count = await scope.locator(selector).filter({ hasText: /^미등록$/ }).count().catch(() => 0);
    if (count > 0) return true;
  }

  const headingWithUnreplied = await scope
    .locator("button,[role='button'],div,span,p,label")
    .filter({ hasText: /답글여부/ })
    .filter({ hasText: /미등록/ })
    .count()
    .catch(() => 0);
  return headingWithUnreplied > 0;
}

async function clickUnrepliedOption(scope) {
  const candidates = [
    scope.locator('[data-area-code="rv.replyno"]'),
    scope.locator('a[data-area-code="rv.replyno"][role="button"]'),
    scope.getByRole("option", { name: /미등록/ }),
    scope.getByRole("menuitem", { name: /미등록/ }),
    scope.getByRole("menuitemradio", { name: /미등록/ }),
    scope.getByRole("radio", { name: /미등록/ }),
    scope.getByText(/^미등록$/),
    scope.locator("li,button,a,div,span,p,label").filter({ hasText: /^미등록$/ }),
  ];

  for (const locator of candidates) {
    if (await safeClick(locator, 1500)) {
      await scope.waitForTimeout(700);
      return true;
    }
  }
  return false;
}

async function applyUnrepliedFilter(scope, page, onLog) {
  if (await isUnrepliedFilterSelected(scope)) {
    onLog("system", "답글여부 필터가 이미 '미등록'으로 설정되어 있습니다.");
    return true;
  }

  if (await clickUnrepliedOption(scope)) {
    if (await isUnrepliedFilterSelected(scope)) {
      onLog("system", "답글여부 필터 '미등록' 적용 완료(data-area/direct).");
      return true;
    }
  }

  const triggers = [
    scope.locator('[data-area-code="rv.replyfilter"]'),
    scope.locator('a[data-area-code="rv.replyfilter"][role="button"]'),
    scope.getByRole("button", { name: /답글여부/ }),
    scope.locator("button,[role='button'],div[role='button'],span").filter({ hasText: /답글여부/ }),
    scope.locator("button,[role='button'],div[role='button'],span").filter({ hasText: /^전체$/ }),
  ];

  for (const trigger of triggers) {
    if (!(await safeClick(trigger, 1500))) continue;
    await scope.waitForTimeout(220);
    if (await clickUnrepliedOption(scope)) {
      if (await isUnrepliedFilterSelected(scope)) {
        onLog("system", "답글여부 필터 '미등록' 적용 완료(dropdown).");
        return true;
      }
    }
    try {
      await page.keyboard.press("Escape");
    } catch {
      // ignore
    }
  }

  // 마지막 fallback: DOM click
  const domClicked = await scope
    .evaluate(() => {
      const normalize = (v) => (v || "").replace(/\s+/g, "").trim();
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const nodes = Array.from(
        document.querySelectorAll("button,[role='button'],li,a,div,span,p,label,[role='option'],[role='menuitem']")
      ).filter((el) => isVisible(el) && normalize(el.textContent) === "미등록");

      const target = nodes[0];
      if (!target) return false;

      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      if (typeof target.click === "function") {
        target.click();
      }
      return true;
    })
    .catch(() => false);

  if (domClicked) {
    await scope.waitForTimeout(700);
    if (await isUnrepliedFilterSelected(scope)) {
      onLog("system", "답글여부 필터 '미등록' 적용 완료(dom-fallback).");
      return true;
    }
  }

  return false;
}

async function narrowToActionableCards(cards, scope, selectors) {
  const variants = [];
  if (selectors.replyWriteButtonSelector) {
    variants.push({
      label: "has-reply-write-selector",
      locator: cards.filter({ has: scope.locator(selectors.replyWriteButtonSelector) }),
    });
  }
  variants.push({
    label: "has-reply-button-text",
    locator: cards.filter({ has: scope.locator(`button:has-text("${selectors.replyToggleButtonByText}")`) }),
  });

  let best = null;
  for (const variant of variants) {
    const count = await variant.locator.count().catch(() => 0);
    if (count > 0 && (!best || count > best.count)) {
      best = { ...variant, count };
    }
  }
  return best;
}

async function waitAfterSkip(page) {
  await page.waitForTimeout(SKIP_DELAY_MS);
}

async function scrollReviewSurface(scope, page) {
  try {
    await scope.evaluate(() => {
      window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
    });
  } catch {
    await page.evaluate(() => {
      window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
    });
  }
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
    apiKey: apiKey || process.env.OPENAI_API_KEY,
  };
  return aiConfig;
}

function isUnsetSmartplaceReviewUrl(platform, userConfig) {
  if (platform !== "smartplace") return false;
  const configuredUrl = String(userConfig.reviewManageUrl || "").trim();
  return !configuredUrl || configuredUrl === DEFAULT_CONFIG.smartplace.reviewManageUrl;
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
    const delayRange = normalizeDelayRangeMs(platformConfig.replyDelayRangeMs || userConfig.replyDelayRangeMs);

    if (isUnsetSmartplaceReviewUrl(run.platform, userConfig)) {
      onLog("error", "스마트플레이스 리뷰 관리 URL이 설정되지 않았습니다. [AI 답글 설정]에서 본인 매장의 '리뷰관리 페이지 URL'을 저장한 뒤 다시 실행해주세요.");
      result.status = "failed";
      result.exitCode = 1;
      return;
    }

    browser = await chromium.launch(buildLaunchOptions());
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: sessionData,
    });
    const page = await context.newPage();

    const sel = platformConfig.selectors;
    let scope = page;
    if (run.platform === "smartplace") {
      scope = await ensureSmartplaceReviewPage(page, platformConfig, sel, onLog);
    } else {
      const reviewUrl = platformConfig.reviewManageUrl;
      onLog("system", `리뷰 페이지 이동: ${reviewUrl}`);
      await page.goto(reviewUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      try {
        await page.waitForLoadState("networkidle", { timeout: 8000 });
      } catch {
        // ignore
      }
      await page.waitForTimeout(1200);
      scope = await chooseReviewScope(page, sel);
    }

    if (run.platform === "smartplace" && sel.replyWriteButtonSelector) {
      const scopeReplyActions = await scope
        .locator(asVisibleSelector(sel.replyWriteButtonSelector))
        .count()
        .catch(() => 0);
      const pageReplyActions = await page
        .locator(asVisibleSelector(sel.replyWriteButtonSelector))
        .count()
        .catch(() => 0);
      onLog("system", `스코프 점검: scope.replywrite=${scopeReplyActions}, page.replywrite=${pageReplyActions}`);
    }

    let sourceChoice = await chooseBestCardSource(page, scope, sel);
    let runSurface = sourceChoice.target;
    let cards = sourceChoice.selected.locator;
    let total = await cards.count();
    onLog(
      "system",
      `리뷰 카드 ${total}개 발견 (surface: ${sourceChoice.label}, source: ${sourceChoice.selected.label}, replyActions: ${sourceChoice.actionCount || 0})`
    );

    if (run.platform === "smartplace" && total > 0) {
      const surfaces = [sourceChoice.target, scope, page].filter((target, idx, arr) => target && arr.indexOf(target) === idx);
      let filterApplied = false;
      for (const surface of surfaces) {
        if (await applyUnrepliedFilter(surface, page, onLog)) {
          filterApplied = true;
          break;
        }
      }
      if (!filterApplied) {
        onLog("warn", "답글여부 '미등록' 필터 적용에 실패했습니다. 전체 리뷰 대상으로 진행합니다.");
      } else {
        sourceChoice = await chooseBestCardSource(page, scope, sel);
        runSurface = sourceChoice.target;
        cards = sourceChoice.selected.locator;
        total = await cards.count();
        onLog(
          "system",
          `필터 적용 후 리뷰 카드 ${total}개 (surface: ${sourceChoice.label}, source: ${sourceChoice.selected.label}, replyActions: ${sourceChoice.actionCount || 0})`
        );
      }
    }

    if (total === 0) {
      if (run.platform === "smartplace") {
        onLog("warn", "리뷰 카드가 0개라서 리뷰 페이지를 다시 열고 한 번 더 탐색합니다.");
        await page.goto(platformConfig.reviewManageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        try {
          await page.waitForLoadState("networkidle", { timeout: 8000 });
        } catch {
          // ignore
        }
        await page.waitForTimeout(1300);
        scope = await chooseReviewScope(page, sel, { preferFrames: true });
        sourceChoice = await chooseBestCardSource(page, scope, sel);
        runSurface = sourceChoice.target;
        cards = sourceChoice.selected.locator;
        total = await cards.count();
        onLog(
          "system",
          `재탐색 결과: 리뷰 카드 ${total}개 (surface: ${sourceChoice.label}, source: ${sourceChoice.selected.label}, replyActions: ${sourceChoice.actionCount || 0})`
        );
      }
    }

    if (total === 0) {
      const emptyReviewTextCount = await sourceChoice.target
        .getByText(/리뷰가 없습니다|등록된 리뷰가 없습니다|표시할 리뷰가 없습니다|리뷰 없음/)
        .count()
        .catch(() => 0);
      if (emptyReviewTextCount > 0) {
        onLog("system", "처리할 리뷰가 없습니다.");
        return;
      }

      const currentUrl = typeof sourceChoice.target.url === "function" ? sourceChoice.target.url() : page.url();
      const title = await page.title().catch(() => "");
      if (currentUrl.includes("nid.naver.com") || /로그인/i.test(title)) {
        onLog("warn", "네이버 로그인이 만료되었거나 추가 인증이 필요합니다. 네이버 계정을 다시 연결해주세요.");
      } else {
        onLog("warn", `리뷰 카드를 찾지 못했습니다. 현재 페이지: ${currentUrl || "-"} ${title ? `(title: ${title})` : ""}`);
        onLog("warn", "스마트플레이스의 경우 [AI 답글 설정]에서 본인 매장의 '리뷰관리 페이지 URL'을 정확히 입력해야 합니다.");
      }
      result.status = "failed";
      result.exitCode = 1;
      return;
    }

    const actionable = await narrowToActionableCards(cards, runSurface, sel);
    if (actionable && actionable.count > 0) {
      cards = actionable.locator;
      total = actionable.count;
      onLog("system", `답글 작성 가능한 카드 ${total}개로 재선정 (${actionable.label})`);
    }

    const ownerPatterns = run.platform === "smartstore"
      ? [/판매자.*답글/i, /답글 완료/i]
      : [/사장님.*답글/i, /답글 완료/i];

    let skippedAlreadyReplied = 0;
    let skippedNoAction = 0;
    let skippedNoSubmit = 0;
    let skippedAi = 0;
    let skippedNoTextarea = 0;

    let cursor = 0;
    let exhaustedScrollTry = 0;
    while (result.processed < limit) {
      if (run.stopRequested) {
        onLog("system", "사용자 중지 요청");
        result.status = "stopped";
        break;
      }

      if (cursor >= total) {
        await scrollReviewSurface(runSurface, page);
        await page.waitForTimeout(900);
        const nextTotal = await cards.count();
        if (nextTotal > total) {
          total = nextTotal;
          exhaustedScrollTry = 0;
          onLog("system", `추가 리뷰 로드: 총 ${total}개`);
          continue;
        }
        exhaustedScrollTry += 1;
        if (exhaustedScrollTry >= 2) {
          break;
        }
        continue;
      }

      const card = cards.nth(cursor);
      const cardOrder = cursor + 1;
      cursor++;
      result.scanned++;

      try { await card.scrollIntoViewIfNeeded(); } catch { /* */ }

      let cardText = "";
      try {
        cardText = await card.innerText();
      } catch {
        await waitAfterSkip(page);
        continue;
      }

      // 이미 답글 있는지 확인
      if (ownerPatterns.some((p) => p.test(cardText))) {
        skippedAlreadyReplied += 1;
        await waitAfterSkip(page);
        continue;
      }

      const hasReplyAction = await hasReplyActionButton(card, sel);
      if (!hasReplyAction) {
        skippedNoAction += 1;
        if (skippedNoAction <= 3) {
          onLog("warn", `#${cardOrder} 답글 버튼 없음(선택자 미일치 가능) -> skip`);
        }
        await waitAfterSkip(page);
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
        skippedAi += 1;
        await waitAfterSkip(page);
        continue;
      }

      if (!reply) {
        skippedAi += 1;
        await waitAfterSkip(page);
        continue;
      }

      const filled = await fillReplyInCard(card, page, sel, reply);
      if (!filled.ok) {
        onLog("warn", `#${cardOrder} 입력 실패: ${filled.reason} -> skip`);
        skippedNoTextarea += 1;
        await waitAfterSkip(page);
        continue;
      }

      if (dryRun) {
        result.processed++;
        onLog("dry-run", `#${result.processed} ${reply.slice(0, 60)}...`);
        continue;
      }

      const submitted = await submitReplyInCard(card, page, sel, ownerPatterns);
      if (!submitted.ok) {
        skippedNoSubmit += 1;
        onLog("warn", `#${cardOrder} 등록 실패: ${submitted.reason} -> skip`);
        await waitAfterSkip(page);
        continue;
      }

      result.processed++;
      onLog("done", `#${result.processed} 답글 등록 완료`);
      const waitMs = randomIntBetween(delayRange.min, delayRange.max);
      await page.waitForTimeout(waitMs);
    }

    onLog("system", `완료: 스캔 ${result.scanned}개, 처리 ${result.processed}개`);
    onLog(
      "system",
      `스킵 요약: 기답글 ${skippedAlreadyReplied}개, 답글버튼없음 ${skippedNoAction}개, 입력창없음 ${skippedNoTextarea}개, 등록실패 ${skippedNoSubmit}개, AI실패 ${skippedAi}개`
    );
  } catch (err) {
    onLog("error", `실행 오류: ${err.message}`);
    result.status = "failed";
    result.exitCode = 1;
  } finally {
    try { await browser?.close(); } catch { /* */ }
    await onFinish(result);
  }
}
