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
export const MOTION_PRESETS = Object.freeze({
  idle: Object.freeze({ opacity: "0.32" }),
  running: Object.freeze({ opacity: "0.69" }),
  preview: Object.freeze({ opacity: "1" }),
});

/** 判断当前该是哪个状态。preview 优先级最高。 */
export function motionState({ dragging, running }) {
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
export function applyMotionState(root, state, enabled) {
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
export function createMotionController({ isRunning, isDragging }) {
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
