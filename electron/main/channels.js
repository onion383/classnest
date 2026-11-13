// =========================================================================
// channels.js —— 主进程 IPC 通道名的唯一来源
//
// 本文件由 testjs/tools/gen-channels.mjs 从 electron/ipc-channels.json 生成，
// **不要手改**：改名单请改 JSON，再运行 `npm run channels:gen`。
//
// 为什么生成而不是手写：ipc-channels.json 已是 preload 白名单与渲染层常量的
// 唯一来源；主进程若继续写 ipcMain.handle('...') 字面量，同一份名单就有两份，
// 改名时只改一侧会变成运行期「通道不存在」。
//
// IPC 包装在调用时才取 ipcMain：main.ipc-auth.js 会在启动最早期替换
// ipcMain.handle / ipcMain.on 挂发送方校验，提前 bind 原始方法会绕过鉴权。
// 同时这里不在顶层 require('electron')，普通 node 单测可以直接 import 本模块。
// =========================================================================

const CH = Object.freeze({
  // ---- send —— 渲染层 → 主进程（单向） ----
  WIDGET_RESIZE: 'widget-resize',
  WIDGET_DRAG_START: 'widget-drag-start',
  WIDGET_DRAG_MOVE: 'widget-drag-move',
  WIDGET_DRAG_END: 'widget-drag-end',
  WIDGET_CENTER: 'widget-center',
  WIDGET_RESTORE_POSITION: 'widget-restore-position',
  WIDGET_FULLSCREEN: 'widget-fullscreen',
  WIDGET_RESTORE: 'widget-restore',
  WIDGET_SET_VISIBLE: 'widget-set-visible',
  WIDGET_SET_SESSION_VISIBLE: 'widget-set-session-visible',
  WIDGET_CONTEXT_MENU: 'widget-context-menu',
  WIDGET_EXIT: 'widget-exit',
  TO_WIDGET: 'to-widget',
  WIN_MINIMIZE: 'win-minimize',
  WIN_MAXIMIZE_TOGGLE: 'win-maximize-toggle',
  WIN_CLOSE: 'win-close',
  SHUTDOWN_ACTION: 'shutdown-action',
  QUIT_APP: 'quit-app',
  SHOW_NATIVE_CONTEXT_MENU: 'show-native-context-menu',
  AI_CONTEXT_MENU: 'ai-context-menu',
  THEME_CHROME: 'theme-chrome',
  DESKTOP_WIDGET_ENABLED: 'desktop-widget-enabled',
  DESKTOP_WIDGET_CONTENT_READY: 'desktop-widget-content-ready',
  DESKTOP_WIDGET_DRAG_START: 'desktop-widget-drag-start',
  DESKTOP_WIDGET_DRAG_MOVE: 'desktop-widget-drag-move',
  DESKTOP_WIDGET_DRAG_END: 'desktop-widget-drag-end',
  DESKTOP_WIDGET_OPEN_PAGE: 'desktop-widget-open-page',
  WIDGETS_READY: 'widgets-ready',
  MIGRATION_READY: 'migration-ready',
  MIGRATION_DISMISS: 'migration-dismiss',
  SETUP_READY: 'setup-ready',
  SETUP_COMPLETE: 'setup-complete',
  SETUP_QUIT: 'setup-quit',
  LAUNCH_SKIP_WARN: 'launch-skip-warn',
  LAUNCH_OPEN_DOWNLOAD: 'launch-open-download',
  UPDATE_INSTALL: 'update-install',
  INP_REPORT: 'inp-report',
  // ---- invoke —— 渲染层 → 主进程（请求-响应） ----
  SELECT_FOLDER: 'select-folder',
  SAVE_BACKGROUND_IMAGE: 'save-background-image',
  SAVE_FILE: 'save-file',
  SCREENSHOT_CAPTURE: 'screenshot-capture',
  SCREENSHOT_REGION: 'screenshot-region',
  SCREENSHOT_REGION_SHOW: 'screenshot-region-show',
  SCREENSHOT_REGION_END: 'screenshot-region-end',
  NOTE_SAVE: 'note-save',
  OPEN_FILE: 'open-file',
  OPEN_UPLOAD_FILE: 'open-upload-file',
  OPEN_FOLDER: 'open-folder',
  GET_SESSION_WIDGET_VISIBLE: 'get-session-widget-visible',
  GET_DESKTOP_LAYER_STATE: 'get-desktop-layer-state',
  GET_USB_AUTO_OPEN: 'get-usb-auto-open',
  SET_USB_AUTO_OPEN: 'set-usb-auto-open',
  OPEN_EXTERNAL: 'open-external',
  GET_MASTER_KEY: 'get-master-key',
  SECURE_HANDSHAKE: 'secure-handshake',
  APPS_SELECT_FILE: 'apps-select-file',
  APPS_RESOLVE_PATHS: 'apps-resolve-paths',
  APPS_LAUNCH: 'apps-launch',
  GET_DATA_DIRECTORIES: 'get-data-directories',
  SET_DATA_DIR: 'set-data-dir',
  SET_THUMBS_DIR: 'set-thumbs-dir',
  SET_SKILLS_DIR: 'set-skills-dir',
  SET_DB_ENCRYPTION: 'set-db-encryption',
  SET_INITIAL_DATA_DIR: 'set-initial-data-dir',
  GET_SETUP_WARMUP: 'get-setup-warmup',
  LAUNCH_PLAN: 'launch-plan',
  GET_PENDING_NOTIFICATION: 'get-pending-notification',
  BACKEND_STATUS: 'backend-status',
  BOOT_STATUS: 'boot-status',
  RESTART_BACKEND: 'restart-backend',
  BACKEND_FAILURE: 'backend-failure',
  PROBE_BACKEND: 'probe-backend',
  PERF_SNAPSHOT: 'perf-snapshot',
  PERF_RESTART_FRONTEND: 'perf-restart-frontend',
  PERF_RESTART_WIDGET: 'perf-restart-widget',
  PERF_RELAUNCH_APP: 'perf-relaunch-app',
  PERF_GC: 'perf-gc',
  PERF_STARTUP: 'perf-startup',
  PERF_DISK_USAGE: 'perf-disk-usage',
  PERF_LOGS_CLEAR: 'perf-logs-clear',
  GET_APP_VERSION: 'get-app-version',
  UPDATE_CHECK: 'update-check',
  SET_CONTENT_PROTECTION: 'set-content-protection',
  COPY_SENSITIVE_TEXT: 'copy-sensitive-text',
  // ---- receive —— 主进程 → 渲染层（推送） ----
  FROM_MAIN: 'from-main',
})

function getIpcMain() {
  return require('electron').ipcMain
}

const IPC = Object.freeze({
  handle(channel, listener) {
    return getIpcMain().handle(channel, listener)
  },
  on(channel, listener) {
    return getIpcMain().on(channel, listener)
  },
  once(channel, listener) {
    return getIpcMain().once(channel, listener)
  },
})

module.exports = { CH, IPC }
