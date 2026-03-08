import { chromium } from "playwright";
import { buildReplyWithAI } from "../ai/replyGenerator.js";

const DEFAULT_CONFIG = {
  smartplace: {
    reviewManageUrl: "https://new.smartplace.naver.com/",
    selectors: {
      reviewCard: "li[class*='Review_pui_review__'], li[class*='review'], article[class*='review'], div[class*='review-card'], div[class*='Review']",
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

    let replyButtonCount = await scope.locator(`button:has-text("${selectors.replyToggleButtonByText}")`).count();
    if (selectors.replyWriteButtonSelector) {
      replyButtonCount += await scope.locator(selectors.replyWriteButtonSelector).count();
    }
    score += Math.min(replyButtonCount, 200) * 4;
  } catch {
    return -1;
  }
  return score;
}

async function chooseReviewScope(page, selectors) {
  const candidates = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
  let bestScope = page;
  let bestScore = -1;
  for (const scope of candidates) {
    const score = await scoreReviewSurface(scope, selectors);
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

    const scope = await chooseReviewScope(page, selectors);
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
        const retriedScope = await chooseReviewScope(page, selectors);
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
    const rank = score + Math.min(count, 200);

    if (!best || rank > best.rank) {
      best = { ...source, selected, count, rank };
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
    scope.getByRole("option", { name: /미등록/ }),
    scope.getByRole("menuitem", { name: /미등록/ }),
    scope.getByRole("menuitemradio", { name: /미등록/ }),
    scope.getByRole("radio", { name: /미등록/ }),
    scope.getByText(/^미등록$/),
    scope.locator("li,button,a,div,span,p,label").filter({ hasText: /^미등록$/ }),
  ];

  for (const locator of candidates) {
    if (await clickFirstVisible(locator, 1300)) {
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
    scope.getByRole("button", { name: /답글여부/ }),
    scope.locator("button,[role='button'],div[role='button'],span").filter({ hasText: /답글여부/ }),
    scope.locator("button,[role='button'],div[role='button'],span").filter({ hasText: /^전체$/ }),
  ];

  for (const trigger of triggers) {
    if (!(await clickFirstVisible(trigger, 1200))) continue;
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

    let sourceChoice = await chooseBestCardSource(page, scope, sel);
    let cards = sourceChoice.selected.locator;
    let total = await cards.count();
    onLog("system", `리뷰 카드 ${total}개 발견 (surface: ${sourceChoice.label}, source: ${sourceChoice.selected.label})`);

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
        cards = sourceChoice.selected.locator;
        total = await cards.count();
        onLog("system", `필터 적용 후 리뷰 카드 ${total}개 (surface: ${sourceChoice.label}, source: ${sourceChoice.selected.label})`);
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
        scope = await chooseReviewScope(page, sel);
        sourceChoice = await chooseBestCardSource(page, scope, sel);
        cards = sourceChoice.selected.locator;
        total = await cards.count();
        onLog("system", `재탐색 결과: 리뷰 카드 ${total}개 (surface: ${sourceChoice.label}, source: ${sourceChoice.selected.label})`);
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

    const actionable = await narrowToActionableCards(cards, sourceChoice.target, sel);
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
        await scrollReviewSurface(scope, page);
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
      cursor++;
      result.scanned++;

      try { await card.scrollIntoViewIfNeeded(); } catch { /* */ }

      let cardText = "";
      try { cardText = await card.innerText(); } catch { continue; }

      // 이미 답글 있는지 확인
      if (ownerPatterns.some((p) => p.test(cardText))) {
        skippedAlreadyReplied += 1;
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
        continue;
      }

      if (!reply) {
        skippedAi += 1;
        continue;
      }

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
      if (!opened) {
        skippedNoAction += 1;
        if (skippedNoAction <= 3) {
          onLog("warn", `#${cursor} 답글 버튼을 찾지 못해 스킵`);
        }
        continue;
      }

      await page.waitForTimeout(300);

      // textarea에 답글 입력
      try {
        const textarea = card.locator(sel.replyTextarea).last();
        await textarea.waitFor({ timeout: 2000, state: "visible" });
        await textarea.fill(reply);
      } catch {
        onLog("warn", `#${cursor} 답글 입력창 없음`);
        skippedNoTextarea += 1;
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
    onLog(
      "system",
      `스킵 요약: 기답글 ${skippedAlreadyReplied}개, 답글버튼없음 ${skippedNoAction}개, 입력창없음 ${skippedNoTextarea}개, AI실패 ${skippedAi}개`
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
