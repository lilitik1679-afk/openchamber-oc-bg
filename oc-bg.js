/*
 * OpenChamber 自定义背景 / 毛玻璃
 * 技术来自 DeepSeek Harness 插件 deepseek-harness-background（HaoyueQin，MIT）：
 *   壁纸层 z-index:-2 + 遮罩层 z-index:-1，属性开关，覆盖设计 token，backdrop-filter 毛玻璃。
 * 使用 OpenChamber 的主题 token，不覆盖应用管理的颜色变量。
 *
 * 视频是额外的合成层，不进 React 渲染。播放时关掉壁纸 filter 和面板 backdrop-filter，
 * 否则浏览器会每帧把整页视频重新模糊进侧栏和输入框，聊天滚动会掉帧。
 */
(function () {
  "use strict";
  if (window.__OCBG__) return;
  window.__OCBG__ = true;

  var STORE_KEY = "ocbg.settings.v2";
  var VERSION = "8";
  var PRESET = "https://haowallpaper.com/link/common/file/previewFileImg/16445310248537472";
  var LOCAL_PRESET = "/oc-bg-wallpaper.webp";
  var IDB_NAME = "ocbg";
  var IDB_STORE = "blobs";
  var IDB_KEY = "wallpaper";
  var IDB_REF = "idb:wallpaper";
  var VIDEO_MAX_BYTES = 32 * 1024 * 1024;
  var VIDEO_WARN_BYTES = 12 * 1024 * 1024;
  var VIDEO_EXT = /\.(mp4|webm|ogv|ogg|m4v|mov|mkv|avi)$/i;
  var IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|svg|avif|apng|ico)$/i;
  var DEFAULTS = {
    enabled: true,
    image: PRESET,
    kind: "auto",
    opacity: 0.9,
    scrim: 0.28,
    panel: 0.42,
    glassBlur: 18,
    wallBlur: 0,
    fit: "cover",
  };
  var settings = Object.assign({}, DEFAULTS);
  var imageState;
  var previewSync;
  var runtimeSrc = null;
  var gestureBound = false;
  var mediaProbe = null;
  var pendingPlay = null;
  var remoteVideo = null;

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) settings = Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (e) { console.warn("[oc-bg] 无法读取背景设置", e); }
    ["opacity", "scrim", "panel", "glassBlur", "wallBlur"].forEach(function (key) {
      var max = key === "glassBlur" ? 40 : key === "wallBlur" ? 60 : key === "scrim" ? 0.95 : 1;
      var value = Number(settings[key]);
      settings[key] = Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : DEFAULTS[key];
    });
    settings.fit = settings.fit === "contain" ? "contain" : "cover";
    settings.kind = settings.kind === "image" || settings.kind === "video" ? settings.kind : "auto";
    settings.image = typeof settings.image === "string" ? settings.image : PRESET;
    if (!settings.image) settings.image = PRESET;
    if (settings.image.indexOf("blob:") === 0 || settings.image.indexOf("data:video") === 0) {
      settings.image = PRESET;
      settings.kind = "auto";
    }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); }
    catch (e) { toast("保存失败：本地存储已满"); }
  }

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("indexedDB unavailable")); return; }
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbPut(blob) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(blob, IDB_KEY);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }
  function idbGet() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readonly");
        var req = tx.objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = function () { db.close(); resolve(req.result || null); };
        req.onerror = function () { db.close(); reject(req.error); };
      });
    });
  }
  function idbDelete() {
    idbOpen().then(function (db) {
      var tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = function () { db.close(); };
      tx.onerror = function () { db.close(); };
    }).catch(function () {});
  }
  function forgetLocalVideo() {
    if (runtimeSrc) {
      URL.revokeObjectURL(runtimeSrc);
      runtimeSrc = null;
    }
    idbDelete();
  }

  function pathWithoutQuery(src) {
    return String(src || "").split("?")[0].split("#")[0];
  }
  function looksLikeVideo(src) {
    return VIDEO_EXT.test(pathWithoutQuery(src));
  }
  function hintedKind(src) {
    if (src === IDB_REF || looksLikeVideo(src)) return "video";
    if (src === PRESET || src.indexOf("data:image/") === 0 || IMAGE_EXT.test(pathWithoutQuery(src))) return "image";
    return null;
  }
  function resolvedKind() {
    if (settings.kind === "video" || settings.kind === "image") return settings.kind;
    return hintedKind(settings.image) || (mediaProbe && mediaProbe.src === settings.image && mediaProbe.kind) || "image";
  }
  function cancelMediaProbe() {
    if (mediaProbe && mediaProbe.status === "loading") mediaProbe.controller.abort();
    if (mediaProbe) clearTimeout(mediaProbe.timer);
    mediaProbe = null;
  }
  function prepareMedia() {
    if (mediaProbe && mediaProbe.src !== settings.image) cancelMediaProbe();
    if (settings.kind !== "auto" || hintedKind(settings.image)) return true;
    if (mediaProbe) return mediaProbe.status !== "loading";
    var probeUrl;
    try { probeUrl = new URL(settings.image, window.location.href); }
    catch (e) { return true; }
    if (probeUrl.protocol !== "http:" && probeUrl.protocol !== "https:") return true;

    // Extensionless media URLs are common. Read only headers, once per source,
    // rather than downloading a video into JS or probing on every slider drag.
    var probe = mediaProbe = {
      src: settings.image, status: "loading", kind: null, contentType: "",
      controller: new AbortController(),
    };
    imageState = { src: imageSrc(), status: "loading" };
    probe.timer = setTimeout(function () { probe.controller.abort(); }, 5000);
    fetch(probeUrl.href, {
      method: "HEAD", signal: probe.controller.signal,
      credentials: "omit", referrerPolicy: "no-referrer",
    }).then(function (response) {
      if (mediaProbe !== probe) return;
      probe.contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      probe.status = "ready";
      if (response.ok && probe.contentType.indexOf("video/") === 0) probe.kind = "video";
      else if (response.ok && probe.contentType.indexOf("image/") === 0) probe.kind = "image";
      else if (response.ok && (probe.contentType === "text/html" || probe.contentType === "application/json")) {
        probe.status = "error";
        imageState = { src: imageSrc(), status: "error", error: "链接返回的是网页或接口数据，请使用图片或视频直链" };
        console.warn("[oc-bg] 链接不是媒体直链", { contentType: probe.contentType });
      }
      // A rejected HEAD does not imply a rejected media GET (signed URLs may
      // allow only GET). The image/video elements remain the final validator.
    }).catch(function (error) {
      if (mediaProbe !== probe) return;
      probe.status = "ready";
      console.info("[oc-bg] 无法读取媒体类型，改由浏览器检测", { reason: error.name });
    }).then(function () {
      clearTimeout(probe.timer);
      if (mediaProbe !== probe || settings.kind !== "auto" || !settings.enabled) return;
      apply();
      if (previewSync) previewSync();
    });
    return false;
  }
  function motionReduced() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  var CSS = [
    /* Keep the host Latin font and supply glyphs on devices without CJK fonts. */
    "body,#root{font-family:var(--font-sans,system-ui),'Noto Sans SC Variable',sans-serif;}",
    ".ocbg-layer,.ocbg-scrim{display:none;}",
    "html[data-ocbg] body{isolation:isolate;}",
    "html[data-ocbg] .ocbg-layer{display:block;position:fixed;inset:0;z-index:-2;pointer-events:none;",
    "background-repeat:no-repeat;background-size:var(--ocbg-fit,cover);background-position:center;",
    "opacity:var(--ocbg-opacity,.9);filter:blur(var(--ocbg-wall-blur,0px));transform:scale(var(--ocbg-wall-scale,1));}",
    "html[data-ocbg] .ocbg-video{position:absolute;inset:0;width:100%;height:100%;object-fit:var(--ocbg-fit,cover);object-position:center;pointer-events:none;}",
    "html[data-ocbg] .ocbg-scrim{display:block;position:fixed;inset:0;z-index:-1;pointer-events:none;",
    "background:var(--ocbg-scrim-color,#000);opacity:var(--ocbg-scrim,.28);}",
    "html[data-ocbg]:not(.dark) .ocbg-scrim{--ocbg-scrim-color:#fff;}",
    "html[data-ocbg].dark .ocbg-scrim{--ocbg-scrim-color:#000;}",
    /* Read the host tokens without replacing them: the app owns theme updates. */
    "html[data-ocbg] body{background-color:var(--surface-background)!important;}",
    "html[data-ocbg] #root,html[data-ocbg] #root .bg-background{background-color:transparent!important;}",
    "html[data-ocbg-glass] .bg-card{background-color:color-mix(in srgb,var(--card) var(--ocbg-panel-opacity),transparent)!important;}",
    "html[data-ocbg-glass] .bg-popover{background-color:color-mix(in srgb,var(--popover) var(--ocbg-panel-opacity),transparent)!important;}",
    "html[data-ocbg-glass] .bg-sidebar{background-color:color-mix(in srgb,var(--sidebar) var(--ocbg-panel-opacity),transparent)!important;}",
    "html[data-ocbg-glass] .bg-secondary{background-color:color-mix(in srgb,var(--secondary) var(--ocbg-panel-opacity),transparent)!important;}",
    "html[data-ocbg-glass] .bg-muted{background-color:color-mix(in srgb,var(--muted) var(--ocbg-panel-opacity),transparent)!important;}",
    "html[data-ocbg-glass] .oc-glass-composer,html[data-ocbg-glass] .oc-glass-floating{",
    "background-color:color-mix(in srgb,var(--surface-elevated) var(--ocbg-panel-opacity),transparent)!important;}",
    /* Limit expensive filters to actual panels, not every muted button/badge. */
    "html[data-ocbg-glass] aside.bg-sidebar,html[data-ocbg-glass] .oc-glass-floating,",
    "html[data-ocbg-glass] .oc-glass-composer{",
    "-webkit-backdrop-filter:blur(var(--ocbg-glass-blur,18px)) saturate(var(--oc-glass-saturation,1));",
    "backdrop-filter:blur(var(--ocbg-glass-blur,18px)) saturate(var(--oc-glass-saturation,1));}",
    /* Playing video already updates every frame. Re-blurring it into panels, or
       filtering the video layer itself, forces a full-frame repaint and stalls scroll. */
    "html[data-ocbg-playing] .ocbg-layer{filter:none!important;transform:none!important;}",
    "html[data-ocbg-playing] aside.bg-sidebar,html[data-ocbg-playing] .oc-glass-floating,",
    "html[data-ocbg-playing] .oc-glass-composer{",
    "-webkit-backdrop-filter:none!important;backdrop-filter:none!important;}",
  ].join("");

  function injectCss() {
    if (document.getElementById("ocbg-style")) return;
    var s = document.createElement("style");
    s.id = "ocbg-style";
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function imageSrc() {
    if (settings.image === IDB_REF && resolvedKind() === "video" && runtimeSrc) return runtimeSrc;
    if (remoteVideo && remoteVideo.src === settings.image && remoteVideo.url && resolvedKind() === "video") return remoteVideo.url;
    if (settings.image === IDB_REF) return "";
    return settings.image === PRESET ? LOCAL_PRESET : settings.image;
  }

  function publishStatus() {
    window.__OCBG_STATUS = Object.assign({}, settings, {
      version: VERSION, image: imageSrc(), resolvedKind: resolvedKind(),
      playing: document.documentElement.hasAttribute("data-ocbg-playing"),
      mediaStatus: imageState ? imageState.status : "idle",
      error: imageState && imageState.error || null,
      errorCode: imageState && imageState.errorCode || null,
      contentType: mediaProbe && mediaProbe.src === settings.image ? mediaProbe.contentType : "",
      transport: remoteVideo && remoteVideo.url ? "local-blob" : "direct",
    });
  }

  function validateImage() {
    var src = imageSrc();
    if (imageState && imageState.src === src && imageState.kind === "image") return;
    var image = new Image();
    imageState = { src: src, kind: "image", status: "loading" };
    image.onload = function () {
      if (imageState.src !== src || imageSrc() !== src || resolvedKind() !== "image") return;
      imageState.status = "loaded";
      publishStatus();
      if (previewSync) previewSync();
    };
    image.onerror = function () {
      if (imageState.src !== src || imageSrc() !== src || resolvedKind() !== "image") return;
      // Some hosts forbid CORS/HEAD while still serving playable media. Try
      // the video decoder once for an unclassified source, without a proxy.
      if (settings.kind === "auto" && mediaProbe && mediaProbe.src === settings.image && !mediaProbe.kind) {
        mediaProbe.kind = "video";
        apply();
        if (previewSync) previewSync();
        return;
      }
      imageState.status = "error";
      imageState.error = "图片加载失败：请上传本地图或使用可直接访问的图片链接";
      publishStatus();
      if (previewSync) previewSync();
      console.warn("[oc-bg] 图片加载失败", { kind: settings.kind });
      if (settings.enabled) toast(imageState.error);
    };
    image.src = src;
  }

  function setPlaying(on) {
    var html = document.documentElement;
    var had = html.getAttribute("data-ocbg-playing") === "on";
    if (on) html.setAttribute("data-ocbg-playing", "on");
    else html.removeAttribute("data-ocbg-playing");
    publishStatus();
    if (had !== on && previewSync) previewSync();
  }

  function stopVideoElement() {
    var video = document.querySelector(".ocbg-video");
    pendingPlay = null;
    document.documentElement.removeAttribute("data-ocbg-video");
    setPlaying(false);
    if (!video) return;
    video.onerror = null;
    video.onloadeddata = null;
    video.pause();
    video.removeAttribute("src");
    try { video.load(); } catch (e) {}
    video.remove();
  }

  function reportVideoError(video) {
    var code = video.error ? video.error.code : 0;
    if ((code === 0 || code === 2 || code === 4) && retryRemoteVideo()) return;
    var messages = {
      1: "视频加载已中止，请重新应用链接",
      2: "视频网络请求失败，请检查链接是否有效或已过期",
      3: "视频解码失败，请转换成 H.264 的 MP4 或 WebM",
      4: "浏览器无法读取这个视频，请确认是视频直链，或转换成 H.264 的 MP4 / WebM",
    };
    imageState = { src: video.dataset.src, status: "error", errorCode: code, error: messages[code] || "视频无法播放，请检查链接和编码" };
    setPlaying(false);
    if (previewSync) previewSync();
    console.warn("[oc-bg] 视频无法播放", { code: code, networkState: video.networkState, readyState: video.readyState });
    toast(imageState.error);
  }

  function releaseRemoteVideo() {
    if (!remoteVideo) return;
    remoteVideo.controller.abort();
    clearTimeout(remoteVideo.timer);
    if (remoteVideo.url) URL.revokeObjectURL(remoteVideo.url);
    remoteVideo = null;
  }

  async function readVideoBlob(response, signal) {
    if (!response.ok) {
      if (response.body) await response.body.cancel();
      throw new Error("视频请求失败（HTTP " + response.status + "），请检查链接是否有访问限制");
    }
    var contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (contentType === "text/html" || contentType === "application/json") {
      if (response.body) await response.body.cancel();
      throw new Error("链接返回的不是视频，请使用视频文件直链");
    }
    var size = Number(response.headers.get("content-length"));
    if (size > VIDEO_MAX_BYTES) {
      if (response.body) await response.body.cancel();
      throw new Error("视频超过 32MB 的兼容加载上限，请换小视频或可直接播放的链接");
    }
    if (!response.body) throw new Error("视频服务器没有返回文件内容");
    var reader = response.body.getReader();
    var chunks = [];
    var total = 0;
    try {
      while (true) {
        var part = await reader.read();
        if (signal.aborted) throw new DOMException("加载已取消", "AbortError");
        if (part.done) break;
        total += part.value.byteLength;
        if (total > VIDEO_MAX_BYTES) {
          await reader.cancel();
          throw new Error("视频超过 32MB 的兼容加载上限，请换小视频或可直接播放的链接");
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    if (!total) throw new Error("视频文件为空");
    return new Blob(chunks, { type: contentType || "application/octet-stream" });
  }

  function retryRemoteVideo() {
    if (remoteVideo) return remoteVideo.status === "loading";
    var url;
    try { url = new URL(settings.image, window.location.href); }
    catch (e) { return false; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.origin === window.location.origin) return false;

    // HTMLVideoElement has no referrerPolicy. Retry rejected cross-origin
    // media with a bounded, CORS-checked fetch instead of changing the host's
    // referrer policy or adding a server proxy. Normal streams stay direct.
    var attempt = remoteVideo = {
      src: settings.image, url: null, status: "loading", controller: new AbortController(),
    };
    attempt.timer = setTimeout(function () { attempt.controller.abort(); }, 30000);
    imageState = { src: imageSrc(), status: "loading" };
    setPlaying(false);
    if (previewSync) previewSync();
    console.info("[oc-bg] 视频直连失败，尝试受限的无来源请求");
    fetch(url.href, {
      signal: attempt.controller.signal, credentials: "omit", referrerPolicy: "no-referrer",
    }).then(function (response) { return readVideoBlob(response, attempt.controller.signal); })
      .then(function (blob) {
        if (remoteVideo !== attempt || !settings.enabled || settings.image !== attempt.src || resolvedKind() !== "video") return;
        attempt.status = "ready";
        attempt.url = URL.createObjectURL(blob);
        apply();
        if (previewSync) previewSync();
      }).catch(function (error) {
        if (remoteVideo !== attempt || !settings.enabled || settings.image !== attempt.src || resolvedKind() !== "video") return;
        attempt.status = "error";
        imageState = {
          src: imageSrc(), status: "error",
          error: error.name === "AbortError" ? "视频加载超时，请检查网络后重新应用" :
            error.name === "TypeError" ? "视频服务器不允许跨站读取，请下载后选择本地文件，或换其他直链" : error.message,
        };
        setPlaying(false);
        if (previewSync) previewSync();
        console.warn("[oc-bg] 视频兼容加载失败", { reason: error.name });
        toast(imageState.error);
      }).then(function () { clearTimeout(attempt.timer); });
    return true;
  }

  function syncPlayback() {
    var video = document.querySelector(".ocbg-video");
    if (!video || !settings.enabled) {
      setPlaying(false);
      return;
    }
    if (imageState && imageState.src === video.dataset.src && imageState.status === "error") return;
    if (document.hidden || motionReduced()) {
      if (!video.paused) video.pause();
      setPlaying(false);
      return;
    }
    if (!video.paused) {
      setPlaying(true);
      return;
    }
    if (pendingPlay && pendingPlay.video === video && pendingPlay.src === video.dataset.src) return;
    var request = pendingPlay = { video: video, src: video.dataset.src };
    var pending = video.play();
    if (pending && pending.then) {
      pending.then(function () {
        if (pendingPlay === request) pendingPlay = null;
        if (!video.isConnected || imageSrc() !== request.src || resolvedKind() !== "video" || !settings.enabled) return;
        if (document.hidden || motionReduced()) { video.pause(); setPlaying(false); return; }
        setPlaying(true);
      }).catch(function (error) {
        if (pendingPlay === request) pendingPlay = null;
        if (!video.isConnected || imageSrc() !== request.src || resolvedKind() !== "video") return;
        setPlaying(false);
        if (error.name === "AbortError") return;
        if (error.name !== "NotAllowedError") {
          if (!imageState || imageState.status !== "error") reportVideoError(video);
          return;
        }
        imageState = { src: request.src, status: "blocked" };
        publishStatus();
        if (previewSync) previewSync();
        if (gestureBound) return;
        gestureBound = true;
        document.addEventListener("pointerdown", function onDown() {
          document.removeEventListener("pointerdown", onDown, true);
          gestureBound = false;
          syncPlayback();
        }, true);
      });
    } else pendingPlay = null;
  }

  function bindPlaybackGuards() {
    document.addEventListener("visibilitychange", syncPlayback);
    var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.addEventListener) mq.addEventListener("change", syncPlayback);
    else if (mq.addListener) mq.addListener(syncPlayback);
  }

  function ensureVideo(layer, src) {
    var video = layer.querySelector(".ocbg-video");
    if (!video) {
      video = document.createElement("video");
      video.className = "ocbg-video";
      video.muted = true;
      video.defaultMuted = true;
      video.loop = true;
      video.playsInline = true;
      video.controls = false;
      video.preload = "metadata";
      video.autoplay = false;
      video.disablePictureInPicture = true;
      video.setAttribute("muted", "");
      video.setAttribute("playsinline", "");
      video.setAttribute("aria-hidden", "true");
      video.onerror = function () {
        if (!video.dataset.src || (imageState && imageState.src !== video.dataset.src)) return;
        if (imageState && imageState.status === "error") return;
        reportVideoError(video);
      };
      video.onloadeddata = function () {
        if (imageState && imageState.src !== video.dataset.src) return;
        imageState = { src: video.dataset.src, status: "loaded" };
        publishStatus();
        if (previewSync) previewSync();
        syncPlayback();
      };
      layer.appendChild(video);
    }
    if (video.dataset.src !== src) {
      imageState = { src: src, status: "loading" };
      video.dataset.src = src;
      video.src = src;
    }
    return video;
  }

  function apply() {
    var html = document.documentElement;
    var kind = resolvedKind();
    if (remoteVideo && (remoteVideo.src !== settings.image || kind !== "video" || !settings.enabled)) releaseRemoteVideo();
    var src = imageSrc();
    publishStatus();
    if (!settings.enabled || !settings.image) {
      html.removeAttribute("data-ocbg");
      html.removeAttribute("data-ocbg-glass");
      html.removeAttribute("data-ocbg-video");
      if (mediaProbe && mediaProbe.status === "loading") cancelMediaProbe();
      stopVideoElement();
      return;
    }
    if (!prepareMedia() || (settings.kind === "auto" && mediaProbe && mediaProbe.status === "error")) {
      html.removeAttribute("data-ocbg");
      html.removeAttribute("data-ocbg-glass");
      stopVideoElement();
      publishStatus();
      return;
    }
    kind = resolvedKind();
    src = imageSrc();
    if (remoteVideo && remoteVideo.src === settings.image && remoteVideo.status !== "ready") {
      publishStatus();
      return;
    }
    if (kind === "video" && !src) return;
    if (kind === "image" && settings.image === IDB_REF) {
      html.removeAttribute("data-ocbg-video");
      stopVideoElement();
      return;
    }
    html.setAttribute("data-ocbg", "on");
    html.style.setProperty("--ocbg-opacity", String(settings.opacity));
    html.style.setProperty("--ocbg-scrim", String(settings.scrim));
    html.style.setProperty("--ocbg-glass-blur", settings.glassBlur + "px");
    html.style.setProperty("--ocbg-panel-opacity", Math.round(settings.panel * 100) + "%");
    html.style.setProperty("--ocbg-wall-blur", settings.wallBlur + "px");
    html.style.setProperty("--ocbg-wall-scale", settings.wallBlur > 0 ? "1.15" : "1");
    html.style.setProperty("--ocbg-fit", settings.fit);

    if (settings.panel >= 0.98) html.removeAttribute("data-ocbg-glass");
    else html.setAttribute("data-ocbg-glass", "on");

    var layer = document.querySelector(".ocbg-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "ocbg-layer";
      document.body.insertBefore(layer, document.body.firstChild);
    }
    if (kind === "video") {
      html.setAttribute("data-ocbg-video", "on");
      layer.style.backgroundImage = "none";
      ensureVideo(layer, src);
      syncPlayback();
    } else {
      html.removeAttribute("data-ocbg-video");
      stopVideoElement();
      layer.style.backgroundImage = "url(" + JSON.stringify(src) + ")";
      validateImage();
    }
    if (!document.querySelector(".ocbg-scrim")) {
      var scrim = document.createElement("div");
      scrim.className = "ocbg-scrim";
      document.body.insertBefore(scrim, layer.nextSibling);
    }
  }

  function toast(msg) {
    var t = document.createElement("div");
    t.textContent = msg;
    t.setAttribute("style",
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;" +
      "background:#111;color:#fff;padding:8px 14px;border-radius:8px;font:13px system-ui;");
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2800);
  }

  function integratedUi() {
    function row(label, node) {
      var r = document.createElement("div");
      r.className = "flex flex-col gap-2 py-0.5 @xl:flex-row @xl:items-center @xl:gap-8";
      var labelWrap = document.createElement("div");
      labelWrap.className = "min-w-0 @xl:w-56 @xl:shrink-0";
      var text = document.createElement("div");
      text.className = "min-w-0 truncate typography-settings-field-label text-foreground";
      text.textContent = label;
      labelWrap.appendChild(text);
      r.appendChild(labelWrap);
      var control = document.createElement("div");
      control.className = "flex min-w-0 flex-1 items-center gap-2 @xl:w-fit @xl:flex-none w-full max-w-[28rem]";
      node.className = (node.className || "") + " min-w-0";
      control.appendChild(node);
      r.appendChild(control);
      return r;
    }

    function button(text, variant) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.className = "inline-flex h-8 items-center justify-center rounded-[9px] border px-2.5 typography-ui-label font-medium text-foreground transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
      if (variant === "danger") b.className += " border-border/60";
      else b.className += " border-border/60 bg-surface-elevated";
      return b;
    }

    function mount() {
      var anchor = document.querySelector('[data-settings-item="appearance.session-activity"]');
      if (!anchor || !anchor.parentElement) return;
      if (document.getElementById("ocbg-settings-section")) return;

      var section = document.createElement("section");
      section.id = "ocbg-settings-section";
      section.setAttribute("data-settings-item", "appearance.background");
      section.className = "space-y-5 border-t border-border/60 py-8";
      var header = document.createElement("div");
      header.className = "flex items-start justify-between gap-3";
      var heading = document.createElement("div");
      heading.className = "min-w-0 space-y-1";
      var title = document.createElement("h2");
      title.className = "typography-settings-section-title text-foreground";
      title.textContent = "背景与毛玻璃";
      heading.appendChild(title);
      header.appendChild(heading);
      section.appendChild(header);
      var content = document.createElement("div");
      content.className = "space-y-3";
      section.appendChild(content);

      var preview = document.createElement("div");
      preview.className = "h-20 w-full max-w-[28rem] rounded-lg border border-border/60 bg-cover bg-center";
      preview.setAttribute("aria-label", "壁纸预览");
      content.appendChild(row("预览", preview));

      var status = document.createElement("p");
      status.className = "typography-meta text-muted-foreground";
      status.setAttribute("role", "status");
      content.appendChild(status);

      var enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = settings.enabled;
      enabled.setAttribute("aria-label", "启用背景");
      enabled.className = "h-4 w-4 accent-primary";
      enabled.onchange = function () {
        settings.enabled = enabled.checked;
        save(); apply(); syncPrev();
      };
      content.appendChild(row("启用背景", enabled));

      function setEnabled(value) {
        settings.enabled = value;
        enabled.checked = value;
      }

      var kind = document.createElement("select");
      kind.setAttribute("aria-label", "背景类型");
      kind.className = "h-9 rounded-lg bg-surface-elevated px-3 text-sm text-foreground ring-1 ring-inset ring-border/60 outline-none focus:ring-2 focus:ring-ring";
      [["auto", "自动"], ["image", "图片"], ["video", "视频"]].forEach(function (entry) {
        var option = document.createElement("option");
        option.value = entry[0];
        option.textContent = entry[1];
        if (settings.kind === entry[0]) option.selected = true;
        kind.appendChild(option);
      });
      kind.onchange = function () {
        settings.kind = kind.value;
        save(); apply(); syncPrev();
      };
      content.appendChild(row("类型", kind));

      var file = document.createElement("input");
      file.type = "file";
      file.accept = "image/*,video/*,.mp4,.webm,.ogv,.ogg,.m4v,.mov,.mkv,.avi";
      file.setAttribute("aria-label", "上传本地图片或视频");
      file.className = "block w-full max-w-[28rem] text-sm text-foreground";
      file.onchange = function () {
        var f = file.files && file.files[0];
        if (!f) return;
        var isVideo = f.type.indexOf("video/") === 0 || looksLikeVideo(f.name);
        if (isVideo) {
          if (f.size > VIDEO_MAX_BYTES) {
            toast("视频超过 32MB，请改用可直接访问的链接");
            file.value = "";
            return;
          }
          if (f.size > VIDEO_WARN_BYTES) toast("视频较大，建议 1080p 短循环，避免占用显存");
          idbPut(f).then(function () {
            if (runtimeSrc) URL.revokeObjectURL(runtimeSrc);
            runtimeSrc = URL.createObjectURL(f);
            settings.kind = "auto";
            settings.image = IDB_REF;
            kind.value = "auto";
            setEnabled(true);
            save(); apply(); syncPrev();
          }).catch(function (error) {
            console.warn("[oc-bg] 无法保存视频", { reason: error.name });
            toast("无法保存视频：请检查浏览器存储权限和可用空间");
          });
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          forgetLocalVideo();
          settings.kind = "auto";
          settings.image = reader.result;
          kind.value = "auto";
          setEnabled(true);
          save(); apply(); syncPrev();
        };
        reader.onerror = function () { toast("无法读取图片文件"); };
        reader.readAsDataURL(f);
      };
      content.appendChild(row("本地图片或视频", file));

      var url = document.createElement("input");
      url.type = "url";
      url.value = settings.image && settings.image.indexOf("data:") !== 0 && settings.image !== IDB_REF ? settings.image : "";
      url.placeholder = "https://example.com/wallpaper.jpg 或 .mp4/.webm";
      url.setAttribute("aria-label", "壁纸链接");
      url.className = "h-9 w-full rounded-lg bg-surface-elevated px-3 text-sm text-foreground ring-1 ring-inset ring-border/60 outline-none focus:ring-2 focus:ring-ring";
      var urlRow = row("壁纸链接", url);
      var applyUrl = button("应用");
      applyUrl.onclick = function () {
        var next = url.value.trim();
        if (!next) {
          if (settings.image === IDB_REF) {
            toast("本地视频仍在使用。要换链接请先填写地址");
            return;
          }
          next = PRESET;
        }
        forgetLocalVideo();
        stopVideoElement();
        releaseRemoteVideo();
        cancelMediaProbe();
        settings.image = next;
        settings.kind = kind.value;
        setEnabled(true);
        save(); apply(); syncPrev();
      };
      urlRow.lastElementChild.appendChild(applyUrl);
      content.appendChild(urlRow);

      function slider(key, label, min, max, step, fmt) {
        var wrap = document.createElement("div");
        wrap.className = "flex min-w-0 flex-1 items-center gap-2";
        var input = document.createElement("input");
        input.type = "range";
        input.min = String(min); input.max = String(max); input.step = String(step);
        input.value = String(settings[key]);
        input.setAttribute("data-ocbg-key", key);
        input.setAttribute("aria-label", label);
        input.className = "min-w-0 flex-1 accent-primary";
        var value = document.createElement("span");
        value.className = "w-12 shrink-0 text-right typography-meta tabular-nums text-muted-foreground";
        function show() { value.textContent = fmt(parseFloat(input.value)); }
        show();
        input.oninput = function () { settings[key] = parseFloat(input.value); show(); apply(); syncPrev(); };
        input.onchange = function () { save(); };
        wrap.appendChild(input); wrap.appendChild(value);
        content.appendChild(row(label, wrap));
      }
      slider("opacity", "壁纸不透明度", 0, 1, 0.05, function (x) { return Math.round(x * 100) + "%"; });
      slider("scrim", "遮罩", 0, 0.95, 0.05, function (x) { return Math.round(x * 100) + "%"; });
      slider("panel", "面板不透明度", 0.05, 1, 0.05, function (x) { return Math.round(x * 100) + "%"; });
      slider("glassBlur", "毛玻璃模糊", 0, 40, 1, function (x) { return x + "px"; });
      slider("wallBlur", "壁纸模糊", 0, 60, 2, function (x) { return x + "px"; });

      var fit = document.createElement("select");
      fit.setAttribute("aria-label", "壁纸填充方式");
      fit.className = "h-9 rounded-lg bg-surface-elevated px-3 text-sm text-foreground ring-1 ring-inset ring-border/60 outline-none focus:ring-2 focus:ring-ring";
      [["cover", "铺满"], ["contain", "完整显示"]].forEach(function (entry) {
        var option = document.createElement("option"); option.value = entry[0]; option.textContent = entry[1];
        if (settings.fit === entry[0]) option.selected = true;
        fit.appendChild(option);
      });
      fit.onchange = function () { settings.fit = fit.value; save(); apply(); syncPrev(); };
      content.appendChild(row("壁纸填充", fit));

      var actions = document.createElement("div");
      actions.className = "flex flex-wrap items-center gap-2 pt-1";
      var clear = button("清除背景", "danger");
      clear.onclick = function () { setEnabled(false); save(); apply(); syncPrev(); };
      actions.appendChild(clear);
      content.appendChild(actions);

      function syncPrev() {
        var kindNow = resolvedKind();
        var src = imageSrc();
        var identifying = settings.kind === "auto" && !hintedKind(settings.image) &&
          (!mediaProbe || mediaProbe.src !== settings.image || mediaProbe.status === "loading");
        preview.style.backgroundImage = kindNow === "video" || !src || identifying ? "none" : "url(" + JSON.stringify(src) + ")";
        if (!settings.enabled) status.textContent = "背景已关闭";
        else if (kindNow === "image" && settings.image === IDB_REF) status.textContent = "当前本地文件是视频，类型请选「视频」";
        else if (imageState && imageState.status === "error") status.textContent = imageState.error || (kindNow === "video" ? "视频加载失败" : "图片加载失败");
        else if (identifying) status.textContent = "正在识别链接类型";
        else if (remoteVideo && remoteVideo.src === settings.image && remoteVideo.status === "loading") status.textContent = "视频直连被限制，正在兼容加载（上限 32MB）";
        else if (imageState && imageState.status === "blocked") status.textContent = "浏览器阻止了自动播放，点击页面后重试";
        else if (kindNow === "video" && motionReduced()) status.textContent = "系统开启了减少动态效果，视频停在第一帧";
        else if (kindNow === "video" && document.hidden) status.textContent = "页面在后台，视频已暂停";
        else if (kindNow === "video" && document.documentElement.getAttribute("data-ocbg-playing") === "on") {
          status.textContent = "视频播放中。壁纸模糊和毛玻璃采样已暂停，避免每帧重绘";
        } else if (!src || !imageState || imageState.status === "loading") {
          status.textContent = kindNow === "video" ? "正在加载视频" : "正在加载图片";
        } else status.textContent = "";
      }
      previewSync = syncPrev;
      syncPrev();
      anchor.parentElement.insertBefore(section, anchor);
    }

    var observer = new MutationObserver(function () {
      if (!document.getElementById("ocbg-settings-section")) mount();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    mount();
  }

  function ui() {
    integratedUi();
  }

  function boot() {
    load();
    injectCss();
    bindPlaybackGuards();
    ui();
    if (settings.image === IDB_REF) {
      idbGet().then(function (blob) {
        if (!blob) {
          toast("本地视频已丢失，已恢复默认壁纸");
          settings.image = PRESET;
          settings.kind = "auto";
          save();
          apply();
          if (previewSync) previewSync();
          return;
        }
        runtimeSrc = URL.createObjectURL(blob);
        apply();
        if (previewSync) previewSync();
      }).catch(function () { toast("无法读取本地视频"); });
      return;
    }
    apply();
  }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
