/* ==========================================================================
   CineStudio — 服务端持久化引导
   职责：
     1. 启动时从服务端拉取业务数据（生成队列 / 分镜脚本 / 已生成视频库），
        回写进 localStorage，让现有各模块的同步 load 逻辑原样可用；
     2. 服务端无数据而本地有 → 一次性把 localStorage 迁移到服务端；
     3. 提供 CineStore.persist(collection)，各模块保存时防抖同步到服务端；
     4. 数据就绪后，按序动态加载 app.js → storyboard.js → videos.js。
   ========================================================================== */

"use strict";

(function () {
  const KEYS = {
    tasks: "agnes.studio.tasks.v1",
    projects: "agnes.studio.projects.v1",
    library: "agnes.studio.library.v1",
  };

  function readLocal(key) {
    try {
      const v = JSON.parse(localStorage.getItem(KEYS[key]) || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  function writeLocal(key, value) {
    try {
      localStorage.setItem(KEYS[key], JSON.stringify(Array.isArray(value) ? value : []));
    } catch {}
  }

  async function postState(body) {
    try {
      await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.warn("[store] 同步到服务端失败：", err.message);
    }
  }

  // 从服务端加载并回写 localStorage；必要时执行一次性迁移
  async function load() {
    let state = null;
    try {
      const res = await fetch("/api/state");
      if (res.ok) state = await res.json();
    } catch (err) {
      console.warn("[store] 无法连接服务端，使用本地缓存：", err.message);
    }
    if (!state) return; // 服务端不可用：退回纯 localStorage

    // 一次性迁移：服务端还没有存过数据，而浏览器本地有 → 上传本地数据
    if (!state.exists) {
      const local = {
        tasks: readLocal("tasks"),
        projects: readLocal("projects"),
        library: readLocal("library"),
      };
      if (local.tasks.length || local.projects.length || local.library.length) {
        await postState(local);
        state = { ...state, ...local };
      }
    }

    // 服务端为准，回写 localStorage 供现有同步 load 使用
    writeLocal("tasks", state.tasks);
    writeLocal("projects", state.projects);
    writeLocal("library", state.library);
  }

  // 防抖持久化：把指定集合的最新值（从 localStorage 读）同步到服务端
  const timers = {};
  function persist(collection) {
    if (!KEYS[collection]) return;
    clearTimeout(timers[collection]);
    timers[collection] = setTimeout(() => {
      postState({ [collection]: readLocal(collection) });
    }, 400);
  }

  window.CineStore = { load, persist };

  // 启动引导：数据就绪后按序加载业务脚本
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("加载失败: " + src));
      document.body.appendChild(s);
    });
  }

  (async function boot() {
    try {
      await load();
    } catch (err) {
      console.warn("[store] 初始化失败：", err.message);
    }
    for (const src of ["app.js", "storyboard.js", "videos.js"]) {
      try {
        await loadScript(src);
      } catch (err) {
        console.error(err.message);
      }
    }
  })();
})();
