/**
 * Gaze 视线检测控制器（基于 @mediapipe/tasks-vision 的 FaceLandmarker）。
 *
 * 对齐参考实现 GazeController：当用户视线离开屏幕时自动隐藏答题 overlay，
 * 视线回来时恢复显示——降低被发现的概率。
 *
 * 实现原理（无需校准）：
 *   - 用 MediaPipe FaceLandmarker 检测 478 个面部关键点（含左右虹膜中心）。
 *   - 从「虹膜中心相对眼眶的水平/垂直偏移」+「鼻尖相对脸颊的水平偏移(头部 yaw)」
 *     判断视线是否朝向屏幕。偏离阈值即视为「移开」。
 *   - 无需 9 点校准（相比 WebGazer），适合即时启用。
 *
 * 资源加载：
 *   - wasm：优先本地 node_modules/@mediapipe/tasks-vision/wasm，回退 CDN。
 *   - 模型：优先本地 assets/face_landmarker.task，回退 Google CDN。
 *
 * 依赖：项目已安装 @mediapipe/tasks-vision（手动解压到 node_modules）。
 * 运行环境：渲染层（nodeIntegration:true，可 require）；需摄像头权限。
 *
 * 用法：
 *   const g = new GazeController();
 *   g.onHide = () => overlay.classList.add('gaze-hidden');
 *   g.onShow = () => overlay.classList.remove('gaze-hidden');
 *   g.onUnsupported = (msg) => console.warn(msg);
 *   await g.start();
 *   g.stop();
 */

/** 检测间隔（ms）：每 250ms 采样一帧（VIDEO 模式支持高频） */
const DETECT_INTERVAL = 250;
/** 连续多少 ms 判定为「移开」才触发隐藏（避免偶发抖动） */
const HIDE_AFTER_MS = 1000;

// MediaPipe Face Mesh 478 点关键索引（用于视线估计）
const LM = {
  noseTip: 1,            // 鼻尖
  leftCheek: 234,        // 左脸颊
  rightCheek: 454,       // 右脸颊
  leftEyeOuter: 33,      // 左眼外角
  leftEyeInner: 133,     // 左眼内角
  leftEyeTop: 159,       // 左眼上睑
  leftEyeBottom: 145,    // 左眼下睑
  rightEyeOuter: 263,    // 右眼外角
  rightEyeInner: 362,    // 右眼内角
  rightEyeTop: 386,      // 右眼上睑
  rightEyeBottom: 374,   // 右眼下睑
  leftIris: 468,         // 左虹膜中心
  rightIris: 473         // 右虹膜中心
};

// 视线移开判定阈值（归一化偏移量；超出即视为移开）
const THRESH = {
  horizontal: 0.20,   // 水平 gaze ratio 偏离 0.5 的阈值
  vertical: 0.20,     // 垂直 gaze ratio 偏离 0.5 的阈值
  yaw: 0.12           // 头部 yaw（鼻尖相对脸颊中点 / 脸宽）阈值
};

class GazeController {
  constructor() {
    this.landmarker = null;        // FaceLandmarker 实例
    this.stream = null;            // 摄像头 MediaStream
    this.video = null;             // 隐藏 <video> 取帧
    this.timer = null;             // 采样定时器
    this.lastFaceAt = 0;           // 上次「正视屏幕」的时间
    this.isLooking = false;        // 当前是否在正视
    this.isRunning = false;
    this._lastTs = 0;              // 上一帧时间戳（detectForVideo 要求单调递增）

    // 事件回调（由调用方覆盖）
    this.onHide = null;            // 视线移开持续一段时间后触发
    this.onShow = null;            // 重新正视屏幕时触发
    this.onUnsupported = null;     // 环境不支持/加载失败时触发
    this.onError = null;           // 其它错误
  }

  /**
   * 解析本地 wasm 目录为 file:// URL（渲染层 require 可用时）。
   * @returns {string|null}
   */
  _resolveLocalWasm() {
    try {
      const path = require('path');
      const pkgPath = require.resolve('@mediapipe/tasks-vision/package.json');
      const wasmDir = path.join(path.dirname(pkgPath), 'wasm');
      return 'file://' + wasmDir.replace(/\\/g, '/');
    } catch (_) {
      return null;
    }
  }

  /**
   * 解析本地模型文件为 file:// URL（assets/face_landmarker.task）。
   * @returns {string|null}
   */
  _resolveLocalModel() {
    try {
      const path = require('path');
      // 相对当前模块定位项目根的 assets 目录
      const root = path.join(__dirname, '..', '..');
      const modelPath = path.join(root, 'assets', 'face_landmarker.task');
      const fs = require('fs');
      if (fs.existsSync(modelPath)) {
        return 'file://' + modelPath.replace(/\\/g, '/');
      }
    } catch (_) {}
    return null;
  }

  /**
   * 启动视线检测：加载 wasm + 模型 + 摄像头，开始周期性检测。
   * @returns {Promise<boolean>} 是否成功启动
   */
  async start() {
    if (this.isRunning) return true;

    // 1. 加载 MediaPipe tasks-vision
    let vision;
    try {
      vision = require('@mediapipe/tasks-vision');
    } catch (e) {
      this._unsupported('@mediapipe/tasks-vision 未安装：' + (e && e.message));
      return false;
    }
    const { FilesetResolver, FaceLandmarker } = vision;

    // 2. 加载 wasm（本地优先，CDN 回退）
    const wasmLoc = this._resolveLocalWasm()
      || 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
    let fileset;
    try {
      fileset = await FilesetResolver.forVisionTasks(wasmLoc);
    } catch (e) {
      this._unsupported('wasm 加载失败：' + (e && e.message));
      return false;
    }

    // 3. 创建 FaceLandmarker（模型本地优先，CDN 回退；GPU 优先，失败回退 CPU）
    const modelUrl = this._resolveLocalModel()
      || 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false
      });
    } catch (e) {
      // GPU 不可用时回退 CPU
      try {
        this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false
        });
      } catch (e2) {
        this._unsupported('FaceLandmarker 创建失败：' + (e2 && e2.message));
        return false;
      }
    }

    // 4. 摄像头
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this._unsupported('当前环境不支持 getUserMedia');
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: 'user' },
        audio: false
      });
    } catch (e) {
      this._unsupported('摄像头不可用或被拒绝：' + (e && e.message ? e.message : e));
      this.stop();
      return false;
    }

    // 5. 隐藏 video 元素播放流
    this.video = document.createElement('video');
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(this.video);
    try { await this.video.play(); } catch (_) { /* 等待定时器取帧 */ }

    this.lastFaceAt = Date.now();
    this.isLooking = true;
    this.isRunning = true;
    this._lastTs = 0;

    // 6. 启动周期性检测
    this.timer = setInterval(() => this._tick(), DETECT_INTERVAL);
    return true;
  }

  /**
   * 单帧检测：用 FaceLandmarker 检测关键点，判断视线是否朝向屏幕。
   */
  async _tick() {
    if (!this.isRunning || !this.video || !this.landmarker) return;
    if (this.video.readyState < 2) return; // 视频未就绪
    // timestamp 必须单调递增
    let ts = performance.now();
    if (ts <= this._lastTs) ts = this._lastTs + 1;
    this._lastTs = ts;
    try {
      const result = this.landmarker.detectForVideo(this.video, ts);
      const faces = result && result.faceLandmarks;
      if (faces && faces.length > 0) {
        const looking = this._isLookingAtScreen(faces[0]);
        this._handleDetection(looking);
      } else {
        // 无人脸：视为移开
        this._handleDetection(false);
      }
    } catch (_) {
      // 单帧失败不致命
    }
  }

  /**
   * 基于关键点判断视线是否朝向屏幕。
   * @param {Array<{x:number,y:number,z:number}>} lm 478 个归一化关键点
   * @returns {boolean} true=正视屏幕；false=视线移开
   */
  _isLookingAtScreen(lm) {
    const p = (i) => lm[i];

    // —— 水平 gaze：虹膜中心相对眼眶内外角 ——
    // 正视时虹膜居中，ratio≈0.5；左右看时偏离
    const lOuter = p(LM.leftEyeOuter).x, lInner = p(LM.leftEyeInner).x;
    const rOuter = p(LM.rightEyeOuter).x, rInner = p(LM.rightEyeInner).x;
    const lIris = p(LM.leftIris).x, rIris = p(LM.rightIris).x;
    // 注意：不同人左右眼内外角 x 顺序可能不同，用 (max-min) 做分母保证 ratio∈[0,1]
    const lDenom = Math.abs(lOuter - lInner) || 1e-6;
    const rDenom = Math.abs(rOuter - rInner) || 1e-6;
    const lRatio = (lIris - Math.min(lOuter, lInner)) / lDenom;
    const rRatio = (rIris - Math.min(rOuter, rInner)) / rDenom;
    const hRatio = (lRatio + rRatio) / 2;
    const hOff = Math.abs(hRatio - 0.5);

    // —— 垂直 gaze：虹膜中心 y 相对上下睑 ——
    const lTop = p(LM.leftEyeTop).y, lBot = p(LM.leftEyeBottom).y;
    const rTop = p(LM.rightEyeTop).y, rBot = p(LM.rightEyeBottom).y;
    const lIrisY = p(LM.leftIris).y, rIrisY = p(LM.rightIris).y;
    const lVDenom = Math.abs(lBot - lTop) || 1e-6;
    const rVDenom = Math.abs(rBot - rTop) || 1e-6;
    const lVRatio = (lIrisY - Math.min(lTop, lBot)) / lVDenom;
    const rVRatio = (rIrisY - Math.min(rTop, rBot)) / rVDenom;
    const vRatio = (lVRatio + rVRatio) / 2;
    const vOff = Math.abs(vRatio - 0.5);

    // —— 头部 yaw：鼻尖 x 相对左右脸颊中点，归一化到脸宽 ——
    const noseX = p(LM.noseTip).x;
    const cheekL = p(LM.leftCheek).x, cheekR = p(LM.rightCheek).x;
    const faceW = Math.abs(cheekR - cheekL) || 1e-6;
    const yaw = Math.abs((noseX - (cheekL + cheekR) / 2) / faceW);

    // 任一指标超阈值即视为「移开」
    if (hOff > THRESH.horizontal) return false;
    if (vOff > THRESH.vertical) return false;
    if (yaw > THRESH.yaw) return false;
    return true;
  }

  /**
   * 根据检测结果切换显示/隐藏。
   * @param {boolean} looking 本帧是否正视屏幕
   */
  _handleDetection(looking) {
    const now = Date.now();
    if (looking) {
      this.lastFaceAt = now;
      if (!this.isLooking) {
        this.isLooking = true;
        if (typeof this.onShow === 'function') {
          try { this.onShow(); } catch (_) {}
        }
      }
    } else {
      // 移开持续超过阈值才隐藏，避免短暂瞥视抖动
      if (this.isLooking && now - this.lastFaceAt > HIDE_AFTER_MS) {
        this.isLooking = false;
        if (typeof this.onHide === 'function') {
          try { this.onHide(); } catch (_) {}
        }
      }
    }
  }

  /**
   * 停止检测并释放摄像头与模型资源。
   */
  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      this.stream = null;
    }
    if (this.video) {
      try { this.video.srcObject = null; } catch (_) {}
      if (this.video.parentNode) this.video.parentNode.removeChild(this.video);
      this.video = null;
    }
    if (this.landmarker) {
      try { this.landmarker.close(); } catch (_) {}
      this.landmarker = null;
    }
    this.isLooking = false;
  }

  /** 触发 onUnsupported 回调 */
  _unsupported(msg) {
    if (typeof this.onUnsupported === 'function') {
      try { this.onUnsupported(msg); } catch (_) {}
    } else {
      console.warn('[GazeController]', msg);
    }
  }
}

module.exports = GazeController;
