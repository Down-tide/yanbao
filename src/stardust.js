/**
 * dsh-photo-skin（言宝）—— 星尘粒子层。
 *
 * 对标「滑动变祖」的粒子效果，但用 Canvas 2D 而不是 WebGL。
 *
 * 为什么不用 WebGL：
 *   滑动变祖那套是 3300 个粒子的 WebGL 实现（顶点着色器 + 片元着色器
 *   + 指针速度场），约 450 行。星尘本来就该稀疏，600 个粒子的 2D
 *   版本在同样观感下更轻、更好维护，也不会在低端设备上因为 WebGL
 *   上下文丢失而整层消失。
 *
 * 视觉参考它的着色器：
 *   core = pow(1 - r, 2.6)      中心亮核
 *   halo = pow(1 - r, 1.1) * 0.35  外圈柔光
 *   这里预渲染成 sprite（离屏 canvas），每帧只需 drawImage，
 *   比逐粒子画 radial-gradient 快一个数量级。
 *
 * 物理参数取自它的 reset()：
 *   vx ±45、vy -30 ~ -140、寿命 3~7 秒、尺寸 2~5.2px
 */

/** 粒子数随强度档位变化：低档克制，高档满天。 */
/*
 * 密度区间。
 *
 * 最初设 120~600，实测（截图 + 高频残差统计）低档只比无粒子多 11% 亮点，
 * 肉眼几乎察觉不到。星尘要「一眼知道有」，下限必须够高。
 * 现在低档 260、高档 900 —— 高档接近滑动变祖的 1/3，但因为是 2D
 * drawImage 且锁 60fps，实测仍能跑满帧。
 */
const MIN_ACTIVE = 260;
const MAX_ACTIVE = 900;

/** 上限帧率，避免在高刷屏上无意义地烧 GPU。 */
const MAX_FPS = 60;

/**
 * 预渲染一颗星尘。
 *
 * sprite 是 32×32 的离屏 canvas，中心亮核 + 柔和光晕，
 * 颜色用白色 —— 实际着色靠 globalAlpha 和混合模式，
 * 深浅主题共用同一张，不必生成两份。
 */
function createSprite(rgb = [255, 255, 255]) {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;

  const center = size / 2;
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5 - center) / center;
      const dy = (y + 0.5 - center) / center;
      const r = Math.hypot(dx, dy);
      if (r > 1) continue;
      // 与滑动变祖的片元着色器同一套公式
      const core = Math.pow(1 - r, 2.6);
      const halo = Math.pow(1 - r, 1.1) * 0.35;
      const alpha = Math.min(1, core + halo);
      const index = (y * size + x) * 4;
      data[index] = rgb[0];
      data[index + 1] = rgb[1];
      data[index + 2] = rgb[2];
      data[index + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * 创建粒子层。
 *
 * @param {{reduced: boolean}} [options]
 * @returns {object} 控制句柄
 */
export function createStardust(options = {}) {
  const noop = {
    canvas: null,
    setLevel() {},
    setAccent() {},
    setPaused() {},
    setVisible() {},
    start() {},
    stop() {},
    dispose() {},
  };

  if (typeof document === "undefined") return noop;

  const reduced =
    options.reduced ??
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ??
    false;
  // 用户开了「减少动态效果」就完全不画 —— 动效过敏是真实存在的
  if (reduced) return noop;

  const canvas = document.createElement("canvas");
  canvas.className = "ps-stardust";
  canvas.setAttribute("aria-hidden", "true");

  const ctx = canvas.getContext("2d");
  if (ctx === null) return noop;

  /*
   * 两套 sprite。
   *
   * ⚠ 这一点最初漏了：九个档位里有五个是「亮色模式」（面板接近白色），
   *   白色星尘在那上面等于不存在。实测那五档的粒子贡献是 0 像素。
   *   亮底改用暖灰（比底板略深），靠 screen 混合之外的正片叠底才看得见。
   */
  /*
   * sprite 按当前帧的 accent 色现算。
   *
   * 早期版本写死白色（暗底）和蓝色（亮底），但九张图的色调差异很大：
   * 舞台新章是粉、林间绿意是绿、舞台暖光是橙 —— 硬塞一个蓝色很突兀。
   *
   * 现在跟随每张图自己的 accent：
   *   暗底 → accent 原色（本身就够亮，能当光点）
   *   亮底 → accent 压暗到面板亮度的 8% 左右，保住色相又够深
   * 颜色只在换帧时重算一次（画 32×32 的 sprite，成本可忽略）。
   */
  let sprite = createSprite([255, 255, 255]);
  if (sprite === null) return noop;

  /** 当前该用哪套配色 / 哪种混合。 */
  let lightMode = false;
  /** 最近一次渲染用的 accent，避免重复重建 sprite。 */
  let currentAccent = "";

  let width = 0;
  let height = 0;
  let dpr = 1;
  let raf = null;
  let last = 0;
  let time = 0;
  let running = false;
  let disposed = false;
  let visible = true;
  let paused = false;

  /*
   * 粒子喷发点（归一化坐标 0..1）。
   *
   * 基准值取自滑动变祖（0.86 / 0.8），那是「输入框右侧」的位置 ——
   * 它的粒子挂在会话列里，输入框就在下方，所以从那里往上冒是对的。
   *
   * 本皮肤的粒子层铺满整个窗口，若照搬 0.8 会因为上升行程不足
   * 全挤在右下角；但如果压到 0.95 又会生成到画布外（直接被重生逻辑
   * 判定为飞出，粒子一个都看不见）。
   *
   * 所以取 0.88：粒子生成在画布内偏下的位置，往上飘 3~7 秒，
   * 行程大约占屏高的 20%~45%，形成一束从右下角斜升的光雾。
   */
  let anchorX = 0.8;
  let anchorY = 0.88;

  /** 0..1，由滑块的强度决定；平滑过渡避免拖滑块时粒子数突变 */
  let level = 0;
  let smoothLevel = 0;

  /** 粒子池。按需增长到 MAX_ACTIVE。 */
  const particles = [];

  const random = (min, max) => min + Math.random() * (max - min);

  /*
   * 粒子重生。
   *
   * 参照滑动变祖的做法：**从一个点喷出、向上飘散**，而不是全屏散布。
   *
   *   particle.x = anchorX * width + (random - 0.5) * spread * 2
   *   particle.vy = -30 - random * 110
   *
   * 其中 spread = width * 0.05 —— 扩散半径只有屏宽的 5%。
   * 所以它的观感是「输入框右侧升起一小簇光雾」，不是满天星。
   *
   * 之前我做成全屏均匀热运动，实测观感是「满屏噪点、像中毒」，
   * 完全不是想要的效果。现在照它的模型来。
   */
  const reset = (p, scatter) => {
    // 点源：在锚点周围一个很小的椭圆范围内撒
    const spread = width * 0.05;
    p.x = anchorX * width + (Math.random() - 0.5) * spread * 2;
    p.y = anchorY * height + (Math.random() - 0.5) * spread * 1.4;
    p.vx = (Math.random() - 0.5) * 90;
    /*
     * 上飘初速。
     * 滑动变祖是 -30 ~ -140，但它的容器矮（会话列），这个速度够用。
     * 本皮肤要铺满整窗，同样的速度只能飘起一小截，观感全压在底部。
     * 实测把上限提到 -320 后，3~7 秒的寿命能覆盖屏高的 40%~100%。
     */
    p.vy = -90 - Math.random() * 230;
    p.maxLife = 3 + Math.random() * 4;
    p.life = scatter ? Math.random() * p.maxLife : 0;
    p.size = 2 + Math.random() * 3.2;
    p.phase = Math.random() * Math.PI * 2;
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const nextDpr = Math.min(1.5, Math.max(1, globalThis.devicePixelRatio ?? 1));
    const nextWidth = Math.max(0, Math.round(rect.width * nextDpr));
    const nextHeight = Math.max(0, Math.round(rect.height * nextDpr));
    if (nextWidth === width && nextHeight === height && nextDpr === dpr) return false;
    dpr = nextDpr;
    width = nextWidth;
    height = nextHeight;
    canvas.width = width;
    canvas.height = height;
    for (const p of particles) reset(p, true);
    return true;
  };

  /*
   * 尺寸监听。
   *
   * ⚠ 这段是必须的：start() 往往在 canvas 还没插进 DOM 时就被调用
   *   （presenter 先建层、再把整层 append 到 body），那一刻
   *   getBoundingClientRect() 全是 0，canvas.width 会被设成 0，
   *   之后没有任何东西再触发测量 —— 结果就是「粒子在跑但一个像素都看不到」。
   */
  let observer = null;
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(() => resize());
    observer.observe(canvas);
  }

  const simulate = (dt) => {
    smoothLevel += (level - smoothLevel) * Math.min(1, dt * 3);
    const active = Math.round(MIN_ACTIVE + smoothLevel * (MAX_ACTIVE - MIN_ACTIVE));
    const levelFactor = 0.45 + 0.55 * smoothLevel;

    for (let i = 0; i < active; i += 1) {
      const p = particles[i];
      p.life += dt;
      if (p.life > p.maxLife) reset(p, false);

      /*
       * 物理照搬滑动变祖的 simulate()：
       *   - curl 用正弦制造「气流」感，让横向漂移不是纯随机抖动
       *   - vy 持续减小（往上加速），模拟热气上升
       *   - 阻尼 0.8
       *   - 飞出画面上方就重生
       */
      const curl = Math.sin(p.y * 16e-4 + time * 0.25 + p.phase);
      p.vx += curl * width * 0.02 * dt + (Math.random() - 0.5) * width * 0.05 * dt;
      p.vy -= height * 8e-3 * dt;
      p.vy += (Math.random() - 0.5) * height * 0.03 * dt;

      // 阻尼，防止速度累积到失控
      const damping = Math.max(0, 1 - 0.8 * dt);
      p.vx *= damping;
      p.vy *= damping;

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      /*
       * 只判断「飞出上方或左右」就重生 —— 不判断下方。
       * 粒子从锚点向上飘，底部本来就没有，多一条判断反而多余。
       */
      if (p.y < -height * 0.15 || p.x < -width * 0.1 || p.x > width * 1.1) {
        reset(p, false);
      }

      // 生命曲线：淡入 → 保持 → 淡出，再叠一层闪烁
      const lifeRatio = p.life / p.maxLife;
      const fade =
        Math.min(1, lifeRatio / 0.18) *
        Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, lifeRatio))), 0.7);
      const twinkle = 0.55 + 0.45 * Math.sin(p.phase + time * 1.6);
      p.alpha = Math.min(1, (0.42 + 0.5 * levelFactor) * twinkle * fade);
      p.drawSize = p.size * dpr * (0.8 + 0.4 * levelFactor);
    }
  };

  const draw = () => {
    if (width === 0 || height === 0) return;
    ctx.clearRect(0, 0, width, height);

    /*
     * 深底用 lighter（加法混合）让光点自然发光；
     * 亮底不能用 lighter —— 加法只会更白，等于看不见。
     * 改用 source-over 直接画深色颗粒。
     */
    ctx.globalCompositeOperation = lightMode ? "source-over" : "lighter";
    const alphaScale = lightMode ? 1.5 : 1;

    const active = Math.round(MIN_ACTIVE + smoothLevel * (MAX_ACTIVE - MIN_ACTIVE));
    for (let i = 0; i < active; i += 1) {
      const p = particles[i];
      if (p.alpha <= 0.01) continue;
      ctx.globalAlpha = Math.min(1, p.alpha * alphaScale);
      // drawSize 是直径，drawImage 要左上角坐标
      const half = p.drawSize / 2;
      ctx.drawImage(sprite, p.x - half, p.y - half, p.drawSize, p.drawSize);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  };

  const frame = (now) => {
    if (disposed) return;
    raf = globalThis.requestAnimationFrame(frame);
    if (!running || paused || !visible) {
      last = now;
      return;
    }
    // 尺寸还是 0（canvas 刚插入 DOM / 布局还没算完）→ 重新测量
    if (width === 0 || height === 0) resize();
    // 锁 60fps：高刷屏上不必跑到 120
    /*
     * 留 1ms 余量：60Hz 屏的 rAF 间隔在 16.6~16.8ms 之间抖动，
     * 严格按 16.67ms 判断会每三帧丢一帧（实测只有 39 fps）。
     * 120Hz 屏上仍然是隔一帧画一帧，封顶 60。
     */
    if (now - last < 1000 / MAX_FPS - 1) return;
    // 页面切回来时 dt 可能很大，钳住避免粒子瞬移
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    simulate(dt);
    draw();
  };

  const start = () => {
    if (running || disposed) return;
    running = true;
    // 池一次建满，避免运行中分配
    for (let i = particles.length; i < MAX_ACTIVE; i += 1) {
      particles.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 1, phase: 0, alpha: 0, drawSize: 1 });
    }
    for (const p of particles) reset(p, true);
    resize();
    last = 0;
    raf = globalThis.requestAnimationFrame(frame);
  };

  const stop = () => {
    running = false;
    if (raf !== null) {
      globalThis.cancelAnimationFrame(raf);
      raf = null;
    }
    ctx.clearRect(0, 0, width, height);
  };

  return {
    /** 挂载用。presenter 把它 append 到背景层里。 */
    canvas,
    /** 0..1 强度；由 presenter 在切帧时写入。 */
    setLevel(next) {
      if (disposed) return;
      const value = Number(next);
      level = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    },
    /** 页面不可见 / 主题不活跃时暂停绘制。 */
    setPaused(next) {
      paused = Boolean(next);
    },
    /**
     * 设置粒子颜色 —— 跟随当前帧的 accent。
     *
     * @param {number[]} accent [r,g,b]
     * @param {boolean} light 是否亮色模式
     */
    setAccent(accent, light) {
      const key = `${accent.join(",")}|${light}`;
      if (currentAccent === key) return;
      currentAccent = key;
      lightMode = Boolean(light);

      // 画布混合模式：暗底用加法混合让光点发亮；亮底必须普通叠加
      canvas.style.mixBlendMode = lightMode ? "normal" : "screen";
      canvas.dataset.light = lightMode ? "1" : "0";

      /*
       * 把 accent 换算成"能看见"的粒子色：
       *   暗底 → 提亮，保证明显亮于面板
       *   亮底 → 压暗到面板亮度的 8% 左右，保住色相同时足够深
       */
      const lin = (v) => {
        const x = v / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);

      /** RGB ↔ HSV，只为了调饱和度（同比缩放会把饱和一起压掉）。 */
      const toHsv = ([r, g, b]) => {
        r /= 255; g /= 255; b /= 255;
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const d = mx - mn;
        let h = 0;
        if (d > 0) {
          if (mx === r) h = ((g - b) / d) % 6;
          else if (mx === g) h = (b - r) / d + 2;
          else h = (r - g) / d + 4;
          h *= 60;
          if (h < 0) h += 360;
        }
        return [h, mx === 0 ? 0 : d / mx, mx];
      };
      const fromHsv = ([h, sat, v]) => {
        const c = v * sat;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = v - c;
        const seg = Math.floor(h / 60) % 6;
        const rgb =
          seg === 0 ? [c, x, 0] :
          seg === 1 ? [x, c, 0] :
          seg === 2 ? [0, c, x] :
          seg === 3 ? [0, x, c] :
          seg === 4 ? [x, 0, c] : [c, 0, x];
        return rgb.map((u) => (u + m) * 255);
      };

      let out = accent.slice(0, 3);
      if (lightMode) {
        /*
         * 白底：压到面板亮度的 ~26%，然后**补回饱和度**。
         *
         * 这一步是必需的：蝶与薄雾、舞台新章的 accent 本身是灰粉
         * （rgb 通道差只有 20 上下），同比压暗后色相基本消失，
         * 变成脏灰。实测 ×1.3 能把它们拉回"柔和的藕粉 / 玫瑰粉"，
         * 又不会像 ×2.4 那样红得刺眼。
         */
        for (let i = 0; i < 80 && lum(out) > 0.26; i += 1) {
          out = out.map((v) => v * 0.92);
        }
        const [h, sat, v] = toHsv(out);
        out = fromHsv([h, Math.min(1, sat * 1.3 + 0.04), v]);
        out = out.map((x) => Math.max(56, Math.round(x)));
      } else {
        // 深底：提亮到足以成光点，同样保持色相
        for (let i = 0; i < 60 && lum(out) < 0.55; i += 1) {
          out = out.map((v) => Math.min(255, v * 1.08 + 4));
        }
        out = out.map((v) => Math.round(v));
      }

      const next = createSprite(out);
      if (next !== null) sprite = next;
    },
    /** 开关控制（设置页的「星尘粒子」）。 */
    setVisible(next) {
      visible = Boolean(next);
      if (!visible) ctx.clearRect(0, 0, width, height);
    },
    start,
    stop,
    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
      observer?.disconnect();
      observer = null;
      particles.length = 0;
      canvas.width = canvas.height = 0;
      canvas.remove();
    },
  };
}

export { MAX_ACTIVE as STARDUST_MAX_PARTICLES };
