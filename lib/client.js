window.__ModuleLoader__.load({
  id: "dsh-photo-skin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

/* ── src/logic.js ── */
/**
 * dsh-photo-skin · 言宝 —— 强度轴与配色（纯函数，无 DOM 依赖）。
 *
 * 强度轴：0..MAX_FRAME 连续，九个锚点均匀落位（对应九张图，亮度从暗到亮）。
 *
 * 配色有**两套主题**，由当前锚点的亮度决定：
 *   dark  模式 —— 深色玻璃 + 浅字（低档，暗夜照片）
 *   light 模式 —— 白底 + 深字（高档，明亮棚拍，对齐 DSH 原生的白底）
 * 中间档位按亮度阈值切换，不做半明半暗的插值 —— 那种文字最难读。
 */

/** 包 id，同时是资源路由前缀的一部分。所有模块共用这一份。 */
const PACKAGE_ID = "dsh-photo-skin";

/** 九个阶段 —— 一张图一档。 */
const MAX_LEVEL = 8;

/** 滑块的分辨率。 */
/*
 * 颗粒质感。
 *
 * 原来的值（0.05 / 0.03）几乎看不见 —— 而且 --ps-grain-image 从未定义，
 * background-image 是空的，等于完全没渲染。两个问题一起修：
 *   1. 用 SVG feTurbulence 生成真实噪点（内联 data URI，不占请求）；
 *   2. 把不透明度提到肉眼可见、但又不至于像老电视雪花。
 *
 * 暗色模式可以放得更重一些：深色底上的亮噪点天然更抢眼，
 * 亮色模式要压住，否则会像脏点。
 */
const GRAIN_OPACITY = Object.freeze({
  dark: "0.14",
  light: "0.28",
});

/** 内联 SVG 噪点。feTurbulence 的 fractalNoise 比随机点更接近胶片颗粒。 */
const GRAIN_IMAGE =
  "url(\"data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">' +
      '<filter id="n">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="3" stitchTiles="stitch"/>' +
      '<feColorMatrix type="saturate" values="0"/>' +
      "</filter>" +
      '<rect width="100%" height="100%" filter="url(#n)" opacity="0.9"/>' +
      "</svg>",
  ) +
  '\")';

const MAX_FRAME = 240;

/** 背景平均亮度超过这个值就切到浅色主题（0..255）。 */
const LIGHT_MODE_THRESHOLD = 100;

/** 把帧号钳制到合法范围。 */
function clampFrame(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_FRAME, Math.max(0, Math.round(value)));
}

/** 档位 -> 帧号。 */
function frameForLevel(level) {
  const safe = Math.max(0, Math.min(MAX_LEVEL, level));
  return clampFrame((safe / MAX_LEVEL) * MAX_FRAME);
}

/** 帧号 -> 档位（四舍五入）。 */
function levelForFrame(frame) {
  return Math.round((clampFrame(frame) / MAX_FRAME) * MAX_LEVEL);
}

/** 帧号 -> 最近的整数档位对应的帧号（用于吸附）。 */
function snapFrame(frame) {
  return frameForLevel(levelForFrame(frame));
}

/**
 * 帧号 -> 连续的阶段小数。
 * 第 0 档 = 0.0，第 8 档 = 8.0。
 */
function stageAt(frame) {
  return (clampFrame(frame) / MAX_FRAME) * MAX_LEVEL;
}

const lerp = (a, b, t) => a + (b - a) * t;

/** 两色线性混合。 */
function mix(a, b, t) {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
}

function rgb(value, alpha = 1) {
  return alpha >= 1
    ? `rgb(${value[0]}, ${value[1]}, ${value[2]})`
    : `rgba(${value[0]}, ${value[1]}, ${value[2]}, ${alpha})`;
}

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));

/** 朝白（amount>0）或朝黑（amount<0）推。 */
function shade(value, amount) {
  const target = amount >= 0 ? 255 : 0;
  const t = Math.abs(amount);
  return [
    value[0] + (target - value[0]) * t,
    value[1] + (target - value[1]) * t,
    value[2] + (target - value[2]) * t,
  ];
}

/** 感知亮度 0..1。 */
function luminance(color) {
  return (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]) / 255;
}

/**
 * 该用浅色主题还是深色主题。
 *
 * 依据是**图片本身的平均亮度**（tone.lum），不是 base（base 是面板底色，
 * 永远是深色），也不是滑块位置 —— 这样换素材、调顺序都会自动正确。
 */
function isLightMode(tone) {
  return (tone.lum ?? luminance(tone.base) * 255) >= LIGHT_MODE_THRESHOLD;
}

/**
 * 由「情绪参数」推导出全部 --ps-* 变量。
 *
 * @param {{base:number[], accent:number[], veil:number}} tone
 * @param {{mask?:boolean, maskStrength?:number}} [options]
 *   mask: 背景遮罩开关（对标滑动变祖的「背景遮罩」）
 *   maskStrength: 0..1 的额外强度倍率
 * @returns {Record<string, string>} 不含 --ps- 前缀的键值表
 */
function deriveTone(tone, options = {}) {
  const { base, accent, veil } = tone;
  const light = isLightMode(tone);
  const { mask = true, maskStrength = 1 } = options;

  /*
   * 遮罩浓度。
   *
   * 这里有个关键点：**遮罩不能跟着图片亮度一路降**。
   * 之前高档只给 0.14，照片几乎原样，文字直接压在脸和花瓣上 —— 实测
   * 浅色档对比度只有 1.5:1，远低于 4.5:1 的可读线。
   *
   * 正确做法是给遮罩一个**下限**：不管图多亮，至少压到能读；
   * 更亮的部分靠主题切换（白底深字）来解决，而不是靠放任照片穿透。
   */
  const floor = light ? 0.42 : 0.34;
  const v = mask ? Math.max(floor, Math.min(0.72, veil)) * maskStrength : 0;

  return light ? lightPalette(base, accent, v) : darkPalette(base, accent, v);
}

/** 深色主题：暗夜照片用，浅字压在玻璃上。 */
function darkPalette(base, accent, v) {
  const text1 = brighter(shade(base, 0.95), [238, 241, 246], 0.7);
  const text2 = brighter(shade(base, 0.78), [190, 197, 208], 0.65);
  const text3 = brighter(shade(base, 0.6), [150, 158, 172], 0.6);

  return {
    mode: "dark",
    "mode-light": "0",

    "surface-1": rgb(base, 0.62),
    "surface-2": rgb(base, 0.78),
    "surface-3": rgb(base, 0.9),
    sidebar: rgb(base, 0.38),
    input: rgb(base, 0.74),
    bubble: rgb(base, 0.8),
    "bubble-hi": rgb(accent, 0.22),
    selector: rgb(base, 0.84),
    menu: rgb(base, 0.93),
    "menu-head": rgb(base, 0.95),
    elevated: "rgba(255, 255, 255, 0.10)",

    hover: "rgba(255, 255, 255, 0.08)",
    active: "rgba(255, 255, 255, 0.12)",
    "hover-strong": "rgba(255, 255, 255, 0.14)",
    "hover-accent": rgb(accent, 0.16),

    "text-1": hex(text1),
    "text-2": hex(text2),
    "text-3": hex(text3),
    /*
     * 反色说明：
     * DSH 侧栏的「deepseek HARNESS」徽章是内联 SVG —— 胶囊用 currentColor
     * （继承父级 color，即 text-1），徽章内的字用 --dsw-alias-label-primary-inverted。
     * 所以 inverted 必须和 text-1 拉开，否则浅色档会变成一坨黑块（实测过）。
     *
     * 深色档：胶囊近白 → 内文要深，取底色。
     */
    "on-accent": hex(shade(base, 0.06)),
    "label-inverted": hex(shade(base, 0.06)),

    "border-1": "rgba(255, 255, 255, 0.09)",
    "border-2": "rgba(255, 255, 255, 0.14)",
    "border-3": "rgba(255, 255, 255, 0.19)",

    code: rgb(base, 0.86),
    "code-head": rgb(base, 0.92),
    "inline-code": "rgba(255, 255, 255, 0.10)",

    scroll: "rgba(255, 255, 255, 0.14)",
    "scroll-hover": "rgba(255, 255, 255, 0.26)",

    accent: hex(accent),
    "accent-hi": hex(shade(accent, 0.18)),
    "accent-soft": rgb(accent, 0.18),
    "accent-ink": hex(contrastOn(accent)),

    blur: "22px",
    "blur-sidebar": "10px",
    "sidebar-veil": rgb(base, 0.30),
    "center-veil": rgb(base, 0.10),
    backdrop: hex(shade(base, -0.35)),
    // 深色模式：全局遮罩保持中等，正文可读性同样靠衬底
    "veil-top": rgb(base, Math.min(0.68, 0.30 + v * 0.35)),
    "veil-mid": rgb(base, Math.min(0.58, 0.24 + v * 0.30)),
    "veil-bottom": rgb(base, Math.min(0.64, 0.28 + v * 0.30)),
    "veil-edge": rgb(base, Math.min(0.78, 0.42 + v * 0.36)),
    grain: GRAIN_OPACITY.dark,
    "read-top": rgb(base, 0),
    "read-mid": rgb(base, Math.min(0.90, Math.max(0.62, v + 0.40))),
    "read-edge": rgb(base, 0),

    "text-backing": rgb(base, 0.34),

    "text-shadow":
      "0 1px 2px rgba(0, 0, 0, 0.55), " +
      "0 0 10px rgba(0, 0, 0, 0.42), " +
      "0 0 22px rgba(0, 0, 0, 0.30)",
  };
}

/** 浅色主题：明亮照片用，深字压在乳白玻璃上 —— 对齐 DSH 原生白底观感。 */
function lightPalette(base, accent, v) {
  const ink = shade(mix(base, [40, 44, 52], 0.55), -0.15);
  const text1 = hex(shade(ink, -0.62));
  const text2 = hex(shade(ink, -0.36));
  const text3 = hex(shade(ink, -0.16));

  // 乳白玻璃：极淡的色调白，不是纯白，免得和照片打架
  const paper = mix([255, 255, 255], base, 0.055);
  const paperStrong = mix([255, 255, 255], base, 0.09);
  const scrim = [252, 252, 253];

  return {
    mode: "light",
    "mode-light": "1",

    "surface-1": rgb(paper, 0.72),
    "surface-2": rgb(paper, 0.86),
    "surface-3": rgb(paperStrong, 0.94),
    sidebar: rgb(paper, 0.46),
    input: rgb(paper, 0.82),
    bubble: rgb(paper, 0.88),
    "bubble-hi": rgb(accent, 0.3),
    selector: rgb(paper, 0.9),
    menu: rgb(paperStrong, 0.96),
    "menu-head": rgb(paperStrong, 0.98),
    elevated: "rgba(20, 24, 32, 0.06)",

    hover: "rgba(20, 24, 32, 0.055)",
    active: "rgba(20, 24, 32, 0.09)",
    "hover-strong": "rgba(20, 24, 32, 0.11)",
    "hover-accent": rgb(accent, 0.22),

    "text-1": text1,
    "text-2": text2,
    "text-3": text3,
    // 浅色档：胶囊近黑（text-1）→ 内文要亮
    "on-accent": hex(contrastOn(accent)),
    "label-inverted": "#f7f7f8",

    "border-1": "rgba(20, 24, 32, 0.08)",
    "border-2": "rgba(20, 24, 32, 0.12)",
    "border-3": "rgba(20, 24, 32, 0.16)",

    code: rgb(paperStrong, 0.92),
    "code-head": rgb(paperStrong, 0.96),
    "inline-code": "rgba(20, 24, 32, 0.07)",

    scroll: "rgba(20, 24, 32, 0.16)",
    "scroll-hover": "rgba(20, 24, 32, 0.28)",

    accent: hex(shade(accent, -0.3)),
    "accent-hi": hex(shade(accent, -0.12)),
    "accent-soft": rgb(accent, 0.24),
    "accent-ink": hex(contrastOn(shade(accent, -0.3))),

    blur: "22px",
    "blur-sidebar": "10px",
    "sidebar-veil": rgb(paper, 0.32),
    "center-veil": rgb(paper, 0.12),
    backdrop: hex(shade(base, 0.35)),
    /*
     * 浅色模式下遮罩是**白色**的，只负责把照片往亮推一点。
     * 不能给太高 —— 一处给 0.42、衬底再给 0.66，两次叠加就把人冲没了。
     * 全局这里只给 0.18~0.26，正文可读性交给 ps-readability 那条窄带。
     */
    "veil-top": rgb(scrim, Math.min(0.34, 0.20 + v * 0.14)),
    "veil-mid": rgb(scrim, Math.min(0.28, 0.15 + v * 0.12)),
    "veil-bottom": rgb(scrim, Math.min(0.32, 0.18 + v * 0.12)),
    "veil-edge": rgb(scrim, Math.min(0.44, 0.26 + v * 0.16)),
    grain: GRAIN_OPACITY.light,
    "read-top": rgb(scrim, 0),
    "read-mid": rgb(scrim, Math.min(0.86, Math.max(0.60, v + 0.30))),
    "read-edge": rgb(scrim, 0),

    // 浅色底上文字不需要暗边，给一层极淡的白晕让笔画从照片里浮起来
    // 浅色模式不加块底（会压低对比），这个值仅用于深色分支的兜底
    "text-backing": "transparent",

    "text-shadow":
      "0 1px 1px rgba(255, 255, 255, 0.55), " +
      "0 0 8px rgba(255, 255, 255, 0.42)",
  };
}

/** 取两个颜色里更亮的那个（按亮度加权混合），避免亮图上的字发灰。 */
function brighter(a, b, t) {
  const la = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  const lb = 0.2126 * b[0] + 0.7152 * b[1] + 0.0722 * b[2];
  if (la >= lb) return a;
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** 强调色上应该用深字还是浅字。 */
function contrastOn(color) {
  return luminance(color) > 0.55 ? [20, 22, 26] : [252, 252, 250];
}

function hex(value) {
  return `#${[value[0], value[1], value[2]]
    .map((n) => clamp255(n).toString(16).padStart(2, "0"))
    .join("")}`;
}

/* ── src/frames.js ── */
/**
 * dsh-photo-skin · 言宝 —— 帧清单。
 *
 * 顺序规则：**按图片亮度从暗到亮排**。
 *   低档（off / low）配最暗的舞台照，高档（max）配最亮的棚拍白底照。
 *   滑块往右拉，整个界面从暗夜走到天亮 —— 和 DSH 原生白底在最高档对齐。
 *
 * 强度轴上有两类帧：
 *   1. 锚点（anchor）：九张原始素材 —— **当前只用这一层**；
 *   2. 过渡帧（transition）：相邻锚点之间由图编辑模型生成的中间态（当前关闭）。
 *
 * 文件命名约定（assets/ 下）：
 *   anchor    : 见 IMAGES[].file
 *   transition: transitions/t00-1.webp … t07-3.webp
 *               （t00 = 第 0 与第 1 个锚点之间，以此类推）
 */


/**
 * 九个锚点，**按平均亮度升序**。
 *
 * ⚠ 这个数组由 `scripts/prepare-images.py` 自动生成。
 *   手动修改会在下次运行脚本时被「合并」逻辑覆盖（同 file 名的项会被替换）。
 *   想换图请把原图放进 raw/，然后重新运行脚本 —— 见 README「换图」一节。
 */
const IMAGES = [
  {
    file: "05-denim-night",
    lum: 42.4,
    label: "暮色初见",
    base: [42, 39, 30],
    accent: [113, 114, 83],
    veil: 0.45,
    focus: "center 30%",
  },
  {
    file: "03-stage-amber",
    lum: 52.2,
    label: "暖灯低语",
    // 均 52.2 · P50 34.7
    base: [22, 18, 28],
    accent: [214, 168, 108],
    veil: 0.32,
    focus: "center 26%",
  },
  {
    file: "09-sequin-violet",
    lum: 52.2,
    label: "碎光夜行",
    // 均 52.2 · P50 30.4 · P90 140.5
    base: [18, 18, 28],
    accent: [170, 176, 226],
    veil: 0.32,
    focus: "center 24%",
  },
  {
    file: "02-moon-blossom",
    lum: 90.4,
    label: "月下花影",
    // 均 90.4 · 中间调
    base: [14, 22, 38],
    accent: [186, 206, 236],
    veil: 0.34,
    focus: "center 30%",
  },
  {
    file: "08-camel-day",
    lum: 102.2,
    label: "沙白之昼",
    // 均 102.2 · 开始转亮
    base: [24, 24, 30],
    accent: [214, 196, 168],
    veil: 0.28,
    focus: "center 40%",
  },
  {
    file: "01-park-sage",
    lum: 109.9,
    label: "松荫素裙",
    // 均 109.9 · 明亮
    base: [22, 30, 22],
    accent: [168, 190, 138],
    veil: 0.24,
    focus: "center 22%",
  },
  {
    file: "04-studio-rose",
    lum: 117.2,
    label: "静室玫瑰",
    // 均 117.2 · P50 154.1 已偏亮
    base: [34, 24, 24],
    accent: [226, 172, 152],
    veil: 0.18,
    focus: "center 24%",
  },
  {
    file: "06-butterfly-mauve",
    lum: 127.7,
    label: "蝶与薄雾",
    // 均 127.7 · P50 147.5
    base: [32, 26, 30],
    accent: [212, 186, 196],
    veil: 0.14,
    focus: "center 22%",
  },
  {
    file: "10-new-singer",
    lum: 158.7,
    label: "晨光初上",
    // 均 158.7 · P50 167.5 —— 全场最亮（户外明亮场景）
    base: [30, 28, 26],
    accent: [214, 170, 176],
    veil: 0.10,
    focus: "center 26%",
  },

];

/**
 * 每对相邻锚点之间几张过渡帧。
 * 目前设为 0：只用九张原图，档位之间直接切换。
 * 想启用过渡帧时改成 3，并自行准备 assets/transitions/ 下的中间态图片。
 */
const TRANSITIONS_PER_GAP = 0;

/** 资源地址前缀，安装时由 client.js 注入实际值。 */
let assetPrefix = "/plugins/dsh-photo-skin/assets/";

function setAssetPrefix(prefix) {
  assetPrefix = prefix;
}

const anchorUrl = (name) => `${assetPrefix}${name}.webp`;
const transitionUrl = (gap, step) =>
  `${assetPrefix}transitions/${`t${String(gap).padStart(2, "0")}-${step}`}.webp`;

/**
 * 展开成完整的帧序列。
 *
 * @param {boolean} progressive 是否插入过渡帧
 */
function buildFrames(progressive) {
  const frames = [];
  IMAGES.forEach((image, index) => {
    frames.push({
      url: anchorUrl(image.file),
      focus: image.focus,
      anchorIndex: index,
      tone: { base: image.base, accent: image.accent, veil: image.veil, lum: image.lum },
    });

    if (!progressive || index === IMAGES.length - 1) return;
    const next = IMAGES[index + 1];
    for (let step = 1; step <= TRANSITIONS_PER_GAP; step += 1) {
      const t = step / (TRANSITIONS_PER_GAP + 1);
      frames.push({
        url: transitionUrl(index, step),
        focus: lerpFocus(image.focus, next.focus, t),
        anchorIndex: index,
        tone: {
          base: mixRgb(image.base, next.base, t),
          accent: mixRgb(image.accent, next.accent, t),
          veil: image.veil + (next.veil - image.veil) * t,
          lum: image.lum + (next.lum - image.lum) * t,
        },
      });
    }
  });
  return frames;
}

const mixRgb = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/** background-position 的百分比插值：只处理 "center NN%" 这种形式。 */
function lerpFocus(from, to, t) {
  const pattern = /^center\s+(\d+(?:\.\d+)?)%$/;
  const a = pattern.exec(from);
  const b = pattern.exec(to);
  if (a === null || b === null) return from;
  const y = Number(a[1]) + (Number(b[1]) - Number(a[1])) * t;
  return `center ${y.toFixed(1)}%`;
}

/** 当前生效的帧序列。presenter 与 slider 共用同一份。 */
let activeFrames = buildFrames(true);

/** 重新计算帧序列（切换「过渡帧」开关时调用）。 */
function useProgressive(progressive) {
  activeFrames = buildFrames(progressive);
  return activeFrames;
}

/** 帧号(0..MAX_FRAME) -> 具体的帧。 */
function frameSpec(frame) {
  if (activeFrames.length === 0) return null;
  const index = Math.min(
    activeFrames.length - 1,
    Math.max(0, Math.round((frame / MAX_FRAME) * (activeFrames.length - 1))),
  );
  return activeFrames[index];
}

/** 帧号 -> 插值后的情绪参数（配色用，比 frameSpec 更连续）。 */
function toneAt(frame) {
  const frames = activeFrames;
  if (frames.length === 0) return { base: [20, 20, 26], accent: [200, 200, 220], veil: 0.4, lum: 60 };
  const scaled = (frame / MAX_FRAME) * (frames.length - 1);
  const from = Math.min(frames.length - 1, Math.floor(scaled));
  const to = Math.min(frames.length - 1, from + 1);
  const t = scaled - from;
  const a = frames[from].tone;
  const b = frames[to].tone;
  return {
    base: mixRgb(a.base, b.base, t),
    accent: mixRgb(a.accent, b.accent, t),
    veil: a.veil + (b.veil - a.veil) * t,
    lum: (a.lum ?? 60) + ((b.lum ?? 60) - (a.lum ?? 60)) * t,
  };
}

/** 方便 presenter 预加载：所有会出现的文件地址。 */
function activeFrameUrls() {
  return activeFrames.map((frame) => frame.url);
}

/* ── src/store.js ── */
/**
 * dsh-photo-skin —— 偏好存储。
 *
 * 参照「滑动变祖」的做法：一个带版本号的 localStorage 记录 + 订阅通知，
 * 设置页和滑块都从同一个快照渲染，跨标签页时靠 storage 事件同步。
 *
 * 与它不同的是：本插件的设置只影响外观，不涉及任何模型状态。
 */


const STORAGE_KEY = "dsh-photo-skin.settings.v1";

/** 所有可持久化的布尔开关。 */
const PERSISTENT_KEYS = [
  "enabled", // 总开关
  "bindEffort", // 滑块同时改模型思考档位
  "fineStops", // 细分：停在 9 个锚点而不是模型档位
  "hideSlider", // 隐藏输入框旁的滑块
  "grain", // 颗粒质感
  "particles", // 星尘粒子
  "motion", // 空闲淡化
  "mask", // 背景遮罩（对标滑动变祖）
  "takeoverLiang", // 与滑动变祖互斥
];

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  bindEffort: true,
  fineStops: true,
  hideSlider: false,
  grain: true,
  particles: true,
  motion: true,
  mask: true,
  takeoverLiang: true,
  /** 上次的强度（0..240）；null = 还没设过，跟随模型档位。 */
  frame: null,
  /**
   * 每个推理档位上次停在哪张图：{ [档位 id]: 帧号 }。
   * 从模型菜单换档时回到那一档上次选的图，而不是区间中点。
   */
  tierFrames: Object.freeze({}),
});

/** 校验 tierFrames；不合法的项丢掉，整体不是对象时返回 null。 */
function cleanTierFrames(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [id, frame] of Object.entries(value)) {
    if (typeof frame === "number" && Number.isFinite(frame) && frame >= 0 && frame <= MAX_FRAME) {
      out[id] = Math.round(frame);
    }
  }
  return out;
}

function getStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 解析持久化记录；任何异常都退化成 null（用默认值）。 */
function parse(raw) {
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw);
    if (
      record === null ||
      typeof record !== "object" ||
      record.version !== 1 ||
      record.values === null ||
      typeof record.values !== "object"
    ) {
      return null;
    }
    const result = { ...DEFAULT_SETTINGS };
    for (const key of PERSISTENT_KEYS) {
      if (typeof record.values[key] === "boolean") result[key] = record.values[key];
    }
    /*
     * frame 是当前强度（0..240），单独校验：必须是有限数字且落在合法范围。
     * 它不是布尔开关，所以不在 PERSISTENT_KEYS 里。
     * 传 null 表示"用户还没手动设过"，由滑块按当前模型档位推导。
     */
    const storedFrame = record.values.frame;
    if (
      typeof storedFrame === "number" &&
      Number.isFinite(storedFrame) &&
      storedFrame >= 0 &&
      storedFrame <= MAX_FRAME
    ) {
      result.frame = Math.round(storedFrame);
    }
    const tierFrames = cleanTierFrames(record.values.tierFrames);
    if (tierFrames !== null) result.tierFrames = tierFrames;
    return result;
  } catch {
    return null;
  }
}

/**
 * 创建偏好存储。返回值与 React 的 useSyncExternalStore 直接兼容。
 *
 * @param {{storage?: Storage|null}} [options]
 */
function createPreferenceStore(options = {}) {
  const storage = options.storage === undefined ? getStorage() : options.storage;
  let snapshot = parse(read(storage, STORAGE_KEY)) ?? { ...DEFAULT_SETTINGS };
  let disposed = false;
  const listeners = new Set();

  const emit = (patch) => {
    if (disposed) return;
    const changed = Object.entries(patch).some(([key, value]) => snapshot[key] !== value);
    if (!changed) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const onStorage = (event) => {
    if (disposed) return;
    if (event.storageArea != null && event.storageArea !== storage) return;
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    const next = parse(event.key === null ? read(storage, STORAGE_KEY) : event.newValue);
    emit(next ?? { ...DEFAULT_SETTINGS });
  };

  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);

  const persist = (values) => {
    if (storage === null) throw new Error("Local settings storage is unavailable");
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, values }));
  };

  /**
   * 写设置。布尔开关必须在白名单里；frame 单独按数字校验。
   * 提到 return 外面，这样 setFrame 也能直接调。
   */
  const update = async (patch) => {
    if (disposed) return;
    for (const [key, value] of Object.entries(patch)) {
      if (key === "frame") {
        if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
          throw new TypeError("Invalid photo-skin frame");
        }
        continue;
      }
      if (key === "tierFrames") {
        if (cleanTierFrames(value) === null) throw new TypeError("Invalid photo-skin tierFrames");
        continue;
      }
      if (!PERSISTENT_KEYS.includes(key) || typeof value !== "boolean") {
        throw new TypeError(`Invalid photo-skin setting: ${key}`);
      }
    }
    const changed = Object.entries(patch).some(([k, v]) => snapshot[k] !== v);
    if (!changed) return;
    const values = { ...snapshot, ...patch };
    persist(values);
    emit(patch);
  };

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    update,

    /** 只写强度（写 localStorage，不改动其它开关）。 */
    async setFrame(frame) {
      return update({ frame: frame === null ? null : Math.round(frame) });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    },
  };
}

/* ── src/effort.js ── */
/**
 * dsh-photo-skin（言宝）—— 推理等级绑定。
 *
 * 完全对标「滑动变祖」的档位模型：
 *   - 档位**不写死**，直接读当前模型的 `reasoning.efforts`；
 *   - N 个档位均匀落在 0..MAX_FRAME 的强度轴上；
 *   - 拖动期间只做视觉预览，松手 / 键盘操作完成 / 失焦时才提交最近档位；
 *   - 提交走官方 ModelDirectory，失败时回退到上一次真实档位。
 *
 * 与「言宝」视觉轴的关系：
 *   视觉轴有 9 个锚点，模型可能只有 4 个档位（例如 off/low/high/max）。
 *   所以「细分」开关决定滑块停在哪套格点上：
 *     细分开（默认）→ 停在 9 个锚点，提交最近档位（外观细腻，模型档位仍准）
 *     细分关        → 只停在模型档位上（严格一档对一档）
 */



/**
 * 九张图 → 四个推理档位的**分组权重**。
 *
 * 需求：off 管 1 张、low 管 2 张、high 管 3 张、max 管 3 张，
 * 图片顺序不动。这样「月下花影」正好落在 high（第 4 个锚点）。
 *
 * 为什么不用「N 档均匀铺满」：模型可能是 2/3/4/5 档，
 * 均匀铺会让每档覆盖的图片数量一样，无法表达"高档管更宽的区间"。
 * 所以改成按权重划分锚点归属。
 */
const EFFORT_WEIGHTS = Object.freeze({
  off: 1,
  low: 2,
  high: 3,
  max: 3,
});

/** 锚点总数从图片清单推导，改图数量时不用同步改这里。 */
const TOTAL_ANCHORS = IMAGES.length;

/**
 * 把锚点按权重分给各档位。
 *
 * @param {number} count 档位数量（模型实际给了几档）
 * @returns {Array<{start:number, end:number}>} 每个档位覆盖的锚点区间 [start, end]
 */
function anchorRanges(count) {
  if (count <= 0) return [];
  if (count === 1) return [{ start: 0, end: TOTAL_ANCHORS - 1 }];

  /*
   * 标准四档用 EFFORT_WEIGHTS 的权重（1/2/3/3），这是产品要求。
   * 非四档时按比例缩放权重，保持"高档管更宽"的形状。
   */
  const standard = [EFFORT_WEIGHTS.off, EFFORT_WEIGHTS.low, EFFORT_WEIGHTS.high, EFFORT_WEIGHTS.max];
  // 把 4 份权重映射到 count 份：少于 4 档就合并，多于 4 档就再切分
  const weights = [];
  if (count === 4) {
    weights.push(...standard);
  } else if (count < 4) {
    // 例：2 档 → off+low / high+max 合并
    const per = 4 / count;
    for (let i = 0; i < count; i += 1) {
      let w = 0;
      for (let k = Math.floor(i * per); k < Math.floor((i + 1) * per); k += 1) w += standard[k];
      weights.push(w);
    }
  } else {
    // 多于 4 档：标准权重基础上，把每档再按锚点数均分
    const extra = count - 4;
    for (let i = 0; i < 4; i += 1) {
      const split = i < extra ? 2 : 1;
      const each = standard[i] / split;
      for (let k = 0; k < split; k += 1) weights.push(each);
    }
  }

  /*
   * 档位数可能**多于锚点数**（某些模型给 10+ 档）。这时候必然有档位分不到
   * 独立的图，只能共享同一个锚点 —— 否则循环越界会算出 NaN，整个分组崩掉。
   * 处理：先把 9 个锚点铺满，剩下的档位复用最后一个锚点。
   */
  const slots = Math.min(count, TOTAL_ANCHORS);
  const ranges = [];
  let cursor = 0;
  for (let i = 0; i < slots; i += 1) {
    const remaining = slots - i;
    const left = TOTAL_ANCHORS - cursor;
    const ideal = (weights[i] / (weights.slice(0, slots).reduce((a, b) => a + b, 0) || 1)) * TOTAL_ANCHORS;
    let take = i === slots - 1 ? left : Math.round(ideal);
    // 每档至少 1 个锚点，且要留够后面的档位
    take = Math.max(1, Math.min(take, left - (remaining - 1)));
    ranges.push({ start: cursor, end: cursor + take - 1 });
    cursor += take;
  }
  // 档位多于锚点：剩余档位共享最后一个锚点
  for (let i = slots; i < count; i += 1) {
    ranges.push({ start: TOTAL_ANCHORS - 1, end: TOTAL_ANCHORS - 1 });
  }
  return ranges;
}

/**
 * 模型档位在强度轴上的位置（该档位区间的**中心**）。
 *
 * 刻度线画在这里，滑块吸到这里，两者用同一个函数算，天然对齐。
 */
function frameForEffort(index, count, ranges) {
  if (count <= 1 || !Number.isFinite(index)) return 0;
  const safe = Math.min(count - 1, Math.max(0, Math.round(index)));
  const r = (ranges ?? anchorRanges(count))[safe];
  if (r === undefined) return 0;
  // 区间的中点（以锚点格为单位）
  const mid = (r.start + r.end) / 2;
  return Math.round((mid / (TOTAL_ANCHORS - 1)) * MAX_FRAME);
}

/**
 * 档位区间最后一张图的帧号。
 * 细分模式下从模型菜单换到一个还没选过图的档位时停在这里（每档最亮的那张）。
 */
function lastFrameForEffort(index, count, ranges) {
  if (count <= 0 || !Number.isFinite(index)) return 0;
  const safe = Math.min(count - 1, Math.max(0, Math.round(index)));
  const r = (ranges ?? anchorRanges(count))[safe];
  if (r === undefined) return 0;
  return Math.round((r.end / (TOTAL_ANCHORS - 1)) * MAX_FRAME);
}

/** 帧号落在哪个档位区间里。 */
function effortIndexAt(frame, count, ranges) {
  const rs = ranges ?? anchorRanges(count);
  if (rs.length === 0) return -1;
  // 换算成锚点格
  const anchor = (clampFrame(frame) / MAX_FRAME) * (TOTAL_ANCHORS - 1);
  for (let i = 0; i < rs.length; i += 1) {
    // 相邻区间共享分界线：用中点判断归属
    const mid = (rs[i].start + rs[i].end) / 2;
    const next = i + 1 < rs.length ? (rs[i + 1].start + rs[i + 1].end) / 2 : Infinity;
    if (anchor < (mid + next) / 2) return i;
  }
  return rs.length - 1;
}

/**
 * 当前帧属于第几档。
 *
 * 注意：这里用**区间归属**而不是「离哪个刻度最近」。
 * 因为一个档位可能覆盖 3 张图（比如 max 管 6/7/8 三个锚点），
 * 用最近刻度的话滑到第 6 个锚点就会误判成 low。
 */
function nearestEffortIndex(frame, efforts) {
  if (efforts.length === 0) return -1;
  return effortIndexAt(frame, efforts.length);
}

/** 从模型状态里找出当前选中的是第几档。 */
function selectedEffortIndex(efforts, selectedId, defaultId) {
  const id = selectedId ?? defaultId;
  return id === undefined ? -1 : efforts.findIndex((effort) => effort.id === id);
}

/**
 * 从 ModelDirectory 的快照里读出当前模型与它的档位。
 *
 * 结构来自 @deepseek-ai/dsh-client-ui-model-selection：
 *   { current: {provider, model, reasoningEffort}, groups: [{id, models:[{id, reasoning:{efforts, defaultEffort}}]}] }
 *
 * @returns {null | {selection: object, efforts: Array<{id,name}>, defaultEffort?: string}}
 */
function modelReasoning(state) {
  const current = state?.current;
  if (current === null || current === undefined) return null;
  const group = state.groups?.find((item) => item.id === current.provider);
  const model = group?.models?.find((item) => item.id === current.model);
  const reasoning = model?.reasoning;
  if (reasoning === undefined || !Array.isArray(reasoning.efforts)) return null;
  return {
    selection: current,
    efforts: reasoning.efforts,
    defaultEffort: reasoning.defaultEffort,
  };
}

/**
 * 提交意图的去重器。
 *
 * 起因：提交后 ModelDirectory 的 store 会先进入 selecting、再给出新快照。
 * 如果不等提交落地就跟着外部快照走，滑块会在「用户拖到的位置」和
 * 「服务端还没确认的旧档位」之间来回弹一下。
 *
 * 所以记住最近一次提交的目标 key，等它真的出现在快照里再恢复同步。
 */
function createEffortSync() {
  let observedKey = null;
  let submitted = null;

  return {
    /** 记下这次要提交到哪个档位。 */
    submit(key) {
      submitted = key;
    },

    reset() {
      submitted = null;
    },

    /**
     * 看到一个外部快照。
     * @returns {number|null} 需要把滑块挪到的帧号；null 表示不用动
     */
    observe({ key, frame }) {
      if (submitted !== null) {
        if (submitted === key) {
          // 提交落地的快照回来了，恢复跟踪
          submitted = null;
          observedKey = key;
        }
        return null;
      }
      if (observedKey === key) return null;
      observedKey = key;
      return frame;
    },
  };
}

/** 滑块该吸到哪个帧：细分模式吸锚点，否则吸模型档位。 */
function snapTarget(frame, { efforts, fine }) {
  if (fine || efforts.length < 2) {
    // N 个锚点 = N-1 个间隔，均匀铺满 0..MAX_FRAME
    const gaps = TOTAL_ANCHORS - 1;
    return Math.round((clampFrame(frame) / MAX_FRAME) * gaps) * (MAX_FRAME / gaps);
  }
  return frameForEffort(nearestEffortIndex(frame, efforts), efforts.length);
}

/** tooltip 文案：档位名 + 模型档位名。 */
function indicatorLabel(frame, efforts, { withLevel }) {
  const gaps = TOTAL_ANCHORS - 1;
  const anchorIndex = Math.min(gaps, Math.round((clampFrame(frame) / MAX_FRAME) * gaps));
  const level = `${anchorIndex + 1}/${TOTAL_ANCHORS}`;
  const effort = efforts[nearestEffortIndex(frame, efforts)];
  const head = withLevel ? level : level;
  return effort === undefined ? head : `${head} · ${effort.name}`;
}

/* ── src/exclusive.js ── */
/**
 * dsh-photo-skin（言宝）—— 与「滑动变祖」的互斥。
 *
 * 为什么需要这一层
 * ────────────────
 * 两个插件都改同一批 --dsw-* 主题变量、都注册 conversation.input.right，
 * 同时开启会并排出现两个滑块、两套配色互相覆盖（实测：--ps-* 44 个
 * 与 --liang-* 21 个并存）。
 *
 * 关键坑（实测踩到的）
 * ──────────────────
 * 「滑动变祖」靠 window 的 storage 事件同步开关，但 **storage 事件只在
 * 其他文档里触发**。我们在同一个页面里写它的 localStorage 键，它收不到
 * 通知，仍然开着。
 *
 * 所以接管必须是两步：
 *   1. 写 localStorage 键（让它下次加载时不启用）；
 *   2. 手动派发一个 StorageEvent（让当前页面里的它立刻响应）。
 * 两步都做，才会当场撤掉。
 *
 * 反向保护
 * ────────
 * 如果用户先用言宝关掉了它、后来又在外面的窗口把它打开，本插件用
 * MutationObserver 盯着 body 的 data-liang-skin 属性，发现它又上线就
 * 再次接管。
 */

const LIANG_PACKAGE_ID = "dsh-client-liang-intensity-skin";
const LIANG_ENABLED_KEY = "dsh-liang-intensity-skin.enabled.v1";

/** 记录「这次是言宝关掉的它」，用来在言宝停用时恢复。 */
const TAKEOVER_MARK = "dsh-photo-skin.took-over-liang";

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 关掉「滑动变祖」。
 *
 * @param {{remember?: boolean}} [options]
 *   remember: 是否记下"原本是开着的"，供 restoreLiangSkin() 恢复。
 * @returns {boolean} 是否真的执行了关闭动作
 */
function disableLiangSkin(options = {}) {
  const { remember = true } = options;
  const storage = safeStorage();

  // 先看当前页面里的它到底开着没有（键可能是 0，但页面里还没响应）
  const liveOn = document.body.getAttribute("data-liang-skin") === "on";
  const keyOn = storage?.getItem(LIANG_ENABLED_KEY) !== "0";

  if (!liveOn && !keyOn) return false;

  /*
   * 只要这次是言宝把它从「开」改成「关」，就记下来，停用言宝时才能还回去。
   * 之前只在它已经显示在页面上时才记：言宝比它先加载时，键被写成 0
   * 却没有标记，停用言宝后它就永远关着。
   */
  if (remember && (liveOn || keyOn) && storage !== null) {
    storage.setItem(TAKEOVER_MARK, "1");
  }

  try {
    storage?.setItem(LIANG_ENABLED_KEY, "0");
  } catch {
    // 隐私模式：键写不进去，下面的事件仍然能让它当场撤掉
  }

  /*
   * 手动派发 StorageEvent —— 这是同文档接管的关键。
   * 注意：这是"伪造"的事件，但它与浏览器真实派发的事件结构一致，
   * 对方只看 key / newValue / storageArea，所以能正确响应。
   * 派发失败（旧浏览器不支持 StorageEvent 构造）时退化为只写键，
   * 效果是刷新后才生效。
   */
  try {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: LIANG_ENABLED_KEY,
        oldValue: "1",
        newValue: "0",
        storageArea: storage ?? undefined,
        url: location.href,
      }),
    );
  } catch {
    // 忽略：刷新后仍然生效
  }

  return true;
}

/**
 * 恢复「滑动变祖」原来的状态。
 * 只在"是言宝关掉的"情况下恢复，绝不擅自打开用户自己关掉的皮肤。
 */
function restoreLiangSkin() {
  const storage = safeStorage();
  if (storage === null) return;
  if (storage.getItem(TAKEOVER_MARK) !== "1") return;

  try {
    storage.setItem(LIANG_ENABLED_KEY, "1");
  } catch {
    return;
  }
  storage.removeItem(TAKEOVER_MARK);

  try {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: LIANG_ENABLED_KEY,
        oldValue: "0",
        newValue: "1",
        storageArea: storage,
        url: location.href,
      }),
    );
  } catch {
    // 忽略
  }
}

/** 「滑动变祖」当前是否在页面上活着。 */
function liangSkinLive() {
  return (
    document.body.getAttribute("data-liang-skin") === "on" ||
    document.querySelector(".liang-skin-backdrop") !== null
  );
}

/**
 * 安装互斥。
 *
 * 三个触发点，缺一个就会出现"开关点了没反应"：
 *   1. 安装时评估一次（插件启动就接管）；
 *   2. **设置变化时重新评估**（用户在设置页拨开关）—— 之前漏了这一步，
 *      所以关掉再打开「与滑动变祖互斥」不会有任何效果；
 *   3. DOM 变化时兜底（对方被别处重新打开）。
 *
 * @param {() => object} getSettings 读取当前设置快照
 * @param {object} scope 偏好存储，用来订阅设置变化
 * @returns {() => void} 卸载函数
 */
function installExclusivity(getSettings, scope) {
  /** 当前是否处于「言宝接管」状态。 */
  const shouldTakeOver = () => {
    const settings = getSettings();
    return settings.enabled && settings.takeoverLiang;
  };

  /** 设置驱动的评估：开启则接管。 */
  const evaluate = () => {
    if (!shouldTakeOver()) return;
    // remember 只在本轮尚未接管过时才记，避免反复覆盖原始状态
    const storage = safeStorage();
    const already = storage?.getItem(TAKEOVER_MARK) === "1";
    disableLiangSkin({ remember: !already });
  };

  const observer = new MutationObserver(() => {
    if (!shouldTakeOver()) return;
    // 它又上线了 → 立刻再接管一次（不重复记标记）
    if (liangSkinLive()) {
      disableLiangSkin({ remember: false });
    }
  });

  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["data-liang-skin"],
  });

  // 订阅设置：用户拨动「与滑动变祖互斥」或「启用言宝」时立刻生效
  const unsubscribe = scope?.subscribe?.(evaluate) ?? (() => {});

  // 首次评估
  evaluate();

  return () => {
    observer.disconnect();
    unsubscribe();
  };
}

/* ── src/stardust.js ── */
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
function createStardust(options = {}) {
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

/* ── src/motion.js ── */
/**
 * dsh-photo-skin（言宝）—— 空闲淡化。
 *
 * 对标「滑动变祖」的 motion 系统：照片在三种状态下有不同的存在感。
 *
 *   idle     模型闲着     → 照片淡下去，把注意力让给界面
 *   running  模型正在跑   → 提亮，人物回到画面里
 *   preview  正在拖滑块   → 全亮，同时阅读衬底临时变淡，方便看清当前这张
 *
 * 透明度沿用它的 PRESETS（0.32 / 0.69 / 1），这也是用户确认喜欢的那一版。
 *
 * 和滑动变祖的差异：
 *   - 它的人物是右侧一块羽化过边缘的图，缩到 0.9 像「往后退」；
 *     本皮肤是满屏照片，缩小会在四周露出一圈底色，所以**不缩放**。
 *   - 淡化作用在包住两层照片的 .ps-stage 上，而不是照片层本身。
 *     照片层只负责换图的交叉淡入（260ms），舞台层只负责淡化（1400ms），
 *     两套时长互不干扰。之前两者共用照片层的 opacity，
 *     换图时新层 1400ms 淡入、旧层 260ms 淡出，照片会掉到 7% 闪一下。
 */

/**
 * 三态预设：只有舞台层的透明度。
 *
 * 不再用 brightness / saturate 滤镜：那一版在遮罩之下只改变屏幕亮度 1–4%，
 * 肉眼看不出来。
 */
const MOTION_PRESETS = Object.freeze({
  idle: Object.freeze({ opacity: "0.32" }),
  running: Object.freeze({ opacity: "0.69" }),
  preview: Object.freeze({ opacity: "1" }),
});

/** 判断当前该是哪个状态。preview 优先级最高。 */
function motionState({ dragging, running }) {
  if (dragging) return "preview";
  if (running) return "running";
  return "idle";
}

/**
 * 把状态写到 DOM 上。
 *
 * @param {HTMLElement|null} root #photo-skin-layer
 * @param {"idle"|"running"|"preview"} state
 * @param {boolean} enabled 是否启用动效
 */
function applyMotionState(root, state, enabled) {
  if (root === null) return;
  /*
   * 关闭时把开关摘掉即可 —— CSS 里所有动效规则都限定在
   * [data-motion="on"] 下，摘掉后原始样式原样生效，一个像素都不动。
   */
  if (!enabled) {
    root.dataset.motion = "off";
    root.removeAttribute("data-motion-state");
    root.style.removeProperty("--ps-motion-opacity");
    return;
  }
  const preset = MOTION_PRESETS[state] ?? MOTION_PRESETS.idle;
  root.dataset.motion = "on";
  root.dataset.motionState = state;
  root.style.setProperty("--ps-motion-opacity", preset.opacity);
}

/**
 * 创建动效控制器：订阅「模型是否在跑」与「是否在拖滑块」，
 * 合并成一个状态再写进 DOM。
 *
 * @param {object} deps
 * @param {() => boolean} deps.isRunning 模型是否在运行
 * @param {() => boolean} deps.isDragging 是否正在拖滑块
 * @returns {object}
 */
function createMotionController({ isRunning, isDragging }) {
  let enabled = true;
  let root = null;
  let state = "idle";
  let raf = null;

  const sync = () => {
    state = motionState({ dragging: isDragging(), running: isRunning() });
    applyMotionState(root, state, enabled);
  };

  /*
   * 用 rAF 合并连续变化：模型运行状态可能在很短时间内反复切换，
   * 每次都同步写 DOM 会造成 layout thrash。一帧只写一次。
   */
  const schedule = () => {
    if (raf !== null) return;
    raf = globalThis.requestAnimationFrame(() => {
      raf = null;
      sync();
    });
  };

  return {
    attach(nextRoot) {
      root = nextRoot;
      sync();
    },
    detach() {
      root = null;
    },
    setEnabled(next) {
      enabled = Boolean(next);
      sync();
    },
    /** 外部状态变化时调用，内部会合并到下一帧。 */
    update: schedule,
    /** 立刻同步一次（首次挂载时用）。 */
    flush: sync,
    getState: () => state,
    dispose() {
      if (raf !== null) {
        globalThis.cancelAnimationFrame(raf);
        raf = null;
      }
      root = null;
    },
  };
}

/* ── src/presenter.js ── */
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





class SkinPresenter {
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

/* ── src/slider.js ── */
/**
 * dsh-photo-skin（言宝）—— 输入框右侧的强度滑块。
 *
 * 完全对标「滑动变祖」的交互：
 *   - 拖动时只做视觉预览，不提交；
 *   - 松手 / 键盘操作完成 / 失焦时吸附并提交最近档位；
 *   - Escape 取消，回到拖动前的位置；
 *   - tooltip 显示当前档位；
 *   - 绑定关闭时滑块只调外观，不提交任何模型状态。
 */




const ANCHOR_COUNT = IMAGES.length; // 9

/** 会改变 range 值的按键。 */
const SLIDER_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End",
]);

function createSliderComponent(React) {
  const { useState, useRef, useEffect, useCallback } = React;

  return function YanbaoSlider({
    directory,
    load,
    select,
    presenter,
    scope,
    available,
    session,
  }) {
    const state = React.useSyncExternalStore(
      (listener) => directory.subscribe(listener),
      () => directory.getSnapshot(),
    );
    const skin = React.useSyncExternalStore(
      (listener) => scope.subscribe(listener),
      () => scope.getSnapshot(),
    );

    /*
     * 模型是否在运行 —— 驱动空闲淡化。
     *
     * 必须在组件里用 useSyncExternalStore 订阅（和滑动变祖的
     * useSessionRunning 完全一致）。早期把它写在插槽的 inject()
     * 里做一次性订阅，那个回调不跟 React 生命周期走，
     * running 变化后从未真正触发过，所以"空闲淡化没效果"。
     */
    const running = React.useSyncExternalStore(
      (listener) => session?.subscribe(listener) ?? (() => {}),
      () => session?.getSnapshot()?.running === true,
    );

    const reasoning = React.useMemo(() => modelReasoning(state), [state]);
    const efforts = reasoning?.efforts ?? [];
    // 档位 → 锚点区间。刻度位置、滑块吸附、提交判定全部基于它，
    // 三处用同一个来源，才不会出现"滑块和竖线对不上"。
    const ranges = React.useMemo(() => anchorRanges(efforts.length), [efforts.length]);

    const committedIndex = selectedEffortIndex(
      efforts,
      reasoning?.selection?.reasoningEffort,
      reasoning?.defaultEffort,
    );
    const bindEffort = skin.bindEffort;
    const fine = bindEffort && skin.fineStops;
    /*
     * 某一档该停在哪张图。
     *   细分模式：这一档上次选的那张；没选过就停在这一档的最后一张。
     *   非细分模式：档位区间中点（滑块只停在档位刻度上）。
     * 之前一律取中点：从模型菜单换档后，3 张图的档位会停在中间那张。
     */
    const tierFrames = skin.tierFrames ?? {};
    const tierFrame = (index) => {
      if (index < 0) return 0;
      if (!fine) return frameForEffort(index, efforts.length, ranges);
      const remembered = tierFrames[efforts[index]?.id];
      if (typeof remembered === "number" && effortIndexAt(remembered, efforts.length, ranges) === index) {
        return remembered;
      }
      return lastFrameForEffort(index, efforts.length, ranges);
    };
    // 模型没给档位时，外观仍可独立工作
    const effortFrame = tierFrame(committedIndex);
    const committedFrame = bindEffort ? effortFrame : Math.max(0, presenter.getFrame());

    const modelKey = JSON.stringify([
      reasoning?.selection?.provider,
      reasoning?.selection?.model,
      efforts.map((effort) => effort.id),
    ]);
    const selectionKey = JSON.stringify([modelKey, efforts[committedIndex]?.id ?? null]);
    const modeKey = JSON.stringify([modelKey, bindEffort, fine]);

    const sync = useRef(createEffortSync());
    const latest = useRef({ committedFrame, committedIndex });
    latest.current = { committedFrame, committedIndex };

    /*
     * 初始帧：优先用上次保存的位置（settings.frame）。
     * 这样即使模型档位没变，用户上次停在 max 组里的第 9 张，重开还是第 9 张，
     * 而不是被拉到档位区间的中点。
     */
    const [frame, setFrame] = useState(() => {
      const saved = skin.frame;
      return typeof saved === "number" ? saved : committedFrame;
    });
    const [pending, setPending] = useState(false);
    const [failed, setFailed] = useState(false);
    const [interacting, setInteracting] = useState(false);
    const dragging = useRef(false);
    const dragStart = useRef(frame);
    const dragStartSelection = useRef(selectionKey);

    const enabled = skin.enabled && available;

    const cancel = useCallback(() => {
      setInteracting(false);
      dragging.current = false;
      presenter.setDragging(false);
      // 拖动期间模型可能被别处改了，这种情况下要跟新的真实档位
      const externalChange = bindEffort && dragStartSelection.current !== selectionKey;
      if (externalChange) {
        sync.current.reset();
        sync.current.observe({ key: selectionKey, frame: committedFrame });
      }
      const restored = externalChange ? committedFrame : dragStart.current;
      setFrame(restored);
      presenter.setFrame(restored);
    }, [bindEffort, selectionKey, committedFrame, presenter]);

    // 隐藏滑块时取消进行中的交互
    useEffect(() => {
      if (!skin.hideSlider) return;
      if (dragging.current) cancel();
      else setInteracting(false);
    }, [skin.hideSlider, cancel]);

    // 首次渲染时让目录加载一次
    useEffect(() => {
      if (enabled) load();
    }, [enabled, load]);

    /*
     * 把 running 推给背景层。卸载时复位，避免插件停用后
     * 照片一直停在 running 状态。
     */
    useEffect(() => {
      if (!available) return undefined;
      presenter.setRunning(running);
      return () => presenter.setRunning(false);
    }, [presenter, running, available]);

    // 拖到一半被卸载（切会话、隐藏滑块）时，别让照片一直停在全亮
    useEffect(() => (available ? () => presenter.setDragging(false) : undefined), [presenter, available]);

    // 跟随外部档位变化（用户在模型菜单里改了档位）
    useEffect(() => {
      if (!enabled || !bindEffort || dragging.current || pending || state.status === "selecting") return;
      const next = sync.current.observe({ key: selectionKey, frame: committedFrame });
      if (next === null) return;
      /*
       * 档位变了要跟随，但如果用户当前停在的位置**仍属于新档位**，
       * 就不要把他拽到区间中点 —— 那正是"回到第 8 档"的根源。
       */
      const saved = skin.frame;
      const keep =
        typeof saved === "number" &&
        effortIndexAt(saved, efforts.length, ranges) === committedIndex;
      const target = keep ? saved : next;
      setFrame(target);
      presenter.setFrame(target);
      /*
       * 跟随后的位置也要记住。之前只改了画面：在模型菜单里换档后，
       * 随便拨一下设置（或停用再启用），背景就会跳回旧档位的那张图，
       * 滑块却还停在新档位。模型档位还没加载出来时不写，免得记成 0。
       */
      if (efforts.length > 0 && saved !== target) void scope.setFrame(target).catch(() => undefined);
    }, [enabled, bindEffort, committedFrame, selectionKey, modeKey, pending, state.status, presenter]);

    /*
     * 跟随**别处**写入的强度（设置页的滑块）。
     *
     * 设置页也有一条强度滑块，它会把值写进同一个 scope。如果没有这个
     * effect，那个值只会反映在当时那幅画面上 —— 输入框旁的这条滑块
     * 仍停在旧位置，两边显示不一致。
     *
     * 三个条件必须同时满足才跟随，否则会打断用户正在进行的拖动：
     *   - 没在拖（dragging.current 为 false）
     *   - 没在提交（pending 为 false）
     *   - 外部值和当前值确实不同
     */
    useEffect(() => {
      if (dragging.current || pending) return;
      const saved = skin.frame;
      if (typeof saved !== "number" || saved === frame) return;
      setFrame(saved);
      presenter.setFrame(saved);
    }, [skin.frame, pending, presenter]);

    /*
     * 记住每一档最后停在哪张图（细分模式）。
     * 位置一保存（拖动松手、键盘、设置页滑块、跟随模型菜单）就记到它所在的档位下，
     * 之后从模型菜单换回这一档时回到这张。
     */
    useEffect(() => {
      if (!fine || efforts.length === 0) return;
      const saved = skin.frame;
      if (typeof saved !== "number") return;
      const id = efforts[effortIndexAt(saved, efforts.length, ranges)]?.id;
      if (id === undefined || tierFrames[id] === saved) return;
      void scope.update({ tierFrames: { ...tierFrames, [id]: saved } }).catch(() => undefined);
    }, [fine, skin.frame, modelKey, tierFrames, scope]);

    if (!enabled || skin.hideSlider) return null;
    // 绑定模式下，没有推理能力或只有一个档位的模型不显示滑块
    if (bindEffort && (reasoning === null || efforts.length < 2)) return null;

    const previewIndex = nearestEffortIndex(frame, efforts);
    const previewEffort = efforts[previewIndex];
    const level = levelForFrame(frame);
    const anchorLabel = IMAGES[Math.min(ANCHOR_COUNT - 1, level)]?.label ?? "";

    const label = bindEffort
      ? `${anchorLabel}${previewEffort ? ` · ${previewEffort.name}` : ""}`
      : anchorLabel;

    /** 非细分模式下，把任意帧吸到最近的模型档位。 */
    const effortFrameFor = (rawFrame) =>
      frameForEffort(nearestEffortIndex(rawFrame, efforts), efforts.length, ranges);

    const commit = async (rawFrame) => {
      // 细分模式吸附到 9 个锚点；未绑定也吸锚点；只有严格绑定才吸模型档位
      const targetFrame =
        fine || !bindEffort ? snapFrame(rawFrame) : effortFrameFor(rawFrame);
      dragging.current = false;
      setInteracting(false);
      setFrame(targetFrame);
      presenter.setFrame(targetFrame);
      /* 记住位置：下次打开能回到同一张 */
      void scope.setFrame(targetFrame).catch(() => undefined);

      if (!bindEffort) return;

      const targetIndex = nearestEffortIndex(rawFrame, efforts);
      const target = efforts[targetIndex];
      if (target === undefined) return;
      if (targetIndex === committedIndex || pending) return;

      const targetKey = JSON.stringify([modelKey, target.id]);
      sync.current.submit(targetKey);
      setPending(true);
      setFailed(false);

      const selection = reasoning?.selection;
      if (selection === undefined || selection === null) return;
      const accepted = await select({
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: target.id,
      });

      setPending(false);
      if (!accepted) {
        /*
         * 模型没换成（DSH 的 selectModel 报错：模型不可用、会话不存在、连接断开等）：
         * 回到拖动前的那张图；那张图已经不属于当前档位时，退回档位中点。
         * 保存的位置也要一起改回去，否则下次渲染又会被拉回失败的那一档。
         */
        sync.current.reset();
        setFailed(true);
        const { committedFrame: fallback, committedIndex: index } = latest.current;
        const start = dragStart.current;
        const restored = effortIndexAt(start, efforts.length, ranges) === index ? start : fallback;
        setFrame(restored);
        presenter.setFrame(restored);
        void scope.setFrame(restored).catch(() => undefined);
      }
    };

    return React.createElement(
      "div",
      {
        className: "ps-effort-control",
        "data-plugin": "dsh-photo-skin",
        "data-state": failed ? "error" : pending ? "pending" : "ready",
        title: label,
      },

      interacting &&
        React.createElement(
          "output",
          {
            className: "ps-effort-control__tooltip",
            style: { "--ps-slider-ratio": frame / MAX_FRAME },
          },
          indicatorLabel(frame, bindEffort ? efforts : [], { withLevel: fine }),
        ),

      React.createElement(
        "div",
        { className: "ps-effort-control__ticks", "aria-hidden": "true" },
        // 刻度只画一套：
        //   细分 / 未绑定 → 9 个锚点（均匀，一眼看出九档）
        //   严格绑定     → 模型档位（有几档画几档，不叠加）
        !fine && bindEffort
          ? efforts.map((effort, index) =>
              React.createElement("i", {
                key: effort.id,
                className: "ps-effort-control__tick",
                style: { left: `${(frameForEffort(index, efforts.length, ranges) / MAX_FRAME) * 100}%` },
              }),
            )
          : Array.from({ length: ANCHOR_COUNT }, (_, i) =>
              React.createElement("i", {
                key: `anchor-${i}`,
                className: "ps-effort-control__tick",
                style: { left: `${(frameForLevel(i) / MAX_FRAME) * 100}%` },
              }),
            ),
      ),

      React.createElement("input", {
        className: "ps-effort-control__range",
        type: "range",
        min: 0,
        max: MAX_FRAME,
        // 细分模式吸附到锚点：9 个点 = 8 个间隔，每格 30 帧，正好落满 0..240
        step: fine ? MAX_FRAME / (ANCHOR_COUNT - 1) : 1,
        value: frame,
        disabled: pending || state.status === "selecting",
        "aria-label": bindEffort ? "言宝强度与思考档位" : "言宝强度",
        "aria-valuetext": bindEffort && previewEffort ? `${anchorLabel}，${previewEffort.name}` : anchorLabel,

        onPointerDown: () => {
          dragging.current = true;
          dragStart.current = frame;
          dragStartSelection.current = selectionKey;
          setInteracting(true);
          // 拖动期间照片全亮（对标滑动变祖的 preview 状态）
          presenter.setDragging(true);
        },
        onInput: (event) => {
          dragging.current = true;
          const next = clampFrame(Number(event.currentTarget.value));
          setFrame(next);
          presenter.setFrame(next);
        },
        onPointerUp: (event) => {
          presenter.setDragging(false);
          void commit(Number(event.currentTarget.value));
        },
        onPointerCancel: cancel,
        onKeyUp: (event) => {
          setInteracting(false);
          presenter.setDragging(false);
          /*
           * 只有真的改了值的键才提交。之前任何键（除 Escape）都会提交：
           * 从输入框按 Tab 聚焦到滑块，Tab 的 keyup 落在滑块上，
           * 没拖动就把模型档位换掉了。
           */
          if (SLIDER_KEYS.has(event.key)) void commit(Number(event.currentTarget.value));
        },
        onBlur: (event) => {
          setInteracting(false);
          presenter.setDragging(false);
          if (dragging.current) void commit(Number(event.currentTarget.value));
        },
        onKeyDown: (event) => {
          if (!dragging.current) {
            dragStart.current = frame;
            dragStartSelection.current = selectionKey;
          }
          setInteracting(true);
          /*
           * 键盘调档也算预览（对标滑动变祖）。只认会改值的键，
           * Tab 离开时不该闪一下全亮。之前键盘路径一直停在空闲态，
           * 每按一次方向键都换一次图、闪一下。
           */
          if (SLIDER_KEYS.has(event.key)) presenter.setDragging(true);
          if (event.key === "Escape" && !pending) {
            event.preventDefault();
            cancel();
          }
        },
      }),
    );
  };
}

/* ── src/settings.js ── */
/**
 * dsh-photo-skin —— 设置面板。
 *
 * 一套组件挂两个入口（与「滑动变祖」相同的做法）：
 *   - settings.section        → 设置 → 言宝
 *   - plugins.bundle.config   → 侧栏 插件 → 言宝
 *
 * 所有开关即时生效并写入 localStorage，没有「保存」按钮。
 */


function createSettingsPanel(React, scope, presenter) {
  const { useState, useEffect, useRef } = React;

  /*
   * 自带的开关组件。
   *
   * 为什么不用 @deepseek-ai/dsh-client-ui-primitives 的 Switch：
   * DSH 的插件开发规范明确要求「不要 require 任何 Harness Client 包」——
   * 这类包随时可能改名或改签名，普通 JS 插件没有类型检查兜底，
   * 一旦它的导出变了，整个 slot 条目会崩掉（rc.5 实测就是这么挂的）。
   * `dsh.client.inject` 里的条目只用于**排序激活**，不保证运行时可 require。
   *
   * 所以这里自写一个：保留用户依赖的 role="switch" + aria-checked 语义，
   * 样式只用 --dsw-alias-* 主题 token。
   */
  function Switch({ checked, disabled, label, onChange }) {
    return React.createElement(
      "button",
      {
        type: "button",
        role: "switch",
        "aria-checked": checked ? "true" : "false",
        "aria-label": label,
        disabled,
        className: "ps-switch",
        "data-checked": checked ? "true" : "false",
        onClick: () => onChange(!checked),
      },
      React.createElement("span", { className: "ps-switch__thumb" }),
    );
  }

  /** 每一行开关。 */
  const ROWS = [
    {
      group: "外观",
      key: "enabled",
      title: "启用言宝",
      description: "关闭后移除背景与配色、滑块和开关，插件本身仍然装在这里，随时可以再打开。",
    },
    {
      group: "外观",
      key: "mask",
      title: "背景遮罩",
      description:
        "压住照片的亮度以保证文字清晰。关掉后人物原样呈现 —— 想要照片最清楚就关它，但亮图上的字可能变难读。",
    },
    {
      group: "外观",
      key: "grain",
      title: "颗粒质感",
      description: "在照片上叠一层极细的胶片颗粒，压掉数码感。",
    },
    {
      group: "外观",
      key: "particles",
      title: "星尘粒子",
      description: "在人物背景上浮起细小的光点，随强度变密。开了「减少动态效果」会自动关闭。",
    },
    {
      group: "外观",
      key: "motion",
      title: "空闲时淡化",
      description:
        "模型闲着时照片淡下去，把注意力让给界面；模型一开工就提亮回来。拖滑块时照片全亮，文字衬底也临时变淡，方便看清人物。",
    },
    {
      group: "强度轴",
      key: "bindEffort",
      title: "绑定思考等级",
      description:
        "开启后滑块同时修改模型的思考档位（松手时才提交）。关闭则只调外观，不碰模型设置。",
    },
    {
      group: "强度轴",
      key: "fineStops",
      title: "细分停点",
      description:
        "开启后滑块可以停在九个锚点上（外观更细腻），提交时仍取最近的模型档位；关闭则只停在模型档位上。",
    },
    {
      group: "强度轴",
      key: "hideSlider",
      title: "隐藏输入框旁的滑块",
      description: "隐藏后仍然可以用设置页里的滑块调整强度。",
    },
    {
      group: "共存",
      key: "takeoverLiang",
      title: "与「滑动变祖」互斥",
      description:
        "开启时，本皮肤启用会自动把「滑动变祖」的开关关掉，避免两个滑块并排、两套配色打架。关闭后需要你手动停用其中一个。",
    },
  ];

  return function PhotoSkinSettings(props) {
    const snapshot = React.useSyncExternalStore(
      (listener) => scope.subscribe(listener),
      () => scope.getSnapshot(),
    );
    const [pending, setPending] = useState(false);
    const [failed, setFailed] = useState(false);
    const [frame, setFrameState] = useState(() => Math.max(0, presenter.getFrame()));
    const busy = useRef(false);
    const mounted = useRef(true);

    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);

    const change = async (key, value) => {
      if (busy.current || !mounted.current) return;
      busy.current = true;
      setPending(true);
      setFailed(false);
      try {
        await scope.update({ [key]: value });
      } catch {
        if (mounted.current) setFailed(true);
      } finally {
        busy.current = false;
        if (mounted.current) setPending(false);
      }
    };

    /*
     * 拖动设置页的强度滑块。
     *
     * 必须同时写进 scope —— 只调 presenter.setFrame() 的话，
     * 这个位置只是"眼前的画面"，没有被持久化。一旦输入框旁的滑块
     * 重新渲染（切窗口、换会话都会触发），它会读到旧的 skin.frame
     * 并把画面拽回去，看起来就像"设置被还原了"。
     */
    const onSlide = (value) => {
      const next = Number(value);
      setFrameState(next);
      presenter.setFrame(next);
      void scope.setFrame(next).catch(() => undefined);
    };

    const groups = [...new Set(ROWS.map((row) => row.group))];

    return React.createElement(
      "div",
      { className: "ps-settings-panel" },

      // 强度预览
      React.createElement(
        "section",
        { className: "ps-settings-panel__group", "aria-label": "强度" },
        React.createElement("h3", { className: "ps-settings-panel__heading" }, "强度"),
        React.createElement(
          "div",
          { className: "ps-settings-panel__preview" },
          React.createElement("input", {
            className: "ps-settings-panel__range",
            type: "range",
            min: 0,
            max: 240,
            step: 1,
            value: frame,
            "aria-label": "皮肤强度",
            onInput: (event) => onSlide(event.currentTarget.value),
          }),
          React.createElement(
            "div",
            { className: "ps-settings-panel__legend" },
            React.createElement("span", null, IMAGES[0].label),
            React.createElement(
              "span",
              { className: "ps-settings-panel__legend-current" },
              /*
 * 帧 → 锚点索引。必须除以 (length - 1)：
 * 九张图对应 8 个间隔，除以 9 会让中间每一档都偏移一格，
 * 图例显示的名字与实际背景图对不上。
 */
              IMAGES[Math.min(IMAGES.length - 1, Math.round((frame / 240) * (IMAGES.length - 1)))]?.label ?? "",
            ),
            React.createElement("span", null, IMAGES[IMAGES.length - 1].label),
          ),
        ),
      ),

      groups.map((group) =>
        React.createElement(
          "section",
          { className: "ps-settings-panel__group", "aria-label": group, key: group },
          React.createElement("h3", { className: "ps-settings-panel__heading" }, group),
          ROWS.filter((row) => row.group === group).map((row) =>
            React.createElement(
              "div",
              { className: "ps-settings-panel__row", key: row.key },
              React.createElement(
                "div",
                { className: "ps-settings-panel__copy" },
                React.createElement("div", { className: "ps-settings-panel__label" }, row.title),
                React.createElement("p", { className: "ps-settings-panel__description" }, row.description),
              ),
              React.createElement(Switch, {
                checked: Boolean(snapshot[row.key]),
                disabled: pending,
                label: row.title,
                onChange: (value) => void change(row.key, value),
              }),
            ),
          ),
        ),
      ),


      failed &&
        React.createElement(
          "p",
          { className: "ps-settings-panel__error", role: "alert" },
          "设置没有保存成功，请检查浏览器是否禁用了本地存储。",
        ),
    );
  };
}

/* ── src/client.js ── */
/**
 * dsh-photo-skin · 言宝 —— 客户端入口。
 *
 * 结构完全对标「滑动变祖」：
 *   偏好存储（store）→ 背景呈现层（presenter）→ 三个插槽，
 *   滑块同时驱动外观强度与模型推理档位。
 *
 * 插槽：
 *   - conversation.input.right  输入框右侧的强度滑块（含推理档位）
 *   - settings.section          设置 → 言宝
 *   - plugins.bundle.config     侧栏 插件 → 言宝
 *
 * 与「滑动变祖」互斥：见 exclusive.js —— 必须先写键再派发 StorageEvent，
 * 只写键在同一个文档里是没用的（storage 事件只在其他文档触发）。
 */









const name = "yanbao";

const DISPLAY_NAME = "言宝";

/** 输入框插槽里用；与「滑动变祖」的 liang-intensity-control 不冲突。 */
const SLOT_ID = "yanbao-intensity-control";

const inject = ["slots", "sessions", "modelDirectories", "locale"];

function apply(ctx) {
  if (typeof document === "undefined") return;

  setAssetPrefix(`/plugins/${PACKAGE_ID}/assets/`);

  // ── 样式 ──
  const style = document.createElement("style");
  style.dataset.plugin = PACKAGE_ID;
  style.textContent = SKIN_CSS;
  document.head.append(style);
  ctx.effect(() => () => style.remove(), `${PACKAGE_ID}: scoped styles`);

  // ── 偏好与呈现层 ──
  const scope = createPreferenceStore();
  ctx.effect(() => () => scope.dispose(), `${PACKAGE_ID}: preference store`);

  const presenter = new SkinPresenter(scope);
  ctx.effect(() => () => presenter.dispose(), `${PACKAGE_ID}: backdrop presenter`);


  const sync = () => {
    const settings = scope.getSnapshot();
    // 过渡帧暂时关闭（TRANSITIONS_PER_GAP = 0），这里保持调用以兼容未来素材
    useProgressive(false);
    presenter.setGrain(settings.grain);
    presenter.setMaskEnabled(settings.mask);
    presenter.setParticlesEnabled(settings.particles);
    presenter.setMotionEnabled(settings.motion);
    if (!settings.enabled) {
      presenter.setEnabled(false);
      return;
    }

    /*
     * 恢复上次的强度 —— 必须在 setEnabled 之前做。
     *
     * 之前只恢复"档位"，档位内的具体位置会丢：停在 max 组里的第 9 张，
     * 重开后会回到该组区间的中点（第 8 张）。现在把 frame 本身持久化。
     *
     * 另外先把 frame 写进 presenter 再启用，避免首帧读到 -1/0
     * 导致背景先闪一张再跳到正确位置。
     */
    const saved = settings.frame;
    if (typeof saved === "number") {
      presenter.setFrame(saved);
    } else if (presenter.getFrame() < 0) {
      presenter.setFrame(60);
    }
    presenter.setEnabled(settings.enabled);
  };

  ctx.effect(() => {
    const unsubscribe = scope.subscribe(sync);
    sync();
    return () => unsubscribe();
  }, `${PACKAGE_ID}: settings sync`);

  // ── 与「滑动变祖」互斥 ──
  const getSettings = () => scope.getSnapshot();
  ctx.effect(() => installExclusivity(getSettings, scope), `${PACKAGE_ID}: liang exclusivity`);

  /*
   * 把之前替用户关掉的「滑动变祖」还回去。两个时机都要接：
   *   1. 用户在设置里停用言宝、或关掉互斥开关 —— 订阅里处理；
   *   2. 插件整体被卸载 —— 走 effect 的清理函数。
   * 只做第一件事的话，卸载言宝之后对方会一直停着。
   */
  ctx.effect(() => {
    /*
     * 恢复的时机被限定得很窄：只有「言宝停用」或「互斥开关关闭」才还回去。
     * 注意这里**不能**在 takeoverLiang 为 true 时也调用 restore ——
     * 那会和 installExclusivity 的接管逻辑打架（一边关一边开）。
     */
    const maybeRestore = () => {
      const settings = scope.getSnapshot();
      if (!settings.enabled || !settings.takeoverLiang) restoreLiangSkin();
    };
    const unsubscribe = scope.subscribe(maybeRestore);
    return () => {
      unsubscribe();
      restoreLiangSkin();
    };
  }, `${PACKAGE_ID}: liang restore`);

  /*
   * ── 组件 ──
   *
   * 只 require react —— 它是浏览器模组表里的基线依赖。
   * 不再 require @deepseek-ai/dsh-client-ui-primitives：
   * rc.5 的插件规范明确要求插件不要依赖任何 Harness Client 包，
   * 那类包的导出随时可能变，且 `dsh.client.inject` 只负责排序、不保证可用。
   */
  const React = require("react");

  const YanbaoSlider = createSliderComponent(React);
  const YanbaoSettings = createSettingsPanel(React, scope, presenter);

  // 输入框右侧的强度滑块
  ctx.slots.inject("conversation.input.right", () =>
    ctx.slots.register(
      {
        name: "conversation.input.right",
        id: SLOT_ID,
        order: 10,
        inject: (sessionId) => {
          // 子 agent 会话不显示滑块，也不提交档位（对标滑动变祖的行为）
          const available = ctx.sessions.subagentAddress(sessionId) === undefined;
          const directory = ctx.modelDirectories.directoryFor(sessionId);
          const sessions = ctx.sessions;
          const sessionScope = sessions.scope?.(sessionId);
          const session =
            sessionScope === undefined ? undefined : sessions.sessionOf?.(sessionScope);
          return {
            available,
            session,
            directory: directory.store,
            presenter,
            scope,
            load: () => {
              if (available) void directory.load().catch(() => undefined);
            },
            select: (selection) =>
              available
                ? directory.select(selection).then((result) => result.ok, () => false)
                : Promise.resolve(false),
          };
        },
      },
      YanbaoSlider,
    ),
  );

  // 设置 → 言宝
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "yanbao-settings",
        order: 46,
        label: () => DISPLAY_NAME,
      },
      function YanbaoSettingsPage(props) {
        return React.createElement(
          "section",
          { className: "ps-settings-page" },
          React.createElement("h2", { className: "ps-settings-page__title" }, DISPLAY_NAME),
          React.createElement(YanbaoSettings, props),
        );
      },
    ),
  );

  // 侧栏 插件 → 言宝
  ctx.slots.inject("plugins.bundle.config", () =>
    ctx.slots.register(
      {
        name: "plugins.bundle.config",
        key: PACKAGE_ID,
        inject: () => ({ scope, presenter }),
      },
      YanbaoSettings,
    ),
  );
}

/* ── src/skin.css ── */
const SKIN_CSS = "/**\n * dsh-photo-skin —— 皮肤样式（唯一真源）。\n *\n * 由 scripts/build.mjs 内联成 SKIN_CSS 常量注入 <head>。\n *\n * 设计要点：\n *   - 只覆盖 --dsw-* 主题变量 + 少量布局容器的背景，不碰组件内部结构；\n *   - 所有规则都挂在 body[data-photo-skin=\"on\"] 下，停用即完全还原；\n *   - 背景层 z-index:-1 且 pointer-events:none，永远不吃鼠标事件。\n *\n * ⚠ 关于类名选择器：\n *   DSH 用的是 CSS Modules，真实类名形如 `PIRFFq_sidebarCol`、\n *   `kB3qhq_newSession` —— 是 `哈希_local名`，**local 名后面没有下划线**。\n *   所以必须写 [class*=\"_sidebarCol\"] 而不是 [class*=\"_sidebarCol_\"]，\n *   后者一个都匹配不上（实测 0 命中）。哈希前缀每次构建都会变，\n *   但 `_local名` 后缀是稳定的，这是唯一可靠的锚点。\n */\n\n/* ───────────────────────── 1. 底色与面板 ───────────────────────── */\n/*\n * ⚠ 启动画面（boot splash）例外。\n *\n * DSH 的启动层用 `background: var(--dsw-alias-bg-base, Canvas)` 铺底，\n * 文字色是 `--dsw-alias-label-primary`。我们为了透出照片把 bg-base 设成\n * transparent，于是启动那几百毫秒里白字压在透明层上、透出浏览器画布的\n * 黑色 —— \"HARNESS\" 就变成一个黑方块。\n *\n * 所以 bg-base 的透明化单独写在文件后面，条件是启动层已经消失。\n */\nbody[data-photo-skin=\"on\"] {\n\n  /* 三层面板：越「上层」越不透明，保证浮层里的字始终清楚 */\n  --dsw-alias-bg-layer-1: var(--ps-surface-1) !important;\n  --dsw-alias-bg-layer-2: var(--ps-surface-2) !important;\n  --dsw-alias-bg-layer-3: var(--ps-surface-3) !important;\n\n  /* 侧栏与输入框：侧栏更透（让背景透出来），输入框稍实（承载打字） */\n  --dsw-specific-sidebar-fill: var(--ps-sidebar) !important;\n  --dsw-specific-input-major: var(--ps-input) !important;\n  --dsw-specific-bubble: var(--ps-bubble) !important;\n  --dsw-specific-bubble-highlight: var(--ps-bubble-hi) !important;\n  --dsw-specific-selector: var(--ps-selector) !important;\n  --dsw-menu-surface-fill: var(--ps-menu) !important;\n  --dsw-specific-menu: var(--ps-menu) !important;\n  --dsw-alias-menu-group-header-fill: var(--ps-menu-head) !important;\n  --dsw-alias-bg-module-platform: var(--ps-surface-2) !important;\n  --dsw-alias-bg-overlay: var(--ps-surface-2) !important;\n  --dsw-alias-bg-multi-select: var(--ps-surface-2) !important;\n\n  /* 按钮：抬高与大按钮用一层薄玻璃，悬浮态再亮一点 */\n  --dsw-alias-button-elevated-fill: var(--ps-elevated) !important;\n  --dsw-alias-button-floating-fill: var(--ps-surface-2) !important;\n  --dsw-alias-button-floating-hover: var(--ps-hover-strong) !important;\n  --dsw-alias-button-primary-fill: var(--ps-accent) !important;\n  --dsw-alias-button-primary-hover: var(--ps-accent-hi) !important;\n  --dsw-alias-button-ghost-active-fill: var(--ps-elevated) !important;\n  --dsw-alias-button-ghost-active-hover: var(--ps-hover-strong) !important;\n  --dsw-alias-button-ghost-active-border: var(--ps-border-2) !important;\n  --dsw-alias-button-info-fill: var(--ps-accent) !important;\n  --dsw-alias-button-info-hover: var(--ps-accent-hi) !important;\n\n  /* 交互底色 */\n  --dsw-alias-interactive-bg-hover: var(--ps-hover) !important;\n  --dsw-alias-interactive-bg-active: var(--ps-active) !important;\n  --dsw-alias-interactive-bg-hover-solid: var(--ps-hover-strong) !important;\n  --dsw-alias-interactive-bg-hover-accent: var(--ps-hover-accent) !important;\n\n  /* 文字：三档亮度，深底上一律浅色 */\n  --dsw-alias-label-primary: var(--ps-text-1) !important;\n  --dsw-alias-label-primary-dimmed: var(--ps-text-1) !important;\n  --dsw-alias-label-secondary: var(--ps-text-2) !important;\n  --dsw-alias-label-tertiary: var(--ps-text-3) !important;\n  --dsw-alias-label-caption: var(--ps-text-3) !important;\n  --dsw-alias-label-dimmed: var(--ps-text-3) !important;\n  --dsw-alias-label-primary-bluish: var(--ps-text-1) !important;\n  --dsw-alias-label-primary-foreground: var(--ps-on-accent) !important;\n  /* 徽章内文用这个；必须与 text-1（胶囊底色）拉开，见 logic.js 注释 */\n  --dsw-alias-label-primary-inverted: var(--ps-label-inverted) !important;\n  --dsw-alias-brand-primary: var(--ps-text-1) !important;\n  --dsw-alias-brand-text: var(--ps-text-1) !important;\n\n  /* 边框：深底上需要一点冷白才看得见 */\n  --dsw-alias-border-l1: var(--ps-border-1) !important;\n  --dsw-alias-border-l2: var(--ps-border-2) !important;\n  --dsw-alias-border-l2-darkmode-thin: var(--ps-border-1) !important;\n  --dsw-alias-border-l3: var(--ps-border-3) !important;\n  --dsw-alias-border-l4: var(--ps-border-3) !important;\n\n  /* 代码块 / 引用 / 行内码：比面板再深一档，才能从玻璃里「沉下去」 */\n  --dsw-alias-markdown-code-block: var(--ps-code) !important;\n  --dsw-alias-markdown-code-block-banner: var(--ps-code-head) !important;\n  --dsw-alias-markdown-code-segment-selected: var(--ps-code-head) !important;\n  --dsw-alias-markdown-code-segment-unselected: var(--ps-code) !important;\n  --dsw-alias-markdown-inline-code: var(--ps-inline-code) !important;\n  --dsw-alias-markdown-placeholder: var(--ps-surface-2) !important;\n  --dsw-alias-markdown-tag: var(--ps-surface-2) !important;\n  --dsw-alias-markdown-citation: var(--ps-surface-3) !important;\n  --dsw-alias-turn-trigger-bg: var(--ps-hover) !important;\n  --dsw-alias-turn-trigger-bg-hover: var(--ps-hover-strong) !important;\n\n  /* 浮层 */\n  --dsw-alias-tooltip-bg: var(--ps-surface-3) !important;\n  --dsw-alias-tooltip-key-bg: var(--ps-hover-strong) !important;\n  --dsw-alias-toast-bg: var(--ps-surface-3) !important;\n  --dsw-alias-toast-label: var(--ps-text-1) !important;\n\n  /* 滚动条 */\n  --dsw-alias-scrollbar-bg-l1: var(--ps-scroll) !important;\n  --dsw-alias-scrollbar-bg-l2: var(--ps-scroll) !important;\n  --dsw-alias-scrollbar-hover-l1: var(--ps-scroll-hover) !important;\n  --dsw-alias-scrollbar-hover-l2: var(--ps-scroll-hover) !important;\n\n  /* 强调色（链接、高亮、业务底色） */\n  --dsw-alias-state-business-primary: var(--ps-accent) !important;\n  --dsw-alias-state-business-tertiary: var(--ps-accent-soft) !important;\n  --dsw-alias-link: var(--ps-accent) !important;\n  --dsw-alias-brand-primary-new-colorprimary-new-color: var(--ps-accent) !important;\n  --dsw-alias-switch-thumb: var(--ps-text-1) !important;\n  --dsw-alias-bg-skeleton: var(--ps-hover) !important;\n\n  /* 让原生控件（下拉、滚动条）也跟着走深色 */\n}\n\n/*\n * bg-base 的透明化：只在启动层消失后生效。\n * 启动层在时给一层不透明的底，白字才不会压在透明层上变成\"黑方块\"。\n * :has() 在 Chromium 105+ 可用，DSH 的 Electron 远高于此。\n */\nbody[data-photo-skin=\"on\"]:not(:has([data-dsh-boot])) {\n  --dsw-alias-bg-base: transparent !important;\n}\n\nbody[data-photo-skin=\"on\"]:has([data-dsh-boot]) {\n  --dsw-alias-bg-base: var(--ps-backdrop, #151517) !important;\n}\n\n/* 原生控件跟随明暗模式 */\nbody[data-photo-skin=\"on\"] { color-scheme: dark; }\nbody[data-photo-skin=\"on\"][data-ps-mode=\"light\"] { color-scheme: light; }\n\n/* ───────────────────────── 2. 布局容器放行 ───────────────────────── */\n/*\n * 这几条是「背景能不能透上来」的关键。DSH 在 macOS 上给侧栏和中间列\n * 单独铺了不透明底色（AppFrame.module.css 里 [data-platform=darwin]\n * 那几条），只改变量还不够，必须把容器本身也改成透明或半透明。\n *\n * 注意选择器写的是 `_frame`、`_sidebarCol` —— 末尾不带下划线，\n * 因为真实类名是 `PIRFFq_frame`（见文件头注释）。\n */\nbody[data-photo-skin=\"on\"] [class*=\"_frame\"] {\n  background: transparent !important;\n}\n\nbody[data-photo-skin=\"on\"] [class*=\"_sidebarCol\"] {\n  background: var(--ps-sidebar-veil) !important;\n  border-right: 1px solid var(--ps-border-1) !important;\n  /* 侧栏只轻微磨砂：够压住背景杂色，又不至于把人物糊掉 */\n  backdrop-filter: blur(var(--ps-blur-sidebar)) saturate(112%);\n  -webkit-backdrop-filter: blur(var(--ps-blur-sidebar)) saturate(112%);\n}\n\n/*\n * 中间列**不能**加 backdrop-filter。\n * 它几乎占满整个窗口，一旦加毛玻璃，被模糊的就是整张壁纸本身 ——\n * 实测效果是照片糊成一团、看不出是谁。这里只铺一层很淡的压暗，\n * 让照片保持清晰，靠背景层自己的渐变遮罩保证文字对比度。\n */\nbody[data-photo-skin=\"on\"] [class*=\"_centerCol\"],\nbody[data-photo-skin=\"on\"] [class*=\"_rightbarCol\"] {\n  background: var(--ps-center-veil) !important;\n  border-left: 1px solid var(--ps-border-1) !important;\n}\n\n/* 侧栏组件自己的根节点还有一层底色，一并放掉 */\nbody[data-photo-skin=\"on\"] [class*=\"_sidebarCol\"] [class*=\"_root\"] {\n  background: transparent !important;\n}\n\n/* 输入框卡片：给一层玻璃描边，浮在背景上更有层次 */\nbody[data-photo-skin=\"on\"] [class*=\"_card\"]:has([contenteditable=\"true\"]),\nbody[data-photo-skin=\"on\"] [class*=\"_card\"]:has(textarea) {\n  backdrop-filter: blur(calc(var(--ps-blur) * 1.4)) saturate(120%);\n  -webkit-backdrop-filter: blur(calc(var(--ps-blur) * 1.4)) saturate(120%);\n  box-shadow:\n    var(--dsw-elevation-soft),\n    inset 0 1px 0 0 var(--ps-border-3);\n}\n\n/* ───────────────────────── 3. 背景层 ───────────────────────── */\n#photo-skin-layer {\n  position: fixed;\n  inset: 0;\n  z-index: -1;\n  pointer-events: none;\n  overflow: hidden;\n  background-color: var(--ps-backdrop);\n\n  /*\n   * 背景层不参与窗口拖动区的计算。\n   *\n   * 不加这条，开启皮肤后 macOS 窗口拖不动（DSH 0.2.2-rc.2 实测）。\n   * 原因：DSH 的 base.css 有\n   *     html[data-platform=darwin] body > :not(#root) { -webkit-app-region: no-drag }\n   * 本层挂在 document.body 下、又不是 #root，于是整层被标成 no-drag；\n   * 它铺满整个窗口（inset: 0），而 Electron 的 app-region 是几何运算、\n   * 按文档顺序依次合成 —— 本层是 body 的最后一个子元素，排在侧栏\n   * topStrip 和会话 header 这些 drag row 之后，于是把它们全减掉了。\n   * DSH 在 AppFrame.module.css 里写了同一条顺序规则：盖住窗口又要保持\n   * 可点击的层才需要排在 drag row 之后；本层只是背景，不需要。\n   *\n   * 复位成 initial 后本层既不加也不减拖动区，drag row 照常生效。\n   * !important 是必须的：DSH 那条选择器的优先级（含 #root）高于本条。\n   *\n   * 实测（真机 DevTools A/B）：只去掉 body 底色 → 拖不动；\n   * 复位本层 app-region → 拖得动。所以修的是这里，不是 body 的底色。\n   */\n  -webkit-app-region: initial !important;\n}\n\n/*\n * 两层 <div>：A 层预加载下一张、B 层显示当前张，交替淡入淡出。\n * 单层做不到「换图时不闪白」，这是必须的。\n */\n/*\n * 背景板。\n *\n * 注意这里**不要**用 transform: scale 或 inset 负值来做\"微放大\"，\n * 也不要留一个固定的 will-change ——\n * 三者都会让浏览器把图层拍成位图再放大，等于人为降低分辨率：\n *   inset:-2% + scale(1.02) ≈ 先放大 4% 再显示，细节直接糊掉。\n * 需要裁切交给 background-size: cover 就够了。\n */\n#photo-skin-layer .ps-plate {\n  position: absolute;\n  inset: 0;\n  background-size: cover;\n  background-position: var(--ps-focus, center);\n  background-repeat: no-repeat;\n  /* 让浏览器用高质量缩放（Chrome/Safari 支持） */\n  image-rendering: auto;\n  opacity: 0;\n  /*\n   * 注意这里**不能**加 transform —— 文件顶部写过原因：\n   * 任何 transform 都会让图层拍成位图再合成，\n   * 2400px 的原图反而更糊（实测过，已回退一次）。\n   */\n  transition: opacity 260ms var(--ds-ease-in-out, ease-in-out);\n}\n\n#photo-skin-layer .ps-plate[data-visible=\"true\"] {\n  opacity: 1;\n}\n\n/*\n * 舞台：包住所有照片层。关闭空闲淡化时它没有任何视觉样式\n * （opacity 1、不建合成层），画面与加功能之前一模一样。\n * 只有开关切换的那一下有 260ms 过渡，避免一帧之内跳亮。\n */\n#photo-skin-layer .ps-stage {\n  position: absolute;\n  inset: 0;\n  transition: opacity 260ms var(--ds-ease-in-out, ease-in-out);\n}\n\n/*\n * ── 空闲淡化：只在开启时追加覆盖 ──\n *\n * 结构照「滑动变祖」的 optional-visuals.css：原始规则保持默认，\n * 只有 data-motion=\"on\" 时才追加。关掉后下面的规则完全不参与匹配。\n *\n * 淡化作用在舞台上，而不是照片层：照片层的 opacity 留给换图的交叉淡入。\n * 之前两者挤在照片层上，换图时新层 1400ms 淡入、旧层 260ms 淡出，\n * 照片会掉到 7% 闪一下。\n *\n * 不缩放：满屏照片缩小会在四周露出一圈底色。\n */\n#photo-skin-layer[data-motion=\"on\"] .ps-stage {\n  opacity: var(--ps-motion-opacity, 1);\n  transition: opacity 1400ms var(--ds-ease-in-out, ease-in-out);\n}\n\n/* 进出拖动都要快：按下立刻全亮，松手立刻开始淡回去 */\n#photo-skin-layer[data-motion=\"on\"][data-motion-state=\"preview\"] .ps-stage {\n  transition-duration: 260ms;\n}\n\n/*\n * 拖滑块时阅读衬底临时变淡，挑图时看得清人物。\n * 只在空闲淡化开启时生效；松手 260ms 恢复，打字前已经回到原样。\n */\n#photo-skin-layer[data-motion=\"on\"] .ps-readability {\n  transition: opacity 260ms var(--ds-ease-in-out, ease-in-out);\n}\n\n#photo-skin-layer[data-motion=\"on\"][data-motion-state=\"preview\"] .ps-readability {\n  opacity: 0.4;\n}\n\n\n\n/* 遮罩：压一层深色，保证任何一张图上的文字都有对比度 */\n/* 遮罩关闭：整层隐去，人物原样呈现 */\n#photo-skin-layer[data-mask=\"off\"] .ps-veil,\n#photo-skin-layer[data-mask=\"off\"] .ps-readability {\n  display: none;\n}\n\n#photo-skin-layer .ps-veil {\n  position: absolute;\n  inset: 0;\n  background:\n    radial-gradient(\n      120% 90% at 50% 0%,\n      transparent 0%,\n      var(--ps-veil-edge) 100%\n    ),\n    linear-gradient(\n      160deg,\n      var(--ps-veil-top) 0%,\n      var(--ps-veil-mid) 45%,\n      var(--ps-veil-bottom) 100%\n    );\n}\n\n/*\n * 正文列渐变压暗：只在中间那条 760px 宽的阅读区加一层很淡的垂直渐变，\n * 从顶部稍重到底部透明。目的是让长段落所在的区域始终有一点点底，\n * 又不至于像整列铺色那样把人的脸也糊掉。\n */\n/*\n * 阅读衬底：正文所在的那条竖带，铺一层稳定的半透明底。\n *\n * 为什么不能用「压暗整个背景」：那样照片就死了。\n * 也不能只靠渐变 —— 段落会跨过脸、头发、花朵，局部亮块一多就糊。\n * 所以这里给阅读区一条**恒定浓度**的衬底（边缘再用 mask 羽化），\n * 段落无论落在哪张图的哪个位置，对比度都是可预期的。\n */\n/*\n * 阅读衬底。\n *\n * 设计演进（重要）：\n *   1. 第一版是一条很淡的渐变 —— 段落跨过脸、花瓣时完全失守；\n *   2. 第二版改成恒定浓度的窄带 —— 可读性够了，但那条白带在脸中央\n *      明晃晃地存在，边缘还有明显接缝；\n *   3. 当前版本：**覆盖整列、浓度降低、四周大幅羽化**。\n *      视觉上感觉不到「有一条带」，但文字底下始终有稳定的底。\n */\n#photo-skin-layer .ps-readability {\n  position: absolute;\n  inset: 0;\n  /* 正文列的实际左边缘就在 x≈290（1600 宽、侧栏 264），\n     羽化必须从更外面开始，否则第一列字正好落在淡出区 */\n  left: 14%;\n  right: 14%;\n  /* 正文从容器顶部就开始，渐变必须在 2% 内就到位，否则首段落在淡出区 */\n  background: linear-gradient(\n    180deg,\n    var(--ps-read-mid) 0%,\n    var(--ps-read-mid) 94%,\n    var(--ps-read-edge) 100%\n  );\n  /* 横向与纵向都做长距离羽化，消除任何可见接缝 */\n  /* 只做横向羽化；纵向铺满，避免首段/末段掉进淡出区 */\n  -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 8%, #000 92%, transparent 100%);\n  mask-image: linear-gradient(90deg, transparent 0%, #000 8%, #000 92%, transparent 100%);\n}\n\n/* 极细颗粒：把 photo 的数码感磨掉一点，也让大面积纯色不那么「塑料」 */\n#photo-skin-layer[data-grain=\"off\"] .ps-grain {\n  display: none;\n}\n\n#photo-skin-layer .ps-grain {\n  position: absolute;\n  inset: 0;\n  opacity: var(--ps-grain);\n  /*\n   * 用 normal 而不是 overlay。\n   *\n   * 实测对比（同一张 SVG 噪点、同一底色）：\n   *   overlay  在暗底和中灰上几乎看不见（标准差差异 < 0.5），\n   *            因为它按底色的亮度重算，噪点被压平了；\n   *   normal   各处都能稳定出颗粒（标准差约 3），观感就是胶片颗粒。\n   *\n   * 早期用 overlay 是为了\"保留对比度\"，但那反而让整个效果形同不存在。\n   */\n  mix-blend-mode: normal;\n  background-image: url(\"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\");\n  background-size: 180px 180px;\n  pointer-events: none;\n}\n\n/* ───────────────────────── 4. 细节打磨 ───────────────────────── */\n\n/*\n * 侧栏「新会话」按钮。\n *\n * ⚠ 这里**不能用** [class*=\"_newSession\"] —— 子串匹配会同时命中它的四个子元素：\n *   kB3qhq_newSessionLabel / LabelMask / Content / Shortcut\n * 结果每个子元素都被塞了背景色和描边，按钮里就出现一块包住文字的灰方块。\n * 凡是 [class*=] 都必须能唯一锁定目标，否则改用 [class~=] 精确匹配整段类名。\n */\nbody[data-photo-skin=\"on\"] [class$=\"_newSession\"] {\n  background: var(--ps-elevated) !important;\n  border-color: var(--ps-border-2) !important;\n  backdrop-filter: blur(14px) saturate(120%);\n  -webkit-backdrop-filter: blur(14px) saturate(120%);\n}\nbody[data-photo-skin=\"on\"] [class$=\"_newSession\"]:hover {\n  background: var(--ps-hover-strong) !important;\n}\n\n/* 选中态导航行：用强调色的一条细边做提示，而不是整块变色 */\nbody[data-photo-skin=\"on\"] [class*=\"_panelActive\"] {\n  background: var(--ps-hover) !important;\n  box-shadow: inset 2px 0 0 0 var(--ps-accent);\n}\n\n/*\n * 正文可读性 —— 这是整张皮肤最关键的一条。\n *\n * 素材里人脸、樱花、白围巾的亮度能到 0.85+，白字压上去直接糊掉。\n * 但把遮罩加到 0.8 又会把照片压成一片死黑，皮肤就白做了。\n *\n * 解法不是继续压背景，而是在**文字自己身上**加一层柔和暗边：\n * 近处 1px 硬阴影保证笔画轮廓，远处 14px 大范围晕染压住周围的亮块。\n * 这样照片保持通透，字也依然清楚 —— 也是各家「照片壁纸」类 App 的通行做法。\n */\nbody[data-photo-skin=\"on\"] [class*=\"_markdown\"],\nbody[data-photo-skin=\"on\"] [class*=\"_markdown\"] *,\nbody[data-photo-skin=\"on\"] [class*=\"_bubbleUser\"],\nbody[data-photo-skin=\"on\"] [class*=\"_panelRow\"],\nbody[data-photo-skin=\"on\"] [class*=\"_sessionRow\"] {\n  text-shadow: var(--ps-text-shadow);\n}\n\n/* 代码块内部自带实底，不需要再做阴影，否则笔画会发胖 */\nbody[data-photo-skin=\"on\"] [class*=\"_markdown\"] pre,\nbody[data-photo-skin=\"on\"] [class*=\"_markdown\"] pre *,\nbody[data-photo-skin=\"on\"] [class*=\"_markdown-code-block\"] * {\n  text-shadow: none;\n}\n\n/* 长文正文行高放宽一点，玻璃背景下更好读 */\nbody[data-photo-skin=\"on\"] [class*=\"_markdown\"] {\n  text-wrap: pretty;\n}\n\n/*\n * 最后一层保险：正文的直接子块（段落、标题、列表）各带一层极淡的底。\n *\n * 为什么必须是「每个块」而不是整列：\n *   整列铺色会出现可见的竖带（前面试过，在脸中央明晃晃的）；\n *   按块铺则跟着文字走，段落短的时候底也短，视觉上更像文字自带的光晕。\n * 浓度很低（深色档 ~0.35 / 浅色档 ~0.45），叠上衬底后足够把对比度托到 4.5+。\n */\n/*\n * ⚠ 只给深色模式加块底。\n * 浅色模式下文字和块底**都是深色**，两者几乎没有亮度差，\n * 加了底反而把对比度从 4.4 压到 2.9（实测）。\n * 浅色模式靠的是「衬底把背景压白 + 深字」这条路径。\n */\nbody[data-photo-skin=\"on\"][data-ps-mode=\"dark\"] [class*=\"_markdown\"] > p,\nbody[data-photo-skin=\"on\"][data-ps-mode=\"dark\"] [class*=\"_markdown\"] > h1,\nbody[data-photo-skin=\"on\"][data-ps-mode=\"dark\"] [class*=\"_markdown\"] > h2,\nbody[data-photo-skin=\"on\"][data-ps-mode=\"dark\"] [class*=\"_markdown\"] > h3,\nbody[data-photo-skin=\"on\"][data-ps-mode=\"dark\"] [class*=\"_markdown\"] > h4,\nbody[data-photo-skin=\"on\"][data-ps-mode=\"dark\"] [class*=\"_markdown\"] > ul,\nbody[data-photo-skin=\"on\"][data-ps-mode=\"dark\"] [class*=\"_markdown\"] > ol,\nbody[data-photo-skin=\"on\"][data-ps-mode=\"dark\"] [class*=\"_markdown\"] > blockquote,\nbody[data-photo-skin=\"on\"][data-ps-mode=\"dark\"] [class*=\"_bubbleUser\"] {\n  background: var(--ps-text-backing);\n  border-radius: var(--dsw-radius-sm, 6px);\n  /* 负外边距 + padding：底色略微外扩，读起来像行内高亮而不是边框 */\n  margin-inline: -8px;\n  padding-inline: 8px;\n  box-decoration-break: clone;\n  -webkit-box-decoration-break: clone;\n}\n\n/* 代码块和表格自己有实底，不要再叠 */\nbody[data-photo-skin=\"on\"][data-ps-mode=\"dark\"] [class*=\"_markdown\"] pre,\nbody[data-photo-skin=\"on\"][data-ps-mode=\"dark\"] [class*=\"_markdown\"] table,\nbody[data-photo-skin=\"on\"][data-ps-mode=\"dark\"] [class*=\"_markdown-code-block\"] {\n  background-color: transparent;\n}\n\n/* 图片预览、代码块这些「实心块」不要跟着玻璃走，给足不透明度 */\nbody[data-photo-skin=\"on\"] [class*=\"_markdown-code-block\"],\nbody[data-photo-skin=\"on\"] pre {\n  backdrop-filter: none;\n  -webkit-backdrop-filter: none;\n}\n\n@media (prefers-reduced-motion: reduce) {\n  #photo-skin-layer .ps-plate {\n    transition: opacity 120ms linear;\n  }\n  /* 选择器要和上面的动效规则一样具体，否则压不住 1400ms */\n  #photo-skin-layer .ps-stage,\n  #photo-skin-layer[data-motion=\"on\"] .ps-stage,\n  #photo-skin-layer[data-motion=\"on\"][data-motion-state=\"preview\"] .ps-stage,\n  #photo-skin-layer[data-motion=\"on\"] .ps-readability {\n    transition: opacity 120ms linear;\n  }\n}\n\n/* 降低透明度偏好（macOS 辅助功能）时，不要用毛玻璃，直接给实色 */\n@media (prefers-reduced-transparency: reduce) {\n  body[data-photo-skin=\"on\"] [class*=\"_sidebarCol\"] {\n    backdrop-filter: none;\n    -webkit-backdrop-filter: none;\n  }\n}\n/* ───────── 5. 强度滑块（观感对齐「滑动变祖」） ───────── */\n.ps-effort-control {\n  --ps-control-accent: var(--ps-accent, #7aaaff);\n  --ps-control-rail: var(--ps-border-3, rgba(255, 255, 255, 0.18));\n  /*\n   * thumb 直径。\n   *\n   * WebKit 的 thumb 中心活动范围是 [thumb/2, W - thumb/2]（两端各内缩半个）。\n   * 所以刻度的 inset 必须**正好等于半个 thumb**，两套坐标才能重合。\n   * 早先写死 10px 与 thumb(11px)/2=5.5px 不一致，端点偏差约 4.5px ——\n   * 表现就是\"max 档滑块跑到竖线右边\"。\n   */\n  --ps-thumb: 11px;\n  --ps-rail-inset: calc(var(--ps-thumb) / 2);\n  position: relative;\n  display: flex;\n  width: 124px;\n  height: 28px;\n  align-items: center;\n  margin: 0 3px;\n  overflow: visible;\n}\n\n.ps-effort-control__ticks {\n  position: absolute;\n  z-index: 0;\n  /* 与滑轨严格对齐 */\n  inset: 0 var(--ps-rail-inset);\n  pointer-events: none;\n}\n\n.ps-effort-control__ticks::before {\n  position: absolute;\n  top: 50%;\n  right: 0;\n  left: 0;\n  height: 1px;\n  content: \"\";\n  background: var(--ps-control-rail);\n  transform: translateY(-50%);\n}\n\n.ps-effort-control__tick {\n  position: absolute;\n  top: 50%;\n  width: 1px;\n  height: 7px;\n  background: var(--ps-control-accent);\n  opacity: 0.45;\n  transform: translate(-50%, -50%);\n}\n\n.ps-effort-control__tooltip {\n  position: absolute;\n  z-index: 4;\n  bottom: calc(100% + 7px);\n  left: calc(10px + (100% - 20px) * var(--ps-slider-ratio, 0));\n  min-width: max-content;\n  padding: 5px 8px;\n  border: 1px solid var(--ps-border-2, rgba(255, 255, 255, 0.14));\n  border-radius: 7px;\n  color: var(--ps-text-1, #f0f2f5);\n  background: var(--ps-surface-3, rgba(20, 22, 28, 0.92));\n  box-shadow: 0 5px 16px rgba(0, 0, 0, 0.28);\n  font-size: 11px;\n  font-weight: 600;\n  line-height: 16px;\n  pointer-events: none;\n  transform: translateX(-50%);\n  white-space: nowrap;\n  backdrop-filter: blur(12px);\n  -webkit-backdrop-filter: blur(12px);\n}\n\n.ps-effort-control__tooltip::after {\n  position: absolute;\n  top: 100%;\n  left: 50%;\n  width: 7px;\n  height: 7px;\n  content: \"\";\n  background: inherit;\n  transform: translate(-50%, -4px) rotate(45deg);\n}\n\n/*\n * 滑块本体铺满容器，用 padding 把轨道挤到和刻度同宽。\n * 这样 thumb 中心的活动范围正好等于刻度的 0%..100%，\n * 两套坐标系统一，端点也能精确落在首尾刻度上。\n */\n.ps-effort-control__range {\n  position: relative;\n  z-index: 1;\n  box-sizing: border-box;\n  width: 100%;\n  height: 28px;\n  margin: 0;\n  padding: 0;\n  background: transparent;\n  cursor: pointer;\n  appearance: none;\n  -webkit-appearance: none;\n}\n\n/*\n * 轨道本身不加 margin —— WebKit 已经为 thumb 内置了半宽 inset，\n * 再加一层就会偏第二次。刻度容器用同样的 inset 即可对齐。\n */\n.ps-effort-control__range::-webkit-slider-runnable-track {\n  height: 28px;\n  background: transparent;\n}\n\n.ps-effort-control__range::-webkit-slider-thumb {\n  width: var(--ps-thumb);\n  height: var(--ps-thumb);\n  margin-top: 8px;\n  border: 2px solid var(--ps-surface-1, rgba(20, 22, 28, 0.9));\n  border-radius: 50%;\n  background: var(--ps-control-accent);\n  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);\n  appearance: none;\n  -webkit-appearance: none;\n}\n\n.ps-effort-control__range:active::-webkit-slider-thumb {\n  width: 15px;\n  height: 15px;\n  margin-top: 6px;\n}\n\n.ps-effort-control__range::-moz-range-track {\n  height: 28px;\n  background: transparent;\n}\n\n.ps-effort-control__range::-moz-range-thumb {\n  width: 11px;\n  height: 11px;\n  border: 2px solid var(--ps-surface-1, rgba(20, 22, 28, 0.9));\n  border-radius: 50%;\n  background: var(--ps-control-accent);\n  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);\n}\n\n.ps-effort-control__range:focus-visible {\n  outline: 2px solid var(--ps-control-accent);\n  outline-offset: 2px;\n  border-radius: 10px;\n}\n\n/* ───────── 6. 设置面板 ───────── */\n.ps-settings-page__title {\n  margin: 0 0 16px;\n  font-size: 20px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n}\n\n.ps-settings-panel {\n  display: flex;\n  flex-direction: column;\n  gap: 22px;\n}\n\n.ps-settings-panel__group {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.ps-settings-panel__heading {\n  margin: 0 0 8px;\n  font-size: 12px;\n  font-weight: 600;\n  letter-spacing: 0.06em;\n  text-transform: uppercase;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.ps-settings-panel__row {\n  display: flex;\n  align-items: flex-start;\n  justify-content: space-between;\n  gap: 20px;\n  padding: 10px 0;\n  border-bottom: 1px solid var(--dsw-alias-border-l1);\n}\n\n.ps-settings-panel__copy {\n  min-width: 0;\n  flex: 1;\n}\n\n.ps-settings-panel__label {\n  font-size: 13px;\n  font-weight: 500;\n  line-height: 20px;\n  color: var(--dsw-alias-label-primary);\n}\n\n.ps-settings-panel__description {\n  margin: 2px 0 0;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.ps-settings-panel__preview {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 4px 0 8px;\n}\n\n.ps-settings-panel__range {\n  width: 100%;\n  height: 24px;\n  accent-color: var(--ps-accent, #7aaaff);\n  cursor: pointer;\n}\n\n.ps-settings-panel__legend {\n  display: flex;\n  justify-content: space-between;\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.ps-settings-panel__legend-current {\n  font-weight: 600;\n  color: var(--ps-accent, var(--dsw-alias-state-business-primary));\n}\n\n.ps-settings-panel__note {\n  margin: 0;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.ps-settings-panel__error {\n  margin: 0;\n  font-size: 12px;\n  color: var(--dsw-alias-state-error-primary, #f26a6a);\n}\n\n/* ───────── 7. 设置页开关（自写，不用 primitives） ───────── */\n/*\n * 只引用 --dsw-alias-* 主题 token，跟随宿主明暗主题。\n * 保留 role=\"switch\" 的语义，键盘 Enter/Space 由原生 button 提供。\n */\n.ps-switch {\n  position: relative;\n  flex: none;\n  width: 36px;\n  height: 20px;\n  padding: 0;\n  border: none;\n  border-radius: 999px;\n  background: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.18));\n  cursor: pointer;\n  transition: background-color 160ms ease;\n  appearance: none;\n  -webkit-appearance: none;\n}\n\n.ps-switch[data-checked=\"true\"] {\n  background: var(--dsw-alias-state-business-primary, #4176e6);\n}\n\n.ps-switch:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.ps-switch:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6);\n  outline-offset: 2px;\n}\n\n.ps-switch__thumb {\n  position: absolute;\n  top: 2px;\n  left: 2px;\n  width: 16px;\n  height: 16px;\n  border-radius: 50%;\n  background: var(--dsw-alias-label-primary-foreground, #fff);\n  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);\n  transition: transform 160ms ease;\n}\n\n.ps-switch[data-checked=\"true\"] .ps-switch__thumb {\n  transform: translateX(16px);\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .ps-switch,\n  .ps-switch__thumb {\n    transition: none;\n  }\n}\n\n/* ───────── 8. 星尘粒子层 ───────── */\n/*\n * 铺满整个背景层，盖在照片与遮罩之上、界面之下。\n * 由 Canvas 2D 绘制（见 src/stardust.js），每帧只做 drawImage。\n */\n#photo-skin-layer .ps-stardust {\n  position: absolute;\n  inset: 0;\n  width: 100%;\n  height: 100%;\n  pointer-events: none;\n  opacity: 1;\n  transition: opacity 700ms var(--ds-ease-in-out, ease-in-out);\n  /* 让粒子在浅色主题下也不至于被整片白底吃掉 */\n  mix-blend-mode: screen;\n}\n\n/* 开关星尘：淡入淡出，不再一帧之内全部出现或消失 */\n#photo-skin-layer[data-particles=\"off\"] .ps-stardust {\n  opacity: 0;\n}\n\n/* 减少动态效果时不画粒子（JS 侧也会直接返回空句柄） */\n@media (prefers-reduced-motion: reduce) {\n  #photo-skin-layer .ps-stardust {\n    display: none;\n  }\n  /* 动效关闭时遮罩不做渐变，避免\"慢慢变暗\"的观感 */\n  #photo-skin-layer .ps-veil {\n    transition: none;\n    opacity: 1;\n  }\n}\n";

    exports.name = name;
    exports.apply = apply;
    exports.inject = inject;
    exports.IMAGES = IMAGES;
    return module.exports;
  },
});
