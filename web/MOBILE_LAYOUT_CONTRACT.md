# 移动端布局防回归契约

这是**产品验收后的强制规则**，适用于会话页顶部、安全区、消息区和底部输入区。它的目标不是让后续改动“尽量别影响”，而是让已验收的行为成为可检查、不可静默回退的契约。

## 已验收状态

| 区域 | 不变量 | 实现入口 |
| --- | --- | --- |
| 顶部外层 | 透明；`backdrop-filter: none`；不得做整条毛玻璃 | `mobileLayoutContract.ts`、`SessionHeader.tsx` |
| 顶部操作 | 操作按钮所在的小胶囊保持实色；整条标题栏背景保持透明 | `SessionHeader.tsx` |
| 标题栏触摸层 | 浮动标题栏固定为 `z-40`，必须高于会话大纲等线程遮罩；透明空白区域必须让触摸穿到消息线程，返回与会话详情仅由实色操作区接收触摸 | `SessionHeader.tsx`、`HappyThread.tsx` |
| 聊天滚动区 | 初始消息从“顶部安全区 + 实测标题栏高度”之后开始；滚动后消息可从完全透明的标题栏下方经过 | `SessionChat.tsx`、`HappyThread.tsx` |
| iOS 顶部安全区 | standalone 模式通常最小 50px；若运行时确认顶部是 WebKit 绘制在 DOM 外的系统区，则不得再叠加这 50px，标题从可见网页视口开始 | `useViewportHeight.ts`、`index.css` |
| iOS 底部安全区 | standalone 模式最小 34px；普通触屏最小 12px | `index.css` |
| 展开输入框 + 键盘 | 底部总间隔固定 **4px**：安全区和常规 12px 间隔均归零，只保留 4px | `index.css` |
| 有内容的输入框 | 草稿非空时始终保持展开；工具按钮以 `mousedown` 保持文本焦点，禁止用 `pointerdown.preventDefault()` 吞掉 iOS 的点击事件 | `HappyComposer.tsx`、`ComposerButtons.tsx` |
| 多行输入框 | 展开态文本行使用自适应 grid 行；超过一行时只能向上扩展，绝不覆盖下方工具、发送或停止按钮 | `HappyComposer.tsx` |
| 键盘态操作菜单 | 工具、权限、技能、上下文和设置菜单必须留在 `VisualViewport` 内；空间不足时可滚动，不得要求先收起键盘 | `ComposerButtons.tsx`、`HappyComposer.tsx` |
| 最新消息可见性 | 线程必须预留实际测得的底部 overlay 高度，消息不得被输入区遮挡 | `SessionChat.tsx`、`HappyThread.tsx` |
| 底部动态入口（排队 / 计划 / Git） | 所有入口独立悬浮在输入框 overlay 上方；不得改变输入框容器高度、底部锚点或键盘间距；线程单独预留入口实际高度。排队详情必须通过 Portal 抽屉展示，抽屉不得进入输入框文档流；SHAPI 与原生 Codex 共用底部 dock 与排队入口命中区域 | `SessionChat.tsx`、`CodexSessionContextPage.tsx`、`SessionDetailBottomDock.tsx`、`SessionDetailQueueTrigger.tsx`、`QueuedMessagesBar.tsx`、`HappyComposer.tsx`、`HappyThread.tsx` |

## 唯一入口

- 思考反馈只在消息线程末尾独占一行；输入框与状态栏不再渲染思考动画，也不得保留思考占位高度。移除原 24px 占位后，排队 / 计划 / Git 入口继续跟随实测 dock 高度，不额外补偿旧间距。（2026-09-07 用户确认）

- CSS 数值只能通过 `web/src/index.css` 中的 **Mobile layout contract** 变量维护。
- 所有渲染组件必须使用 canonical `--app-safe-area-top/right/bottom/left`（输入框可使用由其派生的 composer token）；`env(safe-area-inset-*)` 只允许出现在 `index.css` 的变量定义和 `useViewportHeight.ts` 的浏览器探针中。这样 standalone 的 50px/34px 兜底不会被二级页面或浮层绕过。
- 顶部外层样式只能通过 `web/src/lib/mobileLayoutContract.ts` 的 `mobileLayoutHeaderShellStyle` 进入 `SessionHeader`。
- 浮动标题栏的全宽透明 shell 必须 `pointer-events: none`；左侧操作胶囊、右侧按钮和弹层自行显式 `pointer-events: auto`。不得用透明全宽命中层拦截消息线程的手势。
- 非模态 Toast 不得覆盖标题栏操作区；它必须通过 `--app-toast-top` 从 `--app-safe-area-top + 5rem` 之后出现。模态弹层仍可按预期阻断操作。
- 消息线程必须保持 edge-to-edge；初始顶部留白只能由 `HappyThread.tsx` 的 `getThreadContentPadding` 维护。不得再给非滚动 root 加顶部 padding，否则消息无法从透明标题栏下方滚过。
- 组件不得为了“临时修一个问题”另加平行的底部 `padding`、`margin`、`bottom` 或 `backdrop-filter` 覆盖这些规则。
- `data-ios-system-top-chrome="unreachable"` 只能由 `useViewportHeight.ts` 在 iOS standalone、`env(safe-area-inset-top)=0` 且检测到状态栏级顶部系统区时设置；该状态下禁止重新加 50px 顶部兜底。
- 输入框内的可操作按钮不得在 `pointerdown` 阶段调用 `preventDefault()`；iOS WebKit 可因此省略后续兼容鼠标/`click` 事件。若需保持键盘，统一在 `mousedown` 阶段保持 textarea 焦点。
- 标准输入区的设置菜单必须使用 `ToolbarMenu`；它以 `VisualViewport` 计算位置、宽度和可滚动高度，禁止改回相对输入框的绝对定位。
- 底部排队、计划和 Git 入口必须是 `SessionChat` 底部 overlay 的绝对定位子层；禁止将其可见性传给 `HappyComposer`，也禁止通过普通文档流或固定高度改变输入框位置。排队详情只能从该入口打开 Portal 抽屉。

## 修改流程（强制）

1. 先读取本文件，列出本次改动会触及的契约项。
2. 若会改变任一已验收不变量，必须先向产品方说明影响并取得**明确确认**；不能顺带改动。
3. 同一变更必须同时更新：实现、此文件、`scripts/check-mobile-layout-contract.ts` 和相关测试。不得只改检查来绕过规则。
4. 部署前必须通过：

   ```bash
   bun run test:mobile-layout
   bun typecheck
   bun run test:web
   ```

5. 涉及真实键盘/安全区时，还要在手机 PWA 或对应移动模拟器中依次验收：紧凑态、展开态、键盘态、消息发送后最新消息可见态。
6. 一个验收修复完成后先单独提交。后续部署不得夹带无关的未提交改动；若工作树非干净，必须列出并获得确认后才能部署。

## 自动部署闸门

`bun run test:mobile-layout` 由根测试命令执行，也在 `web` 生产构建前执行。它验证：

- 顶部透明且无毛玻璃；
- WebKit 系统顶部区被识别后不会叠加网页的 50px 顶部兜底；
- 键盘态展开输入框底部总间隔仍是 4px；
- 键盘态操作菜单仍由 `VisualViewport` 约束，所有菜单项可滚动触达；
- 顶部组件仍使用唯一入口；
- 页面、浮层和横向工具栏均未绕过 canonical safe-area 变量；
- 初始消息仍避开标题操作区，滚动消息仍可从透明顶部标题区下方经过；
- 消息线程仍预留测得的底部输入区高度。
- 底部排队、计划或 Git 入口显示/隐藏不会改变输入框底部锚点，且消息线程仍会预留入口高度；排队抽屉本身不会参与该高度计算。

因此，后续改动若把这些已验收状态改回去，测试或生产构建会失败，而不是静默部署。

## 聊天详情抽屉（2026-09-09 统一规则）

- 手机端（包括触屏手机横屏）文件、目录选择、Git 分支、问题选择、工具详情、终端、Diff、网页预览及 HAPI / 原生排队消息在**无文本输入状态**共用 Portal 底部抽屉；详情框桌面保持居中。安装引导、侧栏和普通确认框不在本次范围。
- **可编辑文本是例外**：会话详情内以文字编辑为主要目的的重命名、分组编辑、Git 新建/提交与问题的“其他/自由输入”必须使用共享 `BottomDrawer` 的 `inputDialog`，手机端不能成为下拉抽屉。文件浏览、Git 分支浏览等原有抽屉不能因为包含内联搜索框而整体变成弹窗；搜索仍在会跟随 `VisualViewport` 收缩的原抽屉内完成。输入弹窗必须使用独立的手机渲染分支，不能继承桌面 `DialogContent` 的 `left: 50%`、`translateX` 或居中进出动画；横向直接锚定 `safe-area + edge gap`，任何键盘状态都不得使用位置 transform。键盘出现后，弹窗下沿保持在键盘上方 `--app-mobile-input-dialog-keyboard-gap`，正文在弹窗内滚动，不能被键盘遮住。（2026-09-11 用户确认）
- 默认按内容自然长高，连同标题、底部操作和安全区，最高 **VisualViewport 的 70%**。目录/文件/网页可填满默认高度。用户上拖可展开到顶部安全区下方 **12px**；重新打开恢复默认档，内部导航保留当前档。
- 标题/把手上拖展开；展开态下拖先回到默认档，默认档下拖关闭；短拖/取消回弹；正文滚动不触发拖关。不再展示单独展开/收起图标按钮；把手支持键盘方向键及 Enter/空格切档。点击遮罩或 Escape 关闭。问题提交中禁止误关；关闭不提交，重开保留答案。（2026-09-09 用户调整）
- 进入与背景缩小 **500ms**；退出与背景/顶部恢复 **400ms**；展开收起与拖拽回弹 **300ms**（2026-09-09 用户调整）。退出期间保留正文，条件挂载额外预留 20ms 渲染余量，避免空壳。键盘变化持续使用 VisualViewport，不改输入框锚点。
- 背景缩放/圆角仅在模态打开时作视觉变换，不修改输入框布局和 dock 高度；关闭恢复；嵌套抽屉不得提前恢复。减少动态效果偏好关闭进出/缩放动画。
- 背景关闭恢复使用独立的对称缓入缓出曲线 `cubic-bezier(0.42, 0, 0.58, 1)`，避免沿用弹出曲线导致起步过快；背景缩放、圆角和网页底色同步，关闭总时长仍为 400ms。抽屉本体及拖拽回弹时长不变。
- 顶部融合试验（2026-09-09）：抽屉打开时根画布和背景底色同步淡化 500ms，临时更新 theme-color 尝试融合系统顶栏；关闭恢复当前主题，嵌套抽屉共享状态。不得修改安全区数值、状态栏显示模式、标题和输入框位置；系统顶栏的响应由 iOS 决定，需真机验收。
- 网页预览不得绕过网站的嵌入限制；正文直接展示网页，不常驻嵌入限制说明或“在浏览器打开”文字按钮。标题旁提供复制链接图标：普通网页复制原链接，本地服务复制可重新连接的完整 HAPI 入口，不复制短期嵌入凭证。会话跳转、下载、组合键和自定义协议不被普通网页预览拦截。（2026-09-06 确认）

- 本地 HTTP(S) 服务点击后直接在抽屉加载，不先弹说明或强制新开页面；连接失败在抽屉报错并可重试。嵌入地址由已认证 API 签发，仅允许配置的可信 Web 来源；不能放开登录隔离换取可嵌入性。
- 公网网站确认禁止嵌入时只显示“页面无法预览”，不自动抓取替代正文、不执行网页脚本或转发登录凭证。本地转发不受此检查接口影响。可嵌入网页铺满抽屉正文。（2026-09-09 用户确认）
- 文件浏览抽屉单独收紧标题与正文顶部间距；保留目录和关闭按钮点击面积，不改变其他抽屉或安全区。
