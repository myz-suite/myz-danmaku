// Shared i18n system for MyZ Danmaku extension
// Completely independent from Chrome's i18n API

export type Language = 'zh_CN' | 'en';

export interface Messages {
  [key: string]: string | ((...args: string[]) => string);
}

export const messages: Record<Language, Messages> = {
  zh_CN: {
    // Extension metadata
    extensionName: 'MyZ 弹幕',
    extensionDescription: '将 YouTube 评论作为弹幕叠加显示，并与弹出窗口同步。',
    extensionDefaultTitle: 'MyZ 弹幕',
    
    // Popup UI
    popupTitle: 'MyZ 弹幕',
    refreshButton: '刷新',
    refreshButtonAriaLabel: '刷新弹幕列表',
    loadingStatus: '加载中…',
    danmakuCount: (count: string) => `共 ${count} 条弹幕`,
    notVideoPage: '当前页面不是视频播放',
    noDanmakuAvailable: '暂时没有可显示的弹幕',
    loadError: '加载弹幕时出现错误',
    anonymousAuthor: '匿名',
    pinnedBadge: '置顶',
    likeCount: (count: string) => `👍 ${count}`,
    supportLink: '遇到问题？提交支持请求',
    
    // Settings
    settingsButtonAriaLabel: '设置',
    languageModalTitle: '语言设置',
    closeButtonAriaLabel: '关闭',
    chineseLanguage: '中文 (简体)',
    englishLanguage: 'English',
    saveButton: '保存',
    cancelButton: '取消',
    fontSizeLabel: '弹幕字体大小',
    fontSizeDescription: '调整播放器内弹幕文字的尺寸。',
    fontSizeSmall: '偏小',
    fontSizeMedium: '默认',
    fontSizeLarge: '偏大',
    pageCountLabel: '评论抓取页数',
    pageCountDescription: '每次刷新时加载的评论页数（1-60）。',
    
    // Content script
    danmakuButton: '弹',
    danmakuButtonTitle: '发送弹幕 (Enter)',
    danmakuButtonAriaLabel: '发送弹幕',
    sendUnavailableNotice: '发送弹幕功能暂未实现，请在评论区通过时间码来发送弹幕。'
  },
  
  en: {
    // Extension metadata
    extensionName: 'MyZ Danmaku',
    extensionDescription: 'Overlay YouTube comments as danmaku and sync with popup.',
    extensionDefaultTitle: 'MyZ Danmaku',
    
    // Popup UI
    popupTitle: 'MyZ Danmaku',
    refreshButton: 'Refresh',
    refreshButtonAriaLabel: 'Refresh danmaku list',
    loadingStatus: 'Loading…',
    danmakuCount: (count: string) => `${count} danmaku total`,
    notVideoPage: 'Current page is not a video playback',
    noDanmakuAvailable: 'No danmaku available to display',
    loadError: 'Error occurred while loading danmaku',
    anonymousAuthor: 'Anonymous',
    pinnedBadge: 'Pinned',
    likeCount: (count: string) => `👍 ${count}`,
    supportLink: 'Having issues? Submit a support request',
    
    // Settings
    settingsButtonAriaLabel: 'Settings',
    languageModalTitle: 'Language Settings',
    closeButtonAriaLabel: 'Close',
    chineseLanguage: 'Chinese (Simplified)',
    englishLanguage: 'English',
    saveButton: 'Save',
    cancelButton: 'Cancel',
    fontSizeLabel: 'Danmaku font size',
    fontSizeDescription: 'Adjust the size of overlay comments on the video.',
    fontSizeSmall: 'Smaller',
    fontSizeMedium: 'Default',
    fontSizeLarge: 'Larger',
    pageCountLabel: 'Comment pages to load',
    pageCountDescription: 'Number of comment pages to fetch per refresh (1-60).',
    
    // Content script
    danmakuButton: '弹',
    danmakuButtonTitle: 'Send danmaku (Enter)',
    danmakuButtonAriaLabel: 'Send danmaku',
    sendUnavailableNotice: 'Danmaku sending is not yet implemented. Please send danmaku through timecodes in the comments section.'
  }
};

export class I18nManager {
  private currentLanguage: Language;
  private listeners: Set<(language: Language) => void> = new Set();
  
  constructor(initialLanguage: Language = 'zh_CN') {
    this.currentLanguage = initialLanguage;
  }
  
  getCurrentLanguage(): Language {
    return this.currentLanguage;
  }
  
  setLanguage(language: Language): void {
    if (this.currentLanguage !== language) {
      this.currentLanguage = language;
      this.notifyListeners(language);
    }
  }
  
  addLanguageChangeListener(listener: (language: Language) => void): void {
    this.listeners.add(listener);
  }
  
  removeLanguageChangeListener(listener: (language: Language) => void): void {
    this.listeners.delete(listener);
  }
  
  private notifyListeners(language: Language): void {
    this.listeners.forEach(listener => {
      try {
        listener(language);
      } catch (error) {
        console.warn('Error in language change listener:', error);
      }
    });
  }
  
  t(key: string, ...args: string[]): string {
    const langMessages = messages[this.currentLanguage];
    if (!langMessages) {
      console.warn(`No messages for language: ${this.currentLanguage}`);
      return key;
    }
    
    const message = langMessages[key];
    if (!message) {
      console.warn(`Missing message key: ${key} for language: ${this.currentLanguage}`);
      return key;
    }
    
    if (typeof message === 'function') {
      try {
        return message(...args);
      } catch (error) {
        console.warn(`Error executing message function for key: ${key}`, error);
        return key;
      }
    }
    
    return message;
  }
}

// Create singleton instance
export const i18n = new I18nManager();

// Utility functions for convenience
export const t = (key: string, ...args: string[]) => i18n.t(key, ...args);
export const getCurrentLanguage = () => i18n.getCurrentLanguage();
export const setLanguage = (language: Language) => i18n.setLanguage(language);

// Language change listener helpers
export const onLanguageChange = (listener: (language: Language) => void) => {
  i18n.addLanguageChangeListener(listener);
  return () => i18n.removeLanguageChangeListener(listener);
};
