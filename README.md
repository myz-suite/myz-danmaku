# MyZ Danmaku

MyZ Danmaku 是一个 Chrome 浏览器扩展（Manifest V3），为 YouTube 播放器叠加来自评论区的弹幕。扩展会抓取当前视频的评论，解析其中包含的时间标记，将弹幕与视频时间轴同步，在播放器顶部以动画轨道的形式展示。

> **注意**：本扩展依赖 [youtubei.js](https://github.com/LuanRT/YouTube.js) 作为第三方库与 YouTube 内部接口通信。YouTube 的接口可能随时变更，这可能导致扩展功能暂时失效。遇到此类问题请关注上游库的更新。

## 功能特性

- **评论转弹幕** — 通过 youtubei.js 抓取评论树，自动识别含时间码的评论（如 `1:23 这段太赞了`），构建弹幕条目
- **播放器浮层渲染** — 在视频顶部创建弹幕轨道，根据文本长度与时间分组动态排布，避免重叠
- **离线缓存** — 弹幕数据存入 IndexedDB，支持跨后台脚本、内容脚本、弹窗同步
- **Popup 弹幕列表** — 点击扩展图标查看完整弹幕列表，支持手动刷新
- **徽标计数** — 扩展图标徽标实时显示当前视频的弹幕数量
- **时间轴指示** — 在 YouTube 进度条上绘制弹幕刻度标记
- **自定义设置** — 弹幕字体大小（偏小/默认/偏大）与评论抓取页数（1–60 页）可调
- **SPA 导航感知** — 支持 YouTube 单页应用内的视频切换，自动恢复弹幕缓存
- **多语言** — 支持简体中文与英文界面

## 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript |
| 构建 | Vite + @crxjs/vite-plugin |
| 扩展规范 | Chrome Manifest V3 |
| 弹幕数据源 | [youtubei.js](https://github.com/LuanRT/YouTube.js) v16+ |
| 测试 | Playwright |
| 代码规范 | ESLint + Prettier |

## 开发

```bash
# 安装依赖
npm install

# 启动开发模式（Vite HMR + CRX 热更新）
npm run dev

# 类型检查
npm run typecheck

# 代码规范检查
npm run lint
```

## 构建

```bash
# 生产构建（输出至 dist/，同时在 release/ 生成 zip 包）
npm run build

# 预览构建产物
npm run preview
```

## 图标生成

```bash
# 从 SVG 模板导出多尺寸 PNG
npm run icons
```

源文件位于 `assets/icons/icon-template.svg`，生成产物输出到 `public/icons/`。

## 项目结构

```
├── _locales/              # Chrome i18n 多语言文件
│   ├── en/
│   └── zh_CN/
├── assets/
│   └── icons/             # SVG 模板与图标源文件
├── public/
│   └── icons/             # 打包时使用的多尺寸 PNG 图标
├── scripts/
│   └── generate-icons.mjs # 图标生成脚本
├── src/
│   ├── background.ts      # Service Worker：缓存管理、徽标更新、消息路由
│   ├── content.ts         # 内容脚本：视频识别、评论抓取、弹幕浮层管理
│   ├── content.css        # 弹幕浮层样式（轨道、动画）
│   ├── manifest.ts        # 扩展清单（由 @crxjs/vite-plugin 构建）
│   ├── content/
│   │   ├── network.ts     # youtubei.js 通信层，评论抓取与解析
│   │   └── ui.ts          # 弹幕浮层 DOM 操作与动画控制
│   ├── popup/
│   │   ├── index.html     # Popup 页面
│   │   ├── main.ts        # Popup 入口
│   │   ├── ui.ts          # Popup 渲染逻辑
│   │   └── style.css      # Popup 样式
│   └── shared/
│       ├── constants.ts   # 共享常量
│       ├── danmaku.ts     # 弹幕数据类型定义
│       ├── i18n.ts        # 自定义 i18n 系统
│       ├── language.ts    # 语言偏好管理
│       ├── settings.ts    # 扩展设置管理
│       └── storage.ts     # IndexedDB 缓存操作
└── test/
    └── multipleline_test.ts
```

## 工作原理

1. **视频识别** — 内容脚本监听 `history` 变化与 `yt-navigate-finish` 事件，获取当前页面视频 ID
2. **评论抓取** — 通过 `youtubei.js/web` 分页请求评论区，解析含时间码的评论及其回复
3. **弹幕构建** — 将每个时间戳映射为唯一弹幕条目，支持一条评论包含多个时间点时自动拆分
4. **缓存同步** — 抓取结果写入 IndexedDB，通过 `chrome.runtime.sendMessage` 同步至背景页与弹窗
5. **弹幕渲染** — 内容脚本按轨道顺序与文本宽度约束，在视频顶部创建动画元素
6. **用户交互** — 弹窗读取缓存展示列表；操作按钮徽标显示解析数量；时间轴标记指示弹幕分布

### 缓存与消息协议

- 缓存库名：`myz-danmaku-cache`，对象仓库：`danmaku`
- 消息类型：`danmaku:update`（写入）、`danmaku:get`（读取）、`danmaku:popup-data`（弹窗数据）、`danmaku:clear`（清除）

## 权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 读写 Chrome 存储（设置与语言偏好） |
| `activeTab` | 获取当前标签页信息以更新徽标 |
| `tabs` | 跨标签页管理弹幕状态 |
| `host_permissions: youtube.com` | 在 YouTube 页面注入内容脚本 |

## 支持与反馈

- GitHub Issues: <https://github.com/myz-suite/myz-danmaku/issues>

## 许可

本项目为实验性项目，API 与交互可能随时调整。欢迎反馈改进意见。
