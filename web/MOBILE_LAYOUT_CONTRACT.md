# 移动端布局防回归契约

这是**产品验收后的强制规则**，适用于会话页顶部、安全区、消息区和底部输入区。它的目标不是让后续改动“尽量别影响”，而是让已验收的行为成为可检查、不可静默回退的契约。

## 已验收状态

| 区域 | 不变量 | 实现入口 |
| --- | --- | --- |
| 顶部外层 | 透明；`backdrop-filter: none`；不得做整条毛玻璃 | `mobileLayoutContract.ts`、`SessionHeader.tsx` |
| 顶部操作 | 操作按钮所在的小胶囊可保留实色，以保证可读性；它不等于整条顶部背景 | `SessionHeader.tsx` |
| iOS 顶部安全区 | standalone 模式通常最小 50px；若运行时确认顶部是 WebKit 绘制在 DOM 外的系统区，则不得再叠加这 50px，标题从可见网页视口开始 | `useViewportHeight.ts`、`index.css` |
| iOS 底部安全区 | standalone 模式最小 34px；普通触屏最小 12px | `index.css` |
| 展开输入框 + 键盘 | 额外上移 **4px**，不得被改为其他值 | `index.css` |
| 有内容的输入框 | 草稿非空时始终保持展开；工具按钮以 `mousedown` 保持文本焦点，禁止用 `pointerdown.preventDefault()` 吞掉 iOS 的点击事件 | `HappyComposer.tsx`、`ComposerButtons.tsx` |
| 最新消息可见性 | 线程必须预留实际测得的底部 overlay 高度，消息不得被输入区遮挡 | `SessionChat.tsx`、`HappyThread.tsx` |

## 唯一入口

- CSS 数值只能通过 `web/src/index.css` 中的 **Mobile layout contract** 变量维护。
- 顶部外层样式只能通过 `web/src/lib/mobileLayoutContract.ts` 的 `mobileLayoutHeaderShellStyle` 进入 `SessionHeader`。
- 组件不得为了“临时修一个问题”另加平行的底部 `padding`、`margin`、`bottom` 或 `backdrop-filter` 覆盖这些规则。
- `data-ios-system-top-chrome="unreachable"` 只能由 `useViewportHeight.ts` 在 iOS standalone、`env(safe-area-inset-top)=0` 且检测到状态栏级顶部系统区时设置；该状态下禁止重新加 50px 顶部兜底。
- 输入框内的可操作按钮不得在 `pointerdown` 阶段调用 `preventDefault()`；iOS WebKit 可因此省略后续兼容鼠标/`click` 事件。若需保持键盘，统一在 `mousedown` 阶段保持 textarea 焦点。

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
- 键盘态展开输入框仍是 4px 偏移；
- 顶部组件仍使用唯一入口；
- 消息线程仍预留测得的底部输入区高度。

因此，后续改动若把这些已验收状态改回去，测试或生产构建会失败，而不是静默部署。
