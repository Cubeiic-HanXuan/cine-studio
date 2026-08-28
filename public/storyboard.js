/* ==========================================================================
   CineStudio — 分镜脚本管理
   复用 app.js 的全局工具：el / toast / sleep / uid / esc / extractUrl
   以及 STATUS_LABEL / STATUS_TAG
   ========================================================================== */

"use strict";

const SB_KEY = "agnes.studio.projects.v1";
const POLL_SB_MS = 1500;

const SHOT_SIZES = ["远景", "全景", "中景", "近景", "特写"];
const CAMERA_MOVES = ["固定", "推", "拉", "摇", "移", "跟", "环绕"];
const SHOT_MODES = [
  { value: "text", label: "文生视频" },
  { value: "image", label: "图生视频" },
];
const SECONDS_OPTIONS = ["4", "5", "6", "8", "10", "12"];

let projects = [];
let currentProjectId = null;

// DOM
const singleView = document.getElementById("singleView");
const sbView = document.getElementById("storyboardView");
const sbList = document.getElementById("sbList");
const sbEmpty = document.getElementById("sbEmpty");
const sbProjectSelect = document.getElementById("sbProjectSelect");
const sbSize = document.getElementById("sbSize");
const sbAspect = document.getElementById("sbAspect");
const sbBatchBtn = document.getElementById("sbBatchGenerate");
const sbImportFile = document.getElementById("sbImportFile");

// ---------------------------------------------------------------------------
// 项目持久化
// ---------------------------------------------------------------------------
function loadProjects() {
  try {
    projects = JSON.parse(localStorage.getItem(SB_KEY) || "[]");
  } catch {
    projects = [];
  }
  if (!Array.isArray(projects)) projects = [];
  projects.forEach((p) =>
    (p.shots || []).forEach((s) => {
      if (s.task) s.task.pollerActive = false;
    })
  );
  if (!projects.length) projects = [newProject("我的短剧")];
  if (!projects.some((p) => p.id === currentProjectId)) {
    currentProjectId = projects[0].id;
  }
}

function saveProjects() {
  try { localStorage.setItem(SB_KEY, JSON.stringify(projects)); } catch {}
}

function currentProject() {
  return projects.find((p) => p.id === currentProjectId) || projects[0];
}

function newProject(name) {
  const now = Date.now();
  return {
    id: uid(),
    name: name || "未命名剧本",
    createdAt: now,
    updatedAt: now,
    size: "720P",
    aspect_ratio: "9:16",
    shots: [],
  };
}

function persist() {
  const p = currentProject();
  if (p) p.updatedAt = Date.now();
  saveProjects();
}

function normalizeShot(s) {
  return {
    id: s.id || uid(),
    scene: s.scene || "",
    shotSize: s.shotSize || "中景",
    cameraMove: s.cameraMove || "固定",
    description: s.description || "",
    dialogue: s.dialogue || "",
    seconds: s.seconds || 5,
    mode: s.mode === "image" ? "image" : "text",
    refImage: s.refImage && s.refImage.url ? { url: s.refImage.url, name: s.refImage.name || "" } : null,
    note: s.note || "",
    task: s.task && s.task.videoId ? { ...s.task, pollerActive: false } : null,
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function makeSelect(options, selectedValue) {
  const s = el("select");
  options.forEach((o) => {
    const opt = el("option");
    if (typeof o === "string") { opt.value = o; opt.textContent = o; }
    else { opt.value = o.value; opt.textContent = o.label; }
    s.appendChild(opt);
  });
  s.value = String(selectedValue);
  return s;
}

function shotEl(shot, sel) {
  const card = document.querySelector('.shot-card[data-id="' + shot.id + '"]');
  return card ? card.querySelector(sel) : null;
}

// ---------------------------------------------------------------------------
// 自定义弹窗（替代原生 prompt / confirm），Promise 风格：
//   hasInput=true  → 确定时 resolve 输入值（字符串），取消/关闭 resolve null
//   hasInput=false → 确定时 resolve true，取消/关闭 resolve false
// ---------------------------------------------------------------------------
function openDialog(opts) {
  const {
    title = "",
    message = "",
    inputLabel = "",
    inputValue = "",
    inputPlaceholder = "",
    confirmText = "确定",
    cancelText = "取消",
    danger = false,
    hasInput = false,
  } = opts;

  return new Promise((resolve) => {
    const mask = el("div", "dialog-mask");
    const card = el("div", "dialog-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");

    if (title) {
      const h = el("h3", "dialog-title");
      h.textContent = title;
      card.appendChild(h);
    }
    if (message) {
      const m = el("p", "dialog-message");
      m.innerHTML = message; // 允许传入 <b> 等简单标记
      card.appendChild(m);
    }

    let inputEl = null;
    if (hasInput) {
      if (inputLabel) {
        const lab = el("label", "dialog-label");
        lab.textContent = inputLabel;
        card.appendChild(lab);
      }
      inputEl = el("input", "dialog-input");
      inputEl.type = "text";
      inputEl.value = inputValue;
      inputEl.placeholder = inputPlaceholder || "";
      inputEl.autocomplete = "off";
      card.appendChild(inputEl);
    }

    const actions = el("div", "dialog-actions");
    const cancelBtn = el("button", "btn btn--ghost");
    cancelBtn.type = "button";
    cancelBtn.textContent = cancelText;
    const okBtn = el("button", "btn " + (danger ? "btn--danger" : "btn--primary"));
    okBtn.type = "button";
    okBtn.textContent = confirmText;
    actions.append(cancelBtn, okBtn);
    card.appendChild(actions);

    mask.appendChild(card);
    document.body.appendChild(mask);

    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onEsc);
      document.body.style.overflow = "";
      mask.remove();
      resolve(val);
    };

    cancelBtn.addEventListener("click", () => finish(hasInput ? null : false));
    okBtn.addEventListener("click", () => finish(hasInput ? (inputEl ? inputEl.value.trim() : "") : true));
    mask.addEventListener("click", (e) => { if (e.target === mask) finish(hasInput ? null : false); });

    function onEsc(e) {
      if (e.key === "Escape") finish(hasInput ? null : false);
    }
    document.addEventListener("keydown", onEsc);

    document.body.style.overflow = "hidden";
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); okBtn.click(); }
      });
    } else {
      okBtn.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function renderProjectSelect() {
  sbProjectSelect.innerHTML = "";
  projects.forEach((p) => {
    const opt = el("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sbProjectSelect.appendChild(opt);
  });
  sbProjectSelect.value = currentProjectId;
}

function renderStoryboard() {
  const proj = currentProject();
  if (!proj) return;
  sbSize.value = proj.size || "720P";
  sbAspect.value = proj.aspect_ratio || "9:16";
  sbList.innerHTML = "";
  if (!proj.shots.length) {
    sbList.appendChild(sbEmpty);
    return;
  }
  proj.shots.forEach((shot, i) => sbList.appendChild(makeShotCard(shot, i)));
}

function makeShotCard(shot, index) {
  const proj = currentProject();
  const card = el("div", "shot-card");
  card.dataset.id = shot.id;

  // ---- 头部 ----
  const head = el("div", "shot-head");
  const no = el("div", "shot-no");
  no.textContent = String(index + 1).padStart(2, "0");

  const scene = el("input", "shot-input shot-scene");
  scene.type = "text";
  scene.placeholder = "场景（如：咖啡馆内 / 雨夜街头）";
  scene.value = shot.scene || "";
  scene.addEventListener("input", () => { shot.scene = scene.value; persist(); });

  const sizeSel = makeSelect(SHOT_SIZES, shot.shotSize || "中景");
  sizeSel.classList.add("shot-select");
  sizeSel.title = "景别";
  sizeSel.addEventListener("change", () => { shot.shotSize = sizeSel.value; persist(); });

  const camSel = makeSelect(CAMERA_MOVES, shot.cameraMove || "固定");
  camSel.classList.add("shot-select");
  camSel.title = "运镜";
  camSel.addEventListener("change", () => { shot.cameraMove = camSel.value; persist(); });

  const secSel = makeSelect(SECONDS_OPTIONS, String(shot.seconds || 5));
  secSel.classList.add("shot-select");
  secSel.title = "时长（秒）";
  secSel.addEventListener("change", () => { shot.seconds = secSel.value; persist(); });

  const modeSel = makeSelect(SHOT_MODES, shot.mode || "text");
  modeSel.classList.add("shot-select");
  modeSel.title = "生成模式";

  head.append(no, scene, sizeSel, camSel, secSel, modeSel);

  // ---- 描述与台词 ----
  const body = el("div", "shot-body");
  const descWrap = el("div", "shot-field");
  const descLabel = el("label", "shot-label");
  descLabel.textContent = "画面描述（prompt）";
  const desc = el("textarea", "shot-textarea");
  desc.rows = 3;
  desc.placeholder = "主体与场景 · 动作 · 镜头语言 · 视觉风格 · 声音";
  desc.value = shot.description || "";
  desc.addEventListener("input", () => { shot.description = desc.value; persist(); });
  descWrap.append(descLabel, desc);

  const diaWrap = el("div", "shot-field");
  const diaLabel = el("label", "shot-label");
  diaLabel.textContent = "台词 / 旁白（仅脚本用，不注入模型）";
  const dia = el("textarea", "shot-textarea");
  dia.rows = 3;
  dia.placeholder = "角色对白或旁白";
  dia.value = shot.dialogue || "";
  dia.addEventListener("input", () => { shot.dialogue = dia.value; persist(); });
  diaWrap.append(diaLabel, dia);

  body.append(descWrap, diaWrap);

  // ---- 参考图 + 备注 ----
  const meta = el("div", "shot-meta");
  const mediaEl = el("div", "shot-media");
  const note = el("input", "shot-input shot-note");
  note.type = "text";
  note.placeholder = "备注（可选）";
  note.value = shot.note || "";
  note.addEventListener("input", () => { shot.note = note.value; persist(); });
  meta.append(mediaEl, note);

  // ---- 结果区 ----
  const resultEl = el("div", "shot-result");

  // ---- 操作 ----
  const actions = el("div", "shot-actions");
  const genBtn = el("button", "btn btn--primary");
  genBtn.type = "button";
  genBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor"/></svg>生成`;
  genBtn.addEventListener("click", () => generateShot(shot, genBtn));

  const upBtn = el("button", "mini-btn");
  upBtn.type = "button";
  upBtn.textContent = "↑ 上移";
  upBtn.title = "上移";
  upBtn.disabled = index === 0;
  upBtn.addEventListener("click", () => moveShot(shot.id, -1));

  const downBtn = el("button", "mini-btn");
  downBtn.type = "button";
  downBtn.textContent = "↓ 下移";
  downBtn.title = "下移";
  downBtn.disabled = index === proj.shots.length - 1;
  downBtn.addEventListener("click", () => moveShot(shot.id, 1));

  const delBtn = el("button", "mini-btn mini-btn--danger");
  delBtn.type = "button";
  delBtn.textContent = "删除";
  delBtn.addEventListener("click", async () => {
    const ok = await openDialog({
      title: "删除镜头",
      message: "确定删除该镜头吗？",
      confirmText: "删除",
      cancelText: "取消",
      danger: true,
    });
    if (ok) removeShot(shot.id);
  });

  actions.append(genBtn, upBtn, downBtn, delBtn);

  // ---- 组装 ----
  card.append(head, body, meta, resultEl, actions);

  // 模式切换：切换参考图区域的显示
  modeSel.addEventListener("change", () => {
    shot.mode = modeSel.value;
    persist();
    renderShotMedia(shot, mediaEl);
  });

  renderShotMedia(shot, mediaEl);
  renderShotResult(shot, resultEl);
  return card;
}

// ---------------------------------------------------------------------------
// 参考图
// ---------------------------------------------------------------------------
const refInput = document.createElement("input");
refInput.type = "file";
refInput.accept = "image/*";
refInput.style.display = "none";
document.body.appendChild(refInput);
let refTarget = null;

refInput.addEventListener("change", async () => {
  const f = refInput.files[0];
  const target = refTarget;
  refTarget = null;
  if (!f || !target) return;

  target.refImage = { url: URL.createObjectURL(f), name: f.name, uploading: true };
  renderShotMedia(target, shotEl(target, ".shot-media"));

  const form = new FormData();
  form.append("file", f);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "上传失败");
    target.refImage = { url: data.url, name: data.name, uploading: false };
  } catch (err) {
    target.refImage = null;
    toast("参考图上传失败：" + err.message, "err", 5000);
  }
  persist();
  renderShotMedia(target, shotEl(target, ".shot-media"));
});

function pickRefImage(shot) {
  refTarget = shot;
  refInput.value = "";
  refInput.click();
}

function renderShotMedia(shot, mediaEl) {
  if (!mediaEl) return;
  mediaEl.innerHTML = "";
  if (shot.mode !== "image") {
    const hint = el("div", "shot-media-hint");
    hint.textContent = "文生视频 · 无需参考图";
    mediaEl.appendChild(hint);
    return;
  }
  if (shot.refImage?.url) {
    const thumb = el("div", "shot-media-thumb" + (shot.refImage.uploading ? " is-uploading" : ""));
    const img = el("img");
    img.src = shot.refImage.url;
    img.alt = shot.refImage.name || "";
    thumb.appendChild(img);
    const x = el("button", "thumb__x");
    x.type = "button";
    x.textContent = "✕";
    x.title = "移除参考图";
    x.addEventListener("click", () => {
      shot.refImage = null;
      persist();
      renderShotMedia(shot, shotEl(shot, ".shot-media"));
    });
    thumb.appendChild(x);
    mediaEl.appendChild(thumb);
  } else {
    const drop = el("button", "shot-media-drop");
    drop.type = "button";
    drop.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 16V5m0 0L7.5 9.5M12 5l4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>上传首帧参考图`;
    drop.addEventListener("click", () => pickRefImage(shot));
    mediaEl.appendChild(drop);
  }
}

// ---------------------------------------------------------------------------
// 结果回填
// ---------------------------------------------------------------------------
function renderShotResult(shot, resultEl) {
  if (!resultEl) return;
  resultEl.innerHTML = "";
  const t = shot.task;
  if (!t) return;

  const statusRow = el("div", "shot-result__status");
  const tag = el("span", "tag tag--" + (STATUS_TAG[t.status] || "queued"));
  tag.textContent = STATUS_LABEL[t.status] || t.status || "…";
  statusRow.appendChild(tag);
  if (t.status === "queued" || t.status === "in_progress") {
    const pct = el("span", "task__pct");
    pct.textContent = (t.progress || 0) + "%";
    statusRow.appendChild(pct);
  }
  resultEl.appendChild(statusRow);

  if (t.status === "queued" || t.status === "in_progress") {
    const p = el("div", "progress");
    const bar = el("div", "progress__bar");
    bar.style.width = (t.progress || 0) + "%";
    p.appendChild(bar);
    resultEl.appendChild(p);
  }

  if (t.status === "completed" && t.url) {
    const wrap = el("div", "task__video-wrap");
    const video = el("video");
    video.src = t.url;
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    if (shot.refImage?.url && !shot.refImage.uploading) video.poster = shot.refImage.url;
    video.style.aspectRatio = ((currentProject()?.aspect_ratio || "9:16")).replace(":", " / ");
    wrap.appendChild(video);
    resultEl.appendChild(wrap);

    const acts = el("div", "task__actions");
    const dl = el("a", "mini-btn");
    dl.href = "/api/download?url=" + encodeURIComponent(t.url);
    dl.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 4v11m0 0 4-4m-4 4-4-4M4 19h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>下载`;
    acts.appendChild(dl);

    const open = el("a", "mini-btn");
    open.href = t.url;
    open.target = "_blank";
    open.rel = "noreferrer";
    open.textContent = "新窗口打开";
    acts.appendChild(open);

    const copy = el("button", "mini-btn");
    copy.type = "button";
    copy.textContent = "复制链接";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(t.url); toast("链接已复制", "ok"); }
      catch { toast("复制失败", "err"); }
    });
    acts.appendChild(copy);
    resultEl.appendChild(acts);
  }

  if (t.status === "failed" || t.status === "error") {
    const err = el("div", "task__error");
    err.textContent = t.error || "生成失败";
    resultEl.appendChild(err);
    const retry = el("button", "mini-btn");
    retry.type = "button";
    retry.textContent = "重试";
    retry.addEventListener("click", () => generateShot(shot));
    resultEl.appendChild(retry);
  }
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------
function buildShotRequest(shot) {
  const proj = currentProject();
  const description = (shot.description || "").trim();
  if (!description) return { error: "请先填写「画面描述」" };
  const mode = shot.mode || "text";
  const body = {
    prompt: description,
    seconds: String(shot.seconds || 5),
    size: proj.size || "720P",
    aspect_ratio: proj.aspect_ratio || "9:16",
    mode: mode === "image" ? "keyframe" : "text",
  };
  if (mode === "image") {
    if (!shot.refImage?.url || shot.refImage.uploading) return { error: "图生视频需要先上传参考图" };
    body.first_frame = shot.refImage.url;
  }
  return { body };
}

async function generateShot(shot, genBtn, opts) {
  if (shot.task && ["queued", "in_progress"].includes(shot.task.status)) {
    toast("该镜头已在生成中", "info", 2000);
    return;
  }
  const { body, error } = buildShotRequest(shot);
  if (error) { toast("镜头「" + (shot.scene || shot.description || "?") + "」" + error, "err"); return; }

  if (genBtn) { genBtn.disabled = true; genBtn.classList.add("is-busy"); }

  try {
    const res = await fetch("/api/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(data.error || "创建失败", "err", 5000); return; }
    const videoId = data.video_id || data.id || data.task_id;
    if (!videoId) { toast("响应缺少 video_id", "err"); return; }

    shot.task = {
      videoId,
      taskId: data.id || data.task_id || videoId,
      status: data.status || "queued",
      progress: data.progress || 0,
      url: null,
      error: null,
      pollerActive: false,
      createdAt: Date.now(),
    };
    persist();
    renderShotResult(shot, shotEl(shot, ".shot-result"));
    if (!opts?.silent) toast("镜头已提交生成", "ok", 2000);
    pollShot(shot);
  } catch (err) {
    toast("创建失败：" + err.message, "err");
  } finally {
    if (genBtn) { genBtn.disabled = false; genBtn.classList.remove("is-busy"); }
  }
}

async function pollShot(shot) {
  const t = shot.task;
  if (!t || t.pollerActive) return;
  t.pollerActive = true;
  let backoff = 2000;

  while (true) {
    try {
      const res = await fetch("/api/status?video_id=" + encodeURIComponent(t.videoId));
      if (res.status === 429) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 15000);
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        backoff = 2000;
        t.status = data.status || t.status;
        t.progress = typeof data.progress === "number" ? data.progress : t.progress;
        t.url = extractUrl(data) || t.url || null;
        t.error = data.error?.message || data.error || null;
      } else {
        t.status = "error";
        t.error = data.error || "查询失败（HTTP " + res.status + "）";
      }
      persist();
      renderShotResult(shot, shotEl(shot, ".shot-result"));
      if (t.status === "completed") { toast("镜头生成完成 🎬", "ok", 2000); break; }
      if (t.status === "failed" || t.status === "error") break;
    } catch (err) {
      t.status = "error";
      t.error = err.message;
      persist();
      renderShotResult(shot, shotEl(shot, ".shot-result"));
      break;
    }
    await sleep(POLL_SB_MS);
  }
  t.pollerActive = false;
}

async function batchGenerate() {
  const proj = currentProject();
  if (!proj) return;
  const pending = proj.shots.filter((s) => !(s.task && s.task.status === "completed" && s.task.url));
  if (!pending.length) { toast("所有镜头均已生成", "info"); return; }

  for (let i = 0; i < pending.length; i++) {
    const s = pending[i];
    if (s.task && ["queued", "in_progress"].includes(s.task.status)) continue; // 已在生成中，跳过
    const { error } = buildShotRequest(s);
    if (error) { toast("第 " + (proj.shots.indexOf(s) + 1) + " 镜：" + error, "err"); return; }
  }

  const toGen = pending.filter((s) => !(s.task && ["queued", "in_progress"].includes(s.task.status)));
  if (!toGen.length) { toast("剩余镜头都已在生成中", "info"); return; }

  setBatchBusy(true);
  toast("开始批量生成 " + toGen.length + " 个镜头…", "info", 2600);
  for (const s of toGen) {
    await generateShot(s, null, { silent: true });
    await sleep(1500); // 拉开创建间隔，避免触发限流
  }
  setBatchBusy(false);
}

function setBatchBusy(b) {
  sbBatchBtn.disabled = b;
  sbBatchBtn.classList.toggle("is-busy", b);
  if (b) sbBatchBtn.textContent = "批量生成中…";
  else sbBatchBtn.innerHTML = `<span class="btn__idle"><svg viewBox="0 0 24 24" fill="none"><path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor"/></svg>一键批量生成</span>`;
}

// ---------------------------------------------------------------------------
// 镜头增删排序
// ---------------------------------------------------------------------------
function addShot() {
  const proj = currentProject();
  if (!proj) return;
  proj.shots.push({
    id: uid(),
    scene: "",
    shotSize: "中景",
    cameraMove: "固定",
    description: "",
    dialogue: "",
    seconds: 5,
    mode: "text",
    refImage: null,
    note: "",
    task: null,
  });
  persist();
  renderStoryboard();
}

function moveShot(id, dir) {
  const proj = currentProject();
  const i = proj.shots.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= proj.shots.length) return;
  const [s] = proj.shots.splice(i, 1);
  proj.shots.splice(j, 0, s);
  persist();
  renderStoryboard();
}

function removeShot(id) {
  const proj = currentProject();
  proj.shots = proj.shots.filter((s) => s.id !== id);
  persist();
  renderStoryboard();
}

// ---------------------------------------------------------------------------
// 项目 CRUD
// ---------------------------------------------------------------------------
async function addProject() {
  const name = await openDialog({
    title: "新建剧本",
    inputLabel: "剧本名称",
    inputValue: "我的短剧",
    inputPlaceholder: "输入剧本名称",
    confirmText: "创建",
    hasInput: true,
  });
  if (name == null) return;
  const p = newProject(name || "未命名剧本");
  projects.push(p);
  currentProjectId = p.id;
  saveProjects();
  renderProjectSelect();
  renderStoryboard();
}

async function renameProject() {
  const p = currentProject();
  if (!p) return;
  const name = await openDialog({
    title: "重命名剧本",
    inputLabel: "剧本名称",
    inputValue: p.name,
    inputPlaceholder: "输入剧本名称",
    confirmText: "保存",
    hasInput: true,
  });
  if (name == null) return;
  p.name = name || p.name;
  persist();
  renderProjectSelect();
}

async function deleteProject() {
  const p = currentProject();
  if (!p) return;
  const ok = await openDialog({
    title: "删除剧本",
    message: `确定删除剧本「<b>${esc(p.name)}</b>」吗？其中的所有镜头也会一并删除，此操作不可撤销。`,
    confirmText: "删除",
    cancelText: "取消",
    danger: true,
  });
  if (!ok) return;
  projects = projects.filter((x) => x.id !== p.id);
  if (!projects.length) projects = [newProject("我的短剧")];
  currentProjectId = projects[0].id;
  saveProjects();
  renderProjectSelect();
  renderStoryboard();
}

function exportProject() {
  const p = currentProject();
  if (!p) return;
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = (p.name || "project").replace(/[\\/:*?"<>|]/g, "_") + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  toast("已导出剧本 JSON", "ok");
}

function importProject() {
  sbImportFile.click();
}

sbImportFile.addEventListener("change", async () => {
  const f = sbImportFile.files[0];
  sbImportFile.value = "";
  if (!f) return;
  try {
    const text = await f.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.shots)) throw new Error("文件缺少 shots 数组");
    const p = newProject(data.name || f.name.replace(/\.json$/i, ""));
    p.shots = (data.shots || []).map(normalizeShot);
    p.size = data.size || "720P";
    p.aspect_ratio = data.aspect_ratio || "9:16";
    projects.push(p);
    currentProjectId = p.id;
    saveProjects();
    renderProjectSelect();
    renderStoryboard();
    toast("已导入剧本「" + p.name + "」（" + p.shots.length + " 个镜头）", "ok");
  } catch (err) {
    toast("导入失败：" + err.message, "err");
  }
});

// ---------------------------------------------------------------------------
// 视图切换
// ---------------------------------------------------------------------------
document.querySelectorAll(".view-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".view-tab").forEach((t) => {
      const active = t === tab;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", String(active));
    });
    const view = tab.dataset.view;
    singleView.hidden = view !== "single";
    sbView.hidden = view !== "storyboard";
    const vv = document.getElementById("videosView");
    if (vv) vv.hidden = view !== "videos";
    if (view === "storyboard") renderStoryboard();
    if (view === "videos" && typeof renderVideos === "function") renderVideos();
  });
});

// ---------------------------------------------------------------------------
// 事件绑定与初始化
// ---------------------------------------------------------------------------
sbProjectSelect.addEventListener("change", () => {
  currentProjectId = sbProjectSelect.value;
  saveProjects();
  renderStoryboard();
});

sbSize.addEventListener("change", () => { const p = currentProject(); p.size = sbSize.value; persist(); });
sbAspect.addEventListener("change", () => { const p = currentProject(); p.aspect_ratio = sbAspect.value; persist(); });

document.getElementById("sbNewProject").addEventListener("click", addProject);
document.getElementById("sbRenameProject").addEventListener("click", renameProject);
document.getElementById("sbDeleteProject").addEventListener("click", deleteProject);
document.getElementById("sbExport").addEventListener("click", exportProject);
document.getElementById("sbImport").addEventListener("click", importProject);
document.getElementById("sbAddShot").addEventListener("click", addShot);
sbBatchBtn.addEventListener("click", batchGenerate);

function initStoryboard() {
  loadProjects();
  renderProjectSelect();
  renderStoryboard();
  // 恢复未完成镜头的轮询
  projects.forEach((p) =>
    p.shots.forEach((s) => {
      if (s.task && ["queued", "in_progress"].includes(s.task.status)) pollShot(s);
    })
  );
}

initStoryboard();
