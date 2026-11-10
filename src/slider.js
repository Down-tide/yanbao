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

import {
  MAX_FRAME,
  clampFrame,
  frameForLevel,
  levelForFrame,
  snapFrame,
} from "./logic.js";
import {
  anchorRanges,
  createEffortSync,
  effortIndexAt,
  frameForEffort,
  indicatorLabel,
  lastFrameForEffort,
  modelReasoning,
  nearestEffortIndex,
  selectedEffortIndex,
} from "./effort.js";
import { IMAGES } from "./frames.js";

const ANCHOR_COUNT = IMAGES.length; // 9

/** 会改变 range 值的按键。 */
const SLIDER_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End",
]);

export function createSliderComponent(React) {
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