import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { loadCodeData } from "./services/codeData";

// 预加载内置数据（代码表/词典/单位），编辑器与检查器依赖
void loadCodeData();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
