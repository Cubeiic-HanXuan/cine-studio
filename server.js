// CineStudio — 本地服务
// 作用：
//   1. 托管前端页面
//   2. 保管 API Key（绝不下发给浏览器），代发创建 / 查询请求
//   3. 把用户上传的图片 / 音频 / 视频转存到可公开访问的图床，拿到 Agnes 所需的公开 URL
//
// 运行：npm install && npm start  →  http://localhost:8787

import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const DATA_DIR = path.join(__dirname, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const DEFAULT_BASE_URL = "https://api.agnes-ai.cn/v1";
const MODEL = "agnes-video-2.5";

// ---------------------------------------------------------------------------
// 配置读写（API Key 只保存在服务器本地，不进入前端代码）
// ---------------------------------------------------------------------------
function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

function getApiKey() {
  return process.env.AGNES_API_KEY || readConfig().apiKey || "";
}

function getBaseUrl() {
  return process.env.AGNES_BASE_URL || readConfig().baseUrl || DEFAULT_BASE_URL;
}

function getSmmsToken() {
  return process.env.SMMS_TOKEN || readConfig().smmsToken || "";
}

// 查询接口不在 /v1 下：https://api.agnes-ai.cn/agnesapi
function getQueryOrigin() {
  return getBaseUrl().replace(/\/v1\/?$/, "");
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 4) + "••••••" + key.slice(-4);
}

// ---------------------------------------------------------------------------
// Express 应用
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// 上传：内存接收，最大 500MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ---------------------------------------------------------------------------
// 上传转存：多个公共图床依次尝试，第一个成功即返回
//   优先 uguu.se（永久）→ litterbox（catbox 临时存储子域，最长 72h）
//   → catbox.moe / 0x0.st（部分网络环境下可用，作兜底）
// ---------------------------------------------------------------------------
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// 中文字符文件名在部分图床会出问题，统一转为 ASCII 安全名
function safeName(name) {
  const clean = String(name || "file");
  const dot = clean.lastIndexOf(".");
  const base = (dot > 0 ? clean.slice(0, dot) : clean).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "file";
  const ext = (dot > 0 ? clean.slice(dot + 1) : "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "bin";
  return `${base}.${ext}`;
}

function fileBlob(file) {
  return new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" });
}

async function uploadToUguu(file) {
  const form = new FormData();
  form.append("files[]", fileBlob(file), safeName(file.originalname));
  const res = await fetch("https://uguu.se/upload", {
    method: "POST",
    headers: { "User-Agent": UA },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  const url = data?.files?.[0]?.url;
  if (!res.ok || !/^https?:\/\//.test(url || "")) {
    throw new Error(`uguu.se 上传失败: ${JSON.stringify(data).slice(0, 120)}`);
  }
  return url;
}

async function uploadToLitterbox(file) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("time", "72h");
  form.append("fileToUpload", fileBlob(file), safeName(file.originalname));
  const res = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
    method: "POST",
    headers: { "User-Agent": UA },
    body: form,
  });
  const text = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//.test(text)) {
    throw new Error(`litterbox 上传失败: ${text.slice(0, 120)}`);
  }
  return text;
}

async function uploadToCatbox(file) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("fileToUpload", fileBlob(file), safeName(file.originalname));
  const res = await fetch("https://catbox.moe/user/api.php", {
    method: "POST",
    headers: { "User-Agent": UA },
    body: form,
  });
  const text = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//.test(text)) {
    throw new Error(`catbox.moe 上传失败: ${text.slice(0, 120)}`);
  }
  return text;
}

async function uploadToZeroX(file) {
  const form = new FormData();
  form.append("file", fileBlob(file), safeName(file.originalname));
  const res = await fetch("https://0x0.st", {
    method: "POST",
    headers: { "User-Agent": UA },
    body: form,
  });
  const text = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//.test(text)) {
    throw new Error(`0x0.st 上传失败: ${text.slice(0, 120)}`);
  }
  return text;
}

// sm.ms：国内可访问的图床，需用户提供免费 API Token（https://sm.ms → Dashboard → API Token）
async function uploadToSmms(file, token) {
  const form = new FormData();
  form.append("smfile", fileBlob(file), safeName(file.originalname));
  const res = await fetch("https://sm.ms/api/v2/upload", {
    method: "POST",
    headers: { "User-Agent": UA, Authorization: token },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  const url = data?.data?.url;
  if (!res.ok || !data?.success || !/^https?:\/\//.test(url || "")) {
    throw new Error(`sm.ms 上传失败: ${data?.message || JSON.stringify(data).slice(0, 120)}`);
  }
  return url;
}

app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "未收到文件" });
  }
  // 优先使用用户配置的 sm.ms（国内可访问），其次再退回境外公共图床
  const providers = [];
  const smmsToken = getSmmsToken();
  if (smmsToken) providers.push((file) => uploadToSmms(file, smmsToken));
  providers.push(uploadToUguu, uploadToLitterbox, uploadToCatbox, uploadToZeroX);
  for (const fn of providers) {
    try {
      const url = await fn(req.file);
      return res.json({
        url,
        name: req.file.originalname,
        type: req.file.mimetype,
        size: req.file.size,
      });
    } catch (err) {
      console.error("[upload]", err.message);
    }
  }
  res.status(502).json({
    error: "上传转存失败：所有图床当前均不可用。可稍后重试，或在「图片链接」输入框粘贴一张已公开可访问的 URL。",
  });
});

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
app.get("/api/settings", (_req, res) => {
  const key = getApiKey();
  const smmsToken = getSmmsToken();
  res.json({
    configured: !!key,
    apiKeyMasked: maskKey(key),
    baseUrl: getBaseUrl(),
    model: MODEL,
    smmsConfigured: !!smmsToken,
    smmsTokenMasked: maskKey(smmsToken),
  });
});

app.post("/api/settings", (req, res) => {
  const cfg = readConfig();
  if (typeof req.body.apiKey === "string" && req.body.apiKey.trim()) {
    cfg.apiKey = req.body.apiKey.trim();
  }
  if (typeof req.body.baseUrl === "string" && req.body.baseUrl.trim()) {
    cfg.baseUrl = req.body.baseUrl.replace(/\/+$/, "");
  }
  if (typeof req.body.smmsToken === "string") {
    const t = req.body.smmsToken.trim();
    if (t) cfg.smmsToken = t;
    else delete cfg.smmsToken; // 留空即清除
  }
  writeConfig(cfg);
  res.json({ ok: true });
});

app.post("/api/settings/clear", (_req, res) => {
  const cfg = readConfig();
  delete cfg.apiKey;
  writeConfig(cfg);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 创建视频任务（代理）
// ---------------------------------------------------------------------------
app.post("/api/videos", async (req, res) => {
  const key = getApiKey();
  if (!key) {
    return res.status(401).json({ error: "尚未配置 API Key，请先点击右上角「设置」填入。" });
  }

  const body = { ...req.body, model: MODEL };
  if (body.n == null) body.n = 1;

  const url = `${getBaseUrl()}/videos`;
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: data?.error?.message || data?.message || `创建失败（HTTP ${upstream.status}）`,
        detail: data,
      });
    }
    res.json(data);
  } catch (err) {
    console.error("[create]", err);
    res.status(502).json({ error: "无法连接 Agnes API：" + err.message });
  }
});

// ---------------------------------------------------------------------------
// 查询任务进度（代理）
// ---------------------------------------------------------------------------
app.get("/api/status", async (req, res) => {
  const key = getApiKey();
  if (!key) {
    return res.status(401).json({ error: "尚未配置 API Key" });
  }
  const videoId = req.query.video_id;
  if (!videoId) {
    return res.status(400).json({ error: "缺少 video_id" });
  }
  const params = new URLSearchParams({ video_id: videoId, model_name: MODEL });
  const url = `${getQueryOrigin()}/agnesapi?${params.toString()}`;
  try {
    const upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: data?.error?.message || data?.message || `查询失败（HTTP ${upstream.status}）`,
        status: "error",
      });
    }
    res.json(data);
  } catch (err) {
    console.error("[status]", err);
    res.status(502).json({ error: "查询失败：" + err.message, status: "error" });
  }
});

// ---------------------------------------------------------------------------
// 下载视频（代理流式转发，避免跨域下载被浏览器拦截；仅允许公网地址）
// ---------------------------------------------------------------------------
function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h === "::1") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^0\./.test(h)) return true;
  return false;
}

app.get("/api/download", async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "缺少 url" });
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "无效 URL" });
  }
  if (!/^https?:$/.test(parsed.protocol) || isPrivateHost(parsed.hostname)) {
    return res.status(400).json({ error: "仅支持公网 http(s) 地址" });
  }
  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      redirect: "follow",
    });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: `下载失败（HTTP ${upstream.status}）` });
    }
    const ext = (parsed.pathname.split(".").pop() || "mp4").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "mp4";
    const filename = `agnes-video.${ext}`;
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    const len = upstream.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error("[download]", err);
    if (!res.headersSent) res.status(502).json({ error: "下载失败：" + err.message });
    else res.end();
  }
});

app.listen(PORT, () => {
  const key = getApiKey();
  console.log("");
  console.log("  ✦ CineStudio 已启动");
  console.log(`  ✦ 打开 http://localhost:${PORT}`);
  console.log(
    key
      ? `  ✦ API Key 已配置 (${maskKey(key)})`
      : "  ✦ 尚未配置 API Key，首次使用请在页面右上角「设置」中填入"
  );
  console.log("");
});
