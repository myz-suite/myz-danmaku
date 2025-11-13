import { defineManifest } from "@crxjs/vite-plugin";
import packageJson from "../package.json" with { type: "json" };

// Hybrid approach:
// - Chrome i18n for Web Store detection and basic metadata
// - Custom i18n for dynamic runtime language switching
// This way Chrome Web Store knows we support multiple languages,
// but users can still switch languages dynamically in the extension

export default defineManifest({
  manifest_version: 3,
  
  // Use Chrome i18n for store metadata (required for store language detection)
  name: "__MSG_extensionName__",
  description: "__MSG_extensionDescription__",
  
  version: packageJson.version,
  action: {
    default_title: "__MSG_extensionDefaultTitle__",
    default_popup: "src/popup/index.html"
  },
  background: {
    service_worker: "src/background.js",
    type: "module"
  },
  icons: {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  permissions: ["storage", "activeTab", "tabs"],
  host_permissions: ["https://www.youtube.com/*"],
  content_scripts: [
    {
      matches: ["https://www.youtube.com/*"],
      js: ["src/content.js"],
      run_at: "document_idle"
    }
  ],
  
  // Required for Chrome Web Store language detection
  default_locale: "zh_CN"
});