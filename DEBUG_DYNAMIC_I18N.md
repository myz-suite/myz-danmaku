# MyZ Danmaku 动态多语言系统 - 调试指南

## 🔍 问题诊断

经过分析，发现content script的动态语言切换存在以下问题：

### ❌ 发现的问题

1. **I18nManager未正确初始化**：content script使用了`t()`函数，但没有正确设置初始语言
2. **语言同步机制不完整**：storage变化和内部事件监听可能未正确工作
3. **缺少状态跟踪**：没有跟踪当前语言状态

### ✅ 修复方案

我已经实现了完整的动态语言系统：

## 🎯 核心修复内容

### 1. 正确的I18nManager初始化
```typescript
// 在initializeLanguage中正确初始化
const storedLanguage = await getStoredLanguage();
console.log('MyZ Danmaku: Initializing content script with language', storedLanguage);

// 设置I18nManager的初始语言
setLanguage(storedLanguage);

// 更新UI
updateContentScriptLanguage(storedLanguage);
```

### 2. 完整的语言同步机制
```typescript
// 监听storage变化（来自popup的语言切换）
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes[LANGUAGE_STORAGE_KEY]) {
    const newLanguage = changes[LANGUAGE_STORAGE_KEY].newValue as Language;
    console.log('MyZ Danmaku: Language change detected in storage', newLanguage);
    if (newLanguage) {
      setLanguage(newLanguage); // 确保I18nManager更新
    }
  }
});

// 监听内部语言变化事件
onLanguageChange((language) => {
  console.log('MyZ Danmaku: Internal language change event', language);
  updateContentScriptLanguage(language);
});
```

### 3. 完整的状态管理
```typescript
let currentLanguage: Language = 'zh_CN';
let isLanguageInitialized = false;

function updateContentScriptLanguage(language: Language): void {
  console.log('MyZ Danmaku: Updating content script language to', language);
  currentLanguage = language;
  
  // 更新所有需要语言更新的UI元素
  if (danmakuButton) {
    updateDanmakuButtonText(danmakuButton);
  }
}
```

## 🔧 调试步骤

### 1. 检查Console日志
加载扩展后，打开任何YouTube页面，查看控制台日志：
```
MyZ Danmaku: Initializing content script with language en
MyZ Danmaku: Language initialization complete
```

### 2. 测试语言切换
1. 打开扩展popup
2. 点击设置按钮 (⚙️)
3. 选择英文 (English)
4. 点击保存
5. 查看控制台应该显示：
```
MyZ Danmaku: Language change detected in storage en
MyZ Danmaku: Updating content script language to en
```

### 3. 验证内容更新
切换语言后，YouTube页面上的弹幕按钮应该立即更新为英文文本。

## 📊 实现对比

| 功能 | 之前(静态) | 现在(动态) |
|------|------------|------------|
| Chrome商店检测 | ✅ 静态i18n | ✅ 混合策略 |
| 运行时语言切换 | ❌ 不支持 | ✅ 实时切换 |
| 跨组件同步 | ❌ 无同步 | ✅ 存储+事件 |
| Content Script | ❌ 静态文本 | ✅ 动态更新 |
| 浏览器语言适配 | ❌ 不支持 | ✅ 自动检测 |

## 🧪 测试验证

### 1. 浏览器默认语言测试
```bash
# 设置浏览器为英文环境
# 打开扩展应该显示英文界面
```

### 2. 手动语言切换测试
```bash
# 1. 打开popup，选择中文
# 2. 保存设置
# 3. 观察content script按钮变为中文
# 4. 切换为英文
# 5. 观察content script按钮变为英文
```

### 3. 跨组件同步测试
```bash
# 1. 在popup中切换语言
# 2. 验证content script实时更新
# 3. 验证background脚本语言同步
# 4. 验证存储值正确更新
```

## 📋 当前状态

- ✅ **动态语言系统**：完整实现
- ✅ **Popup尺寸优化**：450px × 600px 保留
- ✅ **实时语言切换**：跨组件同步
- ✅ **浏览器语言适配**：自动检测默认语言
- ✅ **构建测试**：通过所有检查

## 🔍 调试技巧

如果语言切换仍然不工作，请检查：

1. **Console日志**：查看是否有错误信息
2. **Storage值**：检查 `chrome.storage.sync.get('myz-danmaku-language')` 
3. **网络连接**：确保storage同步正常工作
4. **扩展权限**：确认有storage权限

现在你的MyZ Danmaku扩展应该拥有完整的动态多语言功能，content script会实时响应popup中的语言设置！🌍