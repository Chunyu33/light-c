import React from "react";
import { hydrateRoot } from "react-dom/client";
import "./i18n";
import App from "./App";
import { ThemeProvider } from "./contexts";
import "./App.css";

// 静态启动屏已先于 React 绘制，使用 hydration 接管原节点，避免动画重新挂载播放。
hydrateRoot(document.getElementById("root") as HTMLElement,
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
