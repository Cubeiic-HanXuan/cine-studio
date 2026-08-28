/* ==========================================================================
   CineStudio — 已生成视频
   聚合「单镜生成」与「分镜脚本」里所有已完成的视频：
   按剧本分组、按时间排序、支持镜头编号、一键下载到磁盘、导出 CSV。
   复用 app.js 的全局工具 el / toast / esc，以及 task__prompt / mini-btn 样式。
   ========================================================================== */

"use strict";

const TASKS_KEY = "agnes.studio.tasks.v1";
const PROJECTS_KEY = "agnes.studio.projects.v1";

let videosGrouped = true; // 按剧本分组
let videosNewestFirst = true; // 时间排序

const videosList = document.getElementById("videosList");
const videosCount = document.getElementById("videosCount");
const videosGroupBtn = document.getElementById("videosGroupBtn");
const videosSortBtn = document.getElementById("videosSortBtn");
const videosDownloadAll = document.getElementById("videosDownloadAll");
const videosExportCsv = document.getElementById("videosExportCsv");

const FILM_SVG = `<svg viewBox="0 0 24 24" fill="none"><rect x="3.5" y="5" width="17" height="14" rx="2" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="M4.5 17l4.5-4.5 3.2 3.2 2.3-2.3 5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------------------------------------------------------------------------
// 聚合已完成视频
// ---------------------------------------------------------------------------
function collectRecords() {
  const records = [];

  // 1) 单镜生成
  try {
    const tasks = JSON.parse(localStorage.getItem(TASKS_KEY) || "[]");
    (Array.isArray(tasks) ? tasks : []).forEach((t) => {
      if (t && t.status === "completed" && t.url) {
        records.push({
          id: t.id,
          group: "单镜生成",
          shotNo: null,
          scene: "",
          prompt: t.prompt || "",
          url: t.url,
          seconds: t.seconds,
          size: t.size,
          ratio: t.ratio,
          modeLabel: t.modeLabel || "文生视频",
          createdAt: t.createdAt || 0,
          videoId: t.videoId || t.id || "",
          thumb: t.thumb || null,
        });
      }
    });
  } catch {}

  // 2) 分镜脚本
  try {
    const projects = JSON.parse(localStorage.getItem(PROJECTS_KEY) || "[]");
    (Array.isArray(projects) ? projects : []).forEach((p) => {
      (Array.isArray(p.shots) ? p.shots : []).forEach((s, i) => {
        if (s && s.task && s.task.status === "completed" && s.task.url) {
          records.push({
            id: s.id,
            group: p.name || "未命名剧本",
            shotNo: i + 1,
            scene: s.scene || "",
            prompt: s.description || "",
            url: s.task.url,
            seconds: s.seconds,
            size: p.size || "720P",
            ratio: p.aspect_ratio || "9:16",
            modeLabel: s.mode === "image" ? "图生视频" : "文生视频",
            createdAt: s.task.createdAt || p.updatedAt || 0,
            videoId: s.task.videoId || s.id || "",
            thumb: (s.refImage && s.refImage.url) || null,
          });
        }
      });
    });
  } catch {}

  return records;
}

function sortRecords(records) {
  return records.slice().sort((a, b) => {
    const diff = (b.createdAt || 0) - (a.createdAt || 0);
    return videosNewestFirst ? diff : -diff;
  });
}

function groupRecords(records) {
  const map = new Map();
  for (const r of records) {
    if (!map.has(r.group)) map.set(r.group, []);
    map.get(r.group).push(r);
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }));
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// 视频卡片
// ---------------------------------------------------------------------------
function makeVideoCard(r) {
  const card = el("div", "video-card");

  // 媒体区：缩略图，点击切换为内联预览
  const media = el("div", "video-card__media");
  const setFilm = () => (media.innerHTML = FILM_SVG);
  setFilm();
  if (r.thumb) {
    const img = el("img");
    img.src = r.thumb;
    img.alt = "";
    img.addEventListener("error", () => setFilm());
    img.addEventListener("load", () => { media.innerHTML = ""; media.appendChild(img); });
  }
  media.title = "点击预览视频";
  media.addEventListener("click", () => {
    if (media.querySelector("video")) return;
    const v = el("video");
    v.src = r.url;
    v.controls = true;
    v.autoplay = true;
    v.playsInline = true;
    media.innerHTML = "";
    media.appendChild(v);
  });

  // 信息区
  const info = el("div", "video-card__info");

  const head = el("div", "video-card__head");
  const no = el("div", "video-card__no");
  no.textContent = r.shotNo ? String(r.shotNo).padStart(2, "0") : "—";
  const scene = el("div", "video-card__scene");
  scene.textContent = r.scene || (r.shotNo ? "未命名镜头" : "单镜");
  const time = el("div", "video-card__time");
  time.textContent = formatTime(r.createdAt);
  head.append(no, scene, time);
  info.appendChild(head);

  // 提示词（复用收缩/展开样式）
  const promptBox = el("div", "task__prompt-box");
  const promptLine = el("div", "task__prompt is-collapsed");
  promptLine.textContent = r.prompt || "";
  promptLine.title = "点击展开 / 收起";
  const promptTools = el("div", "task__prompt-tools");
  const toggle = el("button", "task__prompt-toggle");
  toggle.type = "button";
  toggle.textContent = "展开";
  const copyPrompt = el("button", "task__prompt-toggle task__prompt-copy");
  copyPrompt.type = "button";
  copyPrompt.textContent = "复制";
  copyPrompt.hidden = true;

  const isCollapsed = () => promptLine.classList.contains("is-collapsed");
  const setExpanded = (e) => {
    promptLine.classList.toggle("is-collapsed", !e);
    toggle.textContent = e ? "收起" : "展开";
    copyPrompt.hidden = !e;
  };
  toggle.addEventListener("click", () => setExpanded(isCollapsed()));
  promptLine.addEventListener("click", () => setExpanded(isCollapsed()));
  copyPrompt.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(r.prompt || ""); toast("提示词已复制", "ok"); }
    catch { toast("复制失败", "err"); }
  });

  promptTools.append(toggle, copyPrompt);
  promptBox.append(promptLine, promptTools);
  info.appendChild(promptBox);

  // 元信息
  const meta = el("div", "video-card__meta");
  meta.textContent = `${r.modeLabel} · ${r.seconds || 5} 秒 · ${r.size || "720P"} · ${r.ratio || "16:9"}`;
  info.appendChild(meta);

  // 操作
  const actions = el("div", "task__actions");

  const dl = el("a", "mini-btn");
  dl.href = "/api/download?url=" + encodeURIComponent(r.url);
  dl.title = "下载视频";
  dl.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 4v11m0 0 4-4m-4 4-4-4M4 19h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>下载`;
  actions.appendChild(dl);

  const open = el("a", "mini-btn");
  open.href = r.url;
  open.target = "_blank";
  open.rel = "noreferrer";
  open.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M7 17L17 7M9 7h8v8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>新窗口打开`;
  actions.appendChild(open);

  const copyLink = el("button", "mini-btn");
  copyLink.type = "button";
  copyLink.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" stroke-width="1.6"/></svg>复制链接`;
  copyLink.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(r.url); toast("链接已复制", "ok"); }
    catch { toast("复制失败", "err"); }
  });
  actions.appendChild(copyLink);

  info.appendChild(actions);
  card.append(media, info);
  return card;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function renderVideos() {
  const records = collectRecords();
  videosCount.textContent = records.length ? `共 ${records.length} 个视频` : "";
  videosList.innerHTML = "";

  if (!records.length) {
    const empty = el("div", "empty");
    empty.innerHTML = `<div class="empty__film" aria-hidden="true">${FILM_SVG}</div>
      <p class="empty__title">还没有生成的视频</p>
      <p class="empty__sub">去「单镜生成」或「分镜脚本」生成视频后，这里会自动汇总</p>`;
    videosList.appendChild(empty);
    return;
  }

  const sorted = sortRecords(records);
  if (videosGrouped) {
    const groups = groupRecords(sorted);
    groups.forEach((g) => {
      const header = el("div", "video-group");
      header.innerHTML = `<span class="video-group__dot"></span><span class="video-group__name">${esc(g.name)}</span><span class="video-group__count">${g.items.length}</span>`;
      videosList.appendChild(header);
      g.items.forEach((r) => videosList.appendChild(makeVideoCard(r)));
    });
  } else {
    sorted.forEach((r) => videosList.appendChild(makeVideoCard(r)));
  }

  // 提示词未溢出时隐藏「展开」按钮
  videosList.querySelectorAll(".task__prompt.is-collapsed").forEach((p) => {
    const tools = p.parentElement.querySelector(".task__prompt-tools");
    if (tools && p.scrollHeight <= p.clientHeight + 1) {
      tools.style.display = "none";
      p.title = "";
    }
  });
}

// ---------------------------------------------------------------------------
// 一键下载全部到磁盘
// ---------------------------------------------------------------------------
const DOWNLOAD_ALL_HTML = `<span class="btn__idle"><svg viewBox="0 0 24 24" fill="none"><path d="M12 4v11m0 0 4-4m-4 4-4-4M4 19h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>一键下载全部到磁盘</span>`;

videosDownloadAll.addEventListener("click", async () => {
  const records = collectRecords();
  if (!records.length) { toast("没有可下载的视频", "err"); return; }

  videosDownloadAll.disabled = true;
  videosDownloadAll.textContent = "正在下载到磁盘…";
  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(data.error || "下载失败", "err", 5000); return; }
    toast(`已保存 ${data.saved} 个视频到磁盘（跳过 ${data.skipped} 个）`, "ok", 6000);
    toast(`保存目录：${data.dir}`, "info", 9000);
  } catch (err) {
    toast("下载失败：" + err.message, "err");
  } finally {
    videosDownloadAll.disabled = false;
    videosDownloadAll.innerHTML = DOWNLOAD_ALL_HTML;
  }
});

// ---------------------------------------------------------------------------
// 导出记录 CSV
// ---------------------------------------------------------------------------
videosExportCsv.addEventListener("click", () => {
  const records = collectRecords();
  if (!records.length) { toast("没有可导出的记录", "err"); return; }
  const rows = [["剧本", "镜头号", "场景", "提示词", "时长(秒)", "分辨率", "画幅", "生成时间", "原地址"]];
  records.forEach((r) => {
    rows.push([
      r.group, r.shotNo ?? "", r.scene || "", r.prompt || "",
      r.seconds ?? "", r.size || "", r.ratio || "", formatTime(r.createdAt), r.url,
    ]);
  });
  const csv = "\ufeff" + rows
    .map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = "已生成视频记录.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  toast("已导出记录 CSV", "ok");
});

// ---------------------------------------------------------------------------
// 分组 / 排序切换
// ---------------------------------------------------------------------------
videosGroupBtn.addEventListener("click", () => {
  videosGrouped = !videosGrouped;
  videosGroupBtn.classList.toggle("is-active", videosGrouped);
  videosGroupBtn.textContent = videosGrouped ? "按剧本分组" : "平铺列表";
  renderVideos();
});

videosSortBtn.addEventListener("click", () => {
  videosNewestFirst = !videosNewestFirst;
  videosSortBtn.textContent = videosNewestFirst ? "最新在前" : "最早在前";
  renderVideos();
});
