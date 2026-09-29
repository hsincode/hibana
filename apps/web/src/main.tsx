import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { prefetch } from "./api";
import "./styles.css";

// 描画前に投げておく。React のマウントを待たない分、初回表示が 1 往復ぶん速い。
prefetch(["/api/me", "/api/guilds", "/api/catalog"]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
