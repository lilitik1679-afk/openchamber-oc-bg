# openchamber-oc-bg

为 **OpenChamber Web** 添加自定义背景壁纸与毛玻璃面板的前端插件。

单文件、零依赖、无构建步骤：一段 vanilla JS 直接注入样式、操作 DOM，并把设置项挂进 OpenChamber 的 Appearance 设置页。

> 参考项目：[HaoyueQin/deepseek-harness-background](https://github.com/HaoyueQin/deepseek-harness-background)（MIT）。本插件借用了它的技术思路：固定壁纸层 + 遮罩层、按属性开关、覆盖/复用设计 token、`backdrop-filter` 毛玻璃。实现是为 OpenChamber 的 token 体系重写的，不是对原项目的直接移植。

## 功能

- **自定义壁纸**：上传本地图片，或粘贴图片链接；内置一张默认壁纸。
- **视频背景**：本地或链接的 MP4 / WebM。播放时自动关掉壁纸模糊和毛玻璃采样，避免每帧重绘拖慢聊天滚动；切到后台或系统开启「减少动态效果」时暂停。本地视频存在 IndexedDB，不进 `localStorage`。
- **无后缀链接也能识别**：「自动」模式先看后缀，没有后缀时用 `HEAD` 读响应的 `Content-Type` 判断是图片还是视频。
- **防盗链兼容**：部分站点会拒绝带来源页的视频请求（返回 403）。直连失败时，会改用不带来源的受限请求（上限 32MB）读成本地 blob 再播放，不经过任何代理。站点不允许跨站读取时，会提示改用本地文件。
- **壁纸层 + 遮罩层**：壁纸固定在 `z-index:-2`，遮罩在 `z-index:-1`；遮罩自动跟随明暗主题（浅色用白纱，深色用黑纱）。
- **毛玻璃面板**：对卡片、弹层、侧边栏、输入区等面板做半透明 + `backdrop-filter` 模糊。
- **实时调节**：壁纸不透明度、遮罩强度、面板不透明度、毛玻璃模糊、壁纸模糊、填充方式（铺满 / 完整显示）。
- **设置持久化**：写入 `localStorage`（键 `ocbg.settings.v2`）。
- **中文字形兜底**：自托管 Noto Sans SC 变量字体，给没有 CJK 字体的设备补字形。
- **不覆盖主题**：只读取宿主的设计 token（`--surface-background`、`--card`、`--popover` 等），颜色仍由 OpenChamber 自己管理。

## 目录结构

```
oc-bg/
├── oc-bg.js                     # 插件本体（唯一源码文件）
├── wallpaper.webp               # 默认壁纸（本地预设）
└── fonts/noto-sans-sc/          # 自托管 Noto Sans SC 变量字体（OFL-1.1，含 LICENSE）
    ├── index.css
    └── files/*.woff2
```

## 安装

把文件放到 OpenChamber Web 的 `dist` 目录（`@openchamber/web` 安装位置）：

```
<dist>/oc-bg.js
<dist>/oc-bg-wallpaper.webp
<dist>/oc-bg-fonts/noto-sans-sc/...
```

然后在 `<dist>/index.html` 里加两行：

```html
<!-- 放在 </head> 前 -->
<link rel="stylesheet" href="/oc-bg-fonts/noto-sans-sc/index.css">

<!-- 放在 </body> 前 -->
<script src="/oc-bg.js?v=6"></script>
```

刷新页面即可。`?v=6` 是缓存版本号，改代码后把它递增即可让浏览器重新拉取。

> 说明：这是直接改动 `@openchamber/web` 的 `dist`，升级 OpenChamber 时可能被覆盖，需要重新安装。

## 使用

打开 **设置 → Appearance**，页面里会出现「背景与毛玻璃」区块：

| 控件 | 含义 |
| --- | --- |
| 启用背景 | 总开关 |
| 类型 | 自动 / 图片 / 视频。自动按后缀判断，无后缀时读响应类型 |
| 本地图片或视频 | 文件选择器可选所有图片和视频（含 `.mp4` `.webm` `.mov` `.mkv` 等）；能否播放取决于浏览器编码支持，推荐 H.264 MP4 / WebM。图片转 Data URL，视频存 IndexedDB，超过 32MB 会拒绝 |
| 壁纸链接 | 粘贴可直接访问的图片或视频 URL |
| 壁纸不透明度 | `0–100%`，壁纸整体透明度 |
| 遮罩 | `0–95%`，壁纸之上的可读性遮罩 |
| 面板不透明度 | `5–100%`，面板表面透明度；`≥98%` 时关闭毛玻璃 |
| 毛玻璃模糊 | `0–40px`，面板 `backdrop-filter` 模糊半径 |
| 壁纸模糊 | `0–60px`，壁纸自身的模糊 |
| 壁纸填充 | `cover`（铺满）/ `contain`（完整显示） |
| 清除背景 | 关闭背景并恢复原始外观 |

## 工作原理

- 用 `MutationObserver` 监听 DOM，把设置区块插到 OpenChamber Appearance 页的 `[data-settings-item="appearance.session-activity"]` 之前。
- 设置写入 `localStorage`，启动时读取并做范围钳制。
- 背景通过 `<html>` 上的 `data-ocbg` / `data-ocbg-glass` 属性开关，具体样式由注入的 `<style id="ocbg-style">` 提供。
- 面板半透明用 `color-mix(in srgb, var(--token) var(--ocbg-panel-opacity), transparent)`，只在 `.bg-card`、`.bg-popover`、`.bg-sidebar` 等面板类上生效；毛玻璃滤镜只加在真正的面板上，避免给每个按钮都上滤镜。
- 壁纸图片先经 `Image()` 预加载校验，失败时提示「图片加载失败」。

## 兼容性

面向 OpenChamber Web（`@openchamber/web`）。依赖的设置锚点 `appearance.session-activity` 与 token 名称属于宿主实现，宿主改版后可能需要同步调整。

## 致谢 / 第三方资源

- 技术思路参考 [HaoyueQin/deepseek-harness-background](https://github.com/HaoyueQin/deepseek-harness-background)（MIT License）。
- 字体：Noto Sans SC，SIL Open Font License 1.1，见 `fonts/noto-sans-sc/LICENSE`。
- 内置默认壁纸 `wallpaper.webp` 仅作演示用途，版权归原始来源所有。

## License

MIT，见 [LICENSE](./LICENSE)。