(() => {
  const app = document.getElementById("app");
  const feed = document.getElementById("feed");
  const empty = document.getElementById("empty");
  const folderLabel = document.getElementById("folder-label");
  const countLabel = document.getElementById("count-label");
  const playPos = document.getElementById("play-pos");
  const hint = document.getElementById("hint");
  const btnFolder = document.getElementById("btn-folder");
  const btnMenu = document.getElementById("btn-menu");
  const topbar = document.querySelector(".topbar");
  const btnCloseSettings = document.getElementById("btn-close-settings");
  const btnEmptySettings = document.getElementById("btn-empty-settings");
  const settings = document.getElementById("settings");
  const settingsMask = document.getElementById("settings-mask");
  const timeCur = document.getElementById("time-cur");
  const timeTotal = document.getElementById("time-total");
  const timeFill = document.getElementById("time-fill");
  const hudBar = document.getElementById("hud-bar");
  const hudThumb = document.getElementById("hud-thumb");
  const btnMode = document.getElementById("btn-mode");
  const hud = document.getElementById("hud");

  if (!app || !feed || !hud) return;

  const TAIL_SKIP = 3.5;
  const MODE_KEY = "ttk_play_mode";
  const CHROME_IDLE_MS = 2200;
  const DRAG_CLICK_PX = 8;

  let videos = [];
  let index = 0;
  let listSig = "";
  let busy = false;
  let dragY = 0;
  let dragging = false;
  let dragMoved = false;
  let startY = 0;
  let startT = 0;
  let settingsOpen = false;
  let scrubbing = false;
  let refreshInFlight = false;
  let chromeVisible = false;
  let chromeHideTimer = null;
  let fitInFlight = false;
  let lastFitKey = "";
  // single = 单集循环；list = 列表循环（默认列表循环）
  let playMode = localStorage.getItem(MODE_KEY) === "single" ? "single" : "list";

  const slides = {
    prev: null,
    curr: null,
    next: null,
  };

  function syncModeButton() {
    if (!btnMode) return;
    btnMode.textContent = playMode === "list" ? "列表循环" : "单集循环";
  }

  /** 向下取整后格式化为 00:00:00（时:分:秒） */
  function formatHMS(seconds) {
    let n = Math.floor(Number(seconds));
    if (!Number.isFinite(n) || n < 0) n = 0;
    const hh = Math.floor(n / 3600);
    const mm = Math.floor((n % 3600) / 60);
    const ss = n % 60;
    const p2 = (x) => (x < 10 ? "0" + x : String(x));
    return p2(hh) + ":" + p2(mm) + ":" + p2(ss);
  }

  function activeVideo() {
    return slides.curr && slides.curr.querySelector("video");
  }

  function playableDuration(video) {
    const d = video && video.duration;
    return Number.isFinite(d) ? Math.max(0, d - TAIL_SKIP) : 0;
  }

  function setProgressUI(ratio, curSec, totalSec) {
    if (!timeFill || !hudThumb || !timeCur || !hudBar) return;
    const pct = Math.max(0, Math.min(100, Number(ratio) * 100 || 0));
    const pctStr = pct.toFixed(2) + "%";
    timeFill.style.width = pctStr;
    hudThumb.style.left = pctStr;
    timeCur.textContent = formatHMS(curSec);
    if (totalSec != null && timeTotal) timeTotal.textContent = formatHMS(totalSec);
    hudBar.setAttribute("aria-valuenow", String(Math.round(pct)));
  }

  let hudTimer = null;

  function stopHudTimer() {
    if (hudTimer != null) {
      clearInterval(hudTimer);
      hudTimer = null;
    }
  }

  function startHudTimer() {
    stopHudTimer();
    updateHud();
    hudTimer = setInterval(updateHud, 200);
  }

  function updateHud() {
    if (scrubbing) return;
    const video = activeVideo();
    if (!video) {
      setProgressUI(0, 0, 0);
      return;
    }
    const playable = playableDuration(video);
    let cur = video.currentTime || 0;
    if (!Number.isFinite(cur) || cur < 0) cur = 0;
    if (cur > playable) cur = playable;
    const ratio = playable > 0 ? cur / playable : 0;
    setProgressUI(ratio, Math.floor(cur), Math.floor(playable));
  }

  function showChrome(sticky) {
    chromeVisible = true;
    app.classList.add("show-chrome");
    if (hud) hud.setAttribute("aria-hidden", "false");
    if (chromeHideTimer != null) {
      clearTimeout(chromeHideTimer);
      chromeHideTimer = null;
    }
    if (sticky || scrubbing || settingsOpen) return;
    chromeHideTimer = window.setTimeout(hideChrome, CHROME_IDLE_MS);
  }

  function hideChrome() {
    if (scrubbing || settingsOpen) return;
    chromeVisible = false;
    app.classList.remove("show-chrome");
    if (hud) hud.setAttribute("aria-hidden", "true");
    if (chromeHideTimer != null) {
      clearTimeout(chromeHideTimer);
      chromeHideTimer = null;
    }
  }

  function bumpChrome() {
    showChrome(false);
  }

  function applyLayoutMode(layout) {
    const fit = layout === "fit";
    app.classList.toggle("layout-fit", fit);
    app.classList.toggle("layout-portrait", !fit);
  }

  /** 按当前片比例调窗口；非竖版时底部留出控件区 */
  async function fitWindowToVideo(video) {
    if (!video) return;
    const vw = video.videoWidth | 0;
    const vh = video.videoHeight | 0;
    if (vw <= 0 || vh <= 0) return;

    const key = `${vw}x${vh}`;
    if (key === lastFitKey && !fitInFlight) {
      // 同尺寸也确保 class 正确（例如重建 DOM 后）
      applyLayoutMode(vw / vh <= 0.72 ? "portrait" : "fit");
      return;
    }

    fitInFlight = true;
    try {
      let layout = vw / vh <= 0.72 ? "portrait" : "fit";
      if (
        window.pywebview &&
        window.pywebview.api &&
        typeof window.pywebview.api.resize_for_video === "function"
      ) {
        const res = await window.pywebview.api.resize_for_video(vw, vh);
        if (res && res.ok && res.layout) layout = res.layout;
      }
      lastFitKey = key;
      applyLayoutMode(layout);
    } catch (_) {
      applyLayoutMode(vw / vh <= 0.72 ? "portrait" : "fit");
    } finally {
      fitInFlight = false;
    }
  }

  function seekFromClientX(clientX) {
    const video = activeVideo();
    if (!video || !hudBar) return;
    const playable = playableDuration(video);
    const rect = hudBar.getBoundingClientRect();
    const w = rect.width || 1;
    let ratio = (clientX - rect.left) / w;
    if (ratio < 0) ratio = 0;
    if (ratio > 1) ratio = 1;
    const t = playable * ratio;
    setProgressUI(ratio, Math.floor(t), Math.floor(playable));
    try {
      video.currentTime = t;
    } catch (_) {}
  }

  function onScrubStart(e) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    scrubbing = true;
    showChrome(true);
    hud.classList.add("is-scrubbing");
    hudBar.classList.add("is-scrubbing");
    seekFromClientX(e.clientX);
    if (hudBar.setPointerCapture) {
      try {
        hudBar.setPointerCapture(e.pointerId);
      } catch (_) {}
    }
  }

  function onScrubMove(e) {
    if (!scrubbing) return;
    e.preventDefault();
    seekFromClientX(e.clientX);
  }

  function onScrubEnd(e) {
    if (!scrubbing) return;
    if (e) seekFromClientX(e.clientX);
    scrubbing = false;
    hud.classList.remove("is-scrubbing");
    hudBar.classList.remove("is-scrubbing");
    updateHud();
    showChrome(false);
  }

  function onReachTail(video) {
    clampIndex();
    if (playMode === "list" && videos.length > 1) {
      go(1);
      return;
    }
    try {
      video.currentTime = 0;
    } catch (_) {}
    video.play().catch(() => {});
  }

  function shortPath(p) {
    if (!p) return "未选择";
    return String(p);
  }

  function openSettings() {
    settingsOpen = true;
    settings.classList.add("open");
    settings.setAttribute("aria-hidden", "false");
    settingsMask.classList.remove("hidden");
    settingsMask.setAttribute("aria-hidden", "false");
    if (topbar) topbar.classList.add("is-open");
    showChrome(true);
  }

  function closeSettings() {
    settingsOpen = false;
    settings.classList.remove("open");
    settings.setAttribute("aria-hidden", "true");
    settingsMask.classList.add("hidden");
    settingsMask.setAttribute("aria-hidden", "true");
    if (topbar) topbar.classList.remove("is-open");
    showChrome(false);
  }

  async function apiList() {
    const r = await fetch("/api/list", { cache: "no-store" });
    if (!r.ok) throw new Error("list " + r.status);
    return r.json();
  }

  function videosSignature(list) {
    return (list || []).map((v) => v.id + ":" + (v.size || 0)).join("\n");
  }

  function clampIndex() {
    if (!videos.length) {
      index = 0;
      return;
    }
    if (!Number.isFinite(index) || index < 0) index = 0;
    if (index >= videos.length) index = videos.length - 1;
  }

  function syncPlayPos() {
    if (!playPos) return;
    if (!videos.length) {
      playPos.textContent = "0/0";
      return;
    }
    clampIndex();
    playPos.textContent = `${index + 1}/${videos.length}`;
  }

  function updateSlideCaption(el, v, i) {
    if (!el || !v) return;
    const name = el.querySelector(".name");
    const idx = el.querySelector(".idx");
    if (name) name.textContent = v.name;
    if (idx) idx.textContent = `${i + 1} / ${videos.length}`;
  }

  /** 列表变了但当前片还在：只换邻项与序号，不碰正在播的 video */
  function softSyncFeed() {
    clampIndex();
    const currV = videos[index];
    if (!currV) {
      clearFeed();
      syncPlayPos();
      return;
    }
    if (!slides.curr || slides.curr.dataset.id !== currV.id) {
      rebuild();
      return;
    }

    updateSlideCaption(slides.curr, currV, index);

    if (slides.prev) {
      slides.prev.remove();
      slides.prev = null;
    }
    if (slides.next) {
      slides.next.remove();
      slides.next = null;
    }

    if (videos.length < 2) {
      syncPlayPos();
      return;
    }

    const pIdx = (index - 1 + videos.length) % videos.length;
    const nIdx = (index + 1) % videos.length;
    slides.prev = makeSlide(videos[pIdx], "prev");
    slides.next = makeSlide(videos[nIdx], "next");
    updateSlideCaption(slides.prev, videos[pIdx], pIdx);
    updateSlideCaption(slides.next, videos[nIdx], nIdx);
    feed.insertBefore(slides.prev, slides.curr);
    feed.appendChild(slides.next);
    syncPlayPos();
  }

  /** 静默刷新：不打断当前播放；删当前片才重建 */
  function applyListQuiet(data) {
    const next = Array.isArray(data && data.videos) ? data.videos : [];
    if (folderLabel) folderLabel.textContent = shortPath(data && data.folder);
    if (countLabel) countLabel.textContent = `${next.length} 个视频`;

    const sig = videosSignature(next);
    if (sig === listSig) {
      syncPlayPos();
      return;
    }

    const prevId = videos[index] && videos[index].id;
    const prevIndex = index;
    videos = next;
    listSig = sig;

    if (!videos.length) {
      empty.classList.remove("hidden");
      clearFeed();
      index = 0;
      syncPlayPos();
      applyLayoutMode("portrait");
      return;
    }
    empty.classList.add("hidden");

    const found = prevId != null ? videos.findIndex((v) => v.id === prevId) : -1;
    if (found >= 0) {
      index = found;
      if (!slides.curr) rebuild();
      else softSyncFeed();
      syncPlayPos();
      return;
    }

    index = Math.min(Math.max(0, prevIndex), videos.length - 1);
    rebuild();
    syncPlayPos();
  }

  async function refreshListQuietly() {
    if (refreshInFlight || busy || scrubbing || dragging) return;
    refreshInFlight = true;
    try {
      applyListQuiet(await apiList());
    } catch (_) {
      // 忽略单次失败，下轮再试
    } finally {
      refreshInFlight = false;
    }
  }

  async function pickFolder() {
    try {
      if (window.pywebview && window.pywebview.api && window.pywebview.api.pick_folder) {
        const res = await window.pywebview.api.pick_folder();
        if (res && res.ok) {
          applyState(res);
          return;
        }
        if (res && res.cancelled) return;
      }
    } catch (_) {}
    alert("请在桌面端运行，或把视频放到 videos 文件夹后刷新");
  }

  function applyState(data) {
    videos = Array.isArray(data && data.videos) ? data.videos : [];
    listSig = videosSignature(videos);
    if (folderLabel) folderLabel.textContent = shortPath(data && data.folder);
    if (countLabel) countLabel.textContent = `${videos.length} 个视频`;
    if (!videos.length) {
      empty.classList.remove("hidden");
      clearFeed();
      index = 0;
      syncPlayPos();
      applyLayoutMode("portrait");
      return;
    }
    empty.classList.add("hidden");
    clampIndex();
    rebuild();
    syncPlayPos();
  }

  function videoUrl(v) {
    // id 已由服务端 quote，直接拼路径
    return `/video/${v.id}`;
  }

  function slideIsActive(el) {
    return !!(el && el.classList.contains("is-active"));
  }

  function makeSlide(v, role) {
    const el = document.createElement("div");
    el.className = `slide is-${role}`;
    el.dataset.role = role;
    el.dataset.id = v.id;

    const video = document.createElement("video");
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.preload = role === "curr" || role === "active" ? "auto" : "metadata";
    video.loop = false;
    video.src = videoUrl(v);
    video.muted = false;

    let skippingTail = false;
    const onTime = () => {
      if (!slideIsActive(el)) return;
      updateHud();
      if (skippingTail) return;
      const d = video.duration;
      if (!Number.isFinite(d) || d <= TAIL_SKIP * 2) return;
      if (video.currentTime >= d - TAIL_SKIP) {
        skippingTail = true;
        onReachTail(video);
        window.setTimeout(() => {
          skippingTail = false;
        }, 160);
      }
    };
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", () => {
      if (!slideIsActive(el)) return;
      updateHud();
      fitWindowToVideo(video);
    });
    video.addEventListener("ended", () => {
      if (!slideIsActive(el)) return;
      onReachTail(video);
    });
    video.addEventListener("error", () => {
      if (!slideIsActive(el)) return;
      // 当前片解码失败时，列表模式下尝试下一集，避免卡死
      if (playMode === "list" && videos.length > 1 && !busy) {
        window.setTimeout(() => go(1), 400);
      }
    });

    const tap = document.createElement("div");
    tap.className = "tap-pause";

    const caption = document.createElement("div");
    caption.className = "caption";
    caption.innerHTML = `<div class="name"></div><div class="idx"></div>`;
    caption.querySelector(".name").textContent = v.name || "";
    caption.querySelector(".idx").textContent = `${indexLabel(v)}`;

    el.appendChild(video);
    el.appendChild(tap);
    el.appendChild(caption);

    tap.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dragMoved) return;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
      bumpChrome();
    });

    return el;
  }

  function indexLabel(v) {
    const i = videos.findIndex((x) => x.id === v.id);
    return i >= 0 ? `${i + 1} / ${videos.length}` : "";
  }

  function clearFeed() {
    stopHudTimer();
    feed.innerHTML = "";
    slides.prev = slides.curr = slides.next = null;
    lastFitKey = "";
  }

  function rebuild() {
    clearFeed();
    clampIndex();
    if (!videos.length) return;

    const currV = videos[index];
    if (!currV) return;

    slides.curr = makeSlide(currV, "active");
    if (videos.length > 1) {
      const pIdx = (index - 1 + videos.length) % videos.length;
      const nIdx = (index + 1) % videos.length;
      slides.prev = makeSlide(videos[pIdx], "prev");
      slides.next = makeSlide(videos[nIdx], "next");
      updateSlideCaption(slides.prev, videos[pIdx], pIdx);
      updateSlideCaption(slides.next, videos[nIdx], nIdx);
      feed.appendChild(slides.prev);
      feed.appendChild(slides.next);
    }
    feed.appendChild(slides.curr);
    playCurrent();
    updateHud();
    syncPlayPos();
  }

  function playCurrent() {
    const v = slides.curr && slides.curr.querySelector("video");
    if (!v) return;
    [slides.prev, slides.next].forEach((s) => {
      const vid = s && s.querySelector("video");
      if (vid) {
        vid.pause();
        try {
          vid.currentTime = 0;
        } catch (_) {}
      }
    });
    const tryPlay = () =>
      v.play().catch(() => {
        v.muted = true;
        return v.play().catch(() => {});
      });
    tryPlay();
    startHudTimer();
    if (v.readyState >= 1) fitWindowToVideo(v);
  }

  function go(delta) {
    if (settingsOpen || busy || videos.length < 2) return;
    clampIndex();

    const expectId =
      videos[(index + (delta > 0 ? 1 : -1) + videos.length) % videos.length].id;
    const innCheck = delta > 0 ? slides.next : slides.prev;
    if (!innCheck || innCheck.dataset.id !== expectId) {
      softSyncFeed();
    }

    busy = true;
    hideHint();

    const goingNext = delta > 0;
    const out = slides.curr;
    const inn = goingNext ? slides.next : slides.prev;
    if (!out || !inn || videos.length < 2) {
      busy = false;
      return;
    }

    out.className = `slide ${goingNext ? "is-prev" : "is-next"}`;
    inn.className = "slide is-active";

    index = (index + delta + videos.length) % videos.length;
    clampIndex();
    syncPlayPos();
    bumpChrome();

    window.setTimeout(() => {
      try {
        rebuild();
      } finally {
        busy = false;
      }
    }, 300);
  }

  function hideHint() {
    if (hint) hint.classList.add("hide");
  }

  function beginDrag(clientY) {
    dragging = true;
    dragMoved = false;
    startY = clientY;
    startT = Date.now();
    dragY = 0;
  }

  function moveDrag(clientY) {
    if (!dragging || busy || videos.length < 2) return;
    dragY = clientY - startY;
    if (Math.abs(dragY) > DRAG_CLICK_PX) dragMoved = true;
    const curr = slides.curr;
    const prev = slides.prev;
    const next = slides.next;
    if (!curr) return;
    curr.style.transition = "none";
    curr.style.transform = `translateY(${dragY}px)`;
    if (prev) {
      prev.style.transition = "none";
      prev.style.transform = `translateY(calc(-100% + ${dragY}px))`;
    }
    if (next) {
      next.style.transition = "none";
      next.style.transform = `translateY(calc(100% + ${dragY}px))`;
    }
  }

  // —— 指针移动：控件显隐（不依赖 CSS :hover，横竖屏视频都稳定）——
  app.addEventListener(
    "pointermove",
    () => {
      if (!settingsOpen) bumpChrome();
    },
    { passive: true }
  );
  app.addEventListener(
    "pointerdown",
    () => {
      if (!settingsOpen) bumpChrome();
    },
    { passive: true }
  );
  // 鼠标离开窗口时收起（触摸设备无 pointerleave 到窗外也可靠 idle）
  document.addEventListener("mouseleave", () => {
    if (!scrubbing && !settingsOpen) hideChrome();
  });

  // —— 手势 / 滚轮 / 键盘 ——
  feed.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (Math.abs(e.deltaY) < 20) return;
      go(e.deltaY > 0 ? 1 : -1);
    },
    { passive: false }
  );

  feed.addEventListener(
    "touchstart",
    (e) => {
      if (!e.touches.length) return;
      beginDrag(e.touches[0].clientY);
    },
    { passive: true }
  );

  feed.addEventListener(
    "touchmove",
    (e) => {
      if (!e.touches.length) return;
      moveDrag(e.touches[0].clientY);
    },
    { passive: true }
  );

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    const dy = dragY;
    const dt = Math.max(1, Date.now() - startT);
    const velocity = dy / dt;
    const thr = Math.min(120, window.innerHeight * 0.18);
    const should = Math.abs(dy) > thr || Math.abs(velocity) > 0.55;

    [slides.curr, slides.prev, slides.next].forEach((s) => {
      if (!s) return;
      s.style.transition = "";
      s.style.transform = "";
    });

    if (should && videos.length > 1) go(dy < 0 ? 1 : -1);
    else {
      if (slides.curr) slides.curr.className = "slide is-active";
      if (slides.prev) slides.prev.className = "slide is-prev";
      if (slides.next) slides.next.className = "slide is-next";
    }
    dragY = 0;
    // 延后清 dragMoved，避免 touchend 后立刻 click 误触发暂停
    window.setTimeout(() => {
      dragMoved = false;
    }, 0);
  }

  feed.addEventListener("touchend", endDrag, { passive: true });
  feed.addEventListener("touchcancel", endDrag, { passive: true });

  feed.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest(".hud, .topbar, .settings, button")) {
      return;
    }
    beginDrag(e.clientY);
  });
  window.addEventListener("mousemove", (e) => {
    moveDrag(e.clientY);
  });
  window.addEventListener("mouseup", endDrag);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settingsOpen) {
      closeSettings();
      return;
    }
    if (settingsOpen) return;
    if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === "j") {
      e.preventDefault();
      go(1);
    } else if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "k") {
      e.preventDefault();
      go(-1);
    } else if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      const v = activeVideo();
      if (!v) return;
      if (v.paused) v.play().catch(() => {});
      else v.pause();
      bumpChrome();
    }
  });

  if (btnMenu) btnMenu.addEventListener("click", openSettings);
  if (btnCloseSettings) btnCloseSettings.addEventListener("click", closeSettings);
  if (settingsMask) settingsMask.addEventListener("click", closeSettings);
  if (btnEmptySettings) btnEmptySettings.addEventListener("click", openSettings);
  if (btnFolder) {
    btnFolder.addEventListener("click", async () => {
      await pickFolder();
    });
  }
  if (btnMode) {
    btnMode.addEventListener("click", (e) => {
      e.stopPropagation();
      playMode = playMode === "single" ? "list" : "single";
      try {
        localStorage.setItem(MODE_KEY, playMode);
      } catch (_) {}
      syncModeButton();
      bumpChrome();
    });
  }

  hud.addEventListener("mousedown", (e) => e.stopPropagation());
  hud.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
  if (hudBar) {
    hudBar.addEventListener("pointerdown", onScrubStart);
    hudBar.addEventListener("pointermove", onScrubMove);
    hudBar.addEventListener("pointerup", onScrubEnd);
    hudBar.addEventListener("pointercancel", onScrubEnd);
    hudBar.addEventListener("lostpointercapture", () => {
      if (scrubbing) onScrubEnd();
    });
    hudBar.addEventListener("keydown", (e) => {
      const video = activeVideo();
      if (!video) return;
      const playable = playableDuration(video);
      if (playable <= 0) return;
      let delta = 0;
      if (e.key === "ArrowLeft") delta = -2;
      else if (e.key === "ArrowRight") delta = 2;
      else return;
      e.preventDefault();
      e.stopPropagation();
      let t = (video.currentTime || 0) + delta;
      if (t < 0) t = 0;
      if (t > playable) t = playable;
      try {
        video.currentTime = t;
      } catch (_) {}
      setProgressUI(t / playable, Math.floor(t), Math.floor(playable));
      bumpChrome();
    });
  }

  async function boot() {
    syncModeButton();
    for (let i = 0; i < 40; i++) {
      if (window.pywebview && window.pywebview.api) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      if (window.pywebview && window.pywebview.api && window.pywebview.api.get_state) {
        applyState(await window.pywebview.api.get_state());
      } else {
        applyState(await apiList());
      }
    } catch (_) {
      applyState({ folder: "", videos: [] });
    }
    showChrome(false);
    window.setTimeout(hideHint, 3500);
    window.setInterval(refreshListQuietly, 5000);
  }

  boot();
})();
