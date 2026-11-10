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
export const PACKAGE_ID = "dsh-photo-skin";

/** 九个阶段 —— 一张图一档。 */
export const MAX_LEVEL = 8;

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
export const GRAIN_OPACITY = Object.freeze({
  dark: "0.14",
  light: "0.28",
});

/** 内联 SVG 噪点。feTurbulence 的 fractalNoise 比随机点更接近胶片颗粒。 */
export const GRAIN_IMAGE =
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

export const MAX_FRAME = 240;

/** 背景平均亮度超过这个值就切到浅色主题（0..255）。 */
export const LIGHT_MODE_THRESHOLD = 100;

/** 把帧号钳制到合法范围。 */
export function clampFrame(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_FRAME, Math.max(0, Math.round(value)));
}

/** 档位 -> 帧号。 */
export function frameForLevel(level) {
  const safe = Math.max(0, Math.min(MAX_LEVEL, level));
  return clampFrame((safe / MAX_LEVEL) * MAX_FRAME);
}

/** 帧号 -> 档位（四舍五入）。 */
export function levelForFrame(frame) {
  return Math.round((clampFrame(frame) / MAX_FRAME) * MAX_LEVEL);
}

/** 帧号 -> 最近的整数档位对应的帧号（用于吸附）。 */
export function snapFrame(frame) {
  return frameForLevel(levelForFrame(frame));
}

/**
 * 帧号 -> 连续的阶段小数。
 * 第 0 档 = 0.0，第 8 档 = 8.0。
 */
export function stageAt(frame) {
  return (clampFrame(frame) / MAX_FRAME) * MAX_LEVEL;
}

const lerp = (a, b, t) => a + (b - a) * t;

/** 两色线性混合。 */
export function mix(a, b, t) {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
}

export function rgb(value, alpha = 1) {
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
export function luminance(color) {
  return (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]) / 255;
}

/**
 * 该用浅色主题还是深色主题。
 *
 * 依据是**图片本身的平均亮度**（tone.lum），不是 base（base 是面板底色，
 * 永远是深色），也不是滑块位置 —— 这样换素材、调顺序都会自动正确。
 */
export function isLightMode(tone) {
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
export function deriveTone(tone, options = {}) {
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