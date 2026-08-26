/* ==========================================================================
   CineStudio — 前端逻辑
   ========================================================================== */

"use strict";

// ---------------------------------------------------------------------------
// 常量与配置
// ---------------------------------------------------------------------------
const MODEL = "agnes-video-2.5";
const STORAGE_KEY = "agnes.studio.tasks.v1";
const POLL_MS = 1500;

const PRICE = { "720P": 0.15, "960P": 0.25, "2K": 0.35 };

const MODES = {
  text: {
    key: "text",
    label: "文生视频",
    apiMode: "text",
    media: null,
    hint: "用文字描述主体、动作、镜头与风格，无需任何素材。",
  },
  image: {
    key: "image",
    label: "图生视频",
    apiMode: "keyframe",
    media: "image",
    hint: "上传一张图片作为视频的<b>真实首帧</b>，描述从该画面开始的运动与运镜。",
  },
  multi: {
    key: "multi",
    label: "多图视频",
    apiMode: "reference",
    media: "multi",
    hint: "上传多张参考图（角色 / 场景 / 风格），在提示词中用 <b>&lt;Picture N&gt;</b> 引用它们。",
  },
  keyframe: {
    key: "keyframe",
    label: "关键帧动画",
    apiMode: "keyframe",
    media: "keyframe",
    hint: "上传<b>首帧</b>与<b>尾帧</b>，视频将在这两个关键帧之间平滑过渡（至少一张）。",
  },
};

const RATIOS = [
  { value: "16:9", label: "横屏", w: 16, h: 9 },
  { value: "9:16", label: "竖屏", w: 9, h: 16 },
  { value: "1:1", label: "方形", w: 1, h: 1 },
  { value: "4:3", label: "传统", w: 4, h: 3 },
  { value: "3:4", label: "人物", w: 3, h: 4 },
  { value: "21:9", label: "宽屏", w: 21, h: 9 },
];

const EXAMPLES = {
  text: [
    "雨后的未来城市街道，霓虹灯倒映在地面，一辆银色跑车缓慢驶过，电影级运镜，自然环境声",
    "夜晚的森林中，三只猫组成微型铜管乐队向前行进，镜头平稳后退，月光穿过树叶，自然脚步声与乐器声",
    "极简陶艺工作室，匠人双手在转盘上拉坯，柔和侧光，特写缓慢推近，陶土与水的细腻质感",
    "雪山之巅的日出延时，云雾在金色晨光中翻涌，一只鹰掠过画面，广角镜头，史诗级氛围",
  ],
  image: [
    "从首帧画面开始，人物缓缓转身走向窗边，衣物与发丝自然摆动，镜头缓慢推进，自然光",
    "以首帧为主体，镜头围绕主体做环绕运镜，光影随时间流动，保持主体外观与细节一致",
    "首帧场景中，微风拂过，水面泛起涟漪，树叶轻轻摇曳，固定机位，电影感色调",
  ],
  multi: [
    "以 <Picture 1> 中的角色和美术风格为参考，角色在花田中自然奔跑，保持外观一致，低机位跟拍",
    "参考 <Picture 1> 的场景与 <Picture 2> 的主体，营造统一的视觉氛围，缓慢推镜",
    "以 <Picture 1> 为视觉主体，融入 <Picture 2> 的背景，主体与场景自然融合，平稳运镜",
  ],
  keyframe: [
    "从首帧姿态自然过渡到尾帧构图，镜头缓慢推进，运动平滑连贯，光线自然演变",
    "首尾帧之间如一段连续运镜，构图与光线自然过渡，保持主体外观一致",
    "人物从首帧的静态姿势缓缓动起来，最终定格在尾帧的画面，镜头轻微环绕",
  ],
};

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
let currentMode = "text";
let currentSize = "720P";
let currentRatio = "16:9";
let tasks = [];
const media = { image: [], multi: [], kfFirst: null, kfLast: null };
let dropTarget = null;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const promptEl = $("#prompt");
const promptCount = $("#promptCount");
const modeHint = $("#modeHint");
const mediaZone = $("#mediaZone");
const mediaLabel = $("#mediaLabel");
const chipsEl = $("#chips");
const taskList = $("#taskList");
const emptyState = $("#emptyState");
const secondsEl = $("#seconds");
const secondsVal = $("#secondsVal");
const sizeSeg = $("#sizeSeg");
const ratioList = $("#ratioList");
const seedEl = $("#seed");
const generateBtn = $("#generateBtn");
const costLine = $("#costLine");
const statusBtn = $("#statusBtn");
const statusDot = $("#statusDot");
const statusLabel = $("#statusLabel");
const settingsBtn = $("#settingsBtn");
const settingsModal = $("#settingsModal");
const apiKeyInput = $("#apiKey");
const baseUrlInput = $("#baseUrl");
const toastStack = $("#toastStack");

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg, type = "info", ms = 3400) {
  const t = el("div", "toast toast--" + type);
  t.textContent = msg;
  toastStack.appendChild(t);
  setTimeout(() => {
    t.classList.add("is-out");
    setTimeout(() => t.remove(), 320);
  }, ms);
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------
function updatePromptCount() {
  promptCount.textContent = promptEl.value.length;
}
promptEl.addEventListener("input", updatePromptCount);

function insertAtCursor(text) {
  const s = promptEl.selectionStart ?? promptEl.value.length;
  const e = promptEl.selectionEnd ?? s;
  promptEl.value = promptEl.value.slice(0, s) + text + promptEl.value.slice(e);
  promptEl.focus();
  promptEl.selectionStart = promptEl.selectionEnd = s + text.length;
  updatePromptCount();
}

function rollExample() {
  const list = EXAMPLES[currentMode] || [];
  if (!list.length) return;
  const idx = Math.floor(Math.random() * list.length);
  promptEl.value = list[idx];
  updatePromptCount();
  toast("已填入灵感示例，可直接修改", "info", 2000);
}

$("#diceBtn").addEventListener("click", rollExample);

// ---------------------------------------------------------------------------
// 模式切换
// ---------------------------------------------------------------------------
document.querySelectorAll(".mode").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});

function setMode(key) {
  currentMode = key;
  document.querySelectorAll(".mode").forEach((b) => {
    const active = b.dataset.mode === key;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", String(active));
  });
  const m = MODES[key];
  modeHint.innerHTML = m.hint;
  mediaLabel.textContent = m.media === null ? "" : m.media === "image" ? "首帧图片" : m.media === "keyframe" ? "关键帧" : "参考图片";
  // 素材区在纯文本模式隐藏
  document.querySelector("#mediaZone").closest(".field").style.display = m.media === null ? "none" : "";
  renderMedia();
  renderChips();
}

// ---------------------------------------------------------------------------
// 画幅选择器
// ---------------------------------------------------------------------------
function renderRatios() {
  ratioList.innerHTML = "";
  RATIOS.forEach((r) => {
    const box = 36;
    let w, h;
    if (r.w >= r.h) { w = box; h = Math.round((box * r.h) / r.w); }
    else { h = box; w = Math.round((box * r.w) / r.h); }
    const b = el("button", "ratio" + (r.value === currentRatio ? " is-active" : ""));
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", r.value === currentRatio);
    const frame = el("span", "ratio__frame");
    frame.style.width = w + "px";
    frame.style.height = h + "px";
    const label = el("small");
    label.textContent = r.label;
    b.append(frame, label);
    b.addEventListener("click", () => {
      currentRatio = r.value;
      renderRatios();
      updateCost();
    });
    ratioList.appendChild(b);
  });
}

// ---------------------------------------------------------------------------
// 分辨率与时长
// ---------------------------------------------------------------------------
sizeSeg.querySelectorAll("button").forEach((b) => {
  b.addEventListener("click", () => {
    currentSize = b.dataset.size;
    sizeSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("is-active", x === b));
    updateCost();
  });
});

function updateSlider() {
  const v = +secondsEl.value;
  const pct = ((v - +secondsEl.min) / (+secondsEl.max - +secondsEl.min)) * 100;
  secondsEl.style.setProperty("--fill", pct + "%");
  secondsVal.textContent = v + " 秒";
}
secondsEl.addEventListener("input", () => { updateSlider(); updateCost(); });

function updateCost() {
  const sec = +secondsEl.value;
  const cost = sec * PRICE[currentSize];
  costLine.innerHTML = `预估 <b>¥${cost.toFixed(2)}</b> · ${sec} 秒 ${currentSize} · ${currentRatio}`;
}

// ---------------------------------------------------------------------------
// 媒体上传
// ---------------------------------------------------------------------------
const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = "image/*";
fileInput.style.display = "none";
document.body.appendChild(fileInput);

fileInput.addEventListener("change", async () => {
  const files = [...fileInput.files];
  const target = dropTarget;
  dropTarget = null;
  if (!target || !files.length) return;
  for (const f of files) await addFile(target, f);
});

function openPicker(target) {
  dropTarget = target;
  fileInput.multiple = target === "multi";
  fileInput.value = "";
  fileInput.click();
}

const DROP_ICON = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 16V5m0 0L7.5 9.5M12 5l4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;

function makeDrop(target, title, sub) {
  const d = el("div", "drop");
  d.innerHTML = `${DROP_ICON}<span class="drop__title">${title}</span><span class="drop__sub">${esc(sub)}</span>`;
  d.addEventListener("click", () => openPicker(target));
  d.addEventListener("dragover", (e) => { e.preventDefault(); d.classList.add("is-drag"); });
  d.addEventListener("dragleave", () => d.classList.remove("is-drag"));
  d.addEventListener("drop", (e) => {
    e.preventDefault();
    d.classList.remove("is-drag");
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) { toast("请拖入图片文件", "err"); return; }
    files.forEach((f) => addFile(target, f));
  });
  return d;
}

const KIND_LABEL = { image: "图", audio: "音", video: "视频" };

function makeThumb(item) {
  const t = el("div", "thumb");
  const kind = item.kind || "image";
  t.classList.add("thumb--" + kind);
  if (item.status === "uploading") t.classList.add("is-uploading");
  if (item.status === "error") t.classList.add("is-error");

  const img = el("img");
  img.src = item.preview || item.url || "";
  img.alt = item.name || "";
  t.appendChild(img);

  const kindTag = el("span", "thumb__kind");
  kindTag.textContent = KIND_LABEL[kind] || kind;
  t.appendChild(kindTag);

  if (item.status === "uploading") {
    const s = el("div", "thumb__status");
    const sp = el("span", "spinner");
    s.appendChild(sp);
    t.appendChild(s);
  } else if (item.status === "error") {
    const s = el("div", "thumb__status");
    s.textContent = "上传失败";
    s.title = item.error || "";
    t.appendChild(s);
  }

  const x = el("button", "thumb__x");
  x.type = "button";
  x.textContent = "✕";
  x.title = "移除";
  x.addEventListener("click", () => removeItem(item));
  t.appendChild(x);
  return t;
}

function renderMedia() {
  const m = MODES[currentMode];
  mediaZone.innerHTML = "";
  if (!m.media) return;

  if (m.media === "image") {
    if (!media.image.length) {
      mediaZone.appendChild(makeDrop("image", "上传首帧图片", "拖拽图片到此处，或点击选择 · PNG / JPG"));
    } else {
      mediaZone.appendChild(makeThumb(media.image[0]));
    }
    mediaZone.appendChild(makeUrlRow("image"));
  } else if (m.media === "keyframe") {
    const grid = el("div", "keyframe-slots");
    const s1 = el("div", "slot");
    s1.appendChild(media.kfFirst ? makeThumb(media.kfFirst) : makeDrop("kfFirst", "首帧", "点击或拖入"));
    const s2 = el("div", "slot");
    s2.appendChild(media.kfLast ? makeThumb(media.kfLast) : makeDrop("kfLast", "尾帧", "点击或拖入"));
    grid.append(s1, s2);
    mediaZone.appendChild(grid);
  } else if (m.media === "multi") {
    if (media.multi.length) {
      const list = el("div", "media-list");
      media.multi.forEach((it) => list.appendChild(makeThumb(it)));
      mediaZone.appendChild(list);
    }
    mediaZone.appendChild(makeDrop("multi", "添加参考图", "可多张，按顺序编号为 <Picture 1>、<Picture 2> …"));
    mediaZone.appendChild(makeUrlRow("multi"));
  }
}

function makeUrlRow(target) {
  const row = el("div", "url-row");
  const input = el("input");
  input.type = "url";
  input.placeholder = "或粘贴公开图片链接（https://…）";
  input.setAttribute("aria-label", "粘贴图片链接");
  const add = el("button", "tool-btn");
  add.type = "button";
  add.textContent = "添加";
  const doAdd = () => {
    const u = input.value.trim();
    if (!/^https?:\/\//.test(u)) { toast("请输入以 http(s):// 开头的链接", "err"); return; }
    const item = {
      id: uid(),
      name: u.split("/").pop() || "图片",
      type: "image/*",
      kind: "image",
      url: u,
      preview: u,
      status: "ready",
      error: null,
    };
    if (target === "image") media.image = [item];
    else if (target === "multi") media.multi.push(item);
    input.value = "";
    renderMedia();
    renderChips();
    toast("已添加图片链接", "ok", 2000);
  };
  add.addEventListener("click", doAdd);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
  row.append(input, add);
  return row;
}

function renderChips() {
  chipsEl.innerHTML = "";
  if (currentMode !== "multi") return;
  media.multi.forEach((it, i) => {
    const c = el("button", "chip");
    c.type = "button";
    c.textContent = `<Picture ${i + 1}>`;
    c.title = it.name || "";
    c.addEventListener("click", () => insertAtCursor(`<Picture ${i + 1}>`));
    chipsEl.appendChild(c);
  });
}

async function addFile(target, file) {
  const item = {
    id: uid(),
    name: file.name,
    type: file.type,
    kind: "image",
    url: null,
    preview: URL.createObjectURL(file),
    status: "uploading",
    error: null,
  };

  if (target === "image") media.image = [item];
  else if (target === "kfFirst") media.kfFirst = item;
  else if (target === "kfLast") media.kfLast = item;
  else if (target === "multi") media.multi.push(item);

  renderMedia();
  renderChips();

  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "上传失败");
    item.url = data.url;
    item.status = "ready";
  } catch (err) {
    item.status = "error";
    item.error = err.message;
    toast("素材上传失败：" + err.message, "err", 5000);
  }
  renderMedia();
}

function removeItem(item) {
  media.image = media.image.filter((x) => x !== item);
  media.multi = media.multi.filter((x) => x !== item);
  if (media.kfFirst === item) media.kfFirst = null;
  if (media.kfLast === item) media.kfLast = null;
  renderMedia();
  renderChips();
}

// ---------------------------------------------------------------------------
// 任务状态
// ---------------------------------------------------------------------------
const STATUS_LABEL = {
  queued: "排队中",
  in_progress: "生成中",
  completed: "已完成",
  failed: "失败",
  error: "连接异常",
};
const STATUS_TAG = { queued: "queued", in_progress: "in_progress", completed: "completed", failed: "failed", error: "error" };

// 兼容不同返回结构，尽量从多个字段里提取视频地址
function extractUrl(data) {
  return (
    data?.metadata?.url ||
    data?.metadata?.video_url ||
    data?.url ||
    data?.video_url ||
    data?.output?.url ||
    data?.result?.url ||
    data?.data?.url ||
    null
  );
}

function saveTasks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {}
}

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    tasks = raw ? JSON.parse(raw).filter((t) => t && t.videoId) : [];
  } catch {
    tasks = [];
  }
  tasks.forEach((t) => { t.pollerActive = false; });
}

function resumePolling() {
  tasks.forEach((t) => {
    if (["queued", "in_progress"].includes(t.status) && !t.pollerActive) poll(t);
  });
}

function renderTasks() {
  taskList.innerHTML = "";
  if (!tasks.length) {
    taskList.appendChild(emptyState);
    return;
  }
  [...tasks].reverse().forEach((t) => taskList.appendChild(makeTaskCard(t)));
}

function makeTaskCard(task) {
  const card = el("div", "task");

  // 顶部
  const top = el("div", "task__top");
  const thumb = el("div", "task__thumb");
  if (task.thumb) {
    const img = el("img");
    img.src = task.thumb;
    thumb.appendChild(img);
  } else {
    thumb.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h10M4 18h7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
  }
  const meta = el("div", "task__meta");
  const modeTag = el("div", "task__mode");
  modeTag.textContent = `${task.modeLabel} · ${task.seconds} 秒 · ${task.size} · ${task.ratio}`;
  const promptLine = el("div", "task__prompt");
  promptLine.textContent = task.prompt || "";
  meta.append(modeTag, promptLine);
  top.append(thumb, meta);
  card.appendChild(top);

  // 状态行
  const statusRow = el("div", "task__status");
  const tag = el("span", "tag tag--" + (STATUS_TAG[task.status] || "queued"));
  tag.textContent = STATUS_LABEL[task.status] || task.status;
  statusRow.appendChild(tag);
  if (task.status === "in_progress" || task.status === "queued") {
    const pct = el("span", "task__pct");
    pct.textContent = (task.progress || 0) + "%";
    statusRow.appendChild(pct);
  }
  card.appendChild(statusRow);

  // 进度条
  if (task.status === "in_progress" || task.status === "queued") {
    const p = el("div", "progress");
    const bar = el("div", "progress__bar");
    bar.style.width = (task.progress || 0) + "%";
    p.appendChild(bar);
    card.appendChild(p);
  }

  // 视频预览
  if (task.status === "completed" && task.url) {
    const wrap = el("div", "task__video-wrap");
    const video = el("video");
    video.src = task.url;
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    if (task.thumb) video.poster = task.thumb;
    if (task.ratio) video.style.aspectRatio = task.ratio.replace(":", " / ");

    const fail = el("div", "task__video-fail");
    fail.hidden = true;
    const failText = el("span");
    failText.textContent = "视频预览加载失败";
    const failLink = el("a", "mini-btn");
    failLink.href = task.url;
    failLink.target = "_blank";
    failLink.rel = "noreferrer";
    failLink.textContent = "在新窗口打开";
    fail.append(failText, failLink);
    video.addEventListener("error", () => {
      video.style.display = "none";
      fail.hidden = false;
    });

    wrap.append(video, fail);
    card.appendChild(wrap);
  } else if (task.status === "completed" && !task.url) {
    const miss = el("div", "task__video-miss");
    const missText = el("span");
    missText.textContent = "任务已完成，但未获取到视频地址";
    const fetchBtn = el("button", "mini-btn");
    fetchBtn.type = "button";
    fetchBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>刷新获取`;
    fetchBtn.addEventListener("click", () => refreshTask(task));
    miss.append(missText, fetchBtn);
    card.appendChild(miss);
  }

  // 错误
  if (task.status === "failed" || task.status === "error") {
    const err = el("div", "task__error");
    err.textContent = task.error || "生成失败，请重试";
    card.appendChild(err);
  }

  // 操作
  const actions = el("div", "task__actions");

  if (task.status === "completed" && task.url) {
    const dl = el("a", "mini-btn");
    dl.href = "/api/download?url=" + encodeURIComponent(task.url);
    dl.title = "下载视频";
    dl.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 4v11m0 0 4-4m-4 4-4-4M4 19h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>下载`;
    actions.appendChild(dl);

    const open = el("a", "mini-btn");
    open.href = task.url;
    open.target = "_blank";
    open.rel = "noreferrer";
    open.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M7 17L17 7M9 7h8v8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>新窗口打开`;
    actions.appendChild(open);

    const copy = el("button", "mini-btn");
    copy.type = "button";
    copy.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" stroke-width="1.6"/></svg>复制链接`;
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(task.url);
        toast("链接已复制", "ok");
      } catch {
        toast("复制失败，请手动复制", "err");
      }
    });
    actions.appendChild(copy);
  }

  if (task.status === "failed" || task.status === "error") {
    const retry = el("button", "mini-btn");
    retry.type = "button";
    retry.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>重试`;
    retry.addEventListener("click", () => createTask(task.request, task));
    actions.appendChild(retry);

    const refresh = el("button", "mini-btn");
    refresh.type = "button";
    refresh.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>刷新状态`;
    refresh.addEventListener("click", () => refreshTask(task));
    actions.appendChild(refresh);
  }

  const del = el("button", "mini-btn mini-btn--danger");
  del.type = "button";
  del.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>删除`;
  del.addEventListener("click", () => removeTask(task));
  actions.appendChild(del);

  card.appendChild(actions);
  return card;
}

function removeTask(task) {
  tasks = tasks.filter((t) => t !== task);
  saveTasks();
  renderTasks();
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------
function collectRequest() {
  const m = MODES[currentMode];
  const prompt = promptEl.value.trim();
  if (!prompt) return { error: "请先填写画面描述" };

  const body = {
    prompt,
    seconds: String(+secondsEl.value),
    size: currentSize,
    aspect_ratio: currentRatio,
    mode: m.apiMode,
  };
  if (seedEl.value && seedEl.value.trim() !== "") body.seed = Number(seedEl.value);

  // 校验并附加媒体
  const pending = [...media.image, ...media.multi, media.kfFirst, media.kfLast].filter(
    (x) => x && x.status === "uploading"
  );
  if (pending.length) return { error: "素材仍在上传中，请稍候" };

  if (m.media === "image") {
    const it = media.image[0];
    if (!it) return { error: "请上传一张首帧图片" };
    if (it.status === "error") return { error: "首帧图片上传失败，请重新上传" };
    body.first_frame = it.url;
  } else if (m.media === "keyframe") {
    if (!media.kfFirst && !media.kfLast) return { error: "请至少上传首帧或尾帧" };
    if (media.kfFirst?.status === "error" || media.kfLast?.status === "error")
      return { error: "关键帧图片上传失败，请重新上传" };
    if (media.kfFirst) body.first_frame = media.kfFirst.url;
    if (media.kfLast) body.last_frame = media.kfLast.url;
  } else if (m.media === "multi") {
    if (!media.multi.length) return { error: "请至少上传一张参考图" };
    if (media.multi.some((x) => x.status === "error")) return { error: "存在上传失败的参考图，请移除后重试" };
    body.images = media.multi.map((x) => x.url);
  }
  return { body };
}

function firstThumb() {
  const it = media.image[0] || media.kfFirst || media.kfLast || media.multi[0];
  return it ? it.url || it.preview : null;
}

async function createTask(requestBody, retryOf) {
  setBusy(true);
  let data;
  try {
    const res = await fetch("/api/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error || `创建失败（HTTP ${res.status}）`, "err", 6000);
      setBusy(false);
      return;
    }
  } catch (err) {
    toast("无法连接本地服务：" + err.message, "err");
    setBusy(false);
    return;
  }

  const videoId = data.video_id || data.id || data.task_id;
  if (!videoId) {
    toast("响应中缺少 video_id，请查看控制台", "err");
    setBusy(false);
    return;
  }

  const task = {
    id: uid(),
    videoId,
    taskId: data.id || data.task_id || videoId,
    status: data.status || "queued",
    progress: data.progress || 0,
    prompt: requestBody.prompt,
    modeLabel: MODES[currentMode].label,
    modeKey: currentMode,
    seconds: requestBody.seconds,
    size: requestBody.size,
    ratio: requestBody.aspect_ratio,
    thumb: firstThumb(),
    url: null,
    error: null,
    request: requestBody,
    createdAt: Date.now(),
    pollerActive: false,
  };

  if (retryOf) tasks = tasks.filter((t) => t !== retryOf);
  tasks.push(task);
  saveTasks();
  renderTasks();
  setBusy(false);
  toast("任务已创建，正在生成…", "ok", 2600);
  poll(task);
}

async function poll(task) {
  if (task.pollerActive) return;
  task.pollerActive = true;
  let backoff = 2000;

  while (true) {
    try {
      const res = await fetch("/api/status?video_id=" + encodeURIComponent(task.videoId));
      if (res.status === 429) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 15000);
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        backoff = 2000;
        task.status = data.status || task.status;
        task.progress = typeof data.progress === "number" ? data.progress : task.progress;
        task.url = extractUrl(data) || task.url || null;
        task.error = data.error?.message || data.error || null;
      } else {
        task.status = "error";
        task.error = data.error || `查询失败（HTTP ${res.status}）`;
      }
      saveTasks();
      renderTasks();
      if (task.status === "completed") {
        toast("视频生成完成 🎬", "ok");
        break;
      }
      if (task.status === "failed" || task.status === "error") {
        break;
      }
    } catch (err) {
      task.status = "error";
      task.error = err.message;
      saveTasks();
      renderTasks();
      break;
    }
    await sleep(POLL_MS);
  }
  task.pollerActive = false;
}

// 手动刷新单个任务状态（如已完成但未拿到视频地址时）
async function refreshTask(task) {
  try {
    const res = await fetch("/api/status?video_id=" + encodeURIComponent(task.videoId));
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      task.status = data.status || task.status;
      task.progress = typeof data.progress === "number" ? data.progress : task.progress;
      task.url = extractUrl(data) || task.url || null;
      task.error = data.error?.message || data.error || null;
      saveTasks();
      renderTasks();
      if (task.status === "completed" && task.url) toast("已获取到视频", "ok", 1600);
      else if (task.status === "completed") toast("任务已完成，但暂未返回视频地址", "info", 2600);
      else toast("状态已刷新", "ok", 1600);
    } else {
      toast(data.error || "刷新失败", "err");
    }
  } catch (err) {
    toast("刷新失败：" + err.message, "err");
  }
}

function setBusy(b) {
  generateBtn.disabled = b;
  generateBtn.classList.toggle("is-busy", b);
}

generateBtn.addEventListener("click", () => {
  const { body, error } = collectRequest();
  if (error) {
    toast(error, "err");
    return;
  }
  createTask(body);
});

$("#clearDoneBtn").addEventListener("click", () => {
  const before = tasks.length;
  tasks = tasks.filter((t) => !["completed", "failed", "error"].includes(t.status));
  if (tasks.length < before) {
    saveTasks();
    renderTasks();
    toast("已清除完成/失败的任务", "info", 2000);
  }
});

// 随机种子
$("#seedRandom").addEventListener("click", () => {
  seedEl.value = String(Math.floor(Math.random() * 1_000_000));
});

// ---------------------------------------------------------------------------
// 设置与连接状态
// ---------------------------------------------------------------------------
async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    const data = await res.json();
    applyStatus(data);
    baseUrlInput.value = data.baseUrl || "";
    apiKeyInput.placeholder = data.configured
      ? "已配置 " + data.apiKeyMasked + "（留空保持不变）"
      : "sk-…";
  } catch {
    applyStatus({ configured: false });
  }
}

function applyStatus(data) {
  statusBtn.classList.toggle("is-ok", !!data.configured);
  statusBtn.classList.toggle("is-no", !data.configured);
  statusLabel.textContent = data.configured ? "已连接" : "未配置密钥";
}

function openSettings() {
  loadSettings();
  settingsModal.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeSettings() {
  settingsModal.hidden = true;
  document.body.style.overflow = "";
}

settingsBtn.addEventListener("click", openSettings);
statusBtn.addEventListener("click", openSettings);
settingsModal.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeSettings));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsModal.hidden) closeSettings();
});

$("#toggleKey").addEventListener("click", () => {
  const isPw = apiKeyInput.type === "password";
  apiKeyInput.type = isPw ? "text" : "password";
  $("#toggleKey").textContent = isPw ? "隐藏" : "显示";
});

$("#saveSettingsBtn").addEventListener("click", async () => {
  const payload = { baseUrl: baseUrlInput.value.trim() };
  if (apiKeyInput.value.trim()) payload.apiKey = apiKeyInput.value.trim();
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error();
    apiKeyInput.value = "";
    toast("设置已保存", "ok");
    await loadSettings();
    closeSettings();
  } catch {
    toast("保存失败", "err");
  }
});

$("#clearKeyBtn").addEventListener("click", async () => {
  try {
    await fetch("/api/settings/clear", { method: "POST" });
    apiKeyInput.value = "";
    toast("密钥已清除", "info");
    await loadSettings();
  } catch {
    toast("清除失败", "err");
  }
});

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
function init() {
  renderRatios();
  updateSlider();
  updateCost();
  updatePromptCount();
  setMode("text");
  loadTasks();
  renderTasks();
  resumePolling();
  loadSettings();
}

init();
