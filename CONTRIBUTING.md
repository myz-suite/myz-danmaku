# Contributing to MyZ Danmaku

感谢你对 MyZ Danmaku 的关注！欢迎提交 Issue 和 Pull Request。

## 重要声明：第三方依赖风险

本扩展依赖 [youtubei.js](https://github.com/LuanRT/YouTube.js) 作为核心数据源。**该库封装了 YouTube 的非公开内部 API**，这意味着：

- YouTube 随时可能变更接口结构或行为，导致扩展功能暂时失效
- 上游库维护者需要在 YouTube 改版后更新适配，本项目需等待上游修复后才能更新
- 任何涉及 `src/content/network.ts` 的修改都可能受到上游库 API 变化的影响

**贡献者在修改与 YouTube 通信相关的代码时，请确保：**
1. 检查 `youtubei.js` 的最新文档与 changelog
2. 不要绕过 `youtubei.js` 直接调用 YouTube API
3. 在 PR 描述中说明是否依赖特定的上游库版本

## 开发环境

```bash
# 安装依赖
npm install

# 启动开发模式
npm run dev
```

开发模式会启动 Vite HMR 和 CRX 热更新，修改代码后浏览器扩展自动重新加载。

## 提交前必检

```bash
# 类型检查
npm run typecheck

# 代码规范
npm run lint
```

两项检查都必须通过后才能提交。

## 代码规范

- **TypeScript**：全项目使用，`strict: true`
- **Import 顺序**：`builtin/external` → `internal` → `parent` → `sibling` → `index`，按字母升序
- **未使用变量**：使用 `_` 前缀命名
- **文件命名**：TypeScript 文件使用小写 kebab-case
- **模块系统**：ESM（`"type": "module"`）
- **注释**：按需添加，不强制要求

## 项目结构参考

```
src/
  background.ts      # Service Worker
  content.ts         # 内容脚本主逻辑
  content/
    network.ts       # youtubei.js 通信层
    ui.ts            # 弹幕浮层 UI
  popup/             # Popup 弹窗
  shared/            # 共享类型与工具
```

## 提交 PR

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feat/my-feature`
3. 确保 `npm run typecheck` 和 `npm run lint` 均通过
4. 提交 PR 并描述变更内容
5. 等待 Code Review

## Bug 反馈

- GitHub Issues: <https://github.com/myz-suite/myz-support/issues>

反馈时请提供：
- YouTube 页面 URL（如适用）
- 浏览器版本与扩展版本
- 控制台错误信息（如有）

## 许可

本项目为实验性项目，API 与交互可能随时调整。
