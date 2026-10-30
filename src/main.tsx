import React from "react";
import { hydrateRoot } from "react-dom/client";
import "./i18n";
import App from "./App";
import { ThemeProvider } from "./contexts";
import "./App.css";

/**
 * 生产环境屏蔽 WebView2 自带的浏览器右键菜单。
 *
 * 那个菜单（返回 / 刷新 / 另存为 / 打印 / 更多工具 / 检查）是 WebView2 的内置行为，
 * 不是我们渲染的 DOM，对用户毫无意义，还会让人以为这是个网页。
 * Tauri 2.9 的窗口构建器没有透出 wry 的 `with_default_context_menus`，
 * 所以走页面层：WebView2 只在 `contextmenu` 未被取消时才弹默认菜单。
 *
 * 几处例外：
 * - 输入框放行：那边要右键粘贴 / 剪切，WebView2 弹的是带上下文项的菜单，
 *   比全局那个“返回 / 刷新”合理得多；`contenteditable=""` 等价于 true，用 :not([contenteditable="false"]) 覆盖。
 * - 选中文字时放行：右键“复制”是最自然的动作，路径、日志都得能拷出去。
 * - 开发环境整体放行：应用里没有别的 devtools 入口，控制台只能靠菜单里的“检查”打开。
 *   以后若要给某块区域做自定义右键菜单，也在这个判断里放行。
 */
if (import.meta.env.PROD) {
  window.addEventListener(
    "contextmenu",
    (event) => {
      const target = event.target;
      const isEditable =
        target instanceof Element &&
        target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])');
      const hasSelection = !window.getSelection()?.isCollapsed;
      if (!isEditable && !hasSelection) {
        event.preventDefault();
      }
    },
    true,
  );
}

// 静态启动屏已先于 React 绘制，使用 hydration 接管原节点，避免动画重新挂载播放。
hydrateRoot(document.getElementById("root") as HTMLElement,
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
