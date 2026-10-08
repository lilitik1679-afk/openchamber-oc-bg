/*
 * OpenChamber 自定义背景 / 毛玻璃
 * 技术来自 DeepSeek Harness 插件 deepseek-harness-background（HaoyueQin，MIT）：
 *   壁纸层 z-index:-2 + 遮罩层 z-index:-1，属性开关，覆盖设计 token，backdrop-filter 毛玻璃。
 * 使用 OpenChamber 的主题 token，不覆盖应用管理的颜色变量。
 */
(function () {
  "use strict";
  if (window.__OCBG__) return;
  window.__OCBG__ = true;

  var STORE_KEY = "ocbg.settings.v2";
  var PRESET = "https://haowallpaper.com/link/common/file/previewFileImg/16445310248537472";
  var LOCAL_PRESET = "/oc-bg-wallpaper.webp";
  var DEFAULTS = {
    enabled: true,
    image: PRESET,
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
    settings.image = typeof settings.image === "string" ? settings.image : PRESET;
    if (!settings.image) settings.image = PRESET;
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); }
    catch (e) { toast("保存失败：本地存储已满"); }
  }

  var CSS = [
    /* Keep the host Latin font and supply glyphs on devices without CJK fonts. */
    "body,#root{font-family:var(--font-sans,system-ui),'Noto Sans SC Variable',sans-serif;}",
    ".ocbg-layer,.ocbg-scrim{display:none;}",
    "html[data-ocbg] body{isolation:isolate;}",
    "html[data-ocbg] .ocbg-layer{display:block;position:fixed;inset:0;z-index:-2;pointer-events:none;",
    "background-repeat:no-repeat;background-size:var(--ocbg-fit,cover);background-position:center;",
    "opacity:var(--ocbg-opacity,.9);filter:blur(var(--ocbg-wall-blur,0px));transform:scale(var(--ocbg-wall-scale,1));}",
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
  ].join("");

  function injectCss() {
    if (document.getElementById("ocbg-style")) return;
    var s = document.createElement("style");
    s.id = "ocbg-style";
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function imageSrc() {
    return settings.image === PRESET ? LOCAL_PRESET : settings.image;
  }

  function validateImage() {
    var src = imageSrc();
    if (imageState && imageState.src === src) return;
    var image = new Image();
    imageState = { src: src, status: "loading" };
    image.onload = function () {
      if (imageState.src !== src) return;
      imageState.status = "loaded";
      if (previewSync) previewSync();
    };
    image.onerror = function () {
      if (imageState.src !== src) return;
      imageState.status = "error";
      if (previewSync) previewSync();
      toast("图片加载失败：请上传本地图或使用可直接访问的图片链接");
    };
    image.src = src;
  }

  function apply() {
    var html = document.documentElement;
    window.__OCBG_STATUS = Object.assign({}, settings, { image: imageSrc() });
    if (!settings.enabled || !settings.image) {
      html.removeAttribute("data-ocbg");
      html.removeAttribute("data-ocbg-glass");
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
    layer.style.backgroundImage = "url(" + JSON.stringify(imageSrc()) + ")";
    if (!document.querySelector(".ocbg-scrim")) {
      var scrim = document.createElement("div");
      scrim.className = "ocbg-scrim";
      document.body.insertBefore(scrim, layer.nextSibling);
    }
    validateImage();
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

      var file = document.createElement("input");
      file.type = "file";
      file.accept = "image/*";
      file.setAttribute("aria-label", "上传本地壁纸");
      file.className = "block w-full max-w-[28rem] text-sm text-foreground";
      file.onchange = function () {
        var f = file.files && file.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          settings.image = reader.result;
          setEnabled(true);
          save(); apply(); syncPrev();
        };
        reader.onerror = function () { toast("无法读取图片文件"); };
        reader.readAsDataURL(f);
      };
      content.appendChild(row("本地壁纸", file));

      var url = document.createElement("input");
      url.type = "url";
      url.value = settings.image && settings.image.indexOf("data:") !== 0 ? settings.image : PRESET;
      url.placeholder = "https://example.com/wallpaper.jpg";
      url.setAttribute("aria-label", "壁纸链接");
      url.className = "h-9 w-full rounded-lg bg-surface-elevated px-3 text-sm text-foreground ring-1 ring-inset ring-border/60 outline-none focus:ring-2 focus:ring-ring";
      var urlRow = row("壁纸链接", url);
      var applyUrl = button("应用");
      applyUrl.onclick = function () {
        settings.image = url.value.trim() || PRESET;
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
        var result = row(label, wrap);
        content.appendChild(result);
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
        preview.style.backgroundImage = settings.image ? "url(" + JSON.stringify(imageSrc()) + ")" : "none";
        status.textContent = !settings.enabled ? "背景已关闭" : imageState?.status === "error" ? "图片加载失败" : imageState?.status === "loaded" ? "" : "正在加载图片";
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
    ui();
    apply();
  }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
