import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";

export const config = {
  runtime: "nodejs18.x",
  memory: 1024,
  maxDuration: 60,
};

export default async function handler(req, res) {
  const { username } = req.query;

  if (!username) {
    res.status(400).json({ ok: false, error: "Missing username" });
    return;
  }

  let browser;
  try {
    const executablePath = await chromium.executablePath();

    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: executablePath || "/usr/bin/chromium-browser",
      headless: true, // force headless
      defaultViewport: chromium.defaultViewport,
    });

    const page = await browser.newPage();
    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Quick test: just get page title
    const title = await page.title();

    res.status(200).json({
      ok: true,
      username,
      title,
    });
  } catch (err) {
    console.error("Handler error:", err);
    res.status(500).json({ ok: false, error: err.message || "Internal Error" });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}
