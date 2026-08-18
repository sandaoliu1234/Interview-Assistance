/**
 * 系统级窗口捕获排除（对齐 HireMe 发行版的 applyExcludeFromCapture）。
 *
 * 原理：调用 Win32 user32.dll 的 SetWindowDisplayAffinity，给窗口设置
 *   WDA_EXCLUDEFROMCAPTURE (0x11)：窗口完全从屏幕捕获/录屏/屏幕共享中排除，
 *   但本地显示器正常可见——这正是比 setContentProtection(WDA_MONITOR，录屏显示黑色)
 *   更彻底的方案，也是 HireMe 发行版 stealthWindow 采用的方式。
 *
 * 实现途径：项目已依赖 koffi（FFI 库），与发行版底层一致；无需额外 native addon。
 *
 * 平台支持：
 *   - Windows 10 version 2004 (build 19041) 及以上：WDA_EXCLUDEFROMCAPTURE 生效。
 *   - 更老的 Windows：回退 WDA_MONITOR (0x01)，录屏时窗口显示为黑色。
 *   - 非 Windows：回退 Electron 内置 win.setContentProtection()。
 */

const koffi = require('koffi');

// Windows Display Affinity 标志位
const WDA_NONE = 0x00000000;              // 默认：正常参与屏幕捕获
const WDA_MONITOR = 0x00000001;           // 捕获时显示为黑色块
const WDA_EXCLUDEFROMCAPTURE = 0x00000011; // 完全从捕获中排除（Win10 2004+）

// 懒加载的 user32 句柄与函数指针（仅 win32 加载一次）
let _user32 = null;
let _setAffinity = null;
let _loadState = null;   // null=未尝试；true=成功；false=失败

/**
 * 懒加载 user32.dll 并解析 SetWindowDisplayAffinity。
 * @returns {boolean} 当前平台是否支持 koffi 调用方式
 */
function ensureFunc() {
  if (_loadState !== null) return _loadState;
  // 仅 Windows 走 koffi 路径；其它平台由调用方回退 setContentProtection
  if (process.platform !== 'win32') {
    _loadState = false;
    return false;
  }
  try {
    _user32 = koffi.load('user32.dll');
    // HWND 在 64 位 Windows 上是 8 字节指针值，按 uint64 传递；
    // dwAffinity 为 DWORD(uint32)。返回 BOOL。
    _setAffinity = _user32.func('bool __stdcall SetWindowDisplayAffinity(uint64 hwnd, uint32 dwAffinity)');
    _loadState = true;
  } catch (e) {
    console.error('[capture-exclusion] koffi 加载 user32/SetWindowDisplayAffinity 失败:', e.message);
    _loadState = false;
  }
  return _loadState;
}

/**
 * 从 Electron BrowserWindow 取原生窗口句柄(HWND)。
 * getNativeWindowHandle() 返回 Buffer，内容即 HWND 的字节表示。
 * @param {Electron.BrowserWindow} browserWindow
 * @returns {bigint} 窗口句柄
 */
function getHwnd(browserWindow) {
  const buf = browserWindow.getNativeWindowHandle();
  // 64 位系统读 8 字节；32 位系统读 4 字节（BigInt 兼容）
  return buf.length >= 8 ? buf.readBigInt64LE() : BigInt(buf.readInt32LE());
}

/**
 * 给指定窗口设置/取消「从屏幕捕获排除」。
 * @param {Electron.BrowserWindow} browserWindow 目标窗口
 * @param {boolean} enabled true=排除捕获（录屏/截图/共享看不到）；false=恢复正常捕获
 * @returns {boolean} 是否成功（失败时调用方可回退 setContentProtection）
 */
function setExcludeFromCapture(browserWindow, enabled) {
  // 非 Windows：返回 false，由调用方回退 setContentProtection
  if (!ensureFunc() || !browserWindow) return false;
  try {
    const hwnd = getHwnd(browserWindow);
    if (enabled) {
      // 优先 WDA_EXCLUDEFROMCAPTURE（最彻底）
      let ok = _setAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
      if (ok) {
        console.log('[capture-exclusion] 已启用 WDA_EXCLUDEFROMCAPTURE（窗口从录屏/共享排除）');
        return true;
      }
      // 老系统不支持 EXCLUDEFROMCAPTURE，回退 WDA_MONITOR（捕获时显示黑色）
      ok = _setAffinity(hwnd, WDA_MONITOR);
      console.log('[capture-exclusion] EXCLUDEFROMCAPTURE 不支持，回退 WDA_MONITOR =>', ok);
      return ok;
    } else {
      // 关闭：恢复 WDA_NONE
      const ok = _setAffinity(hwnd, WDA_NONE);
      console.log('[capture-exclusion] 已恢复 WDA_NONE（正常捕获）=>', ok);
      return ok;
    }
  } catch (e) {
    console.error('[capture-exclusion] SetWindowDisplayAffinity 调用失败:', e.message);
    return false;
  }
}

/**
 * 兼容多平台的「捕获排除」入口：Windows 走 koffi，其它平台走 setContentProtection。
 * @param {Electron.BrowserWindow} browserWindow
 * @param {boolean} enabled
 * @returns {boolean} 是否成功
 */
function applyCaptureExclusion(browserWindow, enabled) {
  if (!browserWindow) return false;
  // Windows：优先 koffi 路径
  if (ensureFunc()) {
    return setExcludeFromCapture(browserWindow, enabled);
  }
  // 非 Windows / koffi 不可用：回退 Electron 内置 setContentProtection
  try {
    browserWindow.setContentProtection(enabled);
    console.log(`[capture-exclusion] 非 Windows，回退 setContentProtection(${enabled})`);
    return true;
  } catch (e) {
    console.error('[capture-exclusion] setContentProtection 回退失败:', e.message);
    return false;
  }
}

module.exports = {
  setExcludeFromCapture,
  applyCaptureExclusion,
  ensureFunc,
  // 暴露常量便于调试/展示
  WDA_NONE,
  WDA_MONITOR,
  WDA_EXCLUDEFROMCAPTURE
};
