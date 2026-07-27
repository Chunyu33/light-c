import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import App from "./App";
import { ThemeProvider } from "./contexts";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
