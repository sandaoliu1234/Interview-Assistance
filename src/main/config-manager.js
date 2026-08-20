/**
 * 配置与本地持久化管理器。
 * 负责加载/保存：用户配置、简历、历史记录、面试会话。
 * 把原先散落在 main.js 里的 config.json / history.json / resume.md
 * 读写逻辑收敛到单一模块，便于后续接入 TypeScript 与统一代理。
 */

const fs = require('fs');
const path = require('path');
const {
  defaultInterviewConfig,
  migrateLegacyConfig
} = require('../shared/interview-config');

/**
 * 配置管理器构造函数。
 * @param {string} userDataPath 应用 userData 目录（配置/数据存放根目录）
 */
function ConfigManager(userDataPath) {
  this.userDataPath = userDataPath;
  this.configPath = path.join(userDataPath, 'config.json');
  this.historyPath = path.join(userDataPath, 'history.json');
  this.resumePath = path.join(userDataPath, 'resume.md');
  this.sessionPath = path.join(userDataPath, 'interview-sessions');
  this.config = defaultInterviewConfig();
}

/**
 * 加载配置：优先读取已保存的 config.json 并迁移到新模型。
 * 若文件不存在或解析失败，回退到默认配置。
 * @returns {Object} 当前生效的配置对象
 */
ConfigManager.prototype.loadConfig = function () {
  try {
    if (fs.existsSync(this.configPath)) {
      const saved = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      // 用迁移函数合并，保证旧字段语义兼容且不继承泄露密钥
      this.config = migrateLegacyConfig(saved);
    } else {
      this.config = defaultInterviewConfig();
    }
  } catch (e) {
    console.error('[ConfigManager] 加载配置失败，使用默认配置:', e.message);
    this.config = defaultInterviewConfig();
  }

  // ============ 🌱 环境变量注入（最高优先级，覆盖 config.json 和默认值）============
  // 字段约定：统一前缀 IA_，避免与系统其他变量冲突
  //   - 既支持 Windows 直接 set IA_XXX=... 再 npm start
  //   - 也支持在项目根目录写 .env 文件（每行 KEY=VALUE）
  // 调试提示：若 .env 未生效，请在终端执行 `set`(Windows) / `env`(Unix) 检查变量是否存在，
  //          并确认 main.js 最顶部有 `require('dotenv').config();`
  const env = process.env || {};

  // ===== 🛡️ 重要：手动解析项目根目录 .env，并强制覆盖 process.env 中的同名字段 =====
  //   根因：dotenv 默认「不覆盖已存在的系统环境变量」。如果用户之前在 Windows 系统设置里
  //         配过 IA_TONGYI_BASE_URL（值里可能带从日志复制的反引号/引号），那么就算 .env
  //         里写了正确值，process.env 仍会保留脏的系统值，导致 URL 带反引号。
  //   方案：在 config 注入阶段，我们手动解析一次 .env，把里面的值「强制覆盖」到一个临时 envCopy，
  //         后续所有注入、判断都用这个 envCopy，而不是 process.env。
  const envCopy = Object.assign({}, env); // 先复制系统环境的快照
  try {
    const _dotenvPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(_dotenvPath)) {
      const _raw = fs.readFileSync(_dotenvPath, 'utf8');
      // 手动解析 dotenv 格式：兼容 KEY=VALUE、KEY="VALUE"、KEY='VALUE'、# 注释、空行
      const _lines = String(_raw || '').split(/\r?\n/);
      // ★ 内联：多层包裹字符剥离（最多 6 轮，顺序先 stripTrim 再 stripChars）
      //   覆盖用户常见错误写法：
      //     IA_TONGYI_BASE_URL="`https://.../api/v1`"  （双引号 + 反引号 双层）
      //     IA_TONGYI_BASE_URL='`https://.../api/v1`'  （单引号 + 反引号 双层）
      //     IA_TONGYI_BASE_URL=``https://.../api/v1``   （双反引号 双层）
      //     IA_TONGYI_BASE_URL=`"https://.../api/v1"`   （反引号 + 双引号 双层）
      //     IA_TONGYI_BASE_URL="  https://.../api/v1  " （前后空格）
      const _STRIP_CHARS = new Set(['`', '"', "'", ' ', '\t', '\r', '\n', '\u3000', '\u201C', '\u201D', '\u2018', '\u2019']);
      const _stripWraps = (raw) => {
        let s = String(raw || '');
        for (let i = 0; i < 8; i++) {
          const before = s;
          s = s.trim();
          while (s.length > 0 && _STRIP_CHARS.has(s.charAt(0))) s = s.slice(1);
          while (s.length > 0 && _STRIP_CHARS.has(s.charAt(s.length - 1))) s = s.slice(0, -1);
          if (s === before) break;
        }
        return s;
      };
      let _parsedFromFile = 0;
      for (const _line of _lines) {
        const _trimmed = String(_line || '').trim();
        if (!_trimmed || _trimmed.startsWith('#')) continue;
        const _eq = _trimmed.indexOf('=');
        if (_eq < 0) continue;
        let _k = _trimmed.substring(0, _eq).trim();
        let _v = _trimmed.substring(_eq + 1);
        // ★★ 修复 1：先去掉严格匹配的单层引号（原逻辑），再用 _stripWraps 多层去包裹（防反引号/多层引号）
        _v = String(_v || '').trim();
        if ((_v.startsWith('"') && _v.endsWith('"')) || (_v.startsWith("'") && _v.endsWith("'"))) {
          _v = _v.slice(1, -1);
        }
        const _beforeStrip = _v;
        _v = _stripWraps(_v);
        if (_beforeStrip !== _v) {
          console.log(`[ConfigManager.env][parse] ⚠ ${_k} 值存在包裹字符，已自动剥离：before=${JSON.stringify(_beforeStrip)} → after=${JSON.stringify(_v)}`);
        }
        if (_k) {
          // ★ 关键：.env 文件里的值优先于 Windows 系统环境变量，强制覆盖
          envCopy[_k] = _v;
          _parsedFromFile++;
        }
      }
      console.log(`[ConfigManager.env] 手动解析 .env 完成：path=${_dotenvPath} | 解析到 ${_parsedFromFile} 条配置（已覆盖系统环境变量中同名字段）`);
    }
  } catch (_e) {
    console.warn('[ConfigManager.env] 手动解析 .env 失败，回退使用 process.env：', _e && _e.message);
  }

  // 【超激进清理】统一函数：去掉所有控制字符 + 常见 Unicode 包裹字符，再按白名单过滤剩余字符。
  //   原因：用户从 .env 示例 / 复制粘贴带入了看不见的控制字符 / 罕见 Unicode 引号变体，导致正则字符类匹配不上。
  //   本函数作为「最后一道关口」，暴力删除所有非白名单字符，保证注入 config 的值绝对干净。
  //   URL 白名单（RFC 3986 unreserved + sub-delims + gen-delims + =&%）：A-Z a-z 0-9 -._~ :/?#[]@ !$&'()*+,;= %
  //   字符串白名单（API Key / 枚举值）：A-Z a-z 0-9 -._~ :/!$&'()*+,;= %@#
  const _aggressiveClean = (raw, kind) => {
    if (typeof raw !== 'string') return '';
    let s = raw;
    // 第一步：统一删除常见 Unicode 引号 / 包裹字符（ASCII 反引号、弯引号、全角反引号、角括号、方头括号、书名号等）
    const wraps = /[\x60\uFF40\u201C\u201D\u2018\u2019\u300C\u300D\u300E\u300F\u3010\u3011\uFF08\uFF09\u300A\u300B\u201E\u201F\u201A\u201B\u00AB\u00BB\u2039\u203A]/g;
    s = s.replace(wraps, '');
    // 第二步：删除所有控制字符（\u0000-\u0008 \u000B \u000C \u000E-\u001F \u007F-\u009F）
    const ctrls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
    s = s.replace(ctrls, '');
    // 第三步：白名单过滤
    let allowed;
    if (kind === 'url') {
      allowed = /[^A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]/g;
    } else {
      allowed = /[^A-Za-z0-9\-._~:\/!$&'()*+,;=%@#]/g;
    }
    s = s.replace(allowed, '');
    return s;
  };

  // 增强字符串清理：去掉首尾可能出现的「反引号(\x60) / 单引号 / 双引号 / 全角空格 / 半角空格 / 弯引号 / 全角括号 / 书名号」
  //   注意：正则里反引号使用 \x60（十六进制 ASCII 码），避免与 JS 模板字符串的 ` 冲突（双重保险）
  //   覆盖范围（和 aiService.js 保持一致，保证 config → ai 整个链路清理一致）：
  //     ASCII 空白 / 全角空格(\u3000) / 半角反引号(\x60) / 全角反引号(｀=\uFF40)
  //     半角单引号'/双引号"  / 弯双引号“”(\u201C\u201D) / 弯单引号‘’(\u2018\u2019)
  //     日角括号「」(\u300C\u300D) / 白角括号『』(\u300E\u300F) / 方头括号【】(\u3010\u3011)
  //     全角圆括号（）(\uFF08\uFF09) / 书名号《》(\u300A\u300B)
  const _WRAP_CHARS = '\\s\\u3000\\x60\\uFF40\'"\\u201C\\u201D\\u2018\\u2019\\u300C\\u300D\\u300E\\u300F\\u3010\\u3011\\uFF08\\uFF09\\u300A\\u300B';
  const _reCleanHead = new RegExp('^[' + _WRAP_CHARS + ']+');
  const _reCleanTail = new RegExp('[' + _WRAP_CHARS + ']+$');
  /**
   * 通用字符串清理：12 轮首尾包裹剥离 + 超激进白名单过滤（保证值绝对干净）。
   * 用于 API Key / 枚举值 / 普通字符串。
   */
  const _cleanStr = (s) => {
    if (typeof s !== 'string') return '';
    let x = s;
    for (let i = 0; i < 12; i++) {
      const before = x;
      x = x.replace(_reCleanHead, '').replace(_reCleanTail, '');
      if (x === before) break;
    }
    return _aggressiveClean(x, 'str');
  };
  /**
   * URL 清理：12 轮首尾包裹剥离 + 去尾部斜杠 + 超激进白名单过滤。
   * 用于 tongyiBaseUrl 等 URL 类型字段。
   */
  const _cleanUrl = (s) => {
    if (typeof s !== 'string') return '';
    let x = s;
    for (let i = 0; i < 12; i++) {
      const before = x;
      x = x.replace(_reCleanHead, '').replace(_reCleanTail, '').replace(/\/+$/, '');
      if (x === before) break;
    }
    const clean = _aggressiveClean(x, 'url');
    return clean.replace(/\/+$/, '');
  };

  // 先把 .env 读到哪些关键变量打出来（脱敏），方便用户直接肉眼确认 dotenv 是否生效
  const _hasEnv = (k) => (typeof envCopy[k] === 'string' && _cleanStr(envCopy[k]).length > 0);
  const _mask = (s, show = 8) => {
    if (!s) return '(empty)';
    const x = _cleanStr(s);
    if (x.length <= show) return x + '*'.repeat(Math.max(0, show - x.length));
    return x.slice(0, show) + '***';
  };
  console.log(
    '[ConfigManager.env] .env/环境变量关键变量快照：'
    + ` IA_TONGYI_API_KEY=${_hasEnv('IA_TONGYI_API_KEY') ? ('set(len=' + _cleanStr(envCopy.IA_TONGYI_API_KEY).length + ') ' + _mask(envCopy.IA_TONGYI_API_KEY)) : '(not-set)'}`
    + ` | IA_TONGYI_BASE_URL=${_hasEnv('IA_TONGYI_BASE_URL') ? JSON.stringify(_cleanUrl(envCopy.IA_TONGYI_BASE_URL)) : '(not-set)'}`
    + ` | IA_DEFAULT_SERVICE=${_hasEnv('IA_DEFAULT_SERVICE') ? _cleanStr(envCopy.IA_DEFAULT_SERVICE) : '(not-set)'}`
    + ` | IA_ZHIPU_API_KEY=${_hasEnv('IA_ZHIPU_API_KEY') ? ('set(len=' + _cleanStr(envCopy.IA_ZHIPU_API_KEY).length + ')') : '(not-set)'}`
    + ` | IA_BAIDU_API_KEY=${_hasEnv('IA_BAIDU_API_KEY') ? ('set(len=' + _cleanStr(envCopy.IA_BAIDU_API_KEY).length + ')') : '(not-set)'}`
    + ` | IA_TONGYI_VISION_MODEL=${_hasEnv('IA_TONGYI_VISION_MODEL') ? _cleanStr(envCopy.IA_TONGYI_VISION_MODEL) : '(not-set,默认qvq-plus)'}`
    + ` | IA_ZHIPU_VISION_MODEL=${_hasEnv('IA_ZHIPU_VISION_MODEL') ? _cleanStr(envCopy.IA_ZHIPU_VISION_MODEL) : '(not-set)'}`
  );
  // ===== ★ 注入前：清理前后对比诊断 warn。如果原值 != 清理后，说明 .env 写法有误（两侧带反引号/引号），一次性打出来供用户修正 =====
  try {
    const _checkList = [
      { key: 'IA_TONGYI_BASE_URL', raw: envCopy.IA_TONGYI_BASE_URL, clean: _cleanUrl(envCopy.IA_TONGYI_BASE_URL), isUrl: true },
      { key: 'IA_TONGYI_API_KEY',  raw: envCopy.IA_TONGYI_API_KEY,  clean: _cleanStr(envCopy.IA_TONGYI_API_KEY),  isUrl: false },
      { key: 'IA_DEFAULT_SERVICE', raw: envCopy.IA_DEFAULT_SERVICE, clean: _cleanStr(envCopy.IA_DEFAULT_SERVICE), isUrl: false },
      { key: 'IA_ZHIPU_API_KEY',   raw: envCopy.IA_ZHIPU_API_KEY,   clean: _cleanStr(envCopy.IA_ZHIPU_API_KEY),   isUrl: false },
      { key: 'IA_BAIDU_API_KEY',   raw: envCopy.IA_BAIDU_API_KEY,   clean: _cleanStr(envCopy.IA_BAIDU_API_KEY),   isUrl: false },
      { key: 'IA_BAIDU_APP_ID',    raw: envCopy.IA_BAIDU_APP_ID,    clean: _cleanStr(envCopy.IA_BAIDU_APP_ID),    isUrl: false },
      { key: 'IA_BAIDU_SECRET_KEY',raw: envCopy.IA_BAIDU_SECRET_KEY,clean: _cleanStr(envCopy.IA_BAIDU_SECRET_KEY),isUrl: false },
      { key: 'IA_WENXIN_API_KEY',  raw: envCopy.IA_WENXIN_API_KEY,  clean: _cleanStr(envCopy.IA_WENXIN_API_KEY),  isUrl: false },
      { key: 'IA_TONGYI_VISION_MODEL', raw: envCopy.IA_TONGYI_VISION_MODEL, clean: _cleanStr(envCopy.IA_TONGYI_VISION_MODEL), isUrl: false },
      { key: 'IA_ZHIPU_VISION_MODEL',  raw: envCopy.IA_ZHIPU_VISION_MODEL,  clean: _cleanStr(envCopy.IA_ZHIPU_VISION_MODEL),  isUrl: false }
    ];
    const _dirtyItems = _checkList.filter(x => (typeof x.raw === 'string') && x.raw !== x.clean);
    if (_dirtyItems.length > 0) {
      const _lines = _dirtyItems.map(x => {
        const _raw = x.isUrl ? JSON.stringify(x.raw) : `(len=${x.raw.length})`;
        const _clean = x.isUrl ? JSON.stringify(x.clean) : `(len=${x.clean.length})`;
        return `    ❌ ${x.key}：\n      原值=${_raw}\n      清理后=${_clean}\n      正确写法示例：${x.key}=${x.clean || '<你的真实值，两侧不要加反引号/双引号/单引号>'}`;
      });
      console.warn(
        `[ConfigManager.env] ⚠️⚠️⚠️ .env 中有 ${_dirtyItems.length} 个配置项写法错误（两侧附带了反引号/引号/不可见字符，现已自动清理，但请手动修正 .env 文件避免后续问题）：\n${_lines.join('\n')}`
      );
    } else {
      console.log(`[ConfigManager.env] ✅ 所有 IA_* 配置项清理通过（原值与清理后一致，.env 写法无反引号/引号包裹问题）`);
    }
  } catch (_diagErr) { /* ignore：即便是诊断逻辑异常也不能阻塞正常配置注入 */ }
  // ===== 开始注入到 this.config（全部通过 _cleanStr/_cleanUrl 清洗，保证 config 中值绝对干净）=====
  if (_hasEnv('IA_BAIDU_APP_ID'))      this.config.baiduAppId     = _cleanStr(envCopy.IA_BAIDU_APP_ID);
  if (_hasEnv('IA_BAIDU_API_KEY'))    this.config.baiduApiKey    = _cleanStr(envCopy.IA_BAIDU_API_KEY);
  if (_hasEnv('IA_BAIDU_SECRET_KEY')) this.config.baiduSecretKey = _cleanStr(envCopy.IA_BAIDU_SECRET_KEY);
  if (_hasEnv('IA_WENXIN_API_KEY'))   this.config.wenxinApiKey   = _cleanStr(envCopy.IA_WENXIN_API_KEY);
  if (_hasEnv('IA_ZHIPU_API_KEY'))    this.config.zhipuApiKey    = _cleanStr(envCopy.IA_ZHIPU_API_KEY);
  if (_hasEnv('IA_TONGYI_API_KEY'))   this.config.tongyiApiKey   = _cleanStr(envCopy.IA_TONGYI_API_KEY);
  // 通义千问自定义 BaseURL：支持百炼私有工作空间（默认公共 dashscope.aliyuncs.com）
  if (_hasEnv('IA_TONGYI_BASE_URL'))  this.config.tongyiBaseUrl  = _cleanUrl(envCopy.IA_TONGYI_BASE_URL);
  // 视觉（多模态）模型选择：支持环境变量覆盖默认 qvq-plus（如切 qvq-max 或下线后换新模型名）
  if (_hasEnv('IA_TONGYI_VISION_MODEL')) this.config.tongyiVisionModel = _cleanStr(envCopy.IA_TONGYI_VISION_MODEL);
  if (_hasEnv('IA_ZHIPU_VISION_MODEL'))  this.config.zhipuVisionModel  = _cleanStr(envCopy.IA_ZHIPU_VISION_MODEL);
  if (_hasEnv('IA_DEFAULT_SERVICE')) {
    const svc = _cleanStr(envCopy.IA_DEFAULT_SERVICE).toLowerCase();
    if (svc === 'wenxin' || svc === 'zhipu' || svc === 'tongyi') {
      this.config.selectedService = svc;
    }
  }
  // 注入后：再次校验 tongyiBaseUrl（如果清理后仍没有 http(s):// 前缀，打致命错误），避免 baseUrl 非法导致所有 LLM 请求失败
  try {
    const bu = (typeof this.config.tongyiBaseUrl === 'string') ? this.config.tongyiBaseUrl : '';
    if (bu && !/^https?:\/\//i.test(bu)) {
      console.error(
        `[ConfigManager.env] ❌❌ tongyiBaseUrl 注入后仍非法（没有 http(s):// 前缀）：值=${JSON.stringify(bu)}\n`
        + `  请修正 .env 文件中的 IA_TONGYI_BASE_URL，正确写法示例：\n`
        + `    IA_TONGYI_BASE_URL=https://llm-xxxxxx.cn-beijing.maas.aliyuncs.com/api/v1\n`
        + `    注意：两侧不要加任何反引号、双引号、单引号！不要有前后空格！`
      );
    }
  } catch (_) { /* ignore */ }
  // 注入后再次打快照（脱敏），确认 config 字段是否真正被覆盖
  console.log(
    '[ConfigManager.env] 注入后config快照：'
    + ` selectedService=${this.config.selectedService || '(empty)'}`
    + ` | tongyiApiKeyLen=${(typeof this.config.tongyiApiKey === 'string') ? this.config.tongyiApiKey.length : 0}`
    + ` | tongyiBaseUrl=${JSON.stringify(this.config.tongyiBaseUrl || '(default: dashscope.aliyuncs.com)')}`
    + ` | tongyiVisionModel=${this.config.tongyiVisionModel || '(empty)'}`
    + ` | zhipuApiKeyLen=${(typeof this.config.zhipuApiKey === 'string') ? this.config.zhipuApiKey.length : 0}`
    + ` | zhipuVisionModel=${this.config.zhipuVisionModel || '(empty)'}`
    + ` | wenxinApiKeyLen=${(typeof this.config.wenxinApiKey === 'string') ? this.config.wenxinApiKey.length : 0}`
  );
  // ============================================================================

  return this.config;
};

/**
 * 保存配置到 config.json（保留全部字段，密钥由用户自行填写）。
 * @param {Object} config 待保存的配置对象
 * @returns {boolean} 是否保存成功
 */
ConfigManager.prototype.saveConfig = function (config) {
  try {
    if (config && typeof config === 'object') {
      this.config = config;
    }
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[ConfigManager] 保存配置失败:', e.message);
    return false;
  }
};

/**
 * 读取当前内存中的配置（不触发磁盘 IO）。
 * @returns {Object} 配置对象
 */
ConfigManager.prototype.getConfig = function () {
  return this.config;
};

/**
 * 加载面试历史记录（每次问答的存档列表）。
 * @returns {Array} 历史记录数组
 */
ConfigManager.prototype.loadHistory = function () {
  try {
    if (fs.existsSync(this.historyPath)) {
      return JSON.parse(fs.readFileSync(this.historyPath, 'utf8'));
    }
  } catch (e) {
    console.error('[ConfigManager] 加载历史记录失败:', e.message);
  }
  return [];
};

/**
 * 保存面试历史记录。
 * @param {Array} history 历史记录数组
 * @returns {boolean} 是否保存成功
 */
ConfigManager.prototype.saveHistory = function (history) {
  try {
    fs.writeFileSync(this.historyPath, JSON.stringify(history || [], null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[ConfigManager] 保存历史记录失败:', e.message);
    return false;
  }
};

/**
 * 保存简历文本到 resume.md。
 * @param {string} content 简历纯文本
 * @returns {boolean} 是否保存成功
 */
ConfigManager.prototype.saveResume = function (content) {
  try {
    fs.writeFileSync(this.resumePath, content || '', 'utf8');
    return true;
  } catch (e) {
    console.error('[ConfigManager] 保存简历失败:', e.message);
    return false;
  }
};

/**
 * 读取已保存的简历文本。
 * @returns {string|null} 简历内容；不存在返回 null
 */
ConfigManager.prototype.loadResume = function () {
  try {
    if (fs.existsSync(this.resumePath)) {
      return fs.readFileSync(this.resumePath, 'utf8');
    }
  } catch (e) {
    console.error('[ConfigManager] 读取简历失败:', e.message);
  }
  return null;
};

/**
 * 删除已保存的简历文件。
 * @returns {boolean} 是否删除成功
 */
ConfigManager.prototype.deleteResume = function () {
  try {
    if (fs.existsSync(this.resumePath)) {
      fs.unlinkSync(this.resumePath);
    }
    return true;
  } catch (e) {
    console.error('[ConfigManager] 删除简历失败:', e.message);
    return false;
  }
};

/**
 * 保存一次面试会话档案（含 transcript / 系统音频路径 / AI 复盘）。
 * @param {string} sessionId 会话唯一标识
 * @param {Object} sessionData 会话数据
 * @returns {boolean} 是否保存成功
 */
ConfigManager.prototype.saveSession = function (sessionId, sessionData) {
  try {
    if (!fs.existsSync(this.sessionPath)) {
      fs.mkdirSync(this.sessionPath, { recursive: true });
    }
    const filePath = path.join(this.sessionPath, `${sessionId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[ConfigManager] 保存会话失败:', e.message);
    return false;
  }
};

/**
 * 保存系统音频存档（WAV）到 sessions/<sessionId>.wav。
 * @param {string} sessionId 会话 ID
 * @param {Buffer|ArrayBuffer} wavBuffer WAV 二进制数据
 * @returns {string|null} 存档文件绝对路径；失败返回 null
 */
ConfigManager.prototype.saveRecording = function (sessionId, wavBuffer) {
  try {
    if (!fs.existsSync(this.sessionPath)) {
      fs.mkdirSync(this.sessionPath, { recursive: true });
    }
    const filePath = path.join(this.sessionPath, `${sessionId}.wav`);
    // 兼容 ArrayBuffer / Buffer / TypedArray
    const buf = Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer);
    fs.writeFileSync(filePath, buf);
    return filePath;
  } catch (e) {
    console.error('[ConfigManager] 保存音频存档失败:', e.message);
    return null;
  }
};

/**
 * 保存 AI 复盘报告到 sessions/<sessionId>.review.md。
 * @param {string} sessionId 会话 ID
 * @param {string} review 复盘 Markdown 文本
 * @returns {string|null} 文件路径；失败返回 null
 */
ConfigManager.prototype.saveReview = function (sessionId, review) {
  try {
    if (!fs.existsSync(this.sessionPath)) {
      fs.mkdirSync(this.sessionPath, { recursive: true });
    }
    const filePath = path.join(this.sessionPath, `${sessionId}.review.md`);
    fs.writeFileSync(filePath, review || '', 'utf8');
    return filePath;
  } catch (e) {
    console.error('[ConfigManager] 保存复盘失败:', e.message);
    return null;
  }
};

/**
 * 列出所有会话档案（json/wav/review 三件套按 ID 聚合）。
 * @returns {Array<Object>} 会话摘要列表（按 ID 倒序）
 */
ConfigManager.prototype.listSessions = function () {
  try {
    if (!fs.existsSync(this.sessionPath)) return [];
    const files = fs.readdirSync(this.sessionPath);
    const ids = new Set(files.map((f) => f.replace(/\.(json|wav|review\.md)$/, '')));
    return Array.from(ids).map((id) => {
      const info = { id };
      if (files.includes(`${id}.json`)) info.jsonPath = path.join(this.sessionPath, `${id}.json`);
      if (files.includes(`${id}.wav`)) info.wavPath = path.join(this.sessionPath, `${id}.wav`);
      if (files.includes(`${id}.review.md`)) info.reviewPath = path.join(this.sessionPath, `${id}.review.md`);
      return info;
    }).sort((a, b) => String(b.id).localeCompare(String(a.id)));
  } catch (e) {
    console.error('[ConfigManager] 列出会话失败:', e.message);
    return [];
  }
};

module.exports = ConfigManager;
