import OpenAI from "openai";

let openaiClient;
const generatedReplyHistory = [];
const maxReplyHistory = 120;

const noiseLinePatterns = [
  /^리뷰\s*\d+/,
  /^사진\s*\d+/,
  /^\d+번째 방문/,
  /^방문일/,
  /^작성일/,
  /^결제 정보 상세 보기/,
  /^영수증$/,
  /^접기$/,
  /^펼치기$/,
  /^수정$/,
  /^삭제$/,
  /^더보기$/,
  /^신고$/,
  /^공유$/,
  /^방문자리뷰/,
  /^작성일순$/,
  /^방문일순$/,
  /^추천순$/,
  /^답글여부/,
  /^전체$/,
  /^등록$/,
  /^미등록$/,
  /^\+\d+$/
];

const styleHints = [
  "따뜻하고 담백한 톤",
  "친근하고 경쾌한 톤",
  "짧고 자연스러운 톤",
  "진심이 느껴지는 부드러운 톤"
];
const noReviewGreetingOptions = [
  "안녕하세요",
  "반갑습니다",
  "안녕하세요, 찾아주셔서 감사합니다"
];
const noReviewInquiryOptions = [
  "제공해드린 커피와 메뉴는 입맛에 맞으셨을까요?",
  "드신 메뉴가 만족스러우셨길 바랍니다.",
  "머무르신 시간이 편안하셨는지 궁금합니다."
];
const noReviewThanksOptions = [
  "리뷰 남겨주셔서 감사합니다.",
  "소중한 리뷰에 진심으로 감사드립니다.",
  "한 줄 리뷰도 큰 힘이 됩니다, 감사합니다."
];
const noReviewCommitmentOptions = [
  "더 좋은 커피와 서비스를 위해 계속 노력하겠습니다.",
  "다음 방문에도 만족하실 수 있도록 더 신경 쓰겠습니다.",
  "항상 더 좋은 맛과 서비스로 보답하겠습니다."
];
const noReviewClosingOptions = [
  "감사합니다.",
  "다음에도 편하게 들러주세요.",
  "다음에도 또 뵙겠습니다."
];

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY 환경변수가 없습니다.");
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey });
  }

  return openaiClient;
}

export function normalizeReviewText(rawText) {
  return (rawText || "").replace(/\s+/g, " ").trim();
}

function stripOwnerReplyBlock(rawText) {
  return (rawText || "")
    .replace(/사장님\s*답글[\s\S]*$/i, "")
    .replace(/판매자\s*답글[\s\S]*$/i, "");
}

function isNoiseLine(line) {
  if (!line) {
    return true;
  }
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }
  if (noiseLinePatterns.some((pattern) => pattern.test(trimmed))) {
    return true;
  }
  if (/^\d{4}\.\s*\d{1,2}\.\s*\d{1,2}/.test(trimmed)) {
    return true;
  }
  if (!/[가-힣a-zA-Z]/.test(trimmed)) {
    return true;
  }
  return false;
}

function pickRandomStyleHint() {
  const idx = Math.floor(Math.random() * styleHints.length);
  return styleHints[idx];
}

function pickRandomFrom(list) {
  const idx = Math.floor(Math.random() * list.length);
  return list[idx];
}

export function extractReviewText(rawText) {
  const lines = stripOwnerReplyBlock(rawText)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isNoiseLine(line));

  const uniqueLines = Array.from(new Set(lines));
  return normalizeReviewText(uniqueLines.join(" "));
}

export function buildTemplateReply(template, reviewText) {
  const summary = normalizeReviewText(reviewText).slice(0, 40);
  return (template || "").replaceAll("{review}", summary);
}

function buildUserPromptWithKeyword(reviewText, selectedKeyword) {
  const keywordPhrase = selectedKeyword ? `${selectedKeyword} 조상일커피` : null;
  const keywordRule = keywordPhrase
    ? `- '${keywordPhrase}' 표현을 문장 안에 정확히 1회 자연스럽게 포함`
    : null;
  const styleHint = pickRandomStyleHint();

  return [
    "다음 고객 리뷰에 답글을 작성해 주세요.",
    "- 리뷰에 없는 사실/메뉴/상황을 지어내지 말 것",
    "- 리뷰어의 감정 톤에 맞춰 답변할 것",
    "- 한국어로 작성",
    "- 과장/허위 표현 금지",
    "- 이모지는 마지막에 최대 1개",
    "- 2~3문장, 250자 이내",
    "- 같은 문구를 반복하지 말고 자연스럽게 변주할 것",
    `- 문체 힌트: ${styleHint}`,
    keywordRule,
    "",
    `고객 리뷰: ${reviewText}`
  ]
    .filter(Boolean)
    .join("\n");
}

function pickRandomKeyword(keywords) {
  if (!Array.isArray(keywords)) {
    return null;
  }
  const list = keywords.map((value) => String(value).trim()).filter(Boolean);
  if (list.length === 0) {
    return null;
  }
  const idx = Math.floor(Math.random() * list.length);
  return list[idx];
}

function normalizeReplyForDupCheck(text) {
  return (text || "")
    .replace(/\s+/g, "")
    .replace(/[!?.~,"'`''""·…]/g, "")
    .toLowerCase();
}

function isDuplicateReply(content) {
  const normalized = normalizeReplyForDupCheck(content);
  return generatedReplyHistory.includes(normalized);
}

function rememberReply(content) {
  const normalized = normalizeReplyForDupCheck(content);
  if (!normalized) {
    return;
  }
  generatedReplyHistory.push(normalized);
  if (generatedReplyHistory.length > maxReplyHistory) {
    generatedReplyHistory.shift();
  }
}

function enforceKeywordPhrase(content, selectedKeyword) {
  if (!selectedKeyword) {
    return content;
  }
  const keywordPhrase = `${selectedKeyword} 조상일커피`;
  if (content.includes(keywordPhrase)) {
    return content;
  }
  const trimmed = content.replace(/\s+$/, "");
  const suffix = ` ${keywordPhrase}에서 또 뵐게요.`;
  return `${trimmed}${suffix}`.trim();
}

function buildNoReviewUserPrompt({ keywordPhrase, baseMessage }) {
  const styleHint = pickRandomStyleHint();
  return [
    "고객 리뷰 텍스트가 매우 짧거나 사실상 비어 있습니다.",
    "아래 기준 멘트의 의미는 유지하되 표현을 다르게 바꿔 자연스럽게 답글을 작성하세요.",
    "- 한국어, 3~4문장",
    "- 광고처럼 과장하지 말 것",
    "- 같은 문구 반복 금지",
    "- 마지막에는 감사의 뉘앙스를 넣을 것",
    `- '${keywordPhrase}'를 정확히 1회 자연스럽게 포함`,
    `- 문체 힌트: ${styleHint}`,
    "",
    `기준 멘트: ${baseMessage}`
  ].join("\n");
}

function buildNoReviewFallbackReply(keywordPhrase) {
  const greeting = pickRandomFrom(noReviewGreetingOptions);
  const inquiry = pickRandomFrom(noReviewInquiryOptions);
  const thanks = pickRandomFrom(noReviewThanksOptions);
  const commitment = pickRandomFrom(noReviewCommitmentOptions);
  const closing = pickRandomFrom(noReviewClosingOptions);
  return `${greeting} ${keywordPhrase}입니다. ${inquiry} ${thanks} ${commitment} ${closing}`.trim();
}

async function requestChatCompletion(client, aiConfig, userPrompt, temperatureOffset = 0) {
  const response = await client.chat.completions.create({
    model: aiConfig.model,
    temperature: Math.min(Number(aiConfig.temperature || 0.7) + temperatureOffset, 1),
    max_tokens: aiConfig.maxTokens,
    messages: [
      { role: "system", content: aiConfig.systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });
  return response.choices?.[0]?.message?.content?.trim() || "";
}

async function generateNoReviewReply(aiConfig) {
  const selectedKeyword = pickRandomKeyword(aiConfig.keywords);
  const keywordPhrase = selectedKeyword ? `${selectedKeyword} 조상일커피` : "조상일커피";
  const baseMessage =
    aiConfig.noReviewBaseMessage ||
    "안녕하세요 [키워드] 조상일커피 입니다. 제공해드린 음식은 입에 맞으셨는지요? 리뷰 남겨주셔서 감사합니다. 더 좋은 커피와 서비스를 위해 노력하겠습니다. 감사합니다.";

  console.log(`[AI] 선택 키워드: ${keywordPhrase}`);
  let aiError;
  if (aiConfig.enabled) {
    try {
      const prompt = buildNoReviewUserPrompt({
        keywordPhrase,
        baseMessage: baseMessage.replace(/\[키워드\]/g, selectedKeyword || "")
      });
      let content = await requestChatCompletion(getOpenAIClient(), aiConfig, prompt, 0);
      if (content && isDuplicateReply(content)) {
        const retryPrompt = `${prompt}\n\n중요: 직전 답글과 표현이 겹칩니다. 문장을 완전히 다르게 다시 작성하세요.`;
        content = await requestChatCompletion(getOpenAIClient(), aiConfig, retryPrompt, 0.12);
      }
      if (content) {
        const finalized = enforceKeywordPhrase(content, selectedKeyword);
        rememberReply(finalized);
        return finalized;
      }
    } catch (error) {
      aiError = error;
    }
  }

  if (aiError) {
    console.log(`[AI-ERROR] ${aiError.message} -> 무리뷰 전용 변주 답글로 대체`);
  }
  for (let i = 0; i < 10; i += 1) {
    const candidate = enforceKeywordPhrase(buildNoReviewFallbackReply(keywordPhrase), selectedKeyword);
    if (!isDuplicateReply(candidate)) {
      rememberReply(candidate);
      return candidate;
    }
  }
  const finalFallback = enforceKeywordPhrase(buildNoReviewFallbackReply(keywordPhrase), selectedKeyword);
  rememberReply(finalFallback);
  return finalFallback;
}

async function generateWithAI(reviewText, aiConfig) {
  const client = getOpenAIClient();
  const selectedKeyword = pickRandomKeyword(aiConfig.keywords);
  const userPrompt = buildUserPromptWithKeyword(reviewText, selectedKeyword);
  if (selectedKeyword) {
    console.log(`[AI] 선택 키워드: ${selectedKeyword} 조상일커피`);
  }

  let content = await requestChatCompletion(client, aiConfig, userPrompt, 0);
  if (content && isDuplicateReply(content)) {
    const retryPrompt = [
      userPrompt,
      "",
      "중요: 직전과 비슷한 답글이 나왔습니다. 표현을 바꿔 완전히 다른 문장으로 다시 작성하세요."
    ].join("\n");
    content = await requestChatCompletion(client, aiConfig, retryPrompt, 0.1);
  }

  if (!content) {
    throw new Error("OpenAI 응답에서 답글 텍스트를 찾지 못했습니다.");
  }
  const finalized = enforceKeywordPhrase(content, selectedKeyword);
  rememberReply(finalized);
  return finalized;
}

export async function buildReplyWithAI({ rawReviewText, aiConfig, replyTemplate }) {
  const reviewText = extractReviewText(rawReviewText);
  if (!reviewText) {
    if (aiConfig.skipIfNoReviewText) {
      return null;
    }
    return generateNoReviewReply(aiConfig);
  }

  if (!aiConfig.enabled) {
    return buildTemplateReply(replyTemplate, reviewText);
  }

  try {
    return await generateWithAI(reviewText, aiConfig);
  } catch (error) {
    if (!aiConfig.fallbackToTemplateOnError) {
      throw error;
    }
    console.log(`[AI-ERROR] ${error.message} -> 템플릿 답글로 대체`);
    return buildTemplateReply(replyTemplate, reviewText);
  }
}
