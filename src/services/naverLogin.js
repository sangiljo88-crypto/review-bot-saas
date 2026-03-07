import { chromium } from "playwright";
import crypto from "node:crypto";
import { saveNaverSession } from "../routes/naver.js";

const NAVER_LOGIN_URL = "https://nid.naver.com/nidlogin.login";
const AUTH_CHECK_URLS = [
  "https://naver.com",
  "https://www.naver.com",
  "https://new.smartplace.naver.com",
  "https://sell.smartstore.naver.com",
];
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5분
const POLL_INTERVAL_MS = 2000;
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

async function refreshLoginPreview(session, { allowFullPageFallback = false } = {}) {
  const { page } = session;

  await tryActivateQrTab(page);
  const qrDataUrl = await captureQrDataUrl(page);

  if (qrDataUrl) {
    session.qrDataUrl = qrDataUrl;
    session.message = "QR 코드가 준비되었습니다. 네이버 앱으로 스캔하세요.";
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
    await refreshLoginPreview(session, { allowFullPageFallback: true });

    // 쿠키 감지 루프
    const startTime = Date.now();
    while (Date.now() - startTime < LOGIN_TIMEOUT_MS) {
      if (session.status === "cancelled") return;

      session.status = "checking";
      const cookies = await context.cookies(...AUTH_CHECK_URLS);
      const hasAuth = cookies.some((c) => c.name === "NID_SES" || c.name === "NID_AUT");

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

      // QR 갱신 시도
      await refreshLoginPreview(session);

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
