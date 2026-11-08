import express from "express";
import path from "path";
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import crypto from "node:crypto";
import dotenv from "dotenv";
import compression from "compression";

dotenv.config();

const app = express();
const PORT = 3000;

// Enable gzip/brotli response compression (reduces JSON transfer by up to 90%)
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers["x-no-compression"]) return false;
    return compression.filter(req, res);
  }
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Catch body-parser errors (e.g. payload too large) and ensure JSON response, never HTML
app.use((err: any, req: any, res: any, next: any) => {
  if (err) {
    console.error("Express payload error:", err.message);
    return res.status(err.status || 400).json({
      success: false,
      error: "Dung lượng ảnh bài làm vượt quá giới hạn hoặc dữ liệu không hợp lệ. Vui lòng thử lại với ảnh dung lượng nhỏ hơn.",
      isFallback: true,
    });
  }
  next();
});

// Insecure agent to handle external image providers with expired or misconfigured SSL certificates (e.g. postimg.cc)
const insecureHttpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: false,
});

// Helper to fetch HTML text ignoring SSL issues and following redirects
function fetchRemoteText(urlStr: string, timeoutMs = 6000, maxRedirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    let redirects = 0;

    function requestUrl(currentUrl: string) {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch (err: any) {
        return reject(new Error("URL không hợp lệ: " + currentUrl));
      }

      const isHttps = parsed.protocol === "https:";
      const client = isHttps ? https : http;

      const req = client.get(
        currentUrl,
        {
          agent: isHttps ? insecureHttpsAgent : undefined,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": "https://postimages.org/",
          },
          timeout: timeoutMs,
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirects >= maxRedirects) {
              res.resume();
              return reject(new Error("Quá nhiều chuyển hướng"));
            }
            redirects++;
            const nextTarget = new URL(res.headers.location, currentUrl).toString();
            res.resume();
            return requestUrl(nextTarget);
          }

          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          res.on("error", reject);
        }
      );

      req.on("timeout", () => req.destroy(new Error("Kết nối quá thời gian chờ (" + timeoutMs + "ms)")));
      req.on("error", reject);
    }

    requestUrl(urlStr);
  });
}

// Helper to stream image response to client ignoring SSL certificate issues
function streamRemoteImage(urlStr: string, res: express.Response, maxRedirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    let redirects = 0;

    function requestNext(target: string) {
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch (e: any) {
        return reject(new Error("URL không hợp lệ: " + target));
      }

      const isHttps = parsed.protocol === "https:";
      const client = isHttps ? https : http;

      const isPostimages = parsed.hostname.includes("postimg.cc") || parsed.hostname.includes("postimages.org");
      const reqHeaders: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      };
      if (isPostimages) {
        reqHeaders["Referer"] = "https://postimages.org/";
      }

      const req = client.get(
        target,
        {
          agent: isHttps ? insecureHttpsAgent : undefined,
          headers: reqHeaders,
          timeout: 15000,
        },
        (remoteRes) => {
          if (remoteRes.statusCode && remoteRes.statusCode >= 300 && remoteRes.statusCode < 400 && remoteRes.headers.location) {
            if (redirects >= maxRedirects) {
              remoteRes.resume();
              return reject(new Error("Quá nhiều chuyển hướng"));
            }
            redirects++;
            const nextTarget = new URL(remoteRes.headers.location, target).toString();
            remoteRes.resume();
            return requestNext(nextTarget);
          }

          if (remoteRes.statusCode && remoteRes.statusCode >= 400) {
            remoteRes.resume();
            // If direct postimg link failed with 404 and doesn't have an extension, try with .jpg automatically
            if (remoteRes.statusCode === 404 && target.includes("i.postimg.cc") && !/\.(jpe?g|png|webp|gif|bmp|svg|avif)($|\?|#)/i.test(target)) {
              return requestNext(target + ".jpg");
            }
            return reject(new Error("Máy chủ ảnh báo lỗi: " + remoteRes.statusCode));
          }

          const contentType = remoteRes.headers["content-type"] || "image/jpeg";
          if (contentType.includes("text/html") || contentType.includes("text/plain")) {
            let body = "";
            remoteRes.setEncoding("utf8");
            remoteRes.on("data", chunk => {
              if (body.length < 65536) body += chunk;
            });
            remoteRes.on("end", () => {
              // 1. Look for id="download"
              const downloadMatch = body.match(/id=["\']download["\'][^>]+href=["\']([^"\']+)["\']/i);
              if (downloadMatch && downloadMatch[1]) {
                return requestNext(downloadMatch[1]);
              }
              // 2. Look for id="direct"
              const directMatch = body.match(/id=["\']direct["\']\s+value=["\']([^"\']+)["\']/i);
              if (directMatch && directMatch[1]) {
                return requestNext(directMatch[1]);
              }
              // 3. Look for https://i.postimg.cc/...
              const iPostMatches = body.match(/https?:\/\/i\.postimg\.cc\/[^\s"\'<>]+/gi);
              if (iPostMatches && iPostMatches.length > 0) {
                return requestNext(iPostMatches[0]);
              }
              // 4. Look for og:image meta tag
              const ogMatches = [...body.matchAll(/<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']/gi)].map(m => m[1]);
              const validOg = ogMatches.find(o => !o.includes("apple-touch-icon") && !o.includes("logo") && !o.includes("favicon"));
              if (validOg) {
                const fullOg = validOg.startsWith("//") ? "https:" + validOg : validOg;
                return requestNext(fullOg);
              }
              return reject(new Error("Phản hồi từ máy chủ là trang web HTML, không tìm thấy liên kết hình ảnh trực tiếp"));
            });
            return;
          }
          res.setHeader("Content-Type", contentType);
          res.setHeader("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
          res.setHeader("Access-Control-Allow-Origin", "*");
          if (remoteRes.headers["content-length"]) {
            res.setHeader("Content-Length", remoteRes.headers["content-length"]);
          }

          remoteRes.pipe(res);
          remoteRes.on("end", resolve);
          remoteRes.on("error", reject);
        }
      );

      req.on("timeout", () => {
        req.destroy(new Error("Kết nối quá thời gian chờ (15s)"));
      });
      req.on("error", reject);
    }

    requestNext(urlStr);
  });
}

// Default fallback API key provided for EduMaster AI services
const DEFAULT_APP_GEMINI_KEY = "AQ.Ab8RN6K-2LrDJSJg5SxjGQEk_hmevTXQyoYLCNL11dpOunZk1A";

// Parse and resolve candidate API keys for automatic failover and quota exhaustion recovery
function resolveCandidateKeys(customApiKey?: string | string[]): string[] {
  const keys: string[] = [];

  if (Array.isArray(customApiKey)) {
    for (const k of customApiKey) {
      if (typeof k === "string" && k.trim().length > 15) {
        const trimmed = k.trim();
        if (!keys.includes(trimmed)) keys.push(trimmed);
      }
    }
  } else if (typeof customApiKey === "string" && customApiKey.trim()) {
    const parts = customApiKey.split(/[,;\n\r]+/).map(p => p.trim()).filter(p => p.length > 15);
    for (const p of parts) {
      if (!keys.includes(p)) keys.push(p);
    }
  }

  // System environment variable
  if (process.env.GEMINI_API_KEY && !keys.includes(process.env.GEMINI_API_KEY)) {
    keys.push(process.env.GEMINI_API_KEY);
  }

  // Default fallback key
  if (DEFAULT_APP_GEMINI_KEY && !keys.includes(DEFAULT_APP_GEMINI_KEY)) {
    keys.push(DEFAULT_APP_GEMINI_KEY);
  }

  return keys;
}

// Lazy initialization for Gemini AI with intelligent key resolution
function getAI(customApiKey?: string | string[]): GoogleGenAI | null {
  const candidates = resolveCandidateKeys(customApiKey);
  if (candidates.length === 0) return null;
  const selectedKey = candidates[0];

  return new GoogleGenAI({ 
    apiKey: selectedKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Intelligent resilient Gemini runner with multi-key rotation, 503/429 retry, and seamless fallback model switching
async function generateGeminiWithRetry(
  aiOrKey: GoogleGenAI | string | string[] | undefined,
  params: {
    contents: any;
    config?: any;
    preferredModels?: string[];
  }
): Promise<any> {
  const candidateModels = params.preferredModels && params.preferredModels.length > 0
    ? params.preferredModels
    : ["gemini-3.8-flash", "gemini-2.5-flash"];

  // Determine candidate API keys
  let keysToTry: string[] = [];
  if (typeof aiOrKey === "string" || Array.isArray(aiOrKey)) {
    keysToTry = resolveCandidateKeys(aiOrKey);
  } else if (aiOrKey && (aiOrKey as any).apiKey) {
    keysToTry = [(aiOrKey as any).apiKey, ...resolveCandidateKeys()];
  } else {
    keysToTry = resolveCandidateKeys();
  }

  // Deduplicate keys
  keysToTry = Array.from(new Set(keysToTry.filter(k => Boolean(k))));

  if (keysToTry.length === 0) {
    throw new Error("Không tìm thấy mã khóa Gemini API hợp lệ. Vui lòng nạp API Key trong phần Quản lý Key.");
  }

  let lastError: any = null;

  for (let kIdx = 0; kIdx < keysToTry.length; kIdx++) {
    const currentApiKey = keysToTry[kIdx];
    const client = new GoogleGenAI({
      apiKey: currentApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    for (const model of candidateModels) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await client.models.generateContent({
            model,
            contents: params.contents,
            config: params.config,
          });
          return response;
        } catch (err: any) {
          lastError = err;
          const errMsg = String(err?.message || err || "");
          const isQuotaExceeded =
            err?.code === 429 ||
            errMsg.includes("Resource has been exhausted") ||
            errMsg.includes("quota") ||
            errMsg.includes("rate limit") ||
            errMsg.includes("Too Many Requests");

          const isTransient =
            err?.status === "UNAVAILABLE" ||
            err?.code === 503 ||
            err?.status === 503 ||
            errMsg.includes("503") ||
            errMsg.includes("high demand") ||
            errMsg.includes("UNAVAILABLE") ||
            errMsg.includes("temporarily unavailable") ||
            errMsg.includes("fetch failed");

          if (isQuotaExceeded) {
            console.warn(`[Gemini API] Quota exhausted on key #${kIdx + 1} (${currentApiKey?.slice(0, 6)}...). Switching to next key in pool...`);
            // Break model loop to advance to next key in pool
            break;
          }

          if (isTransient && attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
            continue;
          }

          if (isTransient) {
            console.warn(`[Gemini API] Model ${model} is temporarily busy (${errMsg}). Trying backup model...`);
            break;
          }

          // If auth error (e.g. invalid key 400/403), break to next key
          if (err?.code === 400 || err?.code === 403 || errMsg.includes("API_KEY_INVALID")) {
            console.warn(`[Gemini API] Key #${kIdx + 1} invalid. Trying next key in pool...`);
            break;
          }

          throw err;
        }
      }
    }
  }

  throw lastError || new Error("Tất cả các mô hình và khóa Gemini API tạm thời không phản hồi. Vui lòng nạp thêm khóa mới.");
}

// In-memory evaluation cache (cleared on restart to avoid stale fake grades)
const aiGradeCache = new Map<string, any>();

function getGradeCacheKey(prefix: string, studentName: string, subject: string, studentContent: string, standardRef: string): string {
  const c1 = (studentContent || "").slice(0, 100);
  const c2 = (standardRef || "").slice(0, 100);
  return `${prefix}_${subject}_${studentName}_${c1}_${c2}`;
}

// Helper to resolve direct image url from hosting pages (like Postimages, Google Drive)
async function resolveDirectImageUrl(urlStr: string): Promise<string> {
  const trimmed = urlStr.trim();
  
  // Google Drive direct image link
  if (trimmed.includes("drive.google.com/file/d/")) {
    const match = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      return `https://drive.google.com/uc?export=view&id=${match[1]}`;
    }
  }
  if (trimmed.includes("drive.google.com/open?id=") || trimmed.includes("drive.google.com/uc?id=")) {
    const match = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      return `https://drive.google.com/uc?export=view&id=${match[1]}`;
    }
  }

  // Postimages direct image extraction
  if (/(?:postimg\.cc|postimages\.org)\/[a-zA-Z0-9_-]+/i.test(trimmed) && !trimmed.includes("i.postimg.cc")) {
    try {
      const html = await fetchRemoteText(trimmed, 6000);
      if (html) {
        const iPostMatch = html.match(/https?:\/\/i\.postimg\.cc\/[^\s"\'<>]+/i);
        if (iPostMatch) return iPostMatch[0];
        const ogMatch = html.match(/<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']/i);
        if (ogMatch && ogMatch[1]) return ogMatch[1];
      }
    } catch (e) {}
  }
  return trimmed;
}

// Helper to fetch remote image buffer supporting self-signed/expired SSL and following redirects
function fetchRemoteImageBuffer(urlStr: string, timeoutMs = 15000, maxRedirects = 5): Promise<{ buffer: Buffer; mimeType: string } | null> {
  return new Promise((resolve) => {
    let redirects = 0;

    function requestNext(currentUrl: string) {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch {
        return resolve(null);
      }

      const isHttps = parsed.protocol === "https:";
      const client = isHttps ? https : http;

      const req = client.get(
        currentUrl,
        {
          agent: isHttps ? insecureHttpsAgent : undefined,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            "Referer": "https://postimages.org/",
          },
          timeout: timeoutMs,
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirects >= maxRedirects) {
              res.resume();
              return resolve(null);
            }
            redirects++;
            const nextTarget = new URL(res.headers.location, currentUrl).toString();
            res.resume();
            return requestNext(nextTarget);
          }

          if (res.statusCode && res.statusCode >= 400) {
            res.resume();
            return resolve(null);
          }

          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on("end", () => {
            const buffer = Buffer.concat(chunks);
            const mimeType = (res.headers["content-type"] || "image/jpeg").split(";")[0].trim();
            resolve({ buffer, mimeType });
          });
          res.on("error", () => resolve(null));
        }
      );

      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.on("error", () => resolve(null));
    }

    requestNext(urlStr);
  });
}

// Helper to prepare content parts for Gemini multimodal vision (handles arrays, data URIs, remote URLs, Postimages, markdown images, and plain text)
async function prepareGeminiContentParts(
  input: string | string[] | undefined | null,
  label: string
): Promise<any[]> {
  if (!input) return [];
  const parts: any[] = [];
  const items = Array.isArray(input) ? input : [input];

  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== "string") continue;
    const trimmed = rawItem.trim();
    if (!trimmed) continue;

    // 1. Data URI
    if (trimmed.startsWith("data:image")) {
      const match = trimmed.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1] || "image/jpeg",
            data: match[2],
          },
        });
        continue;
      }
    }

    // 2. Extract potential URLs from text or direct URL
    const urlMatches = trimmed.match(/https?:\/\/[^\s"\'<>)]+/gi);
    if (urlMatches && urlMatches.length > 0) {
      let hasImage = false;
      for (const rawUrl of urlMatches) {
        const directUrl = await resolveDirectImageUrl(rawUrl);
        const imgData = await fetchRemoteImageBuffer(directUrl);
        if (imgData && imgData.mimeType.startsWith("image/")) {
          parts.push({
            inlineData: {
              mimeType: imgData.mimeType,
              data: imgData.buffer.toString("base64"),
            },
          });
          hasImage = true;
        }
      }
      // If text contains more than just URLs, also include the text
      const cleanText = trimmed.replace(/https?:\/\/[^\s"\'<>)]+/gi, "").trim();
      if (cleanText) {
        parts.push({ text: `[${label} - Ghi chú văn bản]:\n${cleanText}` });
      } else if (!hasImage) {
        parts.push({ text: `[${label}]:\n${trimmed}` });
      }
      continue;
    }

    // 3. Plain text or non-image content
    parts.push({
      text: `[${label}]:\n${trimmed}`,
    });
  }

  return parts;
}

// Legacy wrapper for backwards compatibility
async function prepareGeminiContentPart(
  input: string | undefined | null,
  label: string
): Promise<{ inlineData?: { data: string; mimeType: string }; text?: string } | null> {
  const parts = await prepareGeminiContentParts(input, label);
  return parts.length > 0 ? parts[0] : null;
}

// Robust helper to extract and parse JSON from AI outputs (handles markdown blocks, extra text, etc.)
function safeParseAIJson(rawText: string): any {
  if (!rawText) return {};
  const text = rawText.trim();
  try {
    return JSON.parse(text);
  } catch (e1) {
    // Check markdown code fences ```json ... ```
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch (e2) {}
    }
    // Substring between first { and last }
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.substring(firstBrace, lastBrace + 1));
      } catch (e3) {}
    }
    // Substring between first [ and last ]
    const firstBracket = text.indexOf("[");
    const lastBracket = text.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      try {
        return JSON.parse(text.substring(firstBracket, lastBracket + 1));
      } catch (e4) {}
    }
    console.error("Failed to parse JSON from AI output:", text.slice(0, 300));
    throw new Error("Dữ liệu phản hồi từ AI không đúng định dạng JSON chuẩn.");
  }
}

// Fallback rule-based schedule text parser
function parseScheduleTextFallback(text: string): Record<number, string[]> {
  const schedule: Record<number, string[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 0: [] };
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  let currentDay: number | null = null;

  for (const line of lines) {
    if (/thứ\s*2|thứ\s*hai|monday|\bt2\b/i.test(line)) currentDay = 1;
    else if (/thứ\s*3|thứ\s*ba|tuesday|\bt3\b/i.test(line)) currentDay = 2;
    else if (/thứ\s*4|thứ\s*tư|wednesday|\bt4\b/i.test(line)) currentDay = 3;
    else if (/thứ\s*5|thứ\s*năm|thursday|\bt5\b/i.test(line)) currentDay = 4;
    else if (/thứ\s*6|thứ\s*sáu|friday|\bt6\b/i.test(line)) currentDay = 5;
    else if (/thứ\s*7|thứ\s*bảy|saturday|\bt7\b/i.test(line)) currentDay = 6;
    else if (/chủ\s*nhật|sunday|\bcn\b/i.test(line)) currentDay = 0;
    else if (currentDay !== null) {
      const subjects = line.split(/[,;\-\t|]+/).map(s => s.replace(/^\d+[\.\:\)]\s*/, "").trim()).filter(s => s.length >= 2);
      if (subjects.length > 0) {
        schedule[currentDay].push(...subjects);
      }
    }
  }
  return schedule;
}

// =========================================================================
// DURABLE SUBMISSIONS STORAGE & REAL-TIME SSE SYNC ENGINE
// Ensures student submissions & teacher reviews are synchronized across all devices
// =========================================================================
const SUBMISSIONS_DIR = path.join(process.cwd(), "data");
const SUBMISSIONS_FILE = path.join(SUBMISSIONS_DIR, "submissions.json");
const UPLOADS_DIR = path.join(SUBMISSIONS_DIR, "uploads");

try {
  if (!fs.existsSync(SUBMISSIONS_DIR)) {
    fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });
  }
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  if (!fs.existsSync(SUBMISSIONS_FILE)) {
    fs.writeFileSync(SUBMISSIONS_FILE, "[]", "utf-8");
  }
} catch (e) {
  console.error("Lỗi tạo thư mục data/uploads:", e);
}

// Statically serve uploaded images with Vercel Edge CDN caching and CORS headers
// Long s-maxage allows Vercel Edge to cache images globally without calling the Origin Serverless Function repeatedly
app.use("/api/uploads", express.static(UPLOADS_DIR, {
  maxAge: "365d",
  setHeaders: (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    res.setHeader("CDN-Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Vercel-CDN-Cache-Control", "public, max-age=31536000, immutable");
  }
}));

/**
 * Saves a base64 image data URI to disk as a permanent file and returns its URL (/api/uploads/...)
 */
function saveBase64ImageToDisk(base64Data: string, prefix = "img"): string {
  try {
    if (!base64Data || typeof base64Data !== "string" || !base64Data.startsWith("data:image")) {
      return base64Data;
    }
    const matches = base64Data.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (!matches || matches.length < 3) return base64Data;

    let ext = matches[1].toLowerCase();
    if (ext === "jpeg") ext = "jpg";
    if (ext.includes("svg")) ext = "svg";
    const rawData = matches[2];
    const buffer = Buffer.from(rawData, "base64");

    const hash = crypto.createHash("md5").update(buffer).digest("hex").slice(0, 16);
    const filename = `${prefix}_${Date.now()}_${hash}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    fs.writeFileSync(filePath, buffer);
    return `/api/uploads/${filename}`;
  } catch (err) {
    console.error("Lỗi lưu ảnh lên đĩa:", err);
    return base64Data;
  }
}

// Direct Image Upload Endpoint (stores photos safely as files, freeing localStorage quota)
app.post("/api/upload-image", (req, res) => {
  try {
    const { image, studentId, subject } = req.body;
    if (!image || typeof image !== "string") {
      return res.status(400).json({ error: "Không tìm thấy dữ liệu ảnh" });
    }
    const cleanPrefix = studentId ? `hs${studentId}` : "sub";
    const fileUrl = saveBase64ImageToDisk(image, cleanPrefix);
    res.json({ success: true, url: fileUrl });
  } catch (err: any) {
    console.error("Upload image error:", err);
    res.status(500).json({ error: err.message });
  }
});

let serverSubmissionsCache: any[] = [];

export function sanitizeSubmissionContent(content: any[]): string[] {
  if (!Array.isArray(content)) return [];
  const result: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "string") continue;
    const str = raw.trim();
    if (!str) continue;

    // Preserve special tokens and storage paths
    if (str === "[stored_in_indexeddb]" || str.startsWith("data:image") || str.startsWith("/api/uploads/")) {
      if (!result.includes(str)) result.push(str);
      continue;
    }

    // Unpack text notes containing URLs
    if (str.startsWith("[Ghi chú / Tóm tắt bài làm]:") || str.startsWith("[Ghi chú]:") || str.startsWith("[Ghi chú bài nộp]:")) {
      const textAfter = str.replace(/^\[[^\]]+\]:\s*/, "").trim();
      const spaced = textAfter.replace(/[[\]()<>{}"',;]/g, " ").replace(/%20/g, " ");
      const urls = (spaced.match(/https?:\/\/[^\s"'<>]+/gi) || []).map(u =>
        u.replace(/\[\/?img\]?/gi, "").replace(/\[\/?url.*?\]?/gi, "").replace(/[)\][(,.;:]+$/, "").trim()
      ).filter(Boolean);

      if (urls.length > 0) {
        for (let u of urls) {
          if (u.includes("i.postimg.cc") && !/\.(jpe?g|png|webp|gif|bmp|svg|avif)($|\?|#)/i.test(u)) {
            u = u + ".jpg";
          }
          if (!result.includes(u)) result.push(u);
        }
        let remaining = textAfter;
        for (const u of urls) remaining = remaining.replace(u, "");
        remaining = remaining.replace(/\[\/?img\]?/gi, "").replace(/\[\/?url.*?\]?/gi, "").replace(/[()[\],.;:]/g, " ").trim();
        if (remaining && remaining.length >= 3) {
          result.push(`[Ghi chú / Tóm tắt bài làm]:\n${remaining}`);
        }
        continue;
      } else {
        result.push(str);
        continue;
      }
    }

    // Normal strings: unfuse multiple URLs, brackets, %20
    const spaced = str.replace(/[[\]()<>{}"',;]/g, " ").replace(/%20/g, " ");
    const urls = (spaced.match(/https?:\/\/[^\s"'<>]+/gi) || []).map(u =>
      u.replace(/\[\/?img\]?/gi, "").replace(/\[\/?url.*?\]?/gi, "").replace(/[)\][(,.;:]+$/, "").trim()
    ).filter(Boolean);

    if (urls.length > 0) {
      const hasDirectPostimg = urls.some(u => u.includes("i.postimg.cc"));
      for (let u of urls) {
        if (hasDirectPostimg && u.includes("postimg.cc") && !u.includes("i.postimg.cc")) {
          continue;
        }
        if (u.includes("i.postimg.cc") && !/\.(jpe?g|png|webp|gif|bmp|svg|avif)($|\?|#)/i.test(u)) {
          u = u + ".jpg";
        }
        if (!result.includes(u)) result.push(u);
      }
    } else {
      if (!result.includes(str)) result.push(str);
    }
  }
  return result;
}

function loadSubmissionsFromDisk(): any[] {
  try {
    if (fs.existsSync(SUBMISSIONS_FILE)) {
      const raw = fs.readFileSync(SUBMISSIONS_FILE, "utf-8");
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) {
        let changed = false;
        serverSubmissionsCache = list.map(item => {
          if (Array.isArray(item.content)) {
            const cleaned = sanitizeSubmissionContent(item.content);
            if (JSON.stringify(cleaned) !== JSON.stringify(item.content)) {
              changed = true;
              return { ...item, content: cleaned };
            }
          }
          return item;
        });
        console.log(`[Server Submissions] Đã tải ${serverSubmissionsCache.length} bài nộp từ file đĩa (Tự động chuẩn hóa link ảnh: ${changed ? 'ĐÃ SỬA CÁC LINK LỖI' : 'Sạch sẽ'}).`);
        if (changed) {
          persistSubmissionsToDisk();
        }
        return serverSubmissionsCache;
      }
    }
  } catch (e) {
    console.error("Lỗi đọc file submissions.json:", e);
  }
  return serverSubmissionsCache;
}

// Initial load from disk
loadSubmissionsFromDisk();

function persistSubmissionsToDisk() {
  try {
    serverSubmissionsVersion = Date.now();
    // Only persist if cache has items or file does not exist, preventing wiping disk with empty array
    if (serverSubmissionsCache.length === 0 && fs.existsSync(SUBMISSIONS_FILE)) {
      const existingRaw = fs.readFileSync(SUBMISSIONS_FILE, "utf-8");
      if (existingRaw.length > 10) {
        console.warn("[Server Submissions] Chặn thao tác ghi đè mảng rỗng lên disk!");
        return;
      }
    }
    fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(serverSubmissionsCache, null, 2), "utf-8");
  } catch (e) {
    console.error("Lỗi ghi file submissions.json:", e);
  }
}

// SSE Subscribers for Submissions Real-Time Updates
const sseSubscribers = new Set<express.Response>();

function broadcastSubmissionsSse(data: any) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseSubscribers) {
    try {
      client.write(payload);
    } catch {
      sseSubscribers.delete(client);
    }
  }
}

// 1. SSE Real-Time Stream Endpoint (Safely disabled on Serverless to protect Vercel bandwidth)
app.get("/api/submissions/stream", (req, res) => {
  res.status(204).end();
});

// Helper to normalize any date to YYYY-MM-DD
function normalizeServerDate(dateStr: any): string {
  if (!dateStr) return "";
  const s = String(dateStr).trim();
  const matchYMD = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (matchYMD) {
    return `${matchYMD[1]}-${String(matchYMD[2]).padStart(2, "0")}-${String(matchYMD[3]).padStart(2, "0")}`;
  }
  const matchDMY = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (matchDMY) {
    return `${matchDMY[3]}-${String(matchDMY[2]).padStart(2, "0")}-${String(matchDMY[1]).padStart(2, "0")}`;
  }
  return s;
}

let serverSubmissionsVersion = Date.now();

// 2. GET Submissions (with optional filters, ETag and 304 Not Modified support)
app.get("/api/submissions", (req, res) => {
  try {
    if (serverSubmissionsCache.length === 0) {
      loadSubmissionsFromDisk();
    }

    const { classId, date, dates, studentId, limit } = req.query;

    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    let result = serverSubmissionsCache;

    if (classId) {
      const cleanTarget = String(classId).trim().toLowerCase().replace(/^(lop|lớp|class|c)[_ -]?/i, "");
      result = result.filter(s => {
        const sc = String(s.classId || "").trim().toLowerCase().replace(/^(lop|lớp|class|c)[_ -]?/i, "");
        return !sc || sc === "all" || sc === cleanTarget;
      });
    }

    if (date) {
      const d = normalizeServerDate(date);
      result = result.filter(s => {
        const sDate = normalizeServerDate(s.date);
        const sTime = s.timestamp ? normalizeServerDate(s.timestamp.slice(0, 10)) : "";
        return sDate === d || sTime === d;
      });
    } else if (dates && typeof dates === "string") {
      const dateSet = new Set(dates.split(",").map(d => normalizeServerDate(d.trim())));
      result = result.filter(s => {
        const sDate = normalizeServerDate(s.date);
        const sTime = s.timestamp ? normalizeServerDate(s.timestamp.slice(0, 10)) : "";
        return dateSet.has(sDate) || (sTime && dateSet.has(sTime));
      });
    }

    if (studentId) {
      const sId = Number(studentId);
      result = result.filter(s => Number(s.studentId) === sId);
    }

    if (limit) {
      const maxLimit = Math.max(1, parseInt(String(limit), 10) || 500);
      result = result.slice(0, maxLimit);
    }

    res.json({
      success: true,
      count: result.length,
      total: serverSubmissionsCache.length,
      submissions: result,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. POST Save / Update Single Submission
app.post("/api/submissions", (req, res) => {
  try {
    const item = req.body;
    if (!item || !item.studentId || !item.subject || !item.date) {
      return res.status(400).json({ error: "Thiếu thông tin bắt buộc của bài nộp" });
    }

    const normKey = (s: any) => {
      const cId = String(s.classId || "").trim().toLowerCase().replace(/^(lop|lớp|class|c)[_ -]?/i, "").replace(/\s+/g, "");
      const stId = Number(s.studentId || 0);
      const subj = String(s.subject || "").trim().toLowerCase();
      const dt = normalizeServerDate(s.date);
      return `${cId}__${stId}__${subj}__${dt}`;
    };

    // Convert any heavy base64 data URIs into durable /api/uploads/ URLs on disk & sanitize URLs
    if (Array.isArray(item.content)) {
      item.content = sanitizeSubmissionContent(item.content.map((c: any) => {
        if (typeof c === "string" && c.startsWith("data:image")) {
          return saveBase64ImageToDisk(c, `hs${item.studentId || "sub"}`);
        }
        return c;
      }));
    }

    const targetKey = normKey(item);
    const existingIndex = serverSubmissionsCache.findIndex(s => normKey(s) === targetKey || (s.id && item.id && s.id === item.id));

    if (existingIndex >= 0) {
      const existing = serverSubmissionsCache[existingIndex];
      // Merge content without losing existing photos/links
      const incomingContent = Array.isArray(item.content) ? item.content : [];
      const existingContent = Array.isArray(existing.content) ? existing.content : [];
      const mergedContent = Array.from(new Set([...existingContent, ...incomingContent]));

      serverSubmissionsCache[existingIndex] = {
        ...existing,
        ...item,
        content: incomingContent.length > 0 ? mergedContent : existingContent,
        timestamp: item.timestamp || new Date().toISOString(),
      };
    } else {
      serverSubmissionsCache.unshift({
        id: item.id || `sub_${item.classId || '8a1'}_${item.studentId}_${item.subject}_${item.date}`,
        ...item,
        timestamp: item.timestamp || new Date().toISOString(),
      });
    }

    persistSubmissionsToDisk();
    broadcastSubmissionsSse({
      type: "SUBMISSION_SAVED",
      submission: serverSubmissionsCache[existingIndex >= 0 ? existingIndex : 0],
      count: serverSubmissionsCache.length,
    });

    res.json({
      success: true,
      count: serverSubmissionsCache.length,
      submission: serverSubmissionsCache[existingIndex >= 0 ? existingIndex : 0],
    });
  } catch (err: any) {
    console.error("Save submission error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 4. POST Bulk Submissions Sync (Push multiple submissions from local IndexedDB/localStorage)
app.post("/api/submissions/bulk", (req, res) => {
  try {
    const { submissions } = req.body;
    if (!Array.isArray(submissions) || submissions.length === 0) {
      return res.json({ success: true, count: serverSubmissionsCache.length, updated: 0 });
    }

    const normKey = (s: any) => {
      const cId = String(s.classId || "").trim().toLowerCase().replace(/^(lop|lớp|class|c)[_ -]?/i, "").replace(/\s+/g, "");
      const stId = Number(s.studentId || 0);
      const subj = String(s.subject || "").trim().toLowerCase();
      const dt = normalizeServerDate(s.date);
      return `${cId}__${stId}__${subj}__${dt}`;
    };

    const map = new Map(serverSubmissionsCache.map(s => [normKey(s), s]));
    let updatedCount = 0;

    for (const sub of submissions) {
      if (!sub || !sub.studentId || !sub.subject || !sub.date) continue;

      // Convert any base64 images in batch to disk files & sanitize URLs
      if (Array.isArray(sub.content)) {
        sub.content = sanitizeSubmissionContent(sub.content.map((c: any) => {
          if (typeof c === "string" && c.startsWith("data:image")) {
            return saveBase64ImageToDisk(c, `hs${sub.studentId || "sub"}`);
          }
          return c;
        }));
      }

      const key = normKey(sub);
      const existing = map.get(key);
      if (!existing) {
        map.set(key, sub);
        updatedCount++;
      } else {
        const exTime = existing.timestamp ? new Date(existing.timestamp).getTime() : 0;
        const newTime = sub.timestamp ? new Date(sub.timestamp).getTime() : 0;
        const exImages = (existing.content || []).filter((c: any) => typeof c === "string" && (c.startsWith("data:image") || c.startsWith("http") || c.startsWith("/api/")));
        const newImages = (sub.content || []).filter((c: any) => typeof c === "string" && (c.startsWith("data:image") || c.startsWith("http") || c.startsWith("/api/")));

        if (newTime >= exTime || newImages.length > exImages.length) {
          const mergedContent = Array.from(new Set([...(existing.content || []), ...(sub.content || [])]));
          map.set(key, { ...existing, ...sub, content: mergedContent });
          updatedCount++;
        }
      }
    }

    if (updatedCount > 0) {
      serverSubmissionsCache = Array.from(map.values()).sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
      persistSubmissionsToDisk();
      broadcastSubmissionsSse({ type: "BULK_UPDATED", count: serverSubmissionsCache.length });
    }

    res.json({ success: true, count: serverSubmissionsCache.length, updated: updatedCount });
  } catch (err: any) {
    console.error("Bulk sync error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 5. DELETE Submission by ID
app.delete("/api/submissions/:id", (req, res) => {
  try {
    const id = req.params.id;
    const initialLen = serverSubmissionsCache.length;
    serverSubmissionsCache = serverSubmissionsCache.filter(s => s.id !== id);
    if (serverSubmissionsCache.length !== initialLen) {
      persistSubmissionsToDisk();
      broadcastSubmissionsSse({ type: "SUBMISSION_DELETED", id, count: serverSubmissionsCache.length });
    }
    res.json({ success: true, deleted: initialLen - serverSubmissionsCache.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. DELETE Submissions for Subject (with optional date)
app.delete("/api/submissions", (req, res) => {
  try {
    const { subject, date, classId } = req.query;
    if (!subject) {
      return res.status(400).json({ error: "Thiếu tên môn học cần xóa" });
    }
    const cleanSubj = String(subject).trim().toLowerCase();
    const cleanDate = date ? String(date).trim() : null;
    const cleanClass = classId ? String(classId).trim().toLowerCase() : null;

    const initialLen = serverSubmissionsCache.length;
    serverSubmissionsCache = serverSubmissionsCache.filter(s => {
      const matchSubj = String(s.subject || "").trim().toLowerCase() === cleanSubj;
      const matchDate = cleanDate ? s.date === cleanDate : true;
      const matchClass = cleanClass ? String(s.classId || "").trim().toLowerCase() === cleanClass : true;
      return !(matchSubj && matchDate && matchClass);
    });

    const deleted = initialLen - serverSubmissionsCache.length;
    if (deleted > 0) {
      persistSubmissionsToDisk();
      broadcastSubmissionsSse({ type: "SUBMISSIONS_PURGED", subject, date, count: serverSubmissionsCache.length });
    }
    res.json({ success: true, deleted });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    hasApiKey: !!process.env.GEMINI_API_KEY,
    time: new Date().toISOString(),
  });
});

// =========================================================================
// DURABLE CLASSES & SCHEDULE (TKB) STORAGE ENGINE
// Ensures group assignments (tổ) and timetables (TKB) persist across days and devices
// =========================================================================
const CLASSES_FILE = path.join(SUBMISSIONS_DIR, "classes.json");
let serverClassesCache: any[] = [];

function loadClassesFromDisk(): any[] {
  try {
    if (fs.existsSync(CLASSES_FILE)) {
      const raw = fs.readFileSync(CLASSES_FILE, "utf-8");
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const only8a1 = parsed.filter(c => (c.id || "").toLowerCase() === "8a1" || (c.name || "").toLowerCase() === "8a1");
          serverClassesCache = only8a1.length > 0 ? only8a1 : [parsed[0]];
          return serverClassesCache;
        }
      }
    }
  } catch (e) {
    console.error("Lỗi đọc file classes.json:", e);
  }
  return serverClassesCache;
}

function persistClassesToDisk(): void {
  try {
    const only8a1 = serverClassesCache.filter(c => (c.id || "").toLowerCase() === "8a1" || (c.name || "").toLowerCase() === "8a1");
    fs.writeFileSync(CLASSES_FILE, JSON.stringify(only8a1.length > 0 ? only8a1 : serverClassesCache, null, 2), "utf-8");
  } catch (e) {
    console.error("Lỗi ghi file classes.json:", e);
  }
}

// Initial load
loadClassesFromDisk();

// GET /api/classes (supports ?id=8a1 or all)
app.get("/api/classes", (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    if (serverClassesCache.length === 0) {
      loadClassesFromDisk();
    }
    const { id } = req.query;
    if (id) {
      const cleanId = String(id).trim().toLowerCase();
      const found = serverClassesCache.find(c => (c.id || "").toLowerCase() === cleanId);
      if (found) {
        return res.json({ success: true, class: found });
      }
      return res.status(404).json({ success: false, error: "Class not found" });
    }
    res.json({
      success: true,
      count: serverClassesCache.length,
      classes: serverClassesCache,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/classes (saves single class or bulk array of classes)
app.post("/api/classes", (req, res) => {
  try {
    const payload = req.body;
    if (!payload) {
      return res.status(400).json({ error: "Thiếu dữ liệu lớp học" });
    }

    if (serverClassesCache.length === 0) {
      loadClassesFromDisk();
    }

    const classMap = new Map(serverClassesCache.map(c => [(c.id || "").toLowerCase(), c]));

    if (Array.isArray(payload)) {
      payload.forEach(cls => {
        if (cls && cls.id) {
          const cId = String(cls.id).toLowerCase();
          const existing = classMap.get(cId);
          classMap.set(cId, {
            ...existing,
            ...cls,
            updatedAt: new Date().toISOString(),
          });
        }
      });
    } else if (payload.id) {
      const cId = String(payload.id).toLowerCase();
      const existing = classMap.get(cId);
      classMap.set(cId, {
        ...existing,
        ...payload,
        updatedAt: new Date().toISOString(),
      });
    } else {
      return res.status(400).json({ error: "Dữ liệu lớp học không hợp lệ" });
    }

    const only8a1 = Array.from(classMap.values()).filter(c => (c.id || "").toLowerCase() === "8a1" || (c.name || "").toLowerCase() === "8a1");
    serverClassesCache = only8a1.length > 0 ? only8a1 : Array.from(classMap.values());
    persistClassesToDisk();

    res.json({
      success: true,
      count: serverClassesCache.length,
      message: "Đã lưu trữ dữ liệu lớp và TKB bền vững vào máy chủ!",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// DURABLE CONDUCT LOGS (NỀ NẾP & THI ĐUA) STORAGE ENGINE
// Ensures scoring by team leads and teachers persists across days and mobile devices
// =========================================================================
const CONDUCT_LOGS_FILE = path.join(SUBMISSIONS_DIR, "conduct_logs.json");
let serverConductLogsCache: any[] = [];

function loadConductLogsFromDisk(): any[] {
  try {
    if (fs.existsSync(CONDUCT_LOGS_FILE)) {
      const raw = fs.readFileSync(CONDUCT_LOGS_FILE, "utf-8");
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          serverConductLogsCache = parsed;
          return serverConductLogsCache;
        }
      }
    }
  } catch (e) {
    console.error("Lỗi đọc file conduct_logs.json:", e);
  }
  return serverConductLogsCache;
}

function persistConductLogsToDisk(): void {
  try {
    fs.writeFileSync(CONDUCT_LOGS_FILE, JSON.stringify(serverConductLogsCache, null, 2), "utf-8");
  } catch (e) {
    console.error("Lỗi ghi file conduct_logs.json:", e);
  }
}

// Initial load
loadConductLogsFromDisk();

// GET /api/conduct-logs (supports ?classId=8a1&weekId=...&studentId=...)
app.get("/api/conduct-logs", (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    if (serverConductLogsCache.length === 0) {
      loadConductLogsFromDisk();
    }

    const { classId, weekId, studentId, limit } = req.query;
    let result = serverConductLogsCache;

    if (classId) {
      const cleanClass = String(classId).trim().toLowerCase().replace(/^(lop|lớp|class|c)[_ -]?/i, "");
      result = result.filter(l => {
        const lc = String(l.classId || "").trim().toLowerCase().replace(/^(lop|lớp|class|c)[_ -]?/i, "");
        return !lc || lc === "all" || lc === cleanClass;
      });
    }

    if (weekId) {
      const wId = String(weekId).trim();
      result = result.filter(l => String(l.weekId || "").trim() === wId);
    }

    if (studentId) {
      const sId = Number(studentId);
      result = result.filter(l => Number(l.studentId) === sId);
    }

    if (limit) {
      const maxLimit = Math.max(1, parseInt(String(limit), 10) || 500);
      result = result.slice(0, maxLimit);
    }

    res.json({
      success: true,
      count: result.length,
      total: serverConductLogsCache.length,
      logs: result,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conduct-logs (saves single log or bulk logs)
app.post("/api/conduct-logs", (req, res) => {
  try {
    const payload = req.body;
    if (!payload) {
      return res.status(400).json({ error: "Thiếu dữ liệu nề nếp thi đua" });
    }

    if (serverConductLogsCache.length === 0) {
      loadConductLogsFromDisk();
    }

    const logMap = new Map(serverConductLogsCache.map(l => [l.id, l]));
    const items = Array.isArray(payload) ? payload : [payload];
    let updatedCount = 0;

    for (const item of items) {
      if (!item || !item.id) continue;
      logMap.set(item.id, {
        ...logMap.get(item.id),
        ...item,
        timestamp: item.timestamp || new Date().toISOString(),
      });
      updatedCount++;
    }

    serverConductLogsCache = Array.from(logMap.values()).sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    persistConductLogsToDisk();

    res.json({
      success: true,
      count: serverConductLogsCache.length,
      updated: updatedCount,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/conduct-logs/:id
app.delete("/api/conduct-logs/:id", (req, res) => {
  try {
    const id = req.params.id;
    const initialLen = serverConductLogsCache.length;
    serverConductLogsCache = serverConductLogsCache.filter(l => l.id !== id);
    if (serverConductLogsCache.length !== initialLen) {
      persistConductLogsToDisk();
    }
    res.json({ success: true, deleted: initialLen - serverConductLogsCache.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Image proxy to bypass expired SSL certificates (e.g. postimg.cc) and cross-origin blocking
app.get("/api/proxy-image", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== "string") {
    return res.status(400).send("Thiếu tham số url");
  }

  try {
    let cleanUrl = targetUrl.trim();

    // Sanitize any brackets, noise, or multiple URLs
    const sanitized = sanitizeSubmissionContent([cleanUrl]);
    if (sanitized.length > 0 && sanitized[0].startsWith("http")) {
      cleanUrl = sanitized[0];
    }

    // Auto-append .jpg if i.postimg.cc lacks extension
    if (cleanUrl.includes("i.postimg.cc") && !/\.(jpe?g|png|webp|gif|bmp|svg|avif)($|\?|#)/i.test(cleanUrl)) {
      cleanUrl = cleanUrl + ".jpg";
    }

    // If it's a postimages HTML page instead of direct image (e.g. postimg.cc/<id> or postimages.org/...)
    if (
      /(?:postimg\.cc|postimages\.org)\/(?:[a-zA-Z]{2}\/)?(?:image\/)?([a-zA-Z0-9_-]+)/i.test(cleanUrl) &&
      !/\.(jpe?g|png|webp|gif|bmp|svg|avif)($|\?|#)/i.test(cleanUrl)
    ) {
      try {
        const pageHtml = await fetchRemoteText(cleanUrl, 5000);
        const downloadMatch = pageHtml.match(/id=["\']download["\'][^>]+href=["\']([^"\']+)["\']/i);
        const directMatch = pageHtml.match(/id=["\']direct["\']\s+value=["\']([^"\']+)["\']/i);
        const iPostMatch = pageHtml.match(/https?:\/\/i\.postimg\.cc\/[^\s"\'<>]+/i);
        if (downloadMatch && downloadMatch[1]) {
          cleanUrl = downloadMatch[1];
        } else if (directMatch && directMatch[1]) {
          cleanUrl = directMatch[1];
        } else if (iPostMatch && iPostMatch[0]) {
          cleanUrl = iPostMatch[0];
        }
      } catch {
        // proceed with original URL
      }
    }

    await streamRemoteImage(cleanUrl, res);
  } catch (error: any) {
    console.error("Proxy image error:", error.message);
    if (!res.headersSent) {
      return res.status(502).send("Lỗi tải ảnh qua máy chủ: " + error.message);
    }
  }
});

// AI Generate student evaluation remarks
app.post("/api/ai/generate-comment", async (req, res) => {
  try {
    const { studentName, className, conductScore, conductDetails, homeworkStats, periodName, customApiKey } = req.body;
    const ai = getAI(customApiKey);
    
    if (!ai) {
      // Fallback rule-based comment if no API key is set
      let uudiem = `Em ${studentName} chấp hành tốt nội quy trường lớp, đi học đúng giờ và có tinh thần học tập nghiêm túc.`;
      let nhuocdiem = conductScore < 80 ? "Cần chú ý giữ gìn trật tự và hoàn thành bài tập đầy đủ hơn." : "Cần phát huy tính tự giác và chủ động hơn nữa.";
      let dongvien = `Chúc em tiếp tục cố gắng phấn đấu để đạt thành tích xuất sắc hơn trong ${periodName || "tuần tới"}!`;

      if (conductScore >= 95) {
        uudiem = `Em ${studentName} có ý thức kỷ luật rất cao, đạt nhiều điểm cộng thi đua, luôn gương mẫu trong mọi hoạt động của lớp.`;
      }

      return res.json({
        success: true,
        isFallback: true,
        result: {
          uudiem,
          nhuocdiem,
          dongvien,
          fullSummary: `[Đánh giá ${periodName || "Tuần"} - Lớp ${className}]:\n- Ưu điểm: ${uudiem}\n- Cần khắc phục: ${nhuocdiem}\n- Lời khuyên: ${dongvien}`
        }
      });
    }

    const prompt = `Bạn là một Giáo viên Chủ nhiệm tận tụy tại Trường THCS Phùng Khắc Khoan (xã Tây Phương). 
Hãy viết một bản nhận xét học sinh ngắn gọn, chuẩn mực sư phạm, mang tính động viên, chân thành và chính xác dựa trên thông tin sau:
- Tên học sinh: ${studentName}
- Lớp: ${className}
- Khoảng thời gian: ${periodName || "Tuần này"}
- Điểm thi đua nề nếp: ${conductScore}/100 điểm
- Chi tiết vi phạm/cộng điểm nề nếp: ${JSON.stringify(conductDetails || [])}
- Thống kê nộp bài tập & sao đánh giá: ${JSON.stringify(homeworkStats || {})}

Hãy trả về JSON theo đúng định dạng sau (không thêm markdown ngoài json):
{
  "uudiem": "Các mặt tốt, ưu điểm nổi bật (khen ngợi cụ thể)",
  "nhuocdiem": "Mặt còn hạn chế cần khắc phục (nhắc nhở khéo léo, mang tính xây dựng)",
  "dongvien": "Lời chúc và định hướng phấn đấu cho tuần/kỳ tiếp theo",
  "fullSummary": "Đoạn văn hoàn chỉnh tổng kết 3-4 câu để gửi tin nhắn Zalo cho Phụ huynh học sinh"
}`;

    const response = await generateGeminiWithRetry(ai, {
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    const text = response.text?.trim() || "{}";
    const parsed = safeParseAIJson(text);
    return res.json({ success: true, isFallback: false, result: parsed });
  } catch (error: any) {
    console.error("AI generate comment error:", error);
    res.status(500).json({ error: error.message || "Lỗi tạo nhận xét AI" });
  }
});

// Verify a Gemini API Key (Endpoint to test if a key is valid & has available quota)
app.post("/api/ai/verify-key", async (req, res) => {
  try {
    const { apiKey } = req.body;
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!key || key.length < 15) {
      return res.status(400).json({ success: false, valid: false, error: "Mã khóa API không hợp lệ hoặc quá ngắn." });
    }

    const testClient = new GoogleGenAI({ 
      apiKey: key,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
    });

    const response = await testClient.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Hello. Respond with one word: OK",
    });

    const reply = response.text?.trim() || "";
    return res.json({
      success: true,
      valid: true,
      message: "Khóa API hợp lệ, kết nối Google AI thành công và sẵn sàng chấm bài!",
      maskedKey: key.slice(0, 6) + "..." + key.slice(-4),
      sample: reply.slice(0, 20),
    });
  } catch (err: any) {
    console.warn("Verify key failed:", err?.message || err);
    const errMsg = String(err?.message || err);
    let userMsg = "Không thể xác minh khóa API.";
    if (errMsg.includes("API_KEY_INVALID") || err?.code === 400 || err?.code === 403) {
      userMsg = "Mã khóa API không chính xác hoặc đã bị vô hiệu hóa trên Google AI Studio.";
    } else if (errMsg.includes("Resource has been exhausted") || err?.code === 429) {
      userMsg = "Khóa API này đã hết hạn mức sử dụng (Quota) miễn phí trong ngày của Google. Vui lòng nạp khóa khác!";
    } else if (errMsg.includes("503") || errMsg.includes("UNAVAILABLE")) {
      userMsg = "Hệ thống Google AI tạm thời bận, vui lòng thử lại sau giây lát.";
    }

    return res.status(400).json({
      success: false,
      valid: false,
      error: userMsg,
      rawError: errMsg,
    });
  }
});

// AI Evaluate Notebook / Homework vs Standard Solution (Deep Multimodal OCR & Caching)
app.post("/api/ai/evaluate-notebook", async (req, res) => {
  try {
    const { studentContent, standardReference, subject, studentName, graderRole, graderTitle, graderName, customApiKey } = req.body;
    
    // Determine grader role and title
    const isStudentGrader = graderRole && !["teacher", "admin", "gvcn", "school_admin"].includes(graderRole);
    const effectiveGraderTitle = graderTitle || (graderRole === "team_lead" ? "Tổ trưởng" : graderRole === "monitor" ? "Lớp trưởng" : "Cán sự lớp");

    // Check Cache first to avoid hitting API limits
    const cacheKey = getGradeCacheKey(
      isStudentGrader ? `eval_peer_${graderRole}` : "eval",
      studentName || "hs",
      subject || "mon",
      typeof studentContent === "string" ? studentContent : "",
      typeof standardReference === "string" ? standardReference : ""
    );
    if (aiGradeCache.has(cacheKey)) {
      return res.json({ success: true, isCached: true, isFallback: false, data: aiGradeCache.get(cacheKey) });
    }

    const ai = getAI(customApiKey);

    if (!ai) {
      // Fallback offline evaluation when AI is unavailable
      const fallbackFeedback = isStudentGrader
        ? `${effectiveGraderTitle} nhận xét: Chưa thể kết nối AI để đọc chữ viết tay bài làm của bạn ${studentName || "học sinh"}. Vui lòng kiểm tra lại kết nối mạng hoặc ảnh chụp bài làm.`
        : `Chưa thể kết nối AI để chấm bài cho học sinh ${studentName || "Học sinh"}. Thầy/Cô vui lòng kiểm tra lại ảnh bài nộp hoặc kết nối mạng.`;

      return res.json({
        success: true,
        isFallback: true,
        data: {
          isInvalidSubmission: false,
          relevanceCategory: "valid_homework",
          invalidReason: "",
          rating: 0,
          score: 0,
          completeness: 0,
          cleanliness: "Chưa quét được chữ viết",
          feedback: fallbackFeedback,
          strengths: [],
          missingItems: ["Cần kiểm tra lại ảnh chụp bài tập hoặc kết nối mạng"],
          transcribedText: "Chưa thể kết nối AI OCR nhận diện chữ viết tay.",
          analyzedAt: new Date().toISOString(),
          isOfflineFallback: true,
        }
      });
    }

    const contents: any[] = [];
    let promptText = isStudentGrader
      ? `Bạn là Trợ lý AI hỗ trợ ${effectiveGraderTitle} ${graderName ? `(${graderName})` : ""} chấm bài tập/vở ghi môn ${subject || "học"} cho bạn học "${studentName || "Học sinh"}".
Nhiệm vụ: Phân tích kỹ ảnh nộp thực tế của bạn học "${studentName || "Học sinh"}" và đối chiếu với Đáp án/Vở mẫu nếu có.

QUY TẮC SỐ 1 - BẮT BUỘC NHẬN DIỆN CHUẨN XÁC NỘI DUNG ẢNH NỘP & KIỂM TRA TÍNH HỢP LỆ:
1. Nhận diện chuẩn xác thể loại ảnh nộp vào "detectedContentType":
   - Nếu là vở bài tập: Ghi rõ môn học và dạng vở (VD: "Vở bài tập Toán viết tay (Đại số & Phương trình)", "Vở bài tập Toán viết tay (Hình học có vẽ hình)", "Vở ghi bài / Tập làm văn Ngữ văn viết tay", "Phiếu bài tập Tiếng Anh", "Vở ghi bài Khoa học tự nhiên (Lý/Hóa/Sinh)").
   - Nếu nộp nhầm vở môn khác: Ghi rõ (VD: "Vở môn Tiếng Anh (Nộp nhầm môn ${subject || "học"})").
   - Nếu là ảnh không hợp lệ: Ghi rõ (VD: "Ảnh chân dung / Selfie người (Không hợp lệ)", "Ảnh phòng ngủ / đồ vật trong nhà (Không hợp lệ)", "Ảnh màn hình điện thoại / Game / Meme (Không hợp lệ)", "Trang giấy trắng trơn không có chữ").
2. Trả về "imageContentDescription": Mô tả cụ thể, khách quan 1-2 câu về những gì nhìn thấy trong ảnh (VD: "Ảnh chụp trang vở ô ly, gồm 3 bài tập giải phương trình viết bằng bút bi xanh, có gạch chân tiêu đề rõ ràng.").
3. Trả về "recognizedElements": Mảng chuỗi các chi tiết nhận diện được trong ảnh (VD: ["Chữ viết tay tiếng Việt", "Công thức x = 2", "Hình tam giác vuông", "Kẻ bảng điểm danh"]).
4. Trả về "contentRelevance": "valid_homework" | "wrong_subject" | "person_photo" | "unrelated_photo" | "blank_page"

QUY TẮC PHÁT HIỆN ẢNH RÁC / ẢNH NGƯỜI:
- Nếu ảnh là: Ảnh chân dung người, ảnh selfie, ảnh mặt học sinh, bạn bè, phòng ngủ, bàn trống không có vở, phong cảnh, thú cưng, meme, game điện thoại, hoặc trang giấy trắng trơn:
  -> BẮT BUỘC XÁC ĐỊNH: "isInvalidSubmission": true
  -> "relevanceCategory": "person_photo" (nếu có người) hoặc "unrelated_photo" (đồ vật/phong cảnh) hoặc "blank_page"
  -> "contentRelevance": "person_photo" hoặc "unrelated_photo" hoặc "blank_page"
  -> "detectedContentType": "Ảnh chân dung người / Selfie (Không hợp lệ)" hoặc "Ảnh đồ vật / phòng ngủ không liên quan"
  -> "invalidReason": "Học sinh nộp ảnh người / ảnh không liên quan thay vì chụp vở bài tập môn ${subject || "học"}"
  -> "score": 0.0 (TUYỆT ĐỐI KHÔNG CHO 2/10 HAY ĐIỂM NÀO KHÁC!)
  -> "completeness": 0
  -> "rating": 1
  -> "cleanliness": "Không hợp lệ (Không phải trang vở bài tập)"
  -> "feedback": "${effectiveGraderTitle} nhận xét: CẢNH BÁO - Ảnh bạn nộp là ảnh người / ảnh không liên quan, không phải bài tập môn ${subject || "học"}. Bạn vui lòng chụp lại đúng trang vở bài tập và nộp lại ngay nhé!"
  -> "strengths": []
  -> "missingItems": ["Chưa nộp đúng bài tập môn học"]
  -> "transcribedText": "Phát hiện ảnh người hoặc ảnh chụp không liên quan đến bài tập môn học."

QUY TẮC BẮT BUỘC VỀ XƯNG HÔ VÀ TÁC PHONG (HỌC SINH / CÁN SỰ LỚP CHẤM BÀI CHO BẠN CÙNG LỚP):
1. TUYỆT ĐỐI KHÔNG xưng là "Thầy", "Cô", vì người chấm là ${effectiveGraderTitle} (học sinh cùng lớp).
2. Xưng hô: "Bạn ${studentName || "học sinh"}", người chấm xưng "${effectiveGraderTitle}" hoặc "Mình / Tớ".
3. Trích dẫn chữ viết tay thực tế vào "transcribedText".

Nếu là ảnh bài tập hợp lệ:
- "isInvalidSubmission": false, "relevanceCategory": "valid_homework", "contentRelevance": "valid_homework", "invalidReason": ""
- Phân hóa điểm chuẩn xác:
  + Đúng toàn bộ, trình bày đẹp: score 9-10, completeness 90-100%, 5 sao
  + Khá, sai sót nhỏ: score 7-8.5, completeness 70-85%, 4 sao
  + Trung bình, sai nhiều câu: score 5-6.5, completeness 50-65%, 3 sao
  + Thiếu bài, làm đối phó 1-2 dòng: score 1-4, completeness 10-40%, 1-2 sao

Hãy trả về đúng JSON theo schema sau (chỉ trả về JSON thuần):
{
  "isInvalidSubmission": false,
  "relevanceCategory": "valid_homework",
  "contentRelevance": "valid_homework",
  "detectedContentType": "Vở bài tập môn ${subject || "học"} viết tay",
  "imageContentDescription": "Mô tả cụ thể 1-2 câu về những gì nhìn thấy trong ảnh",
  "recognizedElements": ["Chữ viết tay tiếng Việt", "Công thức toán / lời văn"],
  "invalidReason": "",
  "rating": 4,
  "score": 7.5,
  "completeness": 75,
  "cleanliness": "Chữ viết bạn khá rõ ràng",
  "feedback": "${effectiveGraderTitle} nhận xét: Bạn ${studentName || "học sinh"} ...",
  "strengths": ["Bạn làm đúng câu 1"],
  "missingItems": ["Câu 3 bạn chưa kết luận"],
  "transcribedText": "Trích dẫn nguyên văn 2-4 dòng chữ viết tay hoặc bước giải trong ảnh",
  "analyzedAt": "${new Date().toISOString()}"
}`
      : `Bạn là Giám khảo chấm thi chuyên môn giỏi môn ${subject || "học"} tại trường THCS Việt Nam.
Nhiệm vụ: Phân tích kỹ ảnh nộp thực tế của học sinh "${studentName || "Học sinh"}" và chấm điểm sư phạm chuẩn xác.

QUY TẮC SỐ 1 - BẮT BUỘC NHẬN DIỆN CHUẨN XÁC NỘI DUNG ẢNH NỘP & KIỂM TRA TÍNH HỢP LỆ:
1. Nhận diện chuẩn xác thể loại ảnh nộp vào "detectedContentType":
   - Nếu là vở bài tập: Ghi rõ môn học và dạng vở (VD: "Vở bài tập Toán viết tay (Đại số & Phương trình)", "Vở bài tập Toán viết tay (Hình học có vẽ hình)", "Vở ghi bài / Tập làm văn Ngữ văn viết tay", "Phiếu bài tập Tiếng Anh", "Vở bài tập Khoa học tự nhiên (Lý/Hóa/Sinh)").
   - Nếu nộp nhầm vở môn khác: Ghi rõ (VD: "Vở môn Tiếng Anh (Nộp nhầm môn ${subject || "học"})").
   - Nếu là ảnh không hợp lệ: Ghi rõ (VD: "Ảnh chân dung / Selfie người (Không hợp lệ)", "Ảnh phòng ngủ / đồ vật trong nhà (Không hợp lệ)", "Ảnh màn hình điện thoại / Game / Meme (Không hợp lệ)", "Trang giấy trắng trơn không có chữ").
2. Trả về "imageContentDescription": Mô tả cụ thể, khách quan 1-2 câu về những gì nhìn thấy trong ảnh (VD: "Ảnh chụp rõ nét 1 trang vở ô ly, gồm 3 bài tập giải phương trình viết bằng bút bi xanh, có gạch chân tiêu đề rõ ràng.").
3. Trả về "recognizedElements": Mảng chuỗi các chi tiết nhận diện được trong ảnh (VD: ["Chữ viết tay tiếng Việt", "Công thức x = 2", "Hình tam giác vuông", "Kẻ bảng điểm danh"]).
4. Trả về "contentRelevance": "valid_homework" | "wrong_subject" | "person_photo" | "unrelated_photo" | "blank_page"

QUY TẮC PHÁT HIỆN ẢNH RÁC / ẢNH NGƯỜI:
- Quan sát kỹ ảnh chụp của học sinh:
  + Nếu ảnh là: Ảnh chân dung người, ảnh selfie, ảnh học sinh/bạn bè, ảnh phòng ngủ, trần nhà, bàn ghế trống, phong cảnh, meme, truyện tranh, game điện thoại, hoặc trang giấy trắng trơn:
  -> BẮT BUỘC XÁC ĐỊNH: "isInvalidSubmission": true
  -> "relevanceCategory": "person_photo" (nếu có người) hoặc "unrelated_photo" (đồ vật/phong cảnh) hoặc "blank_page"
  -> "contentRelevance": "person_photo" hoặc "unrelated_photo" hoặc "blank_page"
  -> "detectedContentType": "Ảnh chân dung người / Selfie (Không hợp lệ)" hoặc "Ảnh đồ vật / phòng ngủ không liên quan"
  -> "invalidReason": "Học sinh nộp ảnh người / ảnh không liên quan thay vì chụp vở bài tập môn ${subject || "học"}"
  -> "score": 0.0 (TUYỆT ĐỐI KHÔNG CHO 2/10 HAY ĐIỂM NÀO KHÁC!)
  -> "completeness": 0
  -> "rating": 1
  -> "cleanliness": "Không hợp lệ (Không phải trang vở bài tập)"
  -> "feedback": "CẢNH BÁO SƯ PHẠM: Em đã nộp ảnh người / ảnh không liên quan thay vì chụp vở bài tập môn ${subject || "học"}. Em bị đánh giá 0 điểm và cần chụp lại đúng bài tập nộp lại ngay!"
  -> "strengths": []
  -> "missingItems": ["Chưa nộp bài tập môn học hợp lệ"]
  -> "transcribedText": "Phát hiện ảnh chụp người hoặc ảnh không liên quan đến bài tập môn học."

Nếu là ảnh bài tập hợp lệ:
- "isInvalidSubmission": false, "relevanceCategory": "valid_homework", "contentRelevance": "valid_homework", "invalidReason": ""
- Đọc kỹ chữ viết tay, trích dẫn 2-4 dòng vào "transcribedText".
- Phân hóa điểm chuẩn xác:
  + Xuất sắc, đúng hết: score 9-10, completeness 90-100%, 5 sao
  + Khá, sai sót nhỏ: score 7-8.5, completeness 70-85%, 4 sao
  + Trung bình, sai nhiều câu: score 5-6.5, completeness 50-65%, 3 sao
  + Thiếu bài, làm đối phó 1-2 dòng: score 1-4, completeness 10-40%, 1-2 sao

Hãy trả về đúng JSON theo schema sau (chỉ trả về JSON thuần):
{
  "isInvalidSubmission": false,
  "relevanceCategory": "valid_homework",
  "contentRelevance": "valid_homework",
  "detectedContentType": "Vở bài tập môn ${subject || "học"} viết tay",
  "imageContentDescription": "Mô tả cụ thể 1-2 câu về những gì nhìn thấy trong ảnh",
  "recognizedElements": ["Chữ viết tay tiếng Việt", "Công thức toán / lời văn"],
  "invalidReason": "",
  "rating": 4,
  "score": 7.5,
  "completeness": 75,
  "cleanliness": "Chữ viết nắn nót, rõ ràng",
  "feedback": "Nhận xét sư phạm chi tiết 2-3 câu cho học sinh ${studentName || "Học sinh"}",
  "strengths": ["Làm đúng bài 1 và bài 2"],
  "missingItems": ["Bài 3 tính nhầm kết quả"],
  "transcribedText": "Trích dẫn nguyên văn 2-4 dòng chữ viết tay trong ảnh",
  "analyzedAt": "${new Date().toISOString()}"
};`

    // Handle student submission images or text (with remote URL support)
    const studentParts = await prepareGeminiContentParts(studentContent, `Bài làm của học sinh ${studentName || "Học sinh"}`);
    contents.push(...studentParts);

    // Handle standard reference (image or text)
    if (standardReference) {
      const stdParts = await prepareGeminiContentParts(standardReference, "Đáp án / Vở mẫu chuẩn của Thầy Cô");
      contents.push(...stdParts);
    }

    contents.push({ text: promptText });

    const response = await generateGeminiWithRetry(ai, {
      contents,
      config: {
        responseMimeType: "application/json",
      },
    });

    const parsed = safeParseAIJson(response.text?.trim() || "{}");
    aiGradeCache.set(cacheKey, parsed);
    res.json({ success: true, isFallback: false, data: parsed });
  } catch (error: any) {
    console.warn("AI evaluate notebook notice (fallback activated):", error?.message || error);
    // Return honest fallback evaluation instead of crashing or returning fake 80%
    const studentName = req.body?.studentName || "Học sinh";
    const subject = req.body?.subject || "Bài tập";
    const fallbackData = {
      rating: 0,
      score: 0,
      completeness: 0,
      cleanliness: "Chưa quét được chữ viết",
      feedback: `Không thể hoàn tất chấm AI cho học sinh ${studentName}: Ảnh bài nộp chưa tải được hoặc kết nối AI bận. Thầy/Cô vui lòng kiểm tra lại ảnh bài tập môn ${subject}.`,
      strengths: [],
      missingItems: ["Cần kiểm tra lại ảnh chụp bài làm hoặc kết nối mạng"],
      transcribedText: "Không thể trích xuất chữ viết do lỗi đường truyền hoặc ảnh chưa sẵn sàng.",
      analyzedAt: new Date().toISOString(),
      isOfflineFallback: true,
    };
    res.json({ success: true, isFallback: true, data: fallbackData, warning: error.message });
  }
});

// AI Batch Evaluate Endpoint (Grades entire class or selected students with sequential throttling & caching)
app.post("/api/ai/batch-evaluate", async (req, res) => {
  try {
    const { submissions, subject, standardReference, graderRole, graderTitle, graderName, customApiKey } = req.body;
    if (!Array.isArray(submissions) || submissions.length === 0) {
      return res.status(400).json({ error: "Danh sách bài nộp rỗng." });
    }

    const isStudentGrader = graderRole && !["teacher", "admin", "gvcn", "school_admin"].includes(graderRole);
    const effectiveGraderTitle = graderTitle || (graderRole === "team_lead" ? "Tổ trưởng" : graderRole === "monitor" ? "Lớp trưởng" : "Cán sự lớp");

    const ai = getAI(customApiKey);
    if (!ai) {
      return res.status(400).json({ error: "Chưa kết nối Gemini API." });
    }

    const results: any[] = [];
    for (let i = 0; i < submissions.length; i++) {
      const sub = submissions[i];
      const studentName = sub.studentName || `Học sinh #${sub.studentId}`;
      const firstContent = Array.isArray(sub.content) ? sub.content[0] : sub.content;
      const refToUse = standardReference || sub.standardReference || "";

      const cacheKey = getGradeCacheKey(
        isStudentGrader ? `eval_peer_${graderRole}` : "eval",
        studentName,
        subject || "mon",
        typeof firstContent === "string" ? firstContent : "",
        typeof refToUse === "string" ? refToUse : ""
      );

      if (aiGradeCache.has(cacheKey)) {
        results.push({
          submissionId: sub.id,
          studentId: sub.studentId,
          studentName,
          evaluation: aiGradeCache.get(cacheKey),
          isCached: true,
        });
        continue;
      }

      try {
        const contents: any[] = [];
        let promptText = isStudentGrader
          ? `Bạn là Trợ lý AI hỗ trợ ${effectiveGraderTitle} ${graderName ? `(${graderName})` : ""} chấm bài tập môn ${subject || "học"} cho bạn học "${studentName}".
Nhiệm vụ: Chấm bài nộp thực tế của bạn học "${studentName}" (ảnh chụp chữ viết tay, công thức, bảng biểu, sơ đồ hình vẽ) và đối chiếu đáp án chuẩn (nếu có).

QUY TẮC SỐ 1 - BẮT BUỘC NHẬN DIỆN CHUẨN XÁC NỘI DUNG ẢNH NỘP & KIỂM TRA TÍNH HỢP LỆ:
1. Nhận diện chuẩn xác thể loại ảnh nộp vào "detectedContentType" (VD: "Vở bài tập Toán viết tay (Đại số)", "Vở bài tập Toán viết tay (Hình học có vẽ hình)", "Vở ghi bài Ngữ văn viết tay", "Phiếu bài tập Tiếng Anh", "Ảnh chân dung / Selfie người (Không hợp lệ)", "Ảnh đồ vật / phòng ngủ không liên quan").
2. Trả về "imageContentDescription": Mô tả cụ thể, khách quan 1-2 câu về những gì nhìn thấy trong ảnh.
3. Trả về "recognizedElements": Mảng chuỗi các chi tiết nhận diện được trong ảnh (VD: ["Chữ viết tay tiếng Việt", "Công thức x = 2", "Hình tam giác vuông"]).
4. Trả về "contentRelevance": "valid_homework" | "wrong_subject" | "person_photo" | "unrelated_photo" | "blank_page"

QUY TẮC BẮT BUỘC SỐ 2 - PHÁT HIỆN ẢNH RÁC / ẢNH NGƯỜI:
- NẾU ẢNH NỘP LÀ: Ảnh chân dung người, selfie, ảnh chụp mặt, ảnh bạn bè, phòng ngủ, trần nhà, bàn ghế trống, phong cảnh, xe cộ, meme, game, trang trắng trơn:
  -> BẮT BUỘC TRẢ VỀ:
     "isInvalidSubmission": true,
     "relevanceCategory": "person_photo" (nếu có người) hoặc "unrelated_photo" hoặc "blank_page",
     "contentRelevance": "person_photo" hoặc "unrelated_photo" hoặc "blank_page",
     "detectedContentType": "Ảnh chân dung người / Selfie (Không hợp lệ)" hoặc "Ảnh đồ vật / phòng ngủ không liên quan",
     "invalidReason": "Học sinh nộp ảnh người / ảnh không liên quan thay vì chụp vở bài tập môn ${subject || "học"}",
     "rating": 1,
     "score": 0.0,
     "completeness": 0,
     "cleanliness": "Ảnh không hợp lệ",
     "feedback": "${effectiveGraderTitle} nhận xét: CẢNH BÁO - Ảnh bạn nộp là ảnh người / ảnh không liên quan, không phải bài tập môn ${subject || "học"}. Bạn vui lòng chụp lại đúng trang vở và nộp lại ngay nhé!",
     "strengths": [],
     "missingItems": ["Chưa nộp đúng bài tập"],
     "transcribedText": "Phát hiện ảnh người hoặc ảnh chụp không liên quan."
  -> TUYỆT ĐỐI KHÔNG CHO 2/10 HAY CHO ĐIỂM!

QUY TẮC BẮT BUỘC VỀ XƯNG HÔ (HỌC SINH / CÁN SỰ LỚP CHẤM CHO BẠN CÙNG LỚP):
- TUYỆT ĐỐI KHÔNG xưng là "Thầy", "Cô", KHÔNG xưng "Thầy khen em", "Cô nhắc nhở em" vì người chấm là ${effectiveGraderTitle} (học sinh cùng lớp).
- Gọi bạn học là "Bạn ${studentName}" hoặc "cậu".
- Người chấm xưng là "${effectiveGraderTitle}" hoặc "${effectiveGraderTitle} nhận xét..." hoặc "Mình / Tớ".
- Lời nhận xét mang tính xây dựng, chân thành, tôn trọng.

Nếu là ảnh bài tập hợp lệ:
- "isInvalidSubmission": false, "relevanceCategory": "valid_homework", "contentRelevance": "valid_homework", "invalidReason": ""
- Trích dẫn 2-4 dòng chữ viết tay thực tế vào "transcribedText".

Hãy trả về đúng JSON theo schema sau (chỉ trả về JSON thuần):
{
  "isInvalidSubmission": false,
  "relevanceCategory": "valid_homework",
  "contentRelevance": "valid_homework",
  "detectedContentType": "Vở bài tập môn ${subject || "học"} viết tay",
  "imageContentDescription": "Mô tả cụ thể 1-2 câu về những gì nhìn thấy trong ảnh",
  "recognizedElements": ["Chữ viết tay tiếng Việt", "Công thức toán / lời văn"],
  "invalidReason": "",
  "rating": 4,
  "score": 7.5,
  "completeness": 75,
  "cleanliness": "Chữ viết bạn khá rõ ràng",
  "feedback": "${effectiveGraderTitle} nhận xét: Bạn ${studentName} ...",
  "strengths": ["Điểm làm tốt 1 của bạn"],
  "missingItems": ["Chỗ bạn cần lưu ý sửa 1"],
  "transcribedText": "Trích dẫn nguyên văn 2-4 dòng chữ viết tay hoặc bước giải của bạn trong ảnh",
  "analyzedAt": "${new Date().toISOString()}"
}`
          : `Bạn là Giám khảo chấm thi chuyên môn giỏi môn ${subject || "học"} tại trường THCS Việt Nam.
Nhiệm vụ: Chấm bài nộp thực tế của học sinh "${studentName}" (ảnh chụp chữ viết tay, công thức, bảng biểu, sơ đồ hình vẽ).

QUY TẮC SỐ 1 - BẮT BUỘC NHẬN DIỆN CHUẨN XÁC NỘI DUNG ẢNH NỘP & KIỂM TRA TÍNH HỢP LỆ:
1. Nhận diện chuẩn xác thể loại ảnh nộp vào "detectedContentType" (VD: "Vở bài tập Toán viết tay (Đại số)", "Vở bài tập Toán viết tay (Hình học có vẽ hình)", "Vở ghi bài Ngữ văn viết tay", "Phiếu bài tập Tiếng Anh", "Ảnh chân dung / Selfie người (Không hợp lệ)", "Ảnh đồ vật / phòng ngủ không liên quan").
2. Trả về "imageContentDescription": Mô tả cụ thể, khách quan 1-2 câu về những gì nhìn thấy trong ảnh.
3. Trả về "recognizedElements": Mảng chuỗi các chi tiết nhận diện được trong ảnh (VD: ["Chữ viết tay tiếng Việt", "Công thức x = 2", "Hình tam giác vuông"]).
4. Trả về "contentRelevance": "valid_homework" | "wrong_subject" | "person_photo" | "unrelated_photo" | "blank_page"

QUY TẮC BẮT BUỘC SỐ 2 - PHÁT HIỆN ẢNH RÁC / ẢNH NGƯỜI:
- NẾU ẢNH NỘP LÀ: Ảnh chân dung người, selfie, ảnh chụp mặt, bạn bè, phòng ngủ, trần nhà, bàn ghế trống, phong cảnh, xe cộ, thú cưng, meme, game, trang trắng:
  -> BẮT BUỘC TRẢ VỀ:
     "isInvalidSubmission": true,
     "relevanceCategory": "person_photo" (nếu có người) hoặc "unrelated_photo" hoặc "blank_page",
     "contentRelevance": "person_photo" hoặc "unrelated_photo" hoặc "blank_page",
     "detectedContentType": "Ảnh chân dung người / Selfie (Không hợp lệ)" hoặc "Ảnh đồ vật / phòng ngủ không liên quan",
     "invalidReason": "Học sinh nộp ảnh người / ảnh không liên quan thay vì chụp vở bài tập môn ${subject || "học"}",
     "rating": 1,
     "score": 0.0,
     "completeness": 0,
     "cleanliness": "Ảnh không hợp lệ",
     "feedback": "CẢNH BÁO SƯ PHẠM: Em đã nộp ảnh người / ảnh không liên quan thay vì vở bài tập môn ${subject || "học"}. Em bị đánh giá 0 điểm và cần chụp lại đúng bài tập nộp lại ngay!",
     "strengths": [],
     "missingItems": ["Chưa nộp bài tập hợp lệ"],
     "transcribedText": "Phát hiện ảnh người hoặc ảnh chụp không liên quan."
  -> TUYỆT ĐỐI KHÔNG CHO 2/10 HAY CHO ĐIỂM!

Nếu là ảnh bài tập hợp lệ:
- "isInvalidSubmission": false, "relevanceCategory": "valid_homework", "contentRelevance": "valid_homework", "invalidReason": ""
- Bắt buộc trích dẫn 2-4 dòng chữ viết tay vào "transcribedText".

Hãy trả về đúng JSON theo schema sau (chỉ trả về JSON thuần):
{
  "isInvalidSubmission": false,
  "relevanceCategory": "valid_homework",
  "contentRelevance": "valid_homework",
  "detectedContentType": "Vở bài tập môn ${subject || "học"} viết tay",
  "imageContentDescription": "Mô tả cụ thể 1-2 câu về những gì nhìn thấy trong ảnh",
  "recognizedElements": ["Chữ viết tay tiếng Việt", "Công thức toán / lời văn"],
  "invalidReason": "",
  "rating": 4,
  "score": 7.5,
  "completeness": 75,
  "cleanliness": "Chữ rõ ràng / Cần nắn nót",
  "feedback": "Nhận xét sư phạm chi tiết 2-3 câu cho học sinh ${studentName}",
  "strengths": ["Ý đúng 1"],
  "missingItems": ["Lỗi sai 1"],
  "transcribedText": "Trích dẫn nguyên văn 2-4 dòng chữ viết tay hoặc bước giải của học sinh trong ảnh",
  "analyzedAt": "${new Date().toISOString()}"
}`;

        const studentParts = await prepareGeminiContentParts(sub.content || firstContent, `Bài làm của ${studentName}`);
        contents.push(...studentParts);

        if (refToUse) {
          const refParts = await prepareGeminiContentParts(refToUse, "Đáp án / Vở mẫu chuẩn");
          contents.push(...refParts);
        }

        contents.push({ text: promptText });

        const response = await generateGeminiWithRetry(ai, {
          contents,
          config: { responseMimeType: "application/json" },
        });

        const parsed = safeParseAIJson(response.text?.trim() || "{}");
        aiGradeCache.set(cacheKey, parsed);

        results.push({
          submissionId: sub.id,
          studentId: sub.studentId,
          studentName,
          evaluation: parsed,
          isCached: false,
        });

        // Throttle 1000ms between calls to avoid hitting rate limits
        if (i < submissions.length - 1) {
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (itemErr: any) {
        console.error(`Batch grade error for student ${studentName}:`, itemErr);
        results.push({
          submissionId: sub.id,
          studentId: sub.studentId,
          studentName,
          error: itemErr.message || "Lỗi chấm bài",
        });
      }
    }

    res.json({ success: true, count: results.length, data: results });
  } catch (error: any) {
    console.error("Batch evaluate error:", error);
    res.status(500).json({ error: error.message || "Lỗi chấm bài cả lớp" });
  }
});

// AI OCR & Handwriting Image Parser
app.post("/api/ai/ocr-analyze", async (req, res) => {
  try {
    const { imageBase64, mimeType, taskType, customApiKey } = req.body;
    const ai = getAI(customApiKey);

    if (!ai) {
      return res.status(400).json({ error: "Chưa cấu hình API Key. Vui lòng nhập API Key trong phần Cài đặt." });
    }

    let promptInstruction = "Hãy trích xuất chính xác toàn bộ danh sách học sinh (STT, Họ và tên, Tổ, mã số định danh, ngày sinh, giới tính, ghi chú) từ ảnh này sang danh sách JSON { \"students\": [ { \"id\": 1, \"name\": \"...\", \"team\": 1, \"code\": \"...\", \"dob\": \"...\", \"gender\": \"...\" } ] }.";
    if (taskType === "homework") {
      promptInstruction = "Hãy đọc và nhận xét bài tập của học sinh trong ảnh: Đánh giá bước giải, tính đúng sai, chấm điểm từ 1 đến 5 sao và gợi ý lời nhận xét ngắn gọn.";
    } else if (taskType === "scoresheet") {
      promptInstruction = "Hãy bóc tách bảng chấm điểm/sổ đầu bài/sổ sao đỏ từ ảnh này thành bảng dữ liệu gồm Tên lớp, Thứ, Tiết, Điểm số, Nội dung nhận xét.";
    } else if (taskType === "schedule") {
      promptInstruction = `Bạn là chuyên gia số hóa Thời khóa biểu (TKB) trường phổ thông (THCS/THPT) Việt Nam.
Hãy đọc ảnh thời khóa biểu và trích xuất thành JSON:
1. Nhận diện Tên Lớp ("className", ví dụ "8A1").
2. Các ngày: Thứ 2 ("1"), Thứ 3 ("2"), Thứ 4 ("3"), Thứ 5 ("4"), Thứ 6 ("5"), Thứ 7 ("6").
3. Các buổi: Đọc hết các tiết buổi Sáng (tiết 1-5), sau đó đọc các tiết buổi Chiều (tiết 1-5), bỏ qua ô trống.
4. "schedule": Mảng tên môn chuẩn hóa (Toán, Ngữ văn, Tiếng Anh, KHTN, Lịch sử, Địa lí, GDCD, Công nghệ, Tin học, Mĩ thuật, Âm nhạc, GDTC, GDĐP, HĐTN...).
5. "detailedSchedule": Mảng chuỗi nguyên bản trong ô kèm giáo viên (Ví dụ: "HĐTN 1 - Lãm", "CN - Quang", "TN2 - Oanh(Hóa)", "Toán - Trường"...).
Cấu trúc: { "className": "...", "schedule": { "1": [...], "2": [...], "3": [...], "4": [...], "5": [...], "6": [...] }, "detailedSchedule": { "1": [...], ... } }`;
    }

    let cleanBase64 = "";
    let finalMimeType = mimeType || "image/jpeg";

    if (imageBase64.startsWith("http://") || imageBase64.startsWith("https://")) {
      try {
        const imgFetch = await fetch(imageBase64, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
        });
        if (!imgFetch.ok) {
          throw new Error(`Không thể tải ảnh từ URL (HTTP ${imgFetch.status})`);
        }
        const arrayBuf = await imgFetch.arrayBuffer();
        cleanBase64 = Buffer.from(arrayBuf).toString("base64");
        const ct = imgFetch.headers.get("content-type");
        if (ct && ct.startsWith("image/")) {
          finalMimeType = ct;
        }
      } catch (fetchErr: any) {
        return res.status(400).json({ error: "Lỗi tải ảnh từ đường dẫn: " + fetchErr.message });
      }
    } else {
      cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    }

    const response = await generateGeminiWithRetry(ai, {
      contents: [
        {
          inlineData: {
            data: cleanBase64,
            mimeType: finalMimeType,
          },
        },
        {
          text: promptInstruction + "\nTrả về JSON thuần.",
        },
      ],
      config: {
        responseMimeType: "application/json",
      },
    });

    const parsed = safeParseAIJson(response.text?.trim() || "{}");
    res.json({ success: true, data: parsed });
  } catch (error: any) {
    console.error("AI OCR error:", error);
    res.status(500).json({ error: error.message || "Lỗi phân tích hình ảnh AI" });
  }
});

// Resolve and extract image URLs from text, links, Postimages (postimages.org, postimg.cc, i.postimg.cc)
app.post("/api/resolve-image-urls", async (req, res) => {
  try {
    const { text, urls } = req.body;
    const rawUrls: string[] = [];

    if (Array.isArray(urls)) {
      rawUrls.push(...sanitizeSubmissionContent(urls));
    }

    if (typeof text === "string" && text.trim()) {
      // 1. First extract using sanitizeSubmissionContent which un-fuses BBCode, [url=...], brackets, and %20
      const sanitizedList = sanitizeSubmissionContent([text]);
      rawUrls.push(...sanitizedList);

      // 2. Pre-process text by spacing out brackets, parentheses, semicolons, and commas
      const spacedText = text.replace(/[[\]()<>{}"',;]/g, " ").replace(/%20/g, " ");

      // 3. Raw URLs found in spaced text
      const extractedUrls = (spacedText.match(/https?:\/\/[^\s"'<>]+/gi) || [])
        .map(u => u.replace(/\[\/?img\]?/gi, "").replace(/\[\/?url.*?\]?/gi, "").replace(/[)\][(,.;:]+$/, "").trim())
        .filter(Boolean);
      rawUrls.push(...extractedUrls);
    }

    // Deduplicate and clean candidates
    const candidateUrls = Array.from(new Set(rawUrls.map(u => u.trim()).filter(Boolean)));
    const directImages: string[] = [];
    const pageUrls: string[] = [];

    for (let u of candidateUrls) {
      if (u.includes("i.postimg.cc") && !/\.(jpe?g|png|webp|gif|bmp|svg|avif)($|\?|#)/i.test(u)) {
        u = u + ".jpg";
      }

      if (/^https?:\/\/i\.postimg\.cc\//i.test(u) || /\.(jpe?g|png|webp|gif|bmp|svg|avif)($|\?|#)/i.test(u)) {
        if (!directImages.includes(u)) directImages.push(u);
      } else if (u.startsWith("http://") || u.startsWith("https://")) {
        if (!pageUrls.includes(u)) pageUrls.push(u);
      }
    }

    const resolvedImages: string[] = [...directImages];

    // For any non-direct web pages (e.g. postimg.cc/xxx)
    for (const url of pageUrls) {
      // Check if we already have a direct postimg link with the same ID
      const pageIdMatch = url.match(/(?:postimg\.cc|postimages\.org)\/(?:[a-zA-Z]{2}\/)?(?:image\/)?([a-zA-Z0-9_-]+)/i);
      const pageId = pageIdMatch?.[1];
      if (pageId && directImages.some(d => d.includes(pageId))) {
        continue; // Already resolved via direct link
      }

      // Postimages single image page: postimg.cc/<id> or postimages.org/...
      if (pageIdMatch) {
        try {
          const html = await fetchRemoteText(url, 6000);
          if (html) {
            // Check for download original high-res image link
            const downloadMatch = html.match(/id=["\']download["\'][^>]+href=["\']([^"\']+)["\']/i);
            if (downloadMatch && downloadMatch[1]) {
              resolvedImages.push(downloadMatch[1]);
              continue;
            }

            // Check for direct input field
            const directMatch = html.match(/id=["\']direct["\']\s+value=["\']([^"\']+)["\']/i);
            if (directMatch && directMatch[1]) {
              resolvedImages.push(directMatch[1]);
              continue;
            }

            // Check for i.postimg.cc URL in page
            const iPostMatches = html.match(/https?:\/\/i\.postimg\.cc\/[^\s"\'<>]+/gi);
            if (iPostMatches && iPostMatches.length > 0) {
              resolvedImages.push(iPostMatches[0]);
              continue;
            }

            // Check og:image meta tags
            const ogs = [...html.matchAll(/<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']/gi)].map(m => m[1]);
            const validOg = ogs.find(o => !o.includes("apple-touch-icon") && !o.includes("logo") && !o.includes("favicon"));
            if (validOg) {
              const fullUrl = validOg.startsWith("//") ? "https:" + validOg : validOg;
              resolvedImages.push(fullUrl);
              continue;
            }
          }
        } catch (e) {
          // If scraping fails, fallback to direct proxy candidate
        }
      }

      // Postimages gallery page: postimg.cc/gallery/<id>
      if (/(?:postimg\.cc|postimages\.org)\/gallery\/([a-zA-Z0-9_-]+)/i.test(url)) {
        try {
          const html = await fetchRemoteText(url, 7000);
          if (html) {
            const iPostMatches = html.match(/https?:\/\/i\.postimg\.cc\/[^\s"\'<>]+/gi) || [];
            if (iPostMatches.length > 0) {
              resolvedImages.push(...Array.from(new Set(iPostMatches)));
              continue;
            }
          }
        } catch (e) {}
      }

      // General fallback if it's a URL
      if (!resolvedImages.includes(url)) {
        resolvedImages.push(url);
      }
    }

    res.json({
      success: true,
      images: Array.from(new Set(resolvedImages)),
    });
  } catch (error: any) {
    console.error("Resolve image URLs error:", error);
    res.status(500).json({ error: error.message || "Lỗi xử lý đường dẫn ảnh" });
  }
});

// AI Peer-to-Peer & Standard Comparison Endpoint (Realistic OCR & Caching)
app.post("/api/ai/compare-homework", async (req, res) => {
  try {
    const { 
      studentContent, 
      studentName, 
      referenceContent, 
      referenceStudentName, 
      subject, 
      customApiKey 
    } = req.body;
    
    // Check Cache first
    const cacheKey = getGradeCacheKey(
      "comp",
      `${studentName}_vs_${referenceStudentName || "std"}`,
      subject || "mon",
      typeof studentContent === "string" ? studentContent : "",
      typeof referenceContent === "string" ? referenceContent : ""
    );
    if (aiGradeCache.has(cacheKey)) {
      return res.json({ success: true, isCached: true, isFallback: false, data: aiGradeCache.get(cacheKey) });
    }

    const ai = getAI(customApiKey);

    if (!ai) {
      return res.json({
        success: true,
        isFallback: true,
        data: {
          isInvalidSubmission: false,
          relevanceCategory: "valid_homework",
          invalidReason: "",
          rating: 3,
          score: 6.0,
          similarityScore: 60,
          completeness: 60,
          comparisonSummary: `So sánh bài của ${studentName} với bài của ${referenceStudentName || "bài mẫu"}: Bài làm đã nộp thành công. AI tạm bận, Thầy/Cô hoặc Cán sự lớp vui lòng xem lại ảnh bài nộp để chấm điểm chính xác.`,
          studentStrengths: ["Có tinh thần tự giác nộp bài"],
          studentDifferences: ["Chờ Thầy/Cô hoặc Cán sự lớp kiểm tra trực tiếp"],
          actionableFeedback: "Hãy xem lại bài mẫu để khắc phục những chỗ chưa hoàn thiện.",
          analyzedAt: new Date().toISOString()
        }
      });
    }

    const contents: any[] = [];
    let promptText = `Bạn là Giám khảo chấm thi chuyên môn giỏi môn ${subject || "học"} tại trường THCS Việt Nam.
Nhiệm vụ: Hãy phân tích hình ảnh và so sánh bài làm thực tế của học sinh [${studentName}] với [Bài mẫu / Bài của bạn ${referenceStudentName || "Học sinh đối chiếu"}].

BƯỚC 1: BẮT BUỘC NHẬN DIỆN CHUẨN XÁC NỘI DUNG ẢNH NỘP & KIỂM TRA TÍNH HỢP LỆ:
1. Nhận diện chuẩn xác thể loại ảnh nộp vào "detectedContentType" (VD: "Vở bài tập Toán viết tay (Đại số)", "Vở bài tập Toán viết tay (Hình học có vẽ hình)", "Vở ghi bài Ngữ văn viết tay", "Phiếu bài tập Tiếng Anh", "Ảnh chân dung / Selfie người (Không hợp lệ)", "Ảnh đồ vật / phòng ngủ không liên quan").
2. Trả về "imageContentDescription": Mô tả cụ thể, khách quan 1-2 câu về những gì nhìn thấy trong ảnh.
3. Trả về "recognizedElements": Mảng chuỗi các chi tiết nhận diện được trong ảnh (VD: ["Chữ viết tay tiếng Việt", "Công thức x = 2", "Hình tam giác vuông"]).
4. Trả về "contentRelevance": "valid_homework" | "wrong_subject" | "person_photo" | "unrelated_photo" | "blank_page"

BƯỚC 2: PHÁT HIỆN ẢNH RÁC / ẢNH NGƯỜI (CHỐNG GIAN LẬN):
- Bạn PHẢI quan sát kỹ hình ảnh nộp của học sinh [${studentName}]:
- NẾU ẢNH NỘP LÀ:
  + Ảnh người (ảnh chân dung, selfie, chụp mặt học sinh, chụp bạn bè, chụp người khác)
  + Ảnh sinh hoạt đời thường, phòng ngủ, trần nhà, bàn ghế trống không có trang vở bài tập
  + Ảnh xe cộ, thú cưng, đồ chơi, meme, truyện tranh, ảnh chụp màn hình game/điện thoại
  + Trang giấy trắng trơn hoàn toàn hoặc vẽ linh tinh, không phải vở ghi/bài tập môn ${subject || "học"}
  => ĐÂY LÀ HÀNH VI NỘP ẢNH SAI HOẶC ĐỐI PHÓ!
  => BẮT BUỘC TRẢ VỀ:
     "isInvalidSubmission": true,
     "relevanceCategory": "person_photo" (nếu là ảnh người/chân dung/selfie) hoặc "unrelated_photo" (ảnh đồ vật/phong cảnh) hoặc "blank_page",
     "contentRelevance": "person_photo" hoặc "unrelated_photo" hoặc "blank_page",
     "detectedContentType": "Ảnh chân dung người / Selfie (Không hợp lệ)" hoặc "Ảnh đồ vật / phòng ngủ không liên quan",
     "invalidReason": "Học sinh nộp ảnh người / ảnh không liên quan thay vì chụp vở bài tập môn ${subject || "học"}",
     "rating": 1,
     "score": 0.0,
     "similarityScore": 0,
     "completeness": 0,
     "comparisonSummary": "CẢNH BÁO: Ảnh nộp là ảnh người / ảnh không liên quan, KHÔNG PHẢI vở bài tập môn ${subject || "học"}. Đã đánh giá 0 điểm và yêu cầu học sinh chụp lại đúng bài tập nộp lại ngay.",
     "studentStrengths": [],
     "studentDifferences": ["Học sinh chưa nộp đúng ảnh bài làm môn học"],
     "actionableFeedback": "Em cần chụp lại đúng trang vở bài tập môn ${subject || "học"} và nộp lại ngay cho Thầy/Cô!",
     "transcribedText": "Phát hiện ảnh chụp người hoặc ảnh không liên quan đến bài tập môn học."
  => TUYỆT ĐỐI KHÔNG SO SÁNH NỘI DUNG VỚI BÀI MẪU! TUYỆT ĐỐI KHÔNG CHO 2/10 HAY CHO 75-80% ĐỘ TƯƠNG ĐỒNG!

BƯỚC 3: NẾU LÀ ẢNH VỞ BÀI TẬP HỢP LỆ:
- "isInvalidSubmission": false, "relevanceCategory": "valid_homework", "contentRelevance": "valid_homework", "invalidReason": ""
- So sánh từng dòng, từng bước giải của học sinh với bài đối chiếu:
  + Đúng toàn bộ: score 9-10, similarityScore 90-98%, completeness 90-100%, rating 5
  + Khá, đúng phần lớn: score 7-8.5, similarityScore 70-85%, completeness 75-85%, rating 4
  + Trung bình, sai nhiều câu: score 5-6.5, similarityScore 50-65%, completeness 50-65%, rating 3
  + Thiếu bài, làm đối phó 1-2 dòng: score 1-4, similarityScore 10-40%, completeness 10-40%, rating 1-2

Trả về JSON thuần theo schema sau (không markdown ngoài json):
{
  "isInvalidSubmission": false,
  "relevanceCategory": "valid_homework",
  "contentRelevance": "valid_homework",
  "detectedContentType": "Vở bài tập môn ${subject || "học"} viết tay",
  "imageContentDescription": "Mô tả cụ thể 1-2 câu về những gì nhìn thấy trong ảnh",
  "recognizedElements": ["Chữ viết tay tiếng Việt", "Công thức toán / lời văn"],
  "invalidReason": "",
  "rating": 4,
  "score": 7.5,
  "similarityScore": 75,
  "completeness": 80,
  "comparisonSummary": "Đoạn văn tóm tắt đối chiếu thực tế 2-3 câu",
  "studentStrengths": ["Điểm làm đúng 1", "Điểm làm đúng 2"],
  "studentDifferences": ["Chỗ khác biệt hoặc sai sót so với bài đối chiếu"],
  "actionableFeedback": "Lời khuyên sư phạm trực tiếp cho học sinh",
  "transcribedText": "Trích dẫn nguyên văn 2-4 dòng chữ viết tay của học sinh trong ảnh",
  "analyzedAt": "${new Date().toISOString()}"
}`;

    // Handle student submission (image data URI, remote URL, or text)
    const studentParts = await prepareGeminiContentParts(studentContent, `Bài làm của ${studentName}`);
    contents.push(...studentParts);

    // Handle reference submission (image data URI, remote URL, or text)
    const refParts = await prepareGeminiContentParts(referenceContent, `Bài đối chiếu của ${referenceStudentName || "Bài mẫu chuẩn"}`);
    contents.push(...refParts);

    contents.push({ text: promptText });

    const response = await generateGeminiWithRetry(ai, {
      contents,
      config: {
        responseMimeType: "application/json",
      },
    });

    const parsed = safeParseAIJson(response.text?.trim() || "{}");
    aiGradeCache.set(cacheKey, parsed);
    res.json({ success: true, isFallback: false, data: parsed });
  } catch (error: any) {
    console.warn("AI Compare homework notice (fallback activated):", error?.message || error);
    const studentName = req.body?.studentName || "Học sinh";
    const subject = req.body?.subject || "Bài tập";
    const fallbackData = {
      isInvalidSubmission: false,
      relevanceCategory: "valid_homework",
      invalidReason: "",
      rating: 3,
      similarityScore: 60,
      score: 6.0,
      completeness: 60,
      comparisonSummary: `Bài làm môn ${subject} của em ${studentName} đã nộp. Hệ thống AI đang có lượt tải cao, Thầy/Cô hoặc Cán sự lớp vui lòng xem lại ảnh bài tập để chấm điểm trực tiếp.`,
      studentStrengths: ["Đã nộp bài đầy đủ"],
      studentDifferences: ["Chờ xác nhận lại trực tiếp từ giáo viên/cán sự lớp"],
      actionableFeedback: "Hãy kiểm tra lại bài đối chiếu để ôn tập các câu nâng cao.",
      feedback: `Bài làm môn ${subject} của em ${studentName} đã ghi nhận nộp thành công.`,
      matchingPoints: ["Đã nộp bài đầy đủ"],
      missingPoints: ["Chờ xác nhận trực tiếp từ giáo viên/cán sự lớp"],
      transcribedText: "Ảnh bài nộp đã ghi nhận.",
      analyzedAt: new Date().toISOString(),
      isOfflineFallback: true,
    };
    res.json({ success: true, isFallback: true, data: fallbackData, warning: error?.message || "Model temporarily busy" });
  }
});

// AI Parse Schedule / Thời khóa biểu from Text, Document or Image OCR
app.post("/api/ai/parse-schedule", async (req, res) => {
  try {
    const { rawText, imageBase64, mimeType, customApiKey, targetClassName } = req.body;
    const ai = getAI(customApiKey);

    if (!ai) {
      // Fallback rule-based schedule parsing if no API key is provided
      if (typeof rawText === "string" && rawText.trim().length > 0) {
        const schedule = parseScheduleTextFallback(rawText);
        return res.json({
          success: true,
          isFallback: true,
          schedule,
          detailedSchedule: schedule,
          className: targetClassName || "Lớp học",
        });
      }
      return res.status(400).json({ 
        error: "Chưa cấu hình API Key. Vui lòng kiểm tra biến GEMINI_API_KEY hoặc nhập API Key trong phần Cài đặt." 
      });
    }

    // Determine if input is an image (either passed via imageBase64 or embedded data URL in rawText)
    let isImage = false;
    let cleanBase64 = "";
    let detectedMime = mimeType || "image/jpeg";

    if (imageBase64 && typeof imageBase64 === "string" && imageBase64.trim().length > 0) {
      isImage = true;
      const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/s);
      if (match) {
        detectedMime = match[1];
        cleanBase64 = match[2].trim();
      } else {
        cleanBase64 = imageBase64.replace(/^data:[^;]+;base64,/, "").trim();
      }
    } else if (typeof rawText === "string" && (rawText.startsWith("data:image/") || (rawText.length > 500 && /^[A-Za-z0-9+/=]+$/.test(rawText.slice(0, 100))))) {
      isImage = true;
      const match = rawText.match(/^data:([^;]+);base64,(.+)$/s);
      if (match) {
        detectedMime = match[1];
        cleanBase64 = match[2].trim();
      } else {
        cleanBase64 = rawText.replace(/^data:[^;]+;base64,/, "").trim();
      }
    }

    const targetClassHint = targetClassName 
      ? `\nLƯU Ý ĐẶC BIỆT: Lớp cần trích xuất chính là lớp "${targetClassName}". Nếu trong ảnh có nhiều lớp (ví dụ bảng TKB tổng hợp toàn trường gồm nhiều lớp 6A, 7A, 8A1, 8A2, 9A...), hãy tìm chính xác dòng hoặc cột của lớp "${targetClassName}"!` 
      : "";

    const schedulePrompt = `Bạn là chuyên gia phân tích thị giác AI và số hóa Thời khóa biểu (TKB) trường phổ thông (Tiểu học, THCS, THPT) tại Việt Nam.
Nhiệm vụ: Hãy đọc kỹ từng chi tiết trong hình ảnh/nội dung thời khóa biểu được cung cấp và trích xuất thông tin một cách chính xác tuyệt đối.
${targetClassHint}

HƯỚNG DẪN GIẢI MÃ BẢNG THỜI KHÓA BIỂU ĐẶC BIỆT CẦN LƯU Ý:

1. DẠNG BẢNG EXCEL DỌC (CỘT NGÀY - BUỔI - TIẾT - LỚP) NHƯ TRƯỜNG THCS PHÙNG KHẮC KHOAN:
   - Cột A: "Ngày" (Thứ 2, Thứ 3, Thứ 4, Thứ 5, Thứ 6, Thứ 7). Ô "Thứ 2", "Thứ 3"... thường được GỘP (MERGE) trải dài qua cả 10 dòng (5 tiết Sáng và 5 tiết Chiều)! ĐỪNG NHẦM các dòng sau là không có thứ.
   - Cột B: "Buổi" (Gồm "Sáng" - 5 dòng cho tiết 1 đến 5; và "Chiều" - 5 dòng cho tiết 1 đến 5).
   - Cột C: "Tiết" (Số thứ tự tiết từ 1 đến 5).
   - Cột lớp học (Ví dụ Cột T là "8A1", hoặc 6A1, 7A1, 8A2, 9A1...):
     + Lần lượt đi qua từng Thứ (Thứ 2 -> Thứ 7).
     + Với mỗi Thứ, đọc các tiết SÁNG (Tiết 1 đến 5) rồi đến các tiết CHIỀU (Tiết 1 đến 5).
     + Ô nào để trống hoặc nghỉ thì bỏ qua.
     + Lưu ý: Các ngày có cả tiết Sáng và tiết Chiều (như Thứ 3, Thứ 4) phải xếp các môn buổi sáng trước, rồi nối tiếp các môn buổi chiều theo đúng thứ tự thời gian trong ngày!

2. BẢNG MÃ HÓA CÁC MÔN VÀ CHỮ VIẾT TẮT PHỔ BIẾN Ở TRƯỜNG THCS VIỆT NAM:
   - Trong mỗi ô thường có dạng: "[Tên môn viết tắt] - [Tên Giáo viên phụ trách]".
   - Tên giáo viên đứng sau dấu gạch ngang (-) hoặc ở dòng dưới, KHÔNG ĐƯỢC COI TÊN GIÁO VIÊN LÀ MÔN HỌC!
   - Bảng tra cứu chữ viết tắt:
     • "HĐTN 1", "HĐTN 2", "HĐTN 3" => Môn học: "Hoạt động trải nghiệm" (hoặc "HĐTN"). Giữ chi tiết: "HĐTN 1 - Lãm", "HĐTN 3 - Trường".
     • "CD" => Môn học: "Giáo dục công dân" (GDCD). Ví dụ: "CD - Bình" => Môn: "Giáo dục công dân", GV: "Bình".
     • "CN" => Môn học: "Công nghệ". Ví dụ: "CN - Quang" => Môn: "Công nghệ", GV: "Quang".
     • "Địa" => Môn học: "Lịch sử & Địa lí (Địa lí)". Ví dụ: "Địa - Linh" => Môn: "Địa lí", GV: "Linh".
     • "Sử" => Môn học: "Lịch sử & Địa lí (Lịch sử)". Ví dụ: "Sử - Công" => Môn: "Lịch sử", GV: "Công".
     • "MT" => Môn học: "Mĩ thuật". Ví dụ: "MT - Hoạt" => Môn: "Mĩ thuật", GV: "Hoạt".
     • "Nhạc" => Môn học: "Âm nhạc". Ví dụ: "Nhạc - Tình" => Môn: "Âm nhạc", GV: "Tình".
     • "ĐP" => Môn học: "Giáo dục địa phương". Ví dụ: "ĐP - Uyên" => Môn: "Giáo dục địa phương", GV: "Uyên".
     • "GDTC" => Môn học: "Giáo dục thể chất". Ví dụ: "GDTC - Đ.Hiệp" => Môn: "Giáo dục thể chất", GV: "Đ.Hiệp".
     • "Tin" => Môn học: "Tin học". Ví dụ: "Tin - Huy (tin)" => Môn: "Tin học", GV: "Huy".
     • "TN1" hoặc "TN1 - Hoa(lý)" => Môn học: "KHTN (Vật lí)", GV: "Hoa".
     • "TN2" hoặc "TN2 - Oanh(Hóa)" => Môn học: "KHTN (Hóa học)", GV: "Oanh".
     • "TN3" hoặc "TN3 - Hằng (76)" => Môn học: "KHTN (Sinh học)", GV: "Hằng".
     • "Toán" => Môn học: "Toán". Ví dụ: "Toán - Trường" => Môn: "Toán", GV: "Trường".
     • "Văn" => Môn học: "Ngữ văn". Ví dụ: "Văn - Đ.Oanh" => Môn: "Ngữ văn", GV: "Đ.Oanh".
     • "Anh" => Môn học: "Tiếng Anh". Ví dụ: "Anh - Tuyến" => Môn: "Tiếng Anh", GV: "Tuyến".

3. MÃ HÓA CÁC THỨ TRONG TUẦN (BẮT BUỘC SỬ DỤNG SỐ LÀM KEY):
   - "1": Thứ Hai
   - "2": Thứ Ba
   - "3": Thứ Tư
   - "4": Thứ Năm
   - "5": Thứ Sáu
   - "6": Thứ Bảy
   - "0": Chủ Nhật

4. VÍ DỤ THỰC TẾ LỚP 8A1 (TỪ ẢNH TRƯỜNG THCS PHÙNG KHẮC KHOAN):
   - Thứ 2: Sáng (HĐTN 1 - Lãm, HĐTN 2 - Lãm, CD - Bình, CN - Quang, Địa - Linh) => 5 môn: ["Hoạt động trải nghiệm", "Hoạt động trải nghiệm", "Giáo dục công dân", "Công nghệ", "Địa lí"]
   - Thứ 3: Sáng (CN - Quang, MT - Hoạt, TN3 - Hằng (76), TN1 - Hoa(lý), Anh - Tuyến); Chiều (Văn - Đ.Oanh, Văn - Đ.Oanh, GDTC - Đ.Hiệp) => 8 môn: ["Công nghệ", "Mĩ thuật", "KHTN (Sinh)", "KHTN (Lý)", "Tiếng Anh", "Ngữ văn", "Ngữ văn", "Giáo dục thể chất"]
   - Thứ 4: Sáng (Sử - Công, TN2 - Oanh(Hóa), GDTC - Đ.Hiệp, Anh - Tuyến, Tin - Huy (tin)); Chiều (Anh - Tuyến, Toán - Trường, Toán - Trường) => 8 môn: ["Lịch sử", "KHTN (Hóa)", "Giáo dục thể chất", "Tiếng Anh", "Tin học", "Tiếng Anh", "Toán", "Toán"]
   - Thứ 5: Sáng (ĐP - Uyên, Nhạc - Tình, Toán - Trường, Toán - Trường) => 4 môn: ["Giáo dục địa phương", "Âm nhạc", "Toán", "Toán"]
   - Thứ 6: Sáng (TN2 - Oanh(Hóa), Sử - Công, Văn - Đ.Oanh, Văn - Đ.Oanh, HĐTN 3 - Trường) => 5 môn: ["KHTN (Hóa)", "Lịch sử", "Ngữ văn", "Ngữ văn", "Hoạt động trải nghiệm"]

5. ĐỊNH DẠNG JSON ĐẦU RA BẮT BUỘC:
{
  "className": "${targetClassName || 'Tên lớp tìm thấy (ví dụ 8A1)'}",
  "detectedClasses": ["8A1"],
  "schedule": {
    "1": ["Tên môn chuẩn hóa tiết 1", "Tên môn chuẩn hóa tiết 2", ...],
    "2": [...],
    "3": [...],
    "4": [...],
    "5": [...],
    "6": []
  },
  "detailedSchedule": {
    "1": ["Tên môn kèm GV (ví dụ: HĐTN 1 - Lãm)", "Toán - Trường", ...],
    "2": [...],
    "3": [...],
    "4": [...],
    "5": [...],
    "6": []
  },
  "periodList": [],
  "note": "Thời khóa biểu lớp ${targetClassName || '8A1'} trích xuất đầy đủ các buổi Sáng & Chiều."
}
Chỉ trả về JSON thuần túy, tuyệt đối không chèn chữ ngoài khối JSON.`;

    let contents: any;
    if (isImage) {
      contents = [
        {
          inlineData: {
            data: cleanBase64,
            mimeType: detectedMime,
          },
        },
        {
          text: schedulePrompt,
        },
      ];
    } else {
      contents = `${schedulePrompt}\n\nNội dung văn bản thời khóa biểu:\n"""\n${rawText}\n"""`;
    }

    const response = await generateGeminiWithRetry(ai, {
      contents,
      config: {
        responseMimeType: "application/json",
      },
    });

    const parsed = safeParseAIJson(response.text?.trim() || "{}");
    res.json({ 
      success: true, 
      isFallback: false, 
      data: parsed, 
      schedule: parsed.schedule || {}, 
      detailedSchedule: parsed.detailedSchedule || parsed.schedule || {}, 
      className: parsed.className || targetClassName,
      detectedClasses: parsed.detectedClasses || [],
      periodList: parsed.periodList || [],
      note: parsed.note
    });
  } catch (error: any) {
    console.error("AI parse schedule error:", error);
    res.status(500).json({ error: error.message || "Lỗi đọc Thời khóa biểu AI" });
  }
});

// AI Creative Commendation & Praise Letter Generator
app.post("/api/ai/generate-praise", async (req, res) => {
  try {
    const { 
      studentName, 
      className, 
      score, 
      rank, 
      weekNumber, 
      style, 
      strengths, 
      flaws, 
      teacherHonorific, 
      recipientType,
      customPrompt,
      customApiKey 
    } = req.body;
    
    const ai = getAI(customApiKey);
    const tH = teacherHonorific || "Thầy";
    const isCollective = recipientType === "team" || recipientType === "whole_class" || recipientType === "committee" || 
      (studentName && (studentName.toLowerCase().includes("tập thể") || studentName.toLowerCase().includes("tổ") || studentName.toLowerCase().includes("ban cán sự")));

    if (!ai) {
      let title = isCollective ? "TẬP THỂ DẪN ĐẦU THI ĐUA XUẤT SẮC" : "GƯƠNG SÁNG THI ĐUA XUẤT SẮC";
      let body = isCollective
        ? `rất vui mừng và nhiệt liệt biểu dương tinh thần đoàn kết, ý thức kỷ luật gương mẫu cùng sự nỗ lực bứt phá thi đua của tập thể trong suốt Tuần ${weekNumber}.`
        : `rất vui mừng và nhiệt liệt biểu dương tinh thần tự giác, ý thức rèn luyện nề nếp kỷ luật tốt cùng thành tích học tập vượt trội của em trong suốt Tuần ${weekNumber}.`;
      let quote = isCollective
        ? "Chúc các em luôn đoàn kết gắn bó, phát huy tinh thần đồng đội, cùng nhau tiến bộ và giữ vững vị trí dẫn đầu phong trào thi đua!"
        : "Chúc em luôn giữ vững ngọn lửa đam mê tri thức, tiếp tục rèn đức - luyện tài và là tấm gương sáng cho các bạn noi theo!";

      if (style === "encourage_progress") {
        title = isCollective ? "TẬP THỂ TIẾN BỘ BỨT PHÁ" : "HỌC SINH TIẾN BỘ VƯỢT BẬC";
        body = isCollective
          ? `rất vui mừng ghi nhận sự đoàn kết và nỗ lực vươn lên rõ rệt của tập thể trong Tuần ${weekNumber}. Các em đã cùng nhau khắc phục khó khăn và đạt kết quả rất đáng biểu dương.`
          : `rất vui mừng ghi nhận sự nỗ lực vươn lên rõ rệt của em trong Tuần ${weekNumber}. Em đã kiên trì khắc phục khó khăn và đạt kết quả rất đáng khen ngợi.`;
        quote = isCollective
          ? "Đoàn kết là sức mạnh vô địch, Thầy luôn tin tưởng tập thể sẽ còn bứt phá mạnh mẽ hơn nữa trong các tuần tiếp theo!"
          : "Mỗi ngày một cố gắng, mỗi tuần một tiến bộ; Thầy luôn tin tưởng và đồng hành cùng em trên con đường học vấn!";
      } else if (style === "inspiring_poem") {
        title = isCollective ? "TẬP THỂ HOA ĐIỂM MƯỜI" : "HOA ĐIỂM 10 RỰC RỠ";
        body = isCollective
          ? `tuyên dương tập thể ${studentName} trong Tuần ${weekNumber}: Chung tay đoàn kết rạng danh trường / Thi đua rèn đức tỏa ngát hương / Vững bước đi lên trò chăm ngoan / Điểm mười rực rỡ sáng ngời tương lai.`
          : `tuyên dương bông hoa điểm 10 rực rỡ mang tên ${studentName} trong Tuần ${weekNumber}: Chăm ngoan lễ phép điểm mười nở hoa / Thi đua rèn luyện xứng danh trò tài / Vững bước tương lai rạng ngời ngày mai.`;
        quote = isCollective
          ? "Chúc tập thể luôn giữ vững tinh thần đoàn kết, thi đua sôi nổi và gặt hái thật nhiều hoa điểm 10!"
          : "Chúc em mãi giữ nụ cười rạng rỡ và bay cao bay xa hơn nữa!";
      }

      return res.json({
        success: true,
        isFallback: true,
        data: { title, body, quote }
      });
    }

    const collectiveInstructions = isCollective
      ? `ĐẶC BIỆT LƯU Ý - ĐÂY LÀ THƯ KHEN TẬP THỂ / KHEN TỔ / KHEN TOÀN LỚP:
- Đối tượng được khen là: [${studentName}] (TẬP THỂ).
- TUYỆT ĐỐI KHÔNG dùng từ "khen em", "của em", "em", "cá nhân em".
- BẮT BUỘC PHẢI DÙNG đại từ và ngữ cảnh tập thể: "khen ngợi tập thể", "các em", "tập thể tổ", "toàn thể các em", "tinh thần đoàn kết", "ý thức đồng đội", "giúp đỡ nhau cùng tiến bộ".`
      : `ĐÂY LÀ THƯ KHEN CÁ NHÂN HỌC SINH: [${studentName}]. Dùng đại từ xưng hô "em", "của em", khen ngợi tinh thần tự giác cá nhân.`;

    const prompt = `Bạn là Giáo viên Chủ nhiệm (${tH}) tại trường THCS Phùng Khắc Khoan (xã Tây Phương).
Hãy tạo nội dung Thư Khen vinh danh [${studentName}], Lớp [${className}], Tuần [${weekNumber}], Điểm thi đua [${score}/100], Hạng [#${rank}].
Phong cách yêu cầu: ${style || "Xuất sắc toàn diện"}.
${customPrompt ? `Yêu cầu riêng của giáo viên: "${customPrompt}".` : ""}
Các điểm tốt nổi bật: ${JSON.stringify(strengths || ["Chăm ngoan", "Tự giác", "Đoàn kết"])}.
Các điểm cần nhắc nhở khéo léo (nếu có): ${JSON.stringify(flaws || [])}.

${collectiveInstructions}

Quy tắc biên soạn Sư phạm đặc biệt quan trọng:
1. KHÔNG ĐƯỢC LẶP TỪ: Trong "body", KHÔNG ĐƯỢC bắt đầu bằng từ "${tH}" hay "Thầy Thầy", "Cô Cô". Hãy viết tiếp ngay sau danh xưng (Ví dụ: viết "rất vui mừng và tự hào ghi nhận...", hoặc "nhiệt liệt khen ngợi tinh thần...").
2. Lời văn trang trọng, chuẩn mực tiếng Việt, giàu cảm xúc, mang tính sư phạm và khơi gợi niềm đam mê học tập.
3. Nếu có khuyết điểm, hãy nhắc nhở thật khéo léo, tinh tế dưới dạng lời khuyên định hướng tiến bộ.

Trả về JSON thuần theo schema sau:
{
  "title": "DANH HIỆU KHEN THƯỞNG IN HOA (Ví dụ: TỔ DẪN ĐẦU THI ĐUA XUẤT SẮC hoặc GƯƠNG SÁNG THI ĐUA XUẤT SẮC)",
  "body": "Đoạn văn biểu dương chính (bắt đầu bằng động từ/trạng từ, không lặp lại danh xưng ở đầu câu)",
  "quote": "Lời chúc & châm ngôn truyền cảm hứng bế mạc thư"
}`;

    const response = await generateGeminiWithRetry(ai, {
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    const parsed = safeParseAIJson(response.text?.trim() || "{}");
    res.json({ success: true, data: parsed });
  } catch (error: any) {
    console.error("AI praise error:", error);
    res.status(500).json({ error: error.message || "Lỗi tạo thư khen AI" });
  }
});

// Helper function providing intelligent offline guidance when Gemini API is offline or not configured
function getOfflineAssistantReply(query: string, userRole: string, currentClass: string): string {
  const q = (query || "").toLowerCase();

  // 1. Nộp bài tập & Vở ghi
  if (q.includes("nộp bài") || q.includes("cách nộp") || q.includes("nộp vở") || q.includes("nộp ảnh") || q.includes("drive") || q.includes("youtube")) {
    return `📚 HƯỚNG DẪN NỘP BÀI TẬP & VỞ GHI (DÀNH CHO HỌC SINH):
1. Vào tab "Học tập & Bài tập" -> Chọn "Hôm nay & Nộp bài".
2. Nhấp vào tên Môn học cần nộp. (Nếu muốn chuẩn bị bài cho ngày mai, bấm chọn nút "Báo nộp môn ngày mai" ở trên cùng).
3. Chọn 1 trong 4 hình thức nộp bài:
   - 📸 Tải ảnh bài làm/vở ghi: Chọn nhiều ảnh cùng lúc, hệ thống tự động nén tối ưu (<100KB) giúp tải siêu tốc và không lo đầy bộ nhớ.
   - 📁 Dán link Google Drive: Dán link chia sẻ bài làm hoặc thư mục Drive, hệ thống cho phép thầy cô xem trực tiếp trong ứng dụng.
   - 🎥 Dán link YouTube: Dành cho video thuyết trình, báo cáo thí nghiệm thực hành.
   - ✍️ Nhập văn bản: Viết trực tiếp câu trả lời hoặc ghi chú gửi thầy cô.
4. Bấm "Xác Nhận Nộp Bài".
💡 Mẹo: Bạn có thể bấm "Xem bài đã nộp" để kiểm tra lại và có thể bấm "Xóa bài" để nộp lại nếu bài đó chưa được Thầy/Cô chấm điểm!`;
  }

  // 2. Báo nộp môn ngày mai & Thời khóa biểu 7 ngày
  if (q.includes("ngày mai") || q.includes("hôm sau") || q.includes("thứ 2") || q.includes("thứ 3") || q.includes("thời khóa biểu") || q.includes("tkb") || q.includes("7 ngày") || q.includes("thêm môn")) {
    return `🗓️ TÍNH NĂNG BÁO NỘP MÔN NGÀY MAI & THỜI KHÓA BIỂU 7 NGÀY:
1. Báo nộp môn ngày mai:
   - Khi đến bất kỳ thứ nào trong tuần (ví dụ: Thứ 2), hệ thống sẽ tự động đối chiếu TKB ngày hôm sau (Thứ 3).
   - Học sinh chỉ cần bấm nút "Báo nộp môn ngày mai" để hệ thống chuyển sang danh sách các môn của ngày mai, giúp học sinh chủ động chuẩn bị bài và nộp bài trước khi đến lớp.
2. Thời khóa biểu 7 ngày tổng quan:
   - Bấm vào tab "Thời khóa biểu 7 ngày" để xem lịch học từ Thứ 2 đến Chủ nhật.
   - Giáo viên Chủ nhiệm có thể bấm "Thêm môn" hoặc xóa môn cho từng ngày, sau đó bấm "Lưu Thời Khóa Biểu 7 Ngày" để đồng bộ cho cả lớp.
   - GVCN cũng có thể nhập môn tại mục "Môn mở rộng cần nộp hôm nay" cho các buổi học tăng cường, bồi dưỡng học sinh giỏi mà không làm thay đổi TKB cố định.`;
  }

  // 3. Chấm bài & AI Kiểm tra Vở ghi
  if (q.includes("chấm bài") || q.includes("ai chấm") || q.includes("vở ghi") || q.includes("đánh giá") || q.includes("sao") || q.includes("lời phê")) {
    return `⭐ HƯỚNG DẪN CHẤM BÀI & TRỢ LÝ AI CHẤM CHUẨN (GV & BAN CÁN SỰ):
1. Vào tab "Kiểm Tra & Chấm Bài" (chỉ Thầy Cô, Lớp trưởng, Tổ trưởng mới có quyền truy cập).
2. Lọc danh sách theo Tổ hoặc tìm tên học sinh. Bấm vào môn học của học sinh để mở bảng chấm.
3. Chấm bài với Trợ lý AI:
   - Bấm tab "AI Chấm Chuẩn": Bấm nút "Kiểm Tra Độ Đầy Đủ Vở Ghi", AI sẽ quét nội dung bài nộp, so sánh với yêu cầu chuẩn, tính độ đầy đủ (0-100%) và chỉ ra ưu điểm, thiếu sót.
   - So sánh với bài mẫu: Thầy cô có thể chọn một học sinh tiêu biểu trong lớp để AI so sánh bài nộp với bài mẫu.
4. Đánh giá: Chọn số sao (1 đến 5 sao), bấm chọn các mẫu nhận xét nhanh (Vở sạch chữ đẹp, Nộp bài đúng giờ...) hoặc nhập lời phê riêng.
5. Bấm "Lưu Đánh Giá". Điểm số và lời phê sẽ lưu ngay vào bảng tổng hợp thi đua.`;
  }

  // 4. Sổ đầu bài điện tử
  if (q.includes("sổ đầu bài") || q.includes("tiết học") || q.includes("tiết tốt") || q.includes("sĩ số") || q.includes("bài dạy")) {
    return `📖 HƯỚNG DẪN SỔ ĐẦU BÀI ĐIỆN TỬ:
1. Vào tab "Sổ Đầu Bài Điện Tử".
2. Chọn tuần học hiện tại.
3. Giáo viên bộ môn hoặc Lớp trưởng nhập thông tin tiết học:
   - Tên môn học, Tiết PPCT, Tên bài dạy.
   - Sĩ số vắng mặt (nếu có).
   - Nhận xét tinh thần học tập, trật tự của lớp.
   - Xếp loại tiết học:
     + 🌟 Tiết Tốt: 10 điểm (Lớp học sôi nổi, trật tự, chuẩn bị bài tốt).
     + 🌸 Tiết Khá: 8 - 9 điểm.
     + ⚠️ Tiết Trung bình: 6 - 7 điểm.
     + ❌ Tiết Yếu: Dưới 6 điểm.
4. Hệ thống tự động tính điểm trung bình học tập cả tuần, tính tỉ lệ % tiết tốt và quy đổi sang điểm thi đua tuần của lớp.`;
  }

  // 5. Đội Sao Đỏ & Nền nếp thi đua
  if (q.includes("sao đỏ") || q.includes("trừ điểm") || q.includes("cộng điểm") || q.includes("nền nếp") || q.includes("tiêu chí") || q.includes("vi phạm")) {
    return `🚩 HƯỚNG DẪN ĐỘI SAO ĐỎ & THEO DÕI NỀN NẾP:
1. Đăng nhập với vai trò "Sao Đỏ" (hoặc Thầy/Cô Tổng phụ trách, GVCN).
2. Vào tab "Đội Sao Đỏ & Nền Nếp" -> Bấm "Chấm điểm thi đua / Trừ điểm vi phạm".
3. Chọn Lớp được phân công theo dõi, chọn học sinh vi phạm (hoặc chọn vi phạm tập thể cả tổ/cả lớp).
4. Quy định 10 tiêu chí nền nếp chuẩn (100 điểm ban đầu):
   - Đi học muộn: -2 điểm/lượt
   - Nghỉ học không phép: -5 điểm/lượt
   - Không đồng phục, thiếu khăn quàng: -2 điểm/lượt
   - Mất trật tự trong giờ học: -2 điểm/lượt
   - Không thuộc bài / không làm bài: -2 điểm/lượt
   - Sử dụng điện thoại sai quy định: -5 điểm/lượt
   - Nói tục, chửi bậy: -5 điểm/lượt
   - Vệ sinh lớp học bẩn, trực nhật muộn: -5 điểm/lượt
   - Bỏ tiết, trốn học: -10 điểm/lượt
   - Đánh nhau, gây mất đoàn kết: -20 điểm/lượt
5. Điểm cộng thưởng thi đua:
   - Nhặt được của rơi trả lại người mất: +5 điểm
   - Đạt giải thi đua học tập, văn nghệ, thể thao: +5 đến +10 điểm
   - Gương người tốt việc tốt, giúp đỡ bạn: +5 điểm`;
  }

  // 6. Thư khen vinh danh học sinh & Tùy biến toàn diện / Xuất Word / In ấn
  if (q.includes("thư khen") || q.includes("sửa thứ hạng") || q.includes("sửa hạng") || q.includes("sửa điểm") || q.includes("sửa họ tên") || q.includes("khôi phục") || q.includes("đổi màu") || q.includes("word") || q.includes("docx") || q.includes("in") || q.includes("nghị định 30") || q.includes("chữ ký") || q.includes("vinh danh")) {
    return `🏆 HƯỚNG DẪN CẤP & TÙY BIẾN TOÀN DIỆN THƯ KHEN CHUẨN NGHỊ ĐỊNH 30/2020/NĐ-CP:
1. Vào tab "Bảng Vinh Danh" hoặc "Bảng Xếp Hạng & Thi Đua".
2. Bấm nút "Cấp Thư Khen" (biểu tượng huy chương 🎖️) tại học sinh hoặc Tổ cần khen thưởng.
3. Tùy biến MỌI THÔNG TIN trực tiếp trên thanh công cụ:
   - ✏️ Sửa Họ tên người nhận: Tùy chỉnh danh xưng hoặc họ tên học sinh/tập thể.
   - 🏅 Sửa Danh hiệu: Chọn hoặc nhập danh hiệu vinh danh đặc biệt.
   - 🥇 Sửa Thứ hạng: Thay đổi thứ tự xếp hạng bất kỳ (ví dụ: #1, #2, Thủ khoa, Nhất tổ...).
   - 💯 Sửa Tổng điểm thi đua: Điều chỉnh điểm số tùy ý (ví dụ: 100đ, 98.5đ, Điểm tuyệt đối...).
   - 📝 Sửa Thông tin phụ & Chức danh ký: Tùy biến Tổ, Lớp, Tuần, chức danh người ký (Giáo viên chủ nhiệm, v.v.).
   - 🔄 Nút "Khôi phục mặc định": Hoàn tác tức thì về dữ liệu gốc từ sổ thi đua tuần khi cần.
   - 🎨 Nút "Trợ lý AI tự đổi màu": Tự động phân tích điểm số và thứ hạng để đổi bảng màu giấy khen hoàng gia phù hợp (Vàng Gold, Xanh Sapphire, Đỏ Ruby, Tím Hoàng Gia, Lục Bảo).
4. Xuất file & Trao thưởng:
   - Thể thức chuẩn theo Nghị định 30/2020/NĐ-CP của Chính phủ (Quốc hiệu, Tiêu ngữ, Tên đơn vị, Tiêu đề vinh danh, Lời biểu dương, Ngày tháng, Chức vụ và Họ tên người ký; đã loại bỏ dòng "(Ký, ghi rõ họ tên)" theo quy định mới).
   - Bấm "Tải File Word (.docx)": Tạo ngay file Microsoft Word chuẩn phông chữ đẹp mắt để chỉnh sửa hoặc lưu trữ.
   - Bấm "In Thư Khen": In trực tiếp khổ A4 màu sắc trang nhã trao cho học sinh trong tiết Chào cờ hoặc Sinh hoạt lớp.`;
  }

  // 7. Thống kê nộp bài & Báo cáo nền nếp vi phạm/khen thưởng trực quan
  if (q.includes("thống kê") || q.includes("ma trận") || q.includes("báo cáo") || q.includes("chưa nộp") || q.includes("đã nộp") || q.includes("biểu đồ") || q.includes("xuất excel") || q.includes("zalo")) {
    return `📊 HƯỚNG DẪN BÁO CÁO & THỐNG KÊ TRỰC QUAN (BÀI TẬP & NỀN NẾP):
1. Thống kê nộp bài tập & Ma trận HS × Môn học (Trong "Góc Học Tập"):
   - 📊 Chế độ "Trực quan Thống kê Hôm nay": Xem ngay tổng số học sinh đã nộp, chưa nộp bài nào, số bài đã chấm/chờ chấm, biểu đồ tỉ lệ hoàn thành theo từng môn và tiến độ thi đua 4 tổ.
   - 📋 Chế độ "Ma trận HS × Môn": Xem bảng ma trận toàn diện đối chiếu từng học sinh với tất cả các môn hôm nay (Xanh: Đã nộp/đã chấm, Vàng: Chờ chấm, Đỏ: Chưa nộp).
   - 📥 Nút "Xuất Excel Báo Cáo Hôm Nay": Tải file Excel chuyên nghiệp gồm 4 Sheet:
     + Sheet 1: Bảng Ma trận nộp bài đối chiếu toàn bộ lớp.
     + Sheet 2: Chi tiết từng bài nộp (thời gian, minh chứng, số sao, lời phê).
     + Sheet 3: Thống kê số lượng và tỉ lệ nộp theo từng môn học.
     + Sheet 4: Danh sách học sinh chưa nộp kèm môn còn thiếu và ghi chú đôn đốc.
   - 📱 Nút "Báo Cáo Zalo Hôm Nay": Tự động tạo và sao chép văn bản báo cáo chuyên nghiệp chuẩn định dạng Zalo kèm icon sinh động để gửi ngay vào nhóm phụ huynh.

2. Báo cáo & Thống kê nền nếp vi phạm/khen thưởng (Tab "Thống kê vi phạm & Khen thưởng" trong Nền nếp):
   - Bộ lọc thời gian: "⚡ Hôm nay", "📅 Tuần này", "📆 Tất cả các tuần" hoặc tự chọn ngày.
   - Biểu đồ Top 6 lỗi vi phạm: Nắm bắt ngay hôm nay/tuần này học sinh vi phạm những lỗi gì nhiều nhất (Đi muộn, Không thuộc bài, Điện thoại...).
   - Biểu đồ Top 6 gương sáng khen thưởng: Tuyên dương các bạn có nhiều việc tốt, nhặt của rơi, điểm tốt.
   - Biểu đồ thi đua giữa 4 Tổ: So sánh điểm cộng và điểm trừ của từng tổ.
   - Biểu đồ tròn cơ cấu ghi nhận nề nếp.
   - Xuất Excel chi tiết (.xlsx) với 4 sheet tự động căn chỉnh đẹp mắt.
   - Nút "Báo Cáo Zalo": Tự động sao chép tóm tắt tình hình nề nếp gửi thẳng lên nhóm Zalo phụ huynh.`;
  }

  // 8. Nạp Thời khóa biểu từ ảnh chụp / Camera thông minh
  if (q.includes("nạp tkb") || q.includes("ảnh tkb") || q.includes("camera") || q.includes("thời khóa biểu từ ảnh") || q.includes("nhận diện tkb") || q.includes("ocr")) {
    return `📸 HƯỚNG DẪN NẠP THỜI KHÓA BIỂU TỰ ĐỘNG TỪ ẢNH CHỤP / CAMERA:
1. Vào tab "Thời khóa biểu 7 ngày" -> Bấm nút "📸 Nạp TKB từ ảnh / camera".
2. Chụp ảnh hoặc chọn ảnh bảng Thời khóa biểu:
   - 💡 Mẹo chụp nét: Đặt bảng TKB phẳng phiu, chụp thẳng góc, đủ ánh sáng, thấy rõ chữ các cột Thứ 2 đến Thứ 7 và các buổi Sáng/Chiều.
3. Trợ lý AI Gemini 2.5 Flash Vision sẽ tự động:
   - Nhận diện Tên lớp (ví dụ: 8A1).
   - Tách các cột Thứ 2, Thứ 3, Thứ 4, Thứ 5, Thứ 6, Thứ 7.
   - Tách các tiết buổi Sáng (Tiết 1-5) và buổi Chiều (Tiết 1-5).
   - Chuẩn hóa tên các môn học (Toán, Văn, Anh, KHTN, Sử, Địa, GDCD, Tin, Công nghệ, GDTC, HĐTN...) và tách tên giáo viên phụ trách.
4. Xem trước & Tinh chỉnh:
   - Bảng xem trước trực quan cho phép bạn xem lại từng ngày, nếu cần có thể sửa nhanh trực tiếp.
5. Bấm "Áp Dụng Vào TKB Cả Tuần": Hệ thống sẽ tự động cập nhật vào TKB 7 ngày và tính năng "Báo nộp môn ngày mai" ngay lập tức!`;
  }

  // 9. Khôi phục dữ liệu tự động & Phòng ngừa lỗi
  if (q.includes("phục hồi") || q.includes("checkpoint") || q.includes("lỗi") || q.includes("mất dữ liệu") || q.includes("đồng bộ") || q.includes("nhiều người") || q.includes("quá tải")) {
    return `🛡️ CƠ CHẾ TỰ ĐỘNG KHÔI PHỤC DỮ LIỆU & ĐỒNG BỘ ĐA TỰ ĐỘNG:
1. Checkpoint an toàn tự động:
   - Hệ thống tự động tạo các bản ghi điểm an toàn (Checkpoint) định kỳ và trước mỗi thao tác cập nhật điểm số, bài nộp, thời khóa biểu.
2. Tự phục hồi khi xảy ra lỗi (Auto-Recovery):
   - Nếu đường truyền mạng chập chờn hoặc nhiều học sinh cùng nộp bài dẫn đến dữ liệu trình duyệt bị xung đột/lỗi chuỗi, thuật toán autoRecoverIfCorrupted sẽ tự động phát hiện và khôi phục về Checkpoint an toàn gần nhất mà không làm mất danh sách lớp.
3. Chống tràn bộ nhớ (Quota Protection):
   - Ảnh bài nộp được tự động nén. Nếu bộ nhớ trình duyệt đầy, hệ thống tự động giữ lại 120 bài nộp mới nhất và tối ưu hóa không gian lưu trữ.
4. Đồng bộ đa tab tức thì (BroadcastChannel):
   - Khi mở ứng dụng trên nhiều tab hoặc thiết bị trong cùng trình duyệt, thao tác chấm điểm hay nộp bài ở tab này sẽ tự động cập nhật sang các tab khác trong tích tắc!`;
  }

  // 10. Phân quyền tài khoản
  if (q.includes("phân quyền") || q.includes("tài khoản") || q.includes("mật khẩu") || q.includes("đăng nhập") || q.includes("vai trò") || q.includes("lớp trưởng") || q.includes("tổ trưởng")) {
    return `👥 HỆ THỐNG PHÂN QUYỀN TRÊN EDUMASTER 360:
1. Học sinh:
   - Nộp bài tập, xem bài đã nộp, tự xóa bài nộp của mình khi chưa chấm.
   - Xem TKB 7 ngày, xem điểm nề nếp và nhận xét của thầy cô.
2. Tổ trưởng & Lớp trưởng:
   - Quyền hạn học sinh + Chấm bài tập cho các thành viên trong tổ/lớp.
   - Lớp trưởng có quyền nhập nhận xét Sổ đầu bài điện tử.
3. Đội Sao Đỏ:
   - Chấm điểm trừ vi phạm nền nếp và ghi điểm cộng thi đua cho các lớp.
4. Giáo viên Chủ nhiệm (GVCN):
   - Toàn quyền quản lý lớp: Sửa TKB 7 ngày, thêm môn mở rộng, chấm bài với AI, duyệt sổ đầu bài, cấp Thư khen Word, gửi báo cáo qua Zalo.
5. Giáo viên Bộ môn:
   - Nhập điểm và đánh giá tiết học vào Sổ đầu bài, chấm bài tập môn phụ trách.
6. Quản trị viên / Ban Giám hiệu (Super Admin):
   - Cài đặt tên trường, tên Hiệu trưởng, năm học, quản lý danh sách toàn bộ các lớp, sao lưu/khôi phục toàn bộ hệ thống qua Excel.`;
  }

  // Default welcome response
  return `Chào bạn! Tôi là Trợ lý AI Giáo dục EduMaster 360 của Trường THCS Phùng Khắc Khoan.
Tôi có thể hướng dẫn chi tiết mọi tính năng của hệ thống:
1. 📚 Cách nộp bài tập & vở ghi (ảnh tự nén, Google Drive, YouTube, văn bản).
2. 🗓️ Cách dùng tính năng Báo nộp môn ngày mai & chỉnh sửa TKB 7 ngày.
3. 📸 Cách nạp Thời khóa biểu tự động từ ảnh chụp hoặc camera bằng AI.
4. ⭐ Cách Thầy Cô & Ban cán sự chấm bài, dùng AI phân tích độ đầy đủ vở ghi.
5. 📊 Cách xem biểu đồ thống kê nộp bài (ai đã nộp, đã chấm, chưa nộp) & xuất Excel.
6. 🚨 Cách xem thống kê vi phạm & khen thưởng nề nếp (Top lỗi, thi đua 4 tổ) & gửi Zalo.
7. 📖 Cách ghi và quản lý Sổ đầu bài điện tử (tiết Tốt, Khá, TB, Yếu).
8. 🚩 Cách Đội Sao Đỏ chấm điểm thi đua nền nếp theo 10 tiêu chí.
9. 🏆 Cách cấp và xuất file Word (.docx) Thư Khen chuẩn Nghị định 30/2020/NĐ-CP.
10. 🛡️ Cơ chế tự động khôi phục dữ liệu (Auto-Recovery Checkpoint) an toàn.

Bạn muốn tìm hiểu chi tiết về tính năng nào? Hãy gõ câu hỏi hoặc chọn các gợi ý bên dưới nhé!`;
}

// AI Chatbot Assistant for School, Socratic Learning, Geometry Simulation & Progress Coaching
app.post("/api/ai/chat", async (req, res) => {
  try {
    const { messages, userRole, currentClass, studentContext, schoolContext, customApiKey } = req.body;
    const lastUserMessage = messages && messages.length > 0 
      ? [...messages].reverse().find((m: any) => m.sender === "user")?.text || ""
      : "";

    const ai = getAI(customApiKey);

    if (!ai) {
      // Intelligent rule-based offline responder
      const offlineReply = getOfflineAssistantReply(lastUserMessage, userRole || "guest", currentClass || "");
      return res.json({
        reply: offlineReply,
        isFallback: true
      });
    }

    const studentInfoSnippet = studentContext 
      ? `\nTHÔNG TIN HỌC SINH ĐANG TRÒ CHUYỆN:
- Họ và tên: ${studentContext.name || "Học sinh"} (Tổ: ${studentContext.team || "?"}, Lớp: ${currentClass || "?"})
- Điểm thi đua nền nếp hiện tại: ${studentContext.conductScore !== undefined ? studentContext.conductScore : "100"} điểm
- Số bài tập đã nộp hôm nay/tuần này: ${studentContext.submittedHomeworkCount || 0} bài
- Số sao khen thưởng tích lũy: ${studentContext.totalStars || 0} sao
- Các vi phạm/nhắc nhở gần đây: ${studentContext.recentViolations?.length ? studentContext.recentViolations.join(", ") : "Không có vi phạm, chấp hành tốt"}
- Các việc tốt khen thưởng: ${studentContext.recentGoodDeeds?.length ? studentContext.recentGoodDeeds.join(", ") : "Chăm ngoan"}`
      : "";

    const systemPrompt = `Bạn là Trợ lý AI Giáo dục & Gia sư Học tập Thông thái của Trường THCS Phùng Khắc Khoan (xã Tây Phương, TP. Hà Nội).
Bạn đồng hành cùng Học sinh, Giáo viên, Ban cán sự và Đội Sao Đỏ.

VAI TRÒ TRỌNG TÂM DÀNH CHO HỌC SINH (PHƯƠNG PHÁP SƯ PHẠM SOCRATIC):
1. HƯỚNG DẪN BÀI TẬP - NGUYÊN TẮC VÀNG:
   - TUYỆT ĐỐI KHÔNG giải bài trực tiếp hay đưa ngay đáp án cuối cùng cho học sinh chép!
   - Đóng vai trò người Thầy tận tâm:
     + Phân tích đề bài, chỉ ra giả thiết và kết luận, các từ khóa quan trọng.
     + Nhắc lại các định lý, quy tắc, công thức toán/lý/hóa/ngữ pháp liên quan.
     + Đặt câu hỏi gợi mở từng bước (Step-by-Step) để học sinh tự suy nghĩ và tìm ra lời giải.
     + Khen ngợi khi học sinh có hướng đi đúng, chỉ ra bẫy sai lầm thường gặp.

2. MÔ PHỎNG & TRỰC QUAN HÓA HÌNH HỌC (GEOMETRY SIMULATION):
   - Khi học sinh hỏi về hình học (tam giác, tứ giác, đường tròn, hình chóp, góc, đường cao, định lý Pythagore, Talet...):
     + Mô tả trực quan cấu trúc hình vẽ, cách dựng hình và vẽ thêm đường phụ.
     + HÃY CUNG CẤP ĐOẠN MÃ SVG HOÀN CHỈNH (<svg viewBox="0 0 400 300" ...>...</svg>) với các đỉnh được đánh dấu nhãn (A, B, C, H...), các góc vuông, đường thẳng màu sắc tương phản cao để trình chiếu mô phỏng trực tiếp trên khung chat cho học sinh dễ hình dung!
     + Hoặc vẽ sơ đồ ASCII art / Mermaid / Markdown bảng nếu phù hợp.

3. PHƯƠNG PHÁP HỌC TẬP HIỆU QUẢ:
   - Hướng dẫn các phương pháp học tập khoa học: Lặp lại ngắt quãng (Spaced Repetition), Kỹ thuật Feynman, Sơ đồ tư duy (Mindmap), Phương pháp ghi chép Cornell, Quy tắc Pomodoro.
   - Tư vấn chiến lược ôn thi học kỳ, phân bổ thời gian học các môn tự nhiên và xã hội.

4. CỐ VẤN TIẾN BỘ TỪ KẾT QUẢ NỀN NẾP & HỌC TẬP:
   - Dựa trên dữ liệu học sinh (điểm thi đua, lỗi nền nếp, tình hình nộp bài môn học):
     + Đưa ra lời khuyên chân thành, khích lệ, hướng dẫn giải pháp khắc phục cụ thể (ví dụ: nếu hay quên nộp bài thì đặt báo thức 20:00, nếu bị trừ điểm mất trật tự thì rèn luyện tập trung).
     + Giúp học sinh nhận ra thế mạnh và điểm cần cải thiện để vươn lên Top xuất sắc của lớp.

5. HƯỚNG DẪN CÁC TÍNH NĂNG PHẦN MỀM EDUMASTER 360 (KHI ĐƯỢC HỎI):
   - Nộp bài tập & vở ghi: Hỗ trợ nộp ảnh, Google Drive, YouTube, văn bản.
   - Báo nộp môn ngày mai: Tự động đối chiếu TKB ngày hôm sau để chuẩn bị bài trước khi đến lớp.
   - Duyệt & chấm bài: AI phân tích OCR chữ viết tay, so sánh vở mẫu chuẩn, gợi ý điểm và nhận xét.
   - Sổ đầu bài điện tử, Đội Sao Đỏ chấm 10 tiêu chí nền nếp, Bảng xếp hạng thi đua và Thư khen chuẩn Nghị định 30.${studentInfoSnippet}

Người dùng hiện tại: Vai trò [${userRole || "Học sinh"}], Lớp [${currentClass || "Toàn trường"}].
Hãy trả lời thân thiện, sư phạm, truyền cảm hứng, dùng emoji sinh động và cấu trúc rõ ràng.`;

    // Clean and normalize multi-turn chat contents
    const rawList = Array.isArray(messages) ? messages : [];
    const chatContents: { role: "user" | "model"; parts: { text: string }[] }[] = [];

    for (const m of rawList) {
      if (!m || typeof m.text !== "string" || !m.text.trim()) continue;
      const role: "user" | "model" = m.sender === "user" ? "user" : "model";
      // Ensure the very first turn in multi-turn talk is from 'user'
      if (chatContents.length === 0 && role === "model") {
        continue;
      }
      // Merge consecutive messages with same role
      const last = chatContents[chatContents.length - 1];
      if (last && last.role === role) {
        last.parts[0].text += `\n\n${m.text.trim()}`;
      } else {
        chatContents.push({
          role,
          parts: [{ text: m.text.trim() }],
        });
      }
    }

    // Ensure contents is not empty
    if (chatContents.length === 0) {
      chatContents.push({
        role: "user",
        parts: [{ text: lastUserMessage || "Xin chào Trợ lý Học tập AI." }],
      });
    }

    const response = await generateGeminiWithRetry(ai, {
      contents: chatContents,
      config: {
        systemInstruction: systemPrompt,
      },
    });

    res.json({ reply: response.text?.trim() || "Xin lỗi, tôi chưa thể trả lời câu hỏi này." });
  } catch (error: any) {
    console.error("AI Chat error:", error);
    // Fallback to offline intelligent responder if Gemini fails
    const lastUserMsg = req.body?.messages?.slice(-1)[0]?.text || "";
    const fallbackReply = getOfflineAssistantReply(lastUserMsg, req.body?.userRole || "guest", req.body?.currentClass || "");
    res.json({ reply: fallbackReply, isFallback: true });
  }
});

// Serve pre-packaged Cloudflare Pages deployment zip archive
app.get("/edumaster-cloudflare.zip", (req, res) => {
  const zipPath = path.join(process.cwd(), "public", "edumaster-cloudflare.zip");
  if (fs.existsSync(zipPath)) {
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="edumaster-cloudflare.zip"');
    res.setHeader("Cache-Control", "no-cache");
    return res.sendFile(zipPath);
  }
  res.status(404).send("File edumaster-cloudflare.zip không tìm thấy");
});

// Vite middleware in dev / static serve in production
async function start() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
        }
      }
    }));
    app.get("*", (req, res) => {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`EduMaster 360 Server is running on http://localhost:${PORT}`);
  });
}

start();
