import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const TOKEN_EXPIRES = "7d";
const COOKIE_NAME = "sr_token";

export function signToken(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: TOKEN_EXPIRES });
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export function authRequired(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME] || req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    return res.status(401).json({ error: "로그인이 필요합니다." });
  }
  try {
    const payload = verifyToken(token);
    req.userId = payload.uid;
    next();
  } catch {
    return res.status(401).json({ error: "세션이 만료되었습니다. 다시 로그인해주세요." });
  }
}

export { COOKIE_NAME };
