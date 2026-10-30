// アイコンと OGP 画像を、brand/ の元から public/ に書き出す（判断記録: #142）。
// 使い方: apps/web で `bun brand/render.ts`。Playwright の Chromium を使う（画面テストと同じもの）。
// OGP 画像の日本語は端末の書体で描かれるので、書き出した環境を brand/README.md に残す。
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const browser = await chromium.launch();
try {
  for (const [size, out] of [
    [512, "../public/icon-512.png"],
    [180, "../public/apple-touch-icon.png"],
  ] as const) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
    });
    await page.goto(`file://${here("./icon.svg")}`);
    await page.screenshot({ path: here(out) });
    await page.close();
  }
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
  });
  await page.goto(`file://${here("./og.html")}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: here("../public/og.png") });
  await page.close();
} finally {
  await browser.close();
}
