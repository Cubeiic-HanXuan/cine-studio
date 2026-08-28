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

// 查询接口不在 /v1 下：https://api.agnes-ai.cn/agnesapi
function getQueryOrigin() {
  return getBaseUrl().replace(/\/v1\/?$/, "");
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 4) + "••••••" + key.slice(-4);
}

// 视频本地存储目录：默认项目内 videos/，可在「设置」里改，或用环境变量 VIDEO_DIR
function getVideoDir() {
  return process.env.VIDEO_DIR || readConfig().videoDir || path.join(__dirname, "videos");
}

// ---------------------------------------------------------------------------
// Express 应用
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// 本地视频库：把存储目录以 /videos 暴露给浏览器播放/预览
app.use("/videos", (req, res, next) => {
  express.static(getVideoDir())(req, res, next);
});

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

app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "未收到文件" });
  }
  const providers = [uploadToUguu, uploadToLitterbox, uploadToCatbox, uploadToZeroX];
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
    error: "上传转存失败：所有公共图床当前均不可用，可稍后重试，或在「图片链接」输入框粘贴一张已公开可访问的 URL。",
  });
});

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
app.get("/api/settings", (_req, res) => {
  const key = getApiKey();
  res.json({
    configured: !!key,
    apiKeyMasked: maskKey(key),
    baseUrl: getBaseUrl(),
    model: MODEL,
    videoDir: getVideoDir(),
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
  if (typeof req.body.videoDir === "string") {
    const d = req.body.videoDir.trim();
    if (d) cfg.videoDir = d.replace(/\/+$/, "");
    else delete cfg.videoDir; // 留空恢复默认
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

// ---------------------------------------------------------------------------
// 导出：一键下载全部视频到本地磁盘，并按剧本分组 + 生成清单 CSV
// ---------------------------------------------------------------------------
function safePathName(name) {
  const s = String(name || "")
    .replace(/[\\/:*?"<>|\n\r\t]+/g, "-")
    .replace(/\s+/g, "-")
    .trim();
  return s.slice(0, 60) || "未命名";
}

function guessVideoExt(url) {
  try {
    const p = new URL(url).pathname;
    const ext = (p.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["mp4", "webm", "mov", "m4v", "mkv"].includes(ext)) return "." + ext;
  } catch {}
  return ".mp4";
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

app.post("/api/archive", async (req, res) => {
  const records = req.body?.records;
  if (!Array.isArray(records) || !records.length) {
    return res.status(400).json({ error: "没有可下载的视频记录" });
  }
  const baseDir = getVideoDir();
  fs.mkdirSync(baseDir, { recursive: true });
  const saved = [];
  const manifest = [];
  let skipped = 0;

  for (const r of records) {
    const url = typeof r.url === "string" ? r.url : "";
    const videoId = String(r.videoId || r.id || "");
    if (!/^https?:\/\//.test(url)) { skipped++; continue; }
    try {
      const upstream = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "*/*" },
        redirect: "follow",
      });
      if (!upstream.ok || !upstream.body) { skipped++; continue; }

      const group = safePathName(r.group || "未分组");
      const shotNo = r.shotNo ? String(r.shotNo).padStart(2, "0") : "00";
      const label = safePathName(r.scene || r.prompt || "video").slice(0, 24);
      const vid = videoId.slice(-6) || Date.now().toString(36);
      const dir = path.join(baseDir, group);
      fs.mkdirSync(dir, { recursive: true });
      const filename = `${shotNo}_${label}_${vid}${guessVideoExt(url)}`;
      const filePath = path.join(dir, filename);

      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(filePath);
        Readable.fromWeb(upstream.body).pipe(out);
        out.on("finish", resolve);
        out.on("error", reject);
      });

      const bytes = fs.statSync(filePath).size;
      const rel = path.relative(baseDir, filePath).split(path.sep).join("/");
      const item = { videoId, url, localUrl: "/videos/" + rel, file: rel, bytes };
      saved.push(item);
      manifest.push({ ...r, file: rel, bytes });
    } catch (err) {
      console.error("[archive]", err.message);
      skipped++;
    }
  }

  // 合并进已有清单（按「文件」upsert），避免每次归档覆盖掉历史记录
  const merged = new Map();
  for (const e of readManifestCsv(baseDir)) merged.set(e.file, e);
  for (const m of manifest) {
    merged.set(m.file, {
      group: m.group,
      shotNo: m.shotNo,
      scene: m.scene || "",
      prompt: m.prompt || "",
      seconds: m.seconds ?? "",
      size: m.size || "",
      ratio: m.ratio || "",
      file: m.file,
      url: m.url || "",
      thumb: m.thumb || "",
      time: m.createdAt ? new Date(m.createdAt).toLocaleString("zh-CN") : "",
    });
  }

  const header = ["剧本", "镜头号", "场景", "提示词", "时长(秒)", "分辨率", "画幅", "生成时间", "文件", "原地址", "参考图片"];
  const lines = [header.map(csvCell).join(",")];
  for (const m of merged.values()) {
    lines.push(
      [
        csvCell(m.group),
        csvCell(m.shotNo ?? ""),
        csvCell(m.scene || ""),
        csvCell(m.prompt || ""),
        csvCell(m.seconds ?? ""),
        csvCell(m.size || ""),
        csvCell(m.ratio || ""),
        csvCell(m.time || ""),
        csvCell(m.file),
        csvCell(m.url || ""),
        csvCell(m.thumb || ""),
      ].join(",")
    );
  }
  try {
    fs.writeFileSync(path.join(baseDir, "清单.csv"), "\ufeff" + lines.join("\r\n"), "utf8");
  } catch (e) {
    console.error("[archive csv]", e.message);
  }

  res.json({ ok: true, saved, skipped, total: records.length, dir: baseDir });
});

// ---------------------------------------------------------------------------
// 扫描本地存储目录，返回磁盘上已有的视频（用于恢复：即使浏览器数据被清，
// 已下载到磁盘的视频也能在「已生成视频」里找回来）。优先读「清单.csv」拿完整元数据。
// ---------------------------------------------------------------------------
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  const s = String(text || "").replace(/^\ufeff/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && s[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// 读取「清单.csv」为对象数组（按列名映射，兼容旧版缺少「参考图片」列的清单）
function readManifestCsv(baseDir) {
  const out = [];
  try {
    const csvText = fs.readFileSync(path.join(baseDir, "清单.csv"), "utf8");
    const rows = parseCsv(csvText);
    if (rows.length > 1) {
      const header = rows[0];
      const idx = (name) => header.findIndex((h) => h === name);
      const cols = {
        group: idx("剧本"), shot: idx("镜头号"), scene: idx("场景"), prompt: idx("提示词"),
        seconds: idx("时长(秒)"), size: idx("分辨率"), ratio: idx("画幅"),
        file: idx("文件"), url: idx("原地址"), thumb: idx("参考图片"), time: idx("生成时间"),
      };
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const file = row[cols.file] || "";
        if (!file) continue;
        out.push({
          group: row[cols.group] || "",
          shotNo: row[cols.shot] || "",
          scene: row[cols.scene] || "",
          prompt: row[cols.prompt] || "",
          seconds: row[cols.seconds] || "",
          size: row[cols.size] || "",
          ratio: row[cols.ratio] || "",
          file,
          url: row[cols.url] || "",
          thumb: row[cols.thumb] || "",
          time: row[cols.time] || "",
        });
      }
    }
  } catch {}
  return out;
}

app.get("/api/library", (_req, res) => {
  const baseDir = getVideoDir();
  const records = [];

  // 先解析「清单.csv」，按「文件」列建立完整元数据映射
  const csvMap = new Map();
  for (const m of readManifestCsv(baseDir)) csvMap.set(m.file, m);

  try {
    const groups = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const g of groups) {
      if (!g.isDirectory()) continue;
      const groupDir = path.join(baseDir, g.name);
      const files = fs.readdirSync(groupDir);
      for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        if (!VIDEO_EXTS.has(ext)) continue;
        try {
          const full = path.join(groupDir, f);
          const st = fs.statSync(full);
          const rel = g.name + "/" + f;
          // 文件名格式：<镜头号>_<label>_<videoId后缀>.<ext>
          const base = f.slice(0, -ext.length);
          const parts = base.split("_");
          const shotRaw = parts[0];
          const shotNo = /^\d+$/.test(shotRaw) ? parseInt(shotRaw, 10) : null;
          const suffix = parts.length >= 3 ? parts[parts.length - 1] : "";
          const label = parts.slice(1, -1).join("_");

          const meta = csvMap.get(rel);
          let rec;
          if (meta) {
            rec = {
              id: "disk_" + suffix + "_" + (shotNo ?? 0),
              videoId: "",
              group: meta.group || g.name,
              shotNo: meta.shotNo ? parseInt(meta.shotNo, 10) || null : (shotNo === 0 ? null : shotNo),
              scene: meta.scene || "",
              prompt: meta.prompt || "",
              url: meta.url || "",
              localUrl: "/videos/" + rel,
              localFile: rel,
              seconds: meta.seconds || "",
              size: meta.size || "",
              ratio: meta.ratio || "",
              modeLabel: "",
              createdAt: st.mtimeMs,
              thumb: meta.thumb || null,
              bytes: st.size,
              fromDisk: true,
            };
          } else {
            rec = {
              id: "disk_" + suffix + "_" + (shotNo ?? 0),
              videoId: "",
              group: g.name,
              shotNo: shotNo === 0 ? null : shotNo,
              scene: "",
              prompt: label || "",
              url: "",
              localUrl: "/videos/" + rel,
              localFile: rel,
              seconds: "",
              size: "",
              ratio: "",
              modeLabel: "",
              createdAt: st.mtimeMs,
              thumb: null,
              bytes: st.size,
              fromDisk: true,
            };
          }
          records.push(rec);
        } catch {}
      }
    }
  } catch {
    // 目录不存在等情况，返回空
  }
  records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ records });
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
