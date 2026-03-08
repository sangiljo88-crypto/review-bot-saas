# Smart Review AI (SaaS)

네이버 스마트플레이스/스마트스토어 리뷰 자동 답글 서비스

## 기능

- 이메일 회원가입/로그인
- 서버 내 네이버 QR 로그인 (네이버 앱으로 스캔)
- 사용자별 네이버 세션 암호화 저장
- AI 기반 리뷰 답글 자동 생성 (OpenAI)
- SSE 기반 실시간 실행 로그
- 실행 이력 조회

## Railway 배포

### 1. PostgreSQL 추가

Railway Dashboard → New → Database → PostgreSQL

### 2. 환경변수 설정

| 변수 | 설명 |
|------|------|
| `DATABASE_URL` | Railway PostgreSQL 자동 연결 |
| `JWT_SECRET` | JWT 서명 키 (랜덤 문자열) |
| `SESSION_ENCRYPT_KEY` | 세션 암호화 키 (정확히 32자) |
| `OPENAI_API_KEY` | (선택) 서버 기본 API 키 |

`DATABASE_URL`, `JWT_SECRET`, `SESSION_ENCRYPT_KEY`가 없으면 서버가 시작되지 않습니다.

### 3. 배포

```bash
git push
```

Railway가 Dockerfile을 감지하여 자동 빌드 및 배포합니다.

### 4. 도메인 생성 및 접속

Railway Service → Settings → Networking → **Generate Domain**

생성된 URL로 접속하고, 서버가 살아있는지 `GET /healthz`로 확인할 수 있습니다.

## 로컬 개발

```bash
npm install
npx playwright install chromium
export DATABASE_URL="postgresql://..."
export JWT_SECRET="dev-secret"
export SESSION_ENCRYPT_KEY="01234567890123456789012345678901"
# 로컬에서 크롬 창을 보면서 실행하려면
export PLAYWRIGHT_HEADLESS="false"
npm run dev
```

## 네이버 로그인 방식

서버에서 headless 브라우저로 네이버 로그인 페이지를 열고,
QR 코드를 캡처하여 사용자에게 보여줍니다.
사용자가 네이버 앱으로 QR을 스캔하면 로그인이 완료되고,
세션이 자동으로 암호화 저장됩니다.
