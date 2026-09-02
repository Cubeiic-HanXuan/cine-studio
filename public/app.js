/* ==========================================================================
   CineStudio — 前端逻辑
   ========================================================================== */

"use strict";

// ---------------------------------------------------------------------------
// 常量与配置
// ---------------------------------------------------------------------------
const DEFAULT_MODEL = "agnes-video-2.5";
let currentModel = DEFAULT_MODEL; // 当前模型：顶栏下拉切换，持久化在服务端 config.json
let modelList = [DEFAULT_MODEL]; // 可选模型列表（/api/models 动态拉取 + 自定义）
const STORAGE_KEY = "agnes.studio.tasks.v1";
const POLL_MS = 1500;

const PRICE = { "720P": 0.15, "960P": 0.25, "2K": 0.35 };

// Agnes Video 2.5 只有三个 API mode：text / keyframe / reference，没有独立的图生视频模式。
// 所以界面上的「图生视频」和「关键帧动画」都发 mode:"keyframe"，只是带的媒体字段不同。
// slots 声明每个模式真正会读取、并发送出去的素材槽位 —— media 是全局的，
// 切模式后残留的素材必须靠这份映射排除掉，否则会污染缩略图和「上传中」检查。
const MODES = {
  text: {
    key: "text",
    label: "文生视频",
    apiMode: "text",
    media: null,
    slots: [],
    hint: "用文字描述主体、动作、镜头与风格，无需任何素材。",
  },
  image: {
    key: "image",
    label: "图生视频",
    apiMode: "keyframe",
    media: "image",
    slots: ["image"],
    hint: "上传一张图片作为视频的<b>真实首帧</b>，描述从该画面开始的运动与运镜。Agnes 2.5 没有单独的图生视频模式，这里发的是 <b>keyframe</b> 且只带 <b>first_frame</b>。",
  },
  multi: {
    key: "multi",
    label: "参考生成",
    apiMode: "reference",
    media: "multi",
    slots: ["multi", "audio", "video"],
    hint: "上传参考素材（图片 / 音频 / 视频），在提示词中用 <b>&lt;Picture N&gt;</b>、<b>&lt;Audio N&gt;</b>、<b>&lt;Video N&gt;</b> 引用它们。",
  },
  keyframe: {
    key: "keyframe",
    label: "关键帧动画",
    apiMode: "keyframe",
    media: "keyframe",
    slots: ["kfFirst", "kfLast"],
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
    "以 <Picture 1> 为视觉主体，根据 <Audio 1> 的节奏设计动作和镜头切换，保持自然连贯",
    "参考 <Video 1> 的主体动作和镜头节奏，将场景改为月光下的卧室，保持时序连贯",
    "以 <Picture 1> 为角色参考，跟随 <Video 1> 的动作节奏，并配合 <Audio 1> 的配乐节拍",
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
const media = { image: [], multi: [], audio: [], video: [], kfFirst: null, kfLast: null };
let dropTarget = null;

// 当前模式真正会用到的素材。切模式不清空 media（切回来还能用），
// 所以凡是「这次请求涉及哪些素材」的判断都必须走这里，不能直接遍历 media 全部槽位。
function activeMedia(mode = currentMode) {
  return (MODES[mode].slots || []).flatMap((k) => {
    const v = media[k];
    return Array.isArray(v) ? v : v ? [v] : [];
  });
}

// flash 系列模型能力受限：仅 720P、不支持视频参考、参考图片最多 5 张
function isFlashModel() {
  return /flash/i.test(currentModel || "");
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const promptEl = $("#prompt");
const promptCount = $("#promptCount");
const modeHint = $("#modeHint");
const reqPeek = $("#reqPeek");
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
const videoDirInput = $("#videoDir");
const modelSwitch = $("#modelSwitch");
const modelBtn = $("#modelBtn");
const modelNameEl = $("#modelName");
const modelMenu = $("#modelMenu");
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
  mediaLabel.textContent = m.media === null ? "" : m.media === "image" ? "首帧图片" : m.media === "keyframe" ? "关键帧" : "参考素材";
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
// 不同模型支持的分辨率不同：agnes-video-2.5-flash 等 flash 系列仅支持 720P
function allowedSizes(model) {
  return /flash/i.test(model || "") ? ["720P"] : ["720P", "960P", "2K"];
}

// 按当前模型刷新所有分辨率选择控件（主表单 seg + 分镜脚本下拉）的可用状态
function applySizeAvailability() {
  const allowed = allowedSizes(currentModel);

  // 主表单：禁用不支持的分辨率按钮；若当前选中项被禁用则回退到 720P
  if (!allowed.includes(currentSize)) currentSize = allowed[0];
  sizeSeg.querySelectorAll("button").forEach((b) => {
    const ok = allowed.includes(b.dataset.size);
    b.disabled = !ok;
    b.classList.toggle("is-active", b.dataset.size === currentSize);
  });

  // 分镜脚本：同步禁用下拉选项；若当前值被禁用则回退到 720P 并触发持久化
  const sbSizeEl = document.getElementById("sbSize");
  if (sbSizeEl) {
    [...sbSizeEl.options].forEach((o) => { o.disabled = !allowed.includes(o.value); });
    if (!allowed.includes(sbSizeEl.value)) {
      sbSizeEl.value = allowed[0];
      sbSizeEl.dispatchEvent(new Event("change"));
    }
  }

  // 模型能力影响参考素材区（flash 不支持视频参考）与引用角标，一并刷新
  renderMedia();
  renderChips();

  updateCost();
}

sizeSeg.querySelectorAll("button").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.disabled) return;
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
// 请求字段预览
// ---------------------------------------------------------------------------
// 文档把媒体字段和 mode 绑死：first_frame / last_frame 只属于 keyframe，
// images / audios / videos 只属于 reference，text 带任何一个都会 400。
// 而界面上「图生视频」「关键帧动画」都发 mode:"keyframe"，光看按钮分不出发的是哪些字段，
// 所以直接把结果写在界面上，不必开 devtools 才能确认。
function mediaFields(mode = currentMode) {
  const f = [];
  if (mode === "image") {
    f.push(media.image[0] ? "first_frame" : "first_frame（待上传）");
  } else if (mode === "keyframe") {
    if (media.kfFirst) f.push("first_frame");
    if (media.kfLast) f.push("last_frame");
    if (!f.length) f.push("first_frame / last_frame（至少一张，待上传）");
  } else if (mode === "multi") {
    if (media.multi.length) f.push(`images×${media.multi.length}`);
    if (media.audio.length) f.push(`audios×${media.audio.length}`);
    if (media.video.length && !isFlashModel()) f.push(`videos×${media.video.length}`);
    if (!f.length) f.push("images / audios / videos（至少一类，待添加）");
  }
  return f;
}

function renderReqPeek() {
  if (!reqPeek) return;
  const f = mediaFields();
  reqPeek.innerHTML =
    `将发送 <b>mode: "${MODES[currentMode].apiMode}"</b>` +
    (f.length ? ` · <b>${f.join("</b> + <b>")}</b>` : " · 不带任何媒体字段");
}

// 已创建任务的实际请求体摘要 —— 直接读 task.request（真正发出去的那份），
// 不重新推导，历史任务也能核对。
function requestSummary(req) {
  if (!req || !req.mode) return "";
  const f = [];
  if (req.first_frame) f.push("first_frame");
  if (req.last_frame) f.push("last_frame");
  if (req.images?.length) f.push(`images×${req.images.length}`);
  if (req.audios?.length) f.push(`audios×${req.audios.length}`);
  if (req.videos?.length) f.push(`videos×${req.videos.length}`);
  return `mode: "${req.mode}"` + (f.length ? " · " + f.join(" + ") : "");
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

// 各上传目标对应的素材类型与文件选择器 accept
const TARGET_KIND = { image: "image", multi: "image", kfFirst: "image", kfLast: "image", audio: "audio", video: "video" };
const TARGET_ACCEPT = { image: "image/*", multi: "image/*", kfFirst: "image/*", kfLast: "image/*", audio: "audio/*", video: "video/*" };
// 链接输入框占位提示
const TARGET_URL_PH = {
  image: "或粘贴公开图片链接（https://…）",
  multi: "或粘贴公开图片链接（https://…）",
  audio: "或粘贴公开音频链接（https://…）",
  video: "或粘贴公开视频链接（https://…）",
};

function openPicker(target) {
  dropTarget = target;
  fileInput.multiple = target === "multi" || target === "audio" || target === "video";
  fileInput.accept = TARGET_ACCEPT[target] || "image/*";
  fileInput.value = "";
  fileInput.click();
}

const DROP_ICON = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 16V5m0 0L7.5 9.5M12 5l4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;

function makeDrop(target, title, sub) {
  const kind = TARGET_KIND[target] || "image";
  const d = el("div", "drop");
  d.innerHTML = `${DROP_ICON}<span class="drop__title">${title}</span><span class="drop__sub">${esc(sub)}</span>`;
  d.addEventListener("click", () => openPicker(target));
  d.addEventListener("dragover", (e) => { e.preventDefault(); d.classList.add("is-drag"); });
  d.addEventListener("dragleave", () => d.classList.remove("is-drag"));
  d.addEventListener("drop", (e) => {
    e.preventDefault();
    d.classList.remove("is-drag");
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith(kind + "/"));
    if (!files.length) { toast("请拖入" + KIND_NOUN[kind] + "文件", "err"); return; }
    files.forEach((f) => addFile(target, f));
  });
  return d;
}

const KIND_LABEL = { image: "图", audio: "音", video: "视频" };
const KIND_NOUN = { image: "图片", audio: "音频", video: "视频" };

function makeThumb(item, refLabel) {
  const t = el("div", "thumb");
  const kind = item.kind || "image";
  t.classList.add("thumb--" + kind);
  if (item.status === "uploading") t.classList.add("is-uploading");
  if (item.status === "error") t.classList.add("is-error");

  // 音频 / 视频没有可用的静态预览图，靠 ::after 图标遮罩展示，避免破图
  if (kind === "image") {
    const img = el("img");
    img.src = item.preview || item.url || "";
    img.alt = item.name || "";
    t.appendChild(img);
  }

  if (refLabel) {
    const idx = el("span", "thumb__idx");
    idx.textContent = refLabel;
    t.appendChild(idx);
  }

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
  renderReqPeek(); // 素材一变，实际发出的媒体字段就变，跟着刷新
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
    mediaZone.appendChild(makeThumbSection({
      title: "参考图片",
      hint: "提示词用 &lt;Picture N&gt; 引用" + (isFlashModel() ? " · flash 最多 5 张" : ""),
      target: "multi",
      items: media.multi,
      refPrefix: "Picture",
      dropTitle: "添加参考图",
      dropSub: "可多张 · PNG / JPG",
    }));
    mediaZone.appendChild(makeThumbSection({
      title: "参考音频",
      hint: "提示词用 &lt;Audio N&gt; 引用",
      target: "audio",
      items: media.audio,
      refPrefix: "Audio",
      dropTitle: "添加参考音频",
      dropSub: "可多个 · MP3 / WAV / M4A",
    }));
    if (isFlashModel()) {
      const note = el("div", "media-flash-note");
      note.textContent = "当前 flash 模型不支持视频参考，切换到标准模型 agnes-video-2.5 即可使用。";
      mediaZone.appendChild(note);
    } else {
      mediaZone.appendChild(makeVideoSection());
    }
  }
}

// 参考素材分区头（标题 + 引用提示）
function makeRefHead(title, hint) {
  const head = el("div", "ref-sec__head");
  const t = el("span", "ref-sec__title");
  t.textContent = title;
  const h = el("span", "ref-sec__hint");
  h.innerHTML = hint;
  head.append(t, h);
  return head;
}

// 图片 / 音频参考分区：缩略图网格 + 拖拽区 + 链接输入
function makeThumbSection(opts) {
  const sec = el("div", "ref-sec");
  sec.appendChild(makeRefHead(opts.title, opts.hint));
  if (opts.items.length) {
    const list = el("div", "media-list");
    opts.items.forEach((it, i) => list.appendChild(makeThumb(it, `<${opts.refPrefix} ${i + 1}>`)));
    sec.appendChild(list);
  }
  sec.appendChild(makeDrop(opts.target, opts.dropTitle, opts.dropSub));
  sec.appendChild(makeUrlRow(opts.target));
  return sec;
}

// 视频参考分区：每段视频可单独设置起始秒与是否要求音轨
function makeVideoSection() {
  const sec = el("div", "ref-sec");
  sec.appendChild(makeRefHead("参考视频", "提示词用 &lt;Video N&gt; 引用，可设置起始秒与是否需音轨"));
  if (media.video.length) {
    const list = el("div", "video-ref-list");
    media.video.forEach((it, i) => list.appendChild(makeVideoRow(it, i)));
    sec.appendChild(list);
  }
  sec.appendChild(makeDrop("video", "添加参考视频", "可多个 · MP4 / MOV / WebM"));
  sec.appendChild(makeUrlRow("video"));
  return sec;
}

function makeVideoRow(item, i) {
  const row = el("div", "video-ref");
  if (item.status === "uploading") row.classList.add("is-uploading");
  if (item.status === "error") row.classList.add("is-error");

  const badge = el("span", "video-ref__badge");
  badge.textContent = `<Video ${i + 1}>`;
  row.appendChild(badge);

  const name = el("span", "video-ref__name");
  name.textContent = item.status === "uploading" ? "上传中…" : item.status === "error" ? "上传失败" : (item.name || "参考视频");
  name.title = item.error || item.name || "";
  row.appendChild(name);

  // 起始秒
  const startField = el("label", "video-ref__field");
  const startLabel = el("span", "video-ref__label");
  startLabel.textContent = "起始(秒)";
  const startInput = el("input", "video-ref__num");
  startInput.type = "number";
  startInput.min = "0";
  startInput.step = "1";
  startInput.value = String(item.start_seconds || 0);
  startInput.disabled = item.status !== "ready";
  startInput.addEventListener("change", () => { item.start_seconds = Math.max(0, Number(startInput.value) || 0); });
  startField.append(startLabel, startInput);
  row.appendChild(startField);

  // 是否要求音轨
  const audioField = el("label", "video-ref__check");
  const audioInput = el("input");
  audioInput.type = "checkbox";
  audioInput.checked = !!item.require_audio;
  audioInput.disabled = item.status !== "ready";
  audioInput.addEventListener("change", () => { item.require_audio = audioInput.checked; });
  const audioText = el("span");
  audioText.textContent = "需音轨";
  audioField.append(audioInput, audioText);
  row.appendChild(audioField);

  const x = el("button", "video-ref__x");
  x.type = "button";
  x.textContent = "✕";
  x.title = "移除";
  x.addEventListener("click", () => removeItem(item));
  row.appendChild(x);
  return row;
}

function makeUrlRow(target) {
  const kind = TARGET_KIND[target] || "image";
  const row = el("div", "url-row");
  const input = el("input");
  input.type = "url";
  input.placeholder = TARGET_URL_PH[target] || TARGET_URL_PH.image;
  input.setAttribute("aria-label", "粘贴" + KIND_NOUN[kind] + "链接");
  const add = el("button", "tool-btn");
  add.type = "button";
  add.textContent = "添加";
  const doAdd = () => {
    const u = input.value.trim();
    if (!/^https?:\/\//.test(u)) { toast("请输入以 http(s):// 开头的链接", "err"); return; }
    const item = {
      id: uid(),
      name: u.split("/").pop() || KIND_NOUN[kind],
      type: kind + "/*",
      kind,
      url: u,
      preview: kind === "image" ? u : null,
      status: "ready",
      error: null,
      start_seconds: 0,
      require_audio: false,
    };
    if (target === "image") media.image = [item];
    else if (target === "multi") media.multi.push(item);
    else if (target === "audio") media.audio.push(item);
    else if (target === "video") media.video.push(item);
    input.value = "";
    renderMedia();
    renderChips();
    toast("已添加" + KIND_NOUN[kind] + "链接", "ok", 2000);
  };
  add.addEventListener("click", doAdd);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
  row.append(input, add);
  return row;
}

function addChip(label, name) {
  const c = el("button", "chip");
  c.type = "button";
  c.textContent = label;
  c.title = name || "";
  c.addEventListener("click", () => insertAtCursor(label));
  chipsEl.appendChild(c);
}

function renderChips() {
  chipsEl.innerHTML = "";
  if (currentMode !== "multi") return;
  media.multi.forEach((it, i) => addChip(`<Picture ${i + 1}>`, it.name));
  media.audio.forEach((it, i) => addChip(`<Audio ${i + 1}>`, it.name));
  if (!isFlashModel()) media.video.forEach((it, i) => addChip(`<Video ${i + 1}>`, it.name));
}

async function addFile(target, file) {
  const kind = TARGET_KIND[target] || "image";
  const item = {
    id: uid(),
    name: file.name,
    type: file.type,
    kind,
    url: null,
    preview: kind === "image" ? URL.createObjectURL(file) : null, // 音频/视频无静态预览图
    status: "uploading",
    error: null,
    start_seconds: 0,
    require_audio: false,
  };

  if (target === "image") media.image = [item];
  else if (target === "kfFirst") media.kfFirst = item;
  else if (target === "kfLast") media.kfLast = item;
  else if (target === "multi") media.multi.push(item);
  else if (target === "audio") media.audio.push(item);
  else if (target === "video") media.video.push(item);

  renderMedia();
  renderChips();

  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "上传失败");
    item.url = data.url;
    item.localUrl = data.localUrl || null; // 素材本地落盘地址（图床过期也不丢）
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
  media.audio = media.audio.filter((x) => x !== item);
  media.video = media.video.filter((x) => x !== item);
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
  if (window.CineStore) CineStore.persist("tasks");
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

// ---------------------------------------------------------------------------
// 视频库：独立于「生成队列」的已完成视频记录，清除队列不影响它
// ---------------------------------------------------------------------------
const LIBRARY_KEY = "agnes.studio.library.v1";

function readLibrary() {
  try {
    const l = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "[]");
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}

function writeLibrary(list) {
  try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(list)); } catch {}
  if (window.CineStore) CineStore.persist("library");
}

function addToLibrary(record) {
  if (!record || (!record.url && !record.videoId)) return;
  const list = readLibrary();
  const i = list.findIndex(
    (x) => (record.videoId && x.videoId === record.videoId) || (record.url && x.url === record.url)
  );
  let changed = false;
  if (i >= 0) {
    const merged = { ...list[i], ...record };
    if (JSON.stringify(merged) !== JSON.stringify(list[i])) { list[i] = merged; changed = true; }
  } else {
    list.unshift(record);
    changed = true;
  }
  if (changed) writeLibrary(list);
}

function taskToLibraryRecord(task) {
  return {
    id: task.id,
    videoId: task.videoId,
    group: "单镜生成",
    shotNo: null,
    scene: "",
    prompt: task.prompt || "",
    url: task.url,
    localUrl: task.localUrl || null,
    localFile: task.localFile || null,
    seconds: task.seconds,
    size: task.size,
    ratio: task.ratio,
    modeLabel: task.modeLabel || "文生视频",
    createdAt: task.createdAt || 0,
    thumb: task.thumb || null,
  };
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
  [...tasks].reverse().forEach((t) => {
    const card = makeTaskCard(t);
    taskList.appendChild(card);
    // 提示词未溢出两行时，隐藏「展开」按钮
    const prompt = card.querySelector(".task__prompt");
    const tools = card.querySelector(".task__prompt-tools");
    if (prompt && tools && prompt.classList.contains("is-collapsed")) {
      if (prompt.scrollHeight <= prompt.clientHeight + 1) {
        tools.style.display = "none";
        prompt.title = "";
      }
    }
  });
}

function makeTaskCard(task) {
  const card = el("div", "task");
  card.dataset.id = task.id;

  // 顶部（静态：不随轮询变化）
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

  // 实际请求体摘要：早期任务没存 request，取不到就不显示
  const apiTag = el("div", "task__api");
  apiTag.textContent = requestSummary(task.request);
  apiTag.hidden = !apiTag.textContent;

  // 提示词：默认收缩 2 行，点「展开」显示全文并可复制
  const promptBox = el("div", "task__prompt-box");
  const promptLine = el("div", "task__prompt is-collapsed");
  promptLine.textContent = task.prompt || "";
  promptLine.title = "点击展开 / 收起";

  const promptTools = el("div", "task__prompt-tools");
  const toggleBtn = el("button", "task__prompt-toggle");
  toggleBtn.type = "button";
  toggleBtn.textContent = "展开";
  const copyBtn = el("button", "task__prompt-toggle task__prompt-copy");
  copyBtn.type = "button";
  copyBtn.textContent = "复制";
  copyBtn.hidden = true;

  const isCollapsed = () => promptLine.classList.contains("is-collapsed");
  const setExpanded = (expanded) => {
    promptLine.classList.toggle("is-collapsed", !expanded);
    toggleBtn.textContent = expanded ? "收起" : "展开";
    copyBtn.hidden = !expanded;
  };
  toggleBtn.addEventListener("click", () => setExpanded(isCollapsed()));
  promptLine.addEventListener("click", () => setExpanded(isCollapsed()));
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(task.prompt || "");
      toast("提示词已复制", "ok");
    } catch {
      toast("复制失败，请手动选择复制", "err");
    }
  });

  promptTools.append(toggleBtn, copyBtn);
  promptBox.append(promptLine, promptTools);
  meta.append(modeTag, apiTag, promptBox);
  top.append(thumb, meta);
  card.appendChild(top);

  // 动态区域（状态 / 进度 / 视频 / 操作，随轮询就地更新）
  const body = el("div", "task__body");
  renderTaskBody(task, body);
  card.appendChild(body);
  return card;
}

function renderTaskBody(task, body) {
  body.innerHTML = "";
  const src = task.localUrl || task.url; // 优先本地文件，回退远程

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
  body.appendChild(statusRow);

  // 进度条
  if (task.status === "in_progress" || task.status === "queued") {
    const p = el("div", "progress");
    const bar = el("div", "progress__bar");
    bar.style.width = (task.progress || 0) + "%";
    p.appendChild(bar);
    body.appendChild(p);
  }

  // 视频预览
  if (task.status === "completed" && task.url) {
    const wrap = el("div", "task__video-wrap");
    const video = el("video");
    video.src = src;
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
    failLink.href = src;
    failLink.target = "_blank";
    failLink.rel = "noreferrer";
    failLink.textContent = "在新窗口打开";
    fail.append(failText, failLink);
    video.addEventListener("error", () => {
      video.style.display = "none";
      fail.hidden = false;
    });

    wrap.append(video, fail);
    body.appendChild(wrap);
  } else if (task.status === "completed" && !task.url) {
    const miss = el("div", "task__video-miss");
    const missText = el("span");
    missText.textContent = "任务已完成，但未获取到视频地址";
    const fetchBtn = el("button", "mini-btn");
    fetchBtn.type = "button";
    fetchBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>刷新获取`;
    fetchBtn.addEventListener("click", () => refreshTask(task));
    miss.append(missText, fetchBtn);
    body.appendChild(miss);
  }

  // 错误
  if (task.status === "failed" || task.status === "error") {
    const err = el("div", "task__error");
    err.textContent = task.error || "生成失败，请重试";
    body.appendChild(err);
  }

  // 操作
  const actions = el("div", "task__actions");

  if (task.status === "completed" && task.url) {
    const dl = el("a", "mini-btn");
    if (task.localUrl) {
      dl.href = task.localUrl;
      dl.setAttribute("download", (task.localFile || "video.mp4").split("/").pop());
    } else {
      dl.href = "/api/download?url=" + encodeURIComponent(task.url);
    }
    dl.title = "下载视频";
    dl.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 4v11m0 0 4-4m-4 4-4-4M4 19h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>下载`;
    actions.appendChild(dl);

    const open = el("a", "mini-btn");
    open.href = src;
    open.target = "_blank";
    open.rel = "noreferrer";
    open.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M7 17L17 7M9 7h8v8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>新窗口打开`;
    actions.appendChild(open);

    const copy = el("button", "mini-btn");
    copy.type = "button";
    copy.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" stroke-width="1.6"/></svg>复制链接`;
    const copyTarget = src.startsWith("/") ? location.origin + src : src;
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(copyTarget);
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

  body.appendChild(actions);
}

// 就地更新单个任务卡片的动态区域（不重建整个列表，避免闪烁）
function updateTask(task) {
  const card = document.querySelector('.task[data-id="' + task.id + '"]');
  if (!card) return;
  const body = card.querySelector(".task__body");
  if (body) renderTaskBody(task, body);
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
    model: currentModel, // 创建时选定模型，任务轮询沿用该模型
  };
  if (seedEl.value && seedEl.value.trim() !== "") body.seed = Number(seedEl.value);

  // 校验并附加媒体（只看当前模式的槽位：文生视频不该被别的模式里卡住的上传挡下）
  const pending = activeMedia().filter((x) => x && x.status === "uploading");
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
    // reference 模式：图片 / 音频 / 视频三类参考素材，至少一类非空
    const all = [...media.multi, ...media.audio, ...media.video];
    if (all.some((x) => x.status === "error")) return { error: "存在上传失败的素材，请移除后重试" };
    if (isFlashModel() && media.video.length)
      return { error: "当前 flash 模型不支持视频参考，请移除视频或切换为标准模型" };
    if (isFlashModel() && media.multi.length > 5)
      return { error: "flash 模型参考图片最多 5 张，请移除多余的图片" };

    const imgs = media.multi.map((x) => x.url);
    const auds = media.audio.map((x) => x.url);
    const vids = media.video.map((x) => ({
      url: x.url,
      start_seconds: Math.max(0, Number(x.start_seconds) || 0),
      require_audio: !!x.require_audio,
    }));
    if (!imgs.length && !auds.length && !vids.length)
      return { error: "请至少添加一类参考素材（图片 / 音频 / 视频）" };
    if (imgs.length) body.images = imgs;
    if (auds.length) body.audios = auds;
    if (vids.length) body.videos = vids;
  }
  return { body };
}

// 缩略图只能取本次请求真正发出去的素材。以前是 media.image[0] || kfFirst || ... 有啥拿啥，
// 结果「图生视频传过图 → 切回文生视频生成」的任务会挂着一张根本没发送的图，看着像图被发了。
function firstThumb() {
  const it = activeMedia()[0];
  return it ? it.localUrl || it.url || it.preview : null;
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
    model: requestBody.model || currentModel,
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
      // 沿用任务创建时的模型查询进度（切换模型不影响旧任务）
      const statusUrl = "/api/status?video_id=" + encodeURIComponent(task.videoId) +
        (task.model ? "&model_name=" + encodeURIComponent(task.model) : "");
      const res = await fetch(statusUrl);
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
      updateTask(task);
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
      updateTask(task);
      break;
    }
    await sleep(POLL_MS);
  }
  task.pollerActive = false;
  // 完成后：先记入视频库（与生成队列解耦），再自动下载到本地存储目录
  if (task.status === "completed" && task.url) {
    addToLibrary(taskToLibraryRecord(task));
    archiveTask(task);
  }
}

// 下载单个任务视频到本地存储目录，并记录 localUrl / localFile
async function archiveTask(task) {
  try {
    const res = await fetch("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        records: [
          {
            url: task.url,
            videoId: task.videoId,
            group: "单镜生成",
            shotNo: null,
            scene: "",
            prompt: task.prompt,
            seconds: task.seconds,
            size: task.size,
            ratio: task.ratio,
            createdAt: task.createdAt,
            thumb: task.thumb || null,
          },
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.saved && data.saved[0]) {
      task.localUrl = data.saved[0].localUrl;
      task.localFile = data.saved[0].file;
      saveTasks();
      updateTask(task);
      addToLibrary(taskToLibraryRecord(task)); // 同步本地化结果到视频库
    }
  } catch (e) {
    // 落盘失败不影响使用（仍可回退到远程地址）
    console.warn("[archive]", e.message);
  }
}

// 手动刷新单个任务状态（如已完成但未拿到视频地址时）
async function refreshTask(task) {
  try {
    const statusUrl = "/api/status?video_id=" + encodeURIComponent(task.videoId) +
      (task.model ? "&model_name=" + encodeURIComponent(task.model) : "");
    const res = await fetch(statusUrl);
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      task.status = data.status || task.status;
      task.progress = typeof data.progress === "number" ? data.progress : task.progress;
      task.url = extractUrl(data) || task.url || null;
      task.error = data.error?.message || data.error || null;
      saveTasks();
      updateTask(task);
      if (task.status === "completed" && task.url) {
        addToLibrary(taskToLibraryRecord(task));
        if (!task.localUrl) archiveTask(task);
        toast("已获取到视频", "ok", 1600);
      }
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
// 模型切换（顶栏下拉）：切换结果保存在服务端，对所有新生成的任务生效
// ---------------------------------------------------------------------------
function renderModelMenu() {
  modelMenu.innerHTML = "";
  const title = el("div", "model-menu__title");
  title.textContent = "选择模型";
  modelMenu.appendChild(title);

  // 确保当前使用的模型始终出现在列表里
  const models = modelList.includes(currentModel) ? modelList : [currentModel, ...modelList];
  models.forEach((m) => {
    const b = el("button", "model-menu__item" + (m === currentModel ? " is-active" : ""));
    b.type = "button";
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(m === currentModel));
    b.title = m;
    const span = el("span");
    span.textContent = m;
    b.appendChild(span);
    if (m === currentModel) {
      const check = el("span", "check");
      check.textContent = "✓";
      b.appendChild(check);
    }
    b.addEventListener("click", () => {
      closeModelMenu();
      if (m !== currentModel) switchModel(m);
    });
    modelMenu.appendChild(b);
  });

  modelMenu.appendChild(el("div", "model-menu__divider"));

  // 自定义模型：直接输入模型名使用
  const row = el("div", "model-menu__custom");
  const input = el("input");
  input.type = "text";
  input.placeholder = "自定义模型名称…";
  input.setAttribute("aria-label", "自定义模型名称");
  const ok = el("button", "tool-btn");
  ok.type = "button";
  ok.textContent = "使用";
  const applyCustom = () => {
    const v = input.value.trim();
    if (!v) {
      toast("请输入模型名称", "err", 2000);
      return;
    }
    closeModelMenu();
    if (!modelList.includes(v)) modelList.push(v);
    switchModel(v);
  };
  ok.addEventListener("click", applyCustom);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyCustom();
    }
  });
  row.append(input, ok);
  modelMenu.appendChild(row);
}

function openModelMenu() {
  // 顶栏的 mask-image 会把伸出顶栏的下拉菜单一起羽化成透明，菜单必须挂在 body 下定位
  if (modelMenu.parentElement !== document.body) document.body.appendChild(modelMenu);
  const r = modelBtn.getBoundingClientRect();
  modelMenu.style.top = Math.round(r.bottom + 8) + "px";
  modelMenu.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + "px";
  modelMenu.hidden = false;
  modelBtn.setAttribute("aria-expanded", "true");
}
function closeModelMenu() {
  modelMenu.hidden = true;
  modelBtn.setAttribute("aria-expanded", "false");
}

modelBtn.addEventListener("click", () => {
  if (modelMenu.hidden) {
    renderModelMenu();
    openModelMenu();
    loadModels(); // 打开时拉取最新可选模型列表
  } else {
    closeModelMenu();
  }
});

document.addEventListener("click", (e) => {
  // 菜单已挂在 body 下，按钮区域与菜单内部都不算「外部点击」
  const t = e.target;
  if (!modelMenu.hidden && !modelSwitch.contains(t) && !modelMenu.contains(t)) closeModelMenu();
});

async function switchModel(m) {
  const prev = currentModel;
  currentModel = m;
  modelNameEl.textContent = m;
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m }),
    });
    if (!res.ok) throw new Error();
    applySizeAvailability(); // 切换模型后刷新分辨率可用状态
    toast("模型已切换为 " + m, "ok", 2400);
  } catch {
    currentModel = prev;
    modelNameEl.textContent = prev;
    toast("模型切换失败", "err");
  }
}

// 从服务端拉取可选模型列表（上游 /models 代理，失败时回退当前模型）
async function loadModels() {
  try {
    const res = await fetch("/api/models");
    const data = await res.json();
    if (Array.isArray(data.models) && data.models.length) {
      modelList = [...new Set([currentModel, ...data.models])];
      if (!modelMenu.hidden) renderModelMenu();
    }
  } catch {
    // 拉取失败：保留下拉里的现有项与自定义入口
  }
}

// ---------------------------------------------------------------------------
// 设置与连接状态
// ---------------------------------------------------------------------------
async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    const data = await res.json();
    applyStatus(data);
    baseUrlInput.value = data.baseUrl || "";
    videoDirInput.value = data.videoDir || "";
    currentModel = data.model || DEFAULT_MODEL;
    modelNameEl.textContent = currentModel;
    applySizeAvailability(); // 按持久化的模型初始化分辨率可用状态
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
  if (e.key === "Escape") {
    if (!settingsModal.hidden) closeSettings();
    if (!modelMenu.hidden) closeModelMenu();
  }
});

$("#toggleKey").addEventListener("click", () => {
  const isPw = apiKeyInput.type === "password";
  apiKeyInput.type = isPw ? "text" : "password";
  $("#toggleKey").textContent = isPw ? "隐藏" : "显示";
});

$("#saveSettingsBtn").addEventListener("click", async () => {
  const payload = { baseUrl: baseUrlInput.value.trim() };
  if (apiKeyInput.value.trim()) payload.apiKey = apiKeyInput.value.trim();
  payload.videoDir = videoDirInput.value.trim();
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
