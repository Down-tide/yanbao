/**
 * dsh-photo-skin —— 背景呈现层（Presenter）。
 *
 * 职责：把「当前强度」翻译成页面上的样子。
 *   1. 一个固定在底部的背景层，里面放当前帧的图片；
 *   2. 把由强度插值出的配色写进 body 的 --ps-* 变量；
 *   3. 切帧时用两层 img 交叉淡入，避免闪白。
 *
 * 与「滑动变祖」的差异：它把人物放进会话列（absolute, z-index:0），
 * 本皮肤要铺满整个窗口，所以用 fixed + z-index:-1，
 * 并保证 pointer-events:none，永远不吃鼠标事件。
 */

import { IMAGES, activeFrameUrls, frameSpec, toneAt } from "./frames.js";
import { MAX_FRAME, deriveTone, isLightMode } from "./logic.js";
import { createStardust } from "./stardust.js";
import { applyMotionState, motionState } from "./motion.js";

export class SkinPresenter {
  constructor(scope) {
    this.scope = scope;
    this.root = null;
    /** 包住所有照片层的舞台；空闲淡化作用在它身上。 */
    this.stage = null;
    /** 当前最上面那层照片的地址。 */
    this.topUrl = null;
    /** 正在解码、等着淡入的地址。 */
    this.pendingUrl = null;
    /** 换图令牌：解码完成时若已被更新的请求取代，就丢弃。 */
    this.swapToken = 0;
    /** 已解码完成的地址。 */
    this.decoded = new Set();
    /** 颗粒开关（root 还没建时也要记住）。 */
    this.grainEnabled = true;
    /** 粒子淡出后再停的计时器。 */
    this.particleTimer = null;
    this.currentFrame = -1;
    this.enabled = false;
    this.disposed = false;
    this.unsubscribe = null;
    /** 预加载过的图片地址，避免拖动时空白。 */
    this.loaded = new Set();
    /**
     * 预加载出来的 Image 必须持有引用。
     * 只 new Image() 不保存的话，浏览器可能在加载完成前就回收掉，
     * 预加载等于白做。
     */
    this.images = new Map();
    /** 待执行的 idle 回调句柄，dispose 时要全部取消。 */
    this.idleHandles = new Set();
    /** 背景遮罩开关（对标滑动变祖的「背景遮罩」）。 */
    this.maskEnabled = true;
    /** 星尘粒子层。 */
    this.stardust = null;
    /** 粒子开关。 */
    this.particlesEnabled = true;
    /** 空闲淡化开关。 */
    this.motionEnabled = true;
    /** 模型是否在跑（由 client 订阅会话状态后写入）。 */
    this.running = false;
    /** 是否正在拖滑块。 */
    this.dragging = false;
  }

  /** 惰性建 DOM：插件没启用时不碰 document。 */
  ensureRoot() {
    if (this.root !== null) return this.root;

    const root = document.createElement("div");
    root.id = "photo-skin-layer";
    root.dataset.plugin = PACKAGE_ID;
    root.setAttribute("aria-hidden", "true");

    /*
     * 舞台：照片层都放在它里面。
     * 换图的交叉淡入在照片层上（260ms），空闲淡化在舞台上（1400ms），
     * 两者互不干扰。关掉空闲淡化时舞台不带任何样式，画面与原来一致。
     */
    const stage = document.createElement("div");
    stage.className = "ps-stage";

    const veil = document.createElement("div");
    veil.className = "ps-veil";
    const read = document.createElement("div");
    read.className = "ps-readability";
    const grain = document.createElement("div");
    grain.className = "ps-grain";

    root.append(stage, veil, read, grain);
    root.dataset.grain = this.grainEnabled ? "on" : "off";
    root.dataset.particles = this.particlesEnabled ? "on" : "off";

    /*
     * 星尘粒子层。canvas 自身 pointer-events:none，不挡交互。
     * createStardust 在「减少动态效果」或拿不到 2D 上下文时返回
     * canvas 为 null 的降级句柄，这时不挂任何东西。
     */
    this.stardust = createStardust();
    if (this.stardust.canvas !== null) {
      root.append(this.stardust.canvas);
      this.stardust.setVisible(this.particlesEnabled);
      this.stardust.setLevel(this.currentFrame >= 0 ? this.currentFrame / MAX_FRAME : 0);
      {
        const initial = toneAt(Math.max(0, this.currentFrame));
        this.stardust.setAccent(initial.accent ?? [255, 255, 255], isLightMode(initial));
      }
      /*
       * 这里**不启动** —— 此刻 root 还没插进 document，
       * canvas 的 getBoundingClientRect() 是 0×0，启动会画在 0 尺寸画布上。
       * 交给下面的 attachRoot() 在真正挂载后启动。
       */
    }

    this.root = root;
    this.stage = stage;
    this.topUrl = null;
    this.pendingUrl = null;
    return root;
  }

  /**
   * 把层挂到 body 并启动粒子。
   *
   * 顺序很重要：**先挂载、后启动**。canvas 必须在布局里拿到真实尺寸，
   * 否则宽高是 0，粒子会画在一张 0×0 的画布上（看起来就是「完全没效果」）。
   */
  attachRoot() {
    const root = this.ensureRoot();
    if (root.parentElement === null) {
      document.body.append(root);
      // 已进 DOM，现在测得到尺寸了
      if (this.stardust !== null && this.particlesEnabled) this.stardust.start();
    }
    return root;
  }

  /** 把某一帧的图片地址与配色应用到页面。 */
  applyFrame(frame) {
    const spec = frameSpec(frame);
    if (spec === null) return;

    const root = this.attachRoot();

    // 换图（同一张图不换层；配色照常更新）
    this.showPlate(spec.url, spec.focus);

    // 配色：由当前强度插值 + 遮罩开关共同决定
    const tone = toneAt(frame);
    const palette = deriveTone(tone, { mask: this.maskEnabled });

    for (const [name, value] of Object.entries(palette)) {
      document.body.style.setProperty(`--ps-${name}`, value);
    }

    // 让 CSS 知道该走浅色还是深色分支（原生控件、选区颜色等要用）
    document.body.setAttribute("data-ps-mode", palette.mode);
    root.dataset.mode = palette.mode;
    root.dataset.mask = this.maskEnabled ? "on" : "off";

    this.currentFrame = frame;

    // 粒子密度跟随强度，颜色跟随当前帧的 accent
    if (this.stardust !== null) {
      this.stardust.setLevel(frame / MAX_FRAME);
      this.stardust.setAccent(tone.accent ?? [255, 255, 255], palette.mode === "light");
    }
    this.syncMotion();
  }

  /**
   * 换到某张照片。
   *
   * 两条规则：
   *   1. 图没变就什么都不做。之前每次调用都交换两层，改个设置、
   *      滑块重新挂载都会让同一张图「淡出再淡入」闪一下。
   *   2. 新层盖在旧层上淡入，旧层保持不透明，淡完再移走。
   *      之前是两层同时一出一进，中点只有 75% 覆盖，底色会透出来。
   *
   * 先解码再淡入：3200px 宽的图第一次显示时若还没解码，
   * 淡入会先淡进一片空白、图再「啪」地出现。
   */
  showPlate(url, focus) {
    if (this.stage === null) return;
    const target = this.pendingUrl ?? this.topUrl;
    if (url === target) return;
    if (url === this.topUrl) {
      // 拖回到当前这张：取消还在解码的那张
      this.swapToken += 1;
      this.pendingUrl = null;
      return;
    }
    const token = ++this.swapToken;
    this.pendingUrl = url;
    void this.whenDecoded(url).then(() => {
      if (this.disposed || token !== this.swapToken || this.stage === null) return;
      this.pendingUrl = null;
      this.revealPlate(url, focus);
    });
  }

  /** 解码一张图；失败也照样往下走（显示出来的就是底色）。 */
  whenDecoded(url) {
    if (this.decoded.has(url)) return Promise.resolve();
    let image = this.images.get(url);
    if (image === undefined) {
      image = new Image();
      image.decoding = "async";
      image.src = url;
      this.images.set(url, image);
      this.loaded.add(url);
    }
    const done = () => {
      this.decoded.add(url);
    };
    const decode = typeof image.decode === "function" ? image.decode() : Promise.resolve();
    return decode.then(done, done);
  }

  /** 新建一层照片盖在最上面，淡入后移走下面的层。 */
  revealPlate(url, focus) {
    const stage = this.stage;
    const previous = stage.lastElementChild;
    /*
     * 上一层还没淡完就来了新图（快速拖动）：把它直接钉到不透明，
     * 再移走它下面的层。这样任何时刻最多两层，覆盖率始终是 100%。
     */
    if (previous !== null) {
      previous.style.transition = "none";
      while (stage.firstElementChild !== previous) stage.firstElementChild.remove();
    }

    const plate = document.createElement("div");
    plate.className = "ps-plate";
    plate.style.backgroundImage = `url("${url}")`;
    plate.style.setProperty("--ps-focus", focus);
    stage.append(plate);
    // 先让浏览器记下 opacity:0，再切到可见，transition 才会生效
    void globalThis.getComputedStyle(plate).opacity;
    plate.dataset.visible = "true";
    this.topUrl = url;

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      plate.removeEventListener("transitionend", onEnd);
      if (plate.parentElement !== stage) return;
      while (stage.firstElementChild !== plate) stage.firstElementChild.remove();
    };
    const onEnd = (event) => {
      if (event.target === plate && event.propertyName === "opacity") settle();
    };
    plate.addEventListener("transitionend", onEnd);
    // transitionend 在后台标签页、减少动态效果时可能不来，兜底
    setTimeout(settle, 600);
  }

  /** 把当前 running / dragging / 开关状态写进 DOM。 */
  syncMotion() {
    if (this.root === null) return;
    applyMotionState(
      this.root,
      motionState({ dragging: this.dragging, running: this.running }),
      this.motionEnabled,
    );
  }

  /** 模型运行状态变化（由 client 的会话订阅驱动）。 */
  setRunning(running) {
    if (this.disposed) return;
    const next = Boolean(running);
    if (this.running === next) return;
    this.running = next;
    this.syncMotion();
  }

  /** 标注是否正在拖滑块 —— 拖动期间照片全亮。 */
  setDragging(dragging) {
    if (this.disposed) return;
    const next = Boolean(dragging);
    if (this.dragging === next) return;
    this.dragging = next;
    this.syncMotion();
  }

  /**
   * 星尘粒子开关。
   *
   * 开关走 CSS 淡入淡出（data-particles），关闭时等淡完再停绘制，
   * 不再一帧之内全部消失或全部出现。
   */
  setParticlesEnabled(enabled) {
    if (this.disposed) return;
    const next = Boolean(enabled);
    if (this.particlesEnabled === next) return;
    this.particlesEnabled = next;
    if (this.root !== null) this.root.dataset.particles = next ? "on" : "off";
    if (this.particleTimer !== null) {
      clearTimeout(this.particleTimer);
      this.particleTimer = null;
    }
    if (this.stardust === null) return;
    if (next) {
      this.stardust.setVisible(true);
      this.stardust.start();
      return;
    }
    const stardust = this.stardust;
    this.particleTimer = setTimeout(() => {
      this.particleTimer = null;
      if (!this.particlesEnabled && this.stardust === stardust) {
        stardust.setVisible(false);
        // 淡出后停掉动画循环，不再每帧唤醒主线程；再打开时 start() 会重新起
        stardust.stop();
      }
    }, 760);
  }

  /** 空闲淡化开关。 */
  setMotionEnabled(enabled) {
    if (this.disposed) return;
    const next = Boolean(enabled);
    if (this.motionEnabled === next) return;
    this.motionEnabled = next;
    this.syncMotion();
  }

  /** 预加载所有锚点与过渡帧，让拖动时不出现空白。 */
  /**
   * 预加载。
   *
   * 图升级到宽 3200 后单张约 0.2–0.9 MB，九张全量预加载约 6 MB。
   * 所以只在**空闲时**按需加载，并且优先当前帧及其左右邻帧 ——
   * 用户真正拖动时，目标往往就在附近，命中率很高。
   */
  preload() {
    const urls = activeFrameUrls();
    if (urls.length === 0) return;
    const current = Math.max(0, this.currentFrame);
    const step = Math.max(1, Math.round(urls.length / 8));
    // 当前帧 + 左右各一帧优先
    const priority = [current, current - step, current + step]
      .map((i) => ((i % urls.length) + urls.length) % urls.length);

    const load = (url) => {
      // dispose 之后才到达的 idle 回调直接丢弃
      if (this.disposed || this.loaded.has(url)) return;
      this.loaded.add(url);
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      // 持有引用，避免被 GC 提前回收
      this.images.set(url, image);
    };

    // 先加载优先级最高的三张
    for (const i of priority) load(urls[i]);

    // 其余在浏览器空闲时慢慢补，不抢首屏
    const rest = urls.filter((url) => !this.loaded.has(url));
    if (rest.length === 0) return;
    const schedule =
      typeof globalThis.requestIdleCallback === "function"
        ? (fn, opts) => {
            const handle = globalThis.requestIdleCallback(fn, opts);
            this.idleHandles.add(handle);
            return handle;
          }
        : (fn) => {
            const handle = setTimeout(fn, 1200);
            this.idleHandles.add(handle);
            return handle;
          };
    for (const [index, url] of rest.entries()) {
      schedule(() => load(url), { timeout: 4000 + index * 400 });
    }
  }

  /**
   * 设置强度。
   *
   * 未启用时只**记下**待应用的帧，等 setEnabled(true) 时一次画出来。
   * 这样入口可以先把持久化的 frame 写进来再启用，避免
   * "先闪一张默认图再跳到正确位置"。
   */
  setFrame(frame) {
    if (this.disposed) return;
    this.currentFrame = frame;
    if (!this.enabled) return;
    this.applyFrame(frame);
  }

  /** 当前帧；-1 表示还没设过（由入口给默认强度）。 */
  getFrame() {
    return this.currentFrame;
  }

  setEnabled(enabled) {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;

    if (enabled) {
      document.body.setAttribute("data-photo-skin", "on");
      this.preload();
      this.applyFrame(Math.max(0, this.currentFrame));
    } else {
      this.stardust?.stop();
      this.stardust?.dispose();
      this.stardust = null;
      this.root?.remove();
      // 置空引用，否则旧节点会被一直持有
      this.root = null;
      this.stage = null;
      this.topUrl = null;
      this.pendingUrl = null;
      this.swapToken += 1;
      document.body.removeAttribute("data-photo-skin");
      for (const name of Object.keys(deriveTone(toneAt(0)))) {
        document.body.style.removeProperty(`--ps-${name}`);
      }
    }
  }

  /**
   * 颗粒开关单独控制，不必重建整层。
   *
   * 必须先记下来：启动时这一步在背景层建好之前执行，
   * 之前直接 return，导致「颗粒质感」关掉后重启又出现。
   */
  setGrain(enabled) {
    this.grainEnabled = Boolean(enabled);
    if (this.root === null) return;
    this.root.dataset.grain = this.grainEnabled ? "on" : "off";
  }

  /**
   * 背景遮罩开关。关掉后把遮罩透明度收到 0，人物原样呈现。
   * 注意仍然保留一层极淡的底，否则浅色主题下深色字会失去对比。
   */
  setMaskEnabled(enabled) {
    if (this.disposed) return;
    const changed = this.maskEnabled !== enabled;
    this.maskEnabled = enabled;
    // 只有真的变了才重绘；但 root 还没建时也要设一次 data-mask
    if (!changed) return;
    if (this.root === null) return;
    this.root.dataset.mask = enabled ? "on" : "off";
    if (this.enabled) this.applyFrame(Math.max(0, this.currentFrame));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.stardust?.dispose();
    this.stardust = null;
    // 取消所有待执行的预加载回调
    for (const handle of this.idleHandles) {
      if (typeof globalThis.cancelIdleCallback === "function") {
        globalThis.cancelIdleCallback(handle);
      }
      clearTimeout(handle);
    }
    this.idleHandles.clear();
    // 断开图片引用，让浏览器可以回收
    for (const image of this.images.values()) image.src = "";
    this.images.clear();
    this.loaded.clear();
    this.root?.remove();
    document.body.removeAttribute("data-photo-skin");
    for (const name of Object.keys(deriveTone(toneAt(0)))) {
      document.body.style.removeProperty(`--ps-${name}`);
    }
    this.unsubscribe?.();
    if (this.particleTimer !== null) clearTimeout(this.particleTimer);
    this.particleTimer = null;
    this.root = null;
    this.stage = null;
    this.topUrl = null;
    this.pendingUrl = null;
    this.swapToken += 1;
    this.decoded.clear();
  }
}

export { IMAGES };