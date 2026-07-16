# AGENTS.md

## Project Overview

MyZ Danmaku 是一个 Chrome Manifest V3 扩展，使用 Vite + @crxjs/vite-plugin 构建。它将 YouTube 评论区中含时间码的评论转化为弹幕，在视频播放器顶部以动画形式展示。

核心依赖 `youtubei.js` 是第三方库，用于与 YouTube 内部 API 通信。YouTube 接口变动可能导致此库失效，进而影响扩展功能。

## Build & Quality Commands

```bash
npm run typecheck   # TypeScript 类型检查（必须在提交前通过）
npm run lint        # ESLint 代码规范检查
npm run build       # 生产构建，输出 dist/ 和 release/*.zip
npm run dev         # 开发模式（Vite HMR + CRX 热更新）
npm run icons       # 重新生成多尺寸 PNG 图标
```

## Tech Stack

- **TypeScript** — 全项目使用，`strict: true`
- **Vite 7** + `@crxjs/vite-plugin` — 构建与 HMR
- **Chrome Manifest V3** — 扩展规范
- **youtubei.js v16+** — YouTube 评论抓取
- **ESLint** (flat config) + **Prettier** — 代码规范
- **Playwright** — 测试（目前仅 test/ 目录下的单元测试）

## Code Conventions

- **Import 顺序**: `builtin/external` → `internal` → `parent` → `sibling` → `index`，按字母升序排列
- **未使用变量**: 用 `_` 前缀命名（如 `_unused`）
- **文件命名**: TypeScript 文件使用小写 kebab-case
- **模块系统**: ESM（`"type": "module"`），不使用 CommonJS
- **Chrome API 类型**: 使用 `@types/chrome` 提供的类型，不使用 `window.chrome`
- **DOM 操作**: 内容脚本直接操作 YouTube 页面 DOM，需谨慎处理动态元素
- **状态管理**: 通过 `chrome.storage.sync` 持久化设置，通过 IndexedDB 缓存弹幕数据

## Architecture

### 核心模块

| 文件 | 职责 |
|------|------|
| `src/background.ts` | Service Worker — 缓存读写、徽标更新、消息路由 |
| `src/content.ts` | 内容脚本 — 视频 ID 识别、评论抓取调度、弹幕浮层生命周期 |
| `src/content/network.ts` | youtubei.js 封装层 — InnterTube 客户端初始化、评论抓取与解析 |
| `src/content/ui.ts` | 弹幕浮层 UI — DOM 创建、轨道管理、动画控制、时间轴指示 |
| `src/popup/main.ts` | Popup 入口 — 弹幕列表展示、设置面板 |
| `src/shared/storage.ts` | IndexedDB 操作封装 |
| `src/shared/settings.ts` | 设置读写与变更订阅 |
| `src/shared/i18n.ts` | 自定义 i18n 系统 |

### 数据流

1. Content script 检测到视频 → 通过 `content/network.ts` 调用 youtubei.js 抓取评论
2. 解析出含时间码的评论 → 生成 `DanmakuEntry[]`
3. 通过 `chrome.runtime.sendMessage` 发送 `danmaku:update` → Background script 写入 IndexedDB
4. Content script 从 IndexedDB 读取缓存 → 渲染弹幕浮层
5. Popup script 从 IndexedDB 读取缓存 → 展示弹幕列表

### 关键路径

- **评论抓取入口**: `src/content/network.ts` 中的 `loadDanmakuFromInnertube()`
- **弹幕条目类型**: `src/shared/danmaku.ts` 中的 `DanmakuEntry`
- **缓存操作**: `src/shared/storage.ts` 中的 `readDanmakuRecord()` / `writeDanmakuRecord()`
- **消息路由**: `src/background.ts` 中的 `chrome.runtime.onMessage` 监听

## Important Notes

- **youtubei.js 是第三方依赖**：该库封装了 YouTube 内部 API，YouTube 接口改动可能导致其失效。修改 `src/content/network.ts` 时需关注上游库的版本兼容性。
- **DOM 依赖**: 内容脚本依赖 YouTube 页面的 DOM 结构（如 `.ytd-watch-metadata`），YouTube 改版可能导致选择器失效。
- **Service Worker 生命周期**: MV3 的 Service Worker 非持久化，状态同步依赖 `chrome.storage` 和 IndexedDB。
- **SPA 导航**: YouTube 是单页应用，视频切换不触发页面刷新，需通过 `yt-navigate-finish` 事件检测。
