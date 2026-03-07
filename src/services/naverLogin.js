import { chromium } from "playwright";
import crypto from "node:crypto";
import { saveNaverSession } from "../routes/naver.js";

const NAVER_LOGIN_URL = "https://nid.naver.com/nidlogin.login";
const NAVER_LOGIN_HOST = "nid.naver.com";
const AUTH_CHECK_URLS = [
  "https://nid.naver.com",
  "https://naver.com",
  "https://www.naver.com",
  "https://new.smartplace.naver.com",
  "https://sell.smartstore.naver.com",
];
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5분
const POLL_INTERVAL_MS = 2000;
const CHALLENGE_CAPTURE_INTERVAL_MS = 5000;
const NUMBER_CHALLENGE_KEYWORDS = [
  "PC화면에 보이는 숫자",
  "PC 화면에 보이는 숫자",
  "보이는 숫자를 선택",
  "숫자를 선택하면",
  "인증번호",
];
const QR_TAB_SELECTORS = [
  'button:has-text("QR코드")',
  'a:has-text("QR코드")',
  '[role="tab"]:has-text("QR코드")',
  '[role="tab"]:has-text("QR")',
  'text=QR코드',
];
const QR_IMAGE_SELECTORS = [
  "#qr_wrap img",
  ".qr_area img",
  'img[alt*="QR"]',
  'img[src*="qr"]',
  '[class*="qr"] img',
  "canvas",
];

// 진행 중인 로그인 세션 관리
const loginSessions = new Map();

function buildLaunchOptions() {
  return {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  };
}

function toDataUrl(pngBuffer) {
  return `data:image/png;base64,${pngBuffer.toString("base64")}`;
}

async function tryActivateQrTab(page) {
  for (const selector of QR_TAB_SELECTORS) {
    try {
      const tab = page.locator(selector).first();
      if (await tab.count()) {
        await tab.click({ timeout: 1500 });
        await page.waitForTimeout(300);
        return true;
      }
    } catch {
      // ignore and try next selector
    }
  }
  return false;
}

async function captureQrDataUrl(page) {
  for (const selector of QR_IMAGE_SELECTORS) {
    try {
      const element = page.locator(selector).first();
      if (await element.count()) {
        const screenshot = await element.screenshot({ type: "png" });
        return toDataUrl(screenshot);
      }
    } catch {
      // ignore and try next selector
    }
  }
  return null;
}

async function refreshLoginPreview(
  session,
  { allowFullPageFallback = false, activateQrTab = false } = {}
) {
  const { page } = session;

  if (activateQrTab) {
    await tryActivateQrTab(page);
  }
  const qrDataUrl = await captureQrDataUrl(page);

  if (qrDataUrl) {
    session.qrDataUrl = qrDataUrl;
    if (!session.challengeDataUrl) {
      session.message = "QR 코드가 준비되었습니다. 네이버 앱으로 스캔하세요.";
    }
    return true;
  }

  if (allowFullPageFallback && !session.fullPageFallbackUsed) {
    try {
      const screenshot = await page.screenshot({ type: "png", fullPage: true });
      session.qrDataUrl = toDataUrl(screenshot);
      session.fullPageFallbackUsed = true;
      session.message = "QR 자동 인식에 실패했습니다. 표시된 이미지에서 QR 코드 영역을 스캔해주세요.";
    } catch {
      // ignore
    }
  }

  return false;
}

function hasNumberChallenge(text) {
  return NUMBER_CHALLENGE_KEYWORDS.some((keyword) => text.includes(keyword));
}

async function detectNumericChoices(page) {
  try {
    const numbers = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("button, a, [role='button'], li, span, div"));
      const found = new Set();
      for (const node of nodes) {
        const text = (node.textContent || "").trim();
        if (/^\d{1,3}$/.test(text)) {
          found.add(text);
        }
        if (found.size >= 3) break;
      }
      return Array.from(found);
    });
    return numbers;
  } catch {
    return [];
  }
}

async function refreshChallengePreview(session) {
  const { page } = session;
  let bodyText = "";

  try {
    bodyText = await page.evaluate(() => document.body?.innerText || "");
  } catch {
    return false;
  }

  const numericChoices = await detectNumericChoices(page);
  const challengeDetected = hasNumberChallenge(bodyText) || numericChoices.length >= 3;
  session.challengeActive = challengeDetected;
  session.challengeNumbers = numericChoices;

  if (!challengeDetected) {
    return false;
  }

  const now = Date.now();
  if (session.challengeDataUrl && now - session.lastChallengeCapturedAt < CHALLENGE_CAPTURE_INTERVAL_MS) {
    return true;
  }

  try {
    const screenshot = await page.screenshot({ type: "png" });
    session.challengeDataUrl = toDataUrl(screenshot);
    session.lastChallengeCapturedAt = now;
    session.message = numericChoices.length >= 3
      ? `휴대폰에 나온 숫자를 선택하세요. (PC 표시 숫자: ${numericChoices.join(", ")})`
      : "휴대폰에 나온 숫자를 아래 번호 확인 화면에서 보고 같은 숫자를 선택하세요.";
    return true;
  } catch {
    return false;
  }
}

/**
 * 네이버 로그인 브라우저 세션을 시작합니다.
 * 사용자가 웹 UI에서 QR코드 또는 쿠키 입력 방식으로 로그인을 완료하면
 * 세션이 자동 캡처됩니다.
 */
export async function launchLoginBrowser(userId, platform) {
  // 이미 진행 중인 세션이 있으면 정리
  for (const [sid, session] of loginSessions) {
    if (session.userId === userId) {
      await destroyLoginBrowser(sid);
    }
  }

  const sessionId = crypto.randomUUID();
  const browser = await chromium.launch(buildLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const session = {
    id: sessionId,
    userId,
    platform,
    browser,
    context,
    page,
    status: "waiting",        // waiting | checking | success | failed | cancelled
    loginUrl: NAVER_LOGIN_URL,
    qrDataUrl: null,          // QR 코드 이미지 (추후 확장용)
    challengeDataUrl: null,   // 숫자 선택 인증용 화면
    lastChallengeCapturedAt: 0,
    challengeActive: false,
    challengeNumbers: [],
    fullPageFallbackUsed: false,
    message: "네이버 로그인 페이지로 이동 중...",
    createdAt: Date.now(),
  };

  loginSessions.set(sessionId, session);

  // 백그라운드에서 로그인 감지 시작
  detectLogin(session).catch((err) => {
    console.error(`[naver-login] ${sessionId} error:`, err.message);
    session.status = "failed";
    session.message = `로그인 감지 실패: ${err.message}`;
  });

  return sessionId;
}

async function detectLogin(session) {
  const { page, context } = session;

  try {
    await page.goto(NAVER_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      // 페이지 상태에 따라 networkidle을 못 기다릴 수 있으므로 무시
    }
    session.message = "네이버 로그인 페이지가 준비되었습니다. 아래 방법 중 하나로 로그인해주세요.";

    await page.waitForTimeout(1200);
    await refreshLoginPreview(session, { allowFullPageFallback: true, activateQrTab: true });
    await refreshChallengePreview(session);

    // 쿠키 감지 루프
    const startTime = Date.now();
    while (Date.now() - startTime < LOGIN_TIMEOUT_MS) {
      if (session.status === "cancelled") return;

      session.status = "checking";
      const currentUrl = page.url();
      const cookies = await context.cookies(...AUTH_CHECK_URLS, currentUrl);
      const hasAuth = cookies.some((c) => c.name === "NID_SES" || c.name === "NID_AUT");
      const leftLoginPage =
        currentUrl &&
        !currentUrl.includes(`${NAVER_LOGIN_HOST}/nidlogin.login`) &&
        !currentUrl.includes("about:blank");

      if (hasAuth) {
        session.status = "success";
        session.message = "로그인 성공! 세션을 저장합니다.";

        // storageState 캡처 후 DB 저장
        const storageState = await context.storageState();
        await saveNaverSession(session.userId, session.platform, storageState, "웹 로그인");

        // 정리
        setTimeout(() => destroyLoginBrowser(session.id), 3000);
        return;
      }

      // 일부 환경에서는 쿠키 반영이 지연되고, 먼저 로그인 페이지를 벗어나는 경우가 있습니다.
      if (leftLoginPage && cookies.some((c) => c.domain?.includes("naver.com"))) {
        session.status = "success";
        session.message = "로그인 성공(리다이렉트 감지)! 세션을 저장합니다.";
        const storageState = await context.storageState();
        await saveNaverSession(session.userId, session.platform, storageState, "웹 로그인");
        setTimeout(() => destroyLoginBrowser(session.id), 3000);
        return;
      }

      // 숫자 선택 인증(모바일) 화면이 뜨면 번호 확인용 이미지를 함께 전송
      const challengeVisible = await refreshChallengePreview(session);

      // QR 갱신 시도
      if (!challengeVisible) {
        await refreshLoginPreview(session, { activateQrTab: false });
      }

      await page.waitForTimeout(POLL_INTERVAL_MS);
    }

    // 타임아웃
    session.status = "failed";
    session.message = "로그인 대기 시간이 초과되었습니다. 다시 시도해주세요.";
  } finally {
    if (session.status !== "success") {
      setTimeout(() => destroyLoginBrowser(session.id), 5000);
    }
  }
}

export function getLoginStatus(sessionId) {
  const session = loginSessions.get(sessionId);
  if (!session) return null;
  return {
    sessionId: session.id,
    status: session.status,
    message: session.message,
    qrDataUrl: session.qrDataUrl,
    challengeDataUrl: session.challengeDataUrl,
    challengeNumbers: session.challengeNumbers,
    elapsed: Math.round((Date.now() - session.createdAt) / 1000),
  };
}

export async function destroyLoginBrowser(sessionId) {
  const session = loginSessions.get(sessionId);
  if (!session) return;
  session.status = session.status === "success" ? "success" : "cancelled";
  try {
    await session.browser?.close();
  } catch {
    // ignore
  }
  loginSessions.delete(sessionId);
}
