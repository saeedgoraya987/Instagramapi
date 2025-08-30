// Vercel Node.js Serverless Function: GET /api/profile/[username]
// Scrapes ONLY PUBLIC info; extracts emails/phones if the user posted them publicly.

import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";

// ---- Vercel Function Config ----
export const config = {
  memory: 1024,
  maxDuration: 60
};

// --- helpers ---
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d[\d()\-\s]{7,}\d)/g;
const uniq = (arr) => [...new Set(arr.filter(Boolean))];
const normalizePhone = (s) => s.replace(/[^\d+]/g, "");

// Optional: protect the endpoint with a token
function checkAuth(req) {
  const required = process.env.IG_OSINT_TOKEN || "";
  if (!required) return true;
  const supplied =
    (req.query.token || req.headers["x-api-key"] || "").toString();
  return supplied === required;
}

export default async function handler(req, res) {
  const { username } = req.query;

  if (!checkAuth(req)) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  if (!username || typeof username !== "string") {
    res.status(400).json({ ok: false, error: "username required in path" });
    return;
  }

  let browser;
  try {
    const executablePath = await chromium.executablePath();

    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath,
      headless: chromium.headless,
      defaultViewport: { width: 1200, height: 800 }
    });

    const page = await browser.newPage();

    // Use mobile UA; tends to avoid extra interstitials
    await page.setUserAgent(
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    const url = `https://www.instagram.com/${encodeURIComponent(username)}/?hl=en`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Parse minimal fields from DOM/meta
    const basic = await page.evaluate(() => {
      const out = {
        title: document.title || null,
        bioText: null,
        profilePic: null,
        externalUrl: null,
        fullName: null
      };
      const ld = document.querySelector('script[type="application/ld+json"]');
      if (ld) {
        try {
          const json = JSON.parse(ld.textContent || "{}");
          out.fullName = json?.name || null;
          out.profilePic = json?.image || null;
          if (typeof json?.description === "string") out.bioText = json.description;
        } catch {}
      }
      const ogImg = document.querySelector('meta[property="og:image"]')?.content || null;
      if (!out.profilePic && ogImg) out.profilePic = ogImg;
      const ogDesc = document.querySelector('meta[property="og:description"]')?.content || null;
      if (!out.bioText && ogDesc) out.bioText = ogDesc;
      return out;
    });

    // Try to extract richer info from the boot JSON if present
    const enriched = await page.evaluate(() => {
      const script = document.querySelector("#__NEXT_DATA__");
      if (!script) return null;
      try {
        const json = JSON.parse(script.textContent || "{}");

        const walk = (obj) => {
          if (!obj || typeof obj !== "object") return null;
          if (obj.username && ("is_verified" in obj || "is_private" in obj)) return obj;
          for (const k of Object.keys(obj)) {
            const found = walk(obj[k]);
            if (found) return found;
          }
          return null;
        };

        const user = walk(json);
        if (!user) return null;

        const captions = Array.isArray(user.edge_owner_to_timeline_media?.edges)
          ? user.edge_owner_to_timeline_media.edges
              .slice(0, 6)
              .map((e) => e?.node?.edge_media_to_caption?.edges?.[0]?.node?.text || "")
          : [];

        return {
          fullName: user.full_name ?? null,
          isVerified: user.is_verified ?? null,
          isPrivate: user.is_private ?? null,
          profilePic: user.profile_pic_url_hd || user.profile_pic_url || null,
          followers:
            typeof user.edge_followed_by?.count === "number"
              ? user.edge_followed_by.count
              : typeof user.follower_count === "number"
              ? user.follower_count
              : null,
          following:
            typeof user.edge_follow?.count === "number"
              ? user.edge_follow.count
              : typeof user.following_count === "number"
              ? user.following_count
              : null,
          postsCount:
            typeof user.edge_owner_to_timeline_media?.count === "number"
              ? user.edge_owner_to_timeline_media.count
              : typeof user.media_count === "number"
              ? user.media_count
              : null,
          recentCaptions: captions
        };
      } catch {
        return null;
      }
    });

    const bioText = [basic.bioText].concat(enriched?.bioText || []).filter(Boolean).join("\n");
    const captions = (enriched?.recentCaptions || []).filter(Boolean);

    const emails = uniq((bioText + "\n" + captions.join("\n")).match(EMAIL_RE) || []);
    const phones = uniq(((bioText + "\n" + captions.join("\n")).match(PHONE_RE) || []).map(normalizePhone));

    res.setHeader("Cache-Control", "s-maxage=180, stale-while-revalidate=600");
    res.status(200).json({
      ok: true,
      username,
      full_name: enriched?.fullName ?? basic.fullName ?? null,
      biography: basic.bioText || null,
      external_url: null,
      profile_pic_url: enriched?.profilePic ?? basic.profilePic ?? null,
      is_private: enriched?.isPrivate ?? null,
      is_verified: enriched?.isVerified ?? null,
      followers: enriched?.followers ?? null,
      following: enriched?.following ?? null,
      posts_count: enriched?.postsCount ?? null,
      emails_found: emails,
      phones_found: phones
    });
  } catch (err) {
    console.error("IG OSINT error:", err);
    res.status(503).json({
      ok: false,
      error: "Fetch failed (private profile, rate-limited, or layout changed)"
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}
