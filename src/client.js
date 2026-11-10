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

import { createPreferenceStore } from "./store.js";
import { SkinPresenter } from "./presenter.js";
import { createSliderComponent } from "./slider.js";
import { createSettingsPanel } from "./settings.js";
import { setAssetPrefix, useProgressive } from "./frames.js";
import { installExclusivity, restoreLiangSkin } from "./exclusive.js";
import { PACKAGE_ID } from "./logic.js";
import { SKIN_CSS } from "./skin.js";

export const name = "yanbao";

const DISPLAY_NAME = "言宝";

/** 输入框插槽里用；与「滑动变祖」的 liang-intensity-control 不冲突。 */
const SLOT_ID = "yanbao-intensity-control";

export const inject = ["slots", "sessions", "modelDirectories", "locale"];

export function apply(ctx) {
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