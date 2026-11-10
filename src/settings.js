/**
 * dsh-photo-skin —— 设置面板。
 *
 * 一套组件挂两个入口（与「滑动变祖」相同的做法）：
 *   - settings.section        → 设置 → 言宝
 *   - plugins.bundle.config   → 侧栏 插件 → 言宝
 *
 * 所有开关即时生效并写入 localStorage，没有「保存」按钮。
 */

import { IMAGES } from "./frames.js";

export function createSettingsPanel(React, scope, presenter) {
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