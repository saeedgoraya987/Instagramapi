// Serverless function: GET /api/profile/:username
// Returns public profile info + emails/phones found in bio and latest captions (public only)

import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";

// ---- tiny helpers ----
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d[\d()\-\s]{7,}\d)/g;

const uniq = (arr) => [...new Set(arr.filter(Boolean))];
const normalizePhone = (s) => s.replace(/[^\d+]/g, "");

export default async function handler(req, res) {
  const { username } = req.query;
  if (!username || typeof username !== "string") {
    res.status(400).json({ ok: false, error: "username required in path" });
    return;
  }

  // Simple auth (optional): set IG_OSINT_TOKEN in Vercel env and require ?token=...
  const requiredToken = process.env.IG_OSINT_TOKEN || "";
  if (requiredToken) {
    const supplied = (req.query.token || req.headers["x-api-key"] || "").toString();
    if (supplied !== requiredToken) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
  }

  let browser;
  try {
    // chromium on Vercel
    const exe = await chromium.executablePath();

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1200, height: 800 },
      executablePath: exe,
      headless: true
    });

    const page = await browser.newPage();

    // Pretend to be a mobile Chrome (often fewer interstitials)
    await page.setUserAgent(
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36"
    );

    // Light set of headers
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9"
    });

    const target = `https://www.instagram.com/${encodeURIComponent(username)}/?hl=en`;
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });

    // If Instagram throws a splash/login wall, we still try to parse __NEXT_DATA__ if present.
    // Extract core data from Next.js boot JSON
    const nextData = await page.evaluate(() => {
      const script = document.querySelector('#__NEXT_DATA__');
      if (!script) return null;
      try {
        return JSON.parse(script.textContent);
      } catch {
        return null;
      }
    });

    if (!nextData) {
      // Sometimes IG delays; try a short wait + retry once
      await page.waitForTimeout(1500);
    }

    const data = await page.evaluate(() => {
      const out = {
        title: document.title || null,
        bioText: null,
        profilePic: null,
        externalUrl: null,
        fullName: null,
        isVerified: null,
        isPrivate: null,
        followers: null,
        following: null,
        postsCount: null,
        recentCaptions: []
      };

      // 1) Try schema.org block for basics
      const ld = document.querySelector('script[type="application/ld+json"]');
      if (ld) {
        try {
          const json = JSON.parse(ld.textContent || "{}");
          if (json) {
            out.fullName = json.name || out.fullName;
            out.profilePic = json.image || out.profilePic;
            out.externalUrl = json.sameAs || out.externalUrl;
            // json.description sometimes contains bio
            if (typeof json.description === "string") out.bioText = json.description;
          }
        } catch {}
      }

      // 2) Try grabbing meta tags as fallback
      const d = (sel) => document.querySelector(sel)?.getAttribute("content") || null;
      if (!out.bioText) {
        // The OG:description typically includes "Follow X on Instagram: “bio…”."
        const ogDesc = d('meta[property="og:description"]');
        if (ogDesc) out.bioText = ogDesc;
      }
      if (!out.profilePic) out.profilePic = d('meta[property="og:image"]');

      return out;
    });

    // 3) Parse richer fields (counts/verified/private) from __NEXT_DATA__ if present
    const enriched = await page.evaluate(() => {
      const script = document.querySelector('#__NEXT_DATA__');
      if (!script) return null;
      try {
        const json = JSON.parse(script.textContent || "{}");
        // Heuristic traversal: Instagram changes keys often; we walk known places
        // Look for "user" or "account" shaped objects with username fields.
        let user = null;

        const deepFindUser = (obj) => {
          if (!obj || typeof obj !== "object") return null;
          if (
            obj.username &&
            (typeof obj.is_verified !== "undefined" || typeof obj.is_private !== "undefined")
          ) return obj;
          for (const k of Object.keys(obj)) {
            const found = deepFindUser(obj[k]);
            if (found) return found;
          }
          return null;
        };

        user = deepFindUser(json);

        if (!user) return null;
        return {
          fullName: user.full_name ?? null,
          isVerified: user.is_verified ?? null,
          isPrivate: user.is_private ?? null,
          profilePic: user.profile_pic_url_hd || user.profile_pic_url ?? null,
          followers: typeof user.edge_followed_by?.count === "number" ? user.edge_followed_by.count
                    : (typeof user.follower_count === "number" ? user.follower_count : null),
          following: typeof user.edge_follow?.count === "number" ? user.edge_follow.count
                    : (typeof user.following_count === "number" ? user.following_count : null),
          postsCount: typeof user.edge_owner_to_timeline_media?.count === "number"
                    ? user.edge_owner_to_timeline_media.count
                    : (typeof user.media_count === "number" ? user.media_count : null),
          // Captions are nested under edges if present in boot JSON
          recentCaptions: Array.isArray(user.edge_owner_to_timeline_media?.edges)
            ? user.edge_owner_to_timeline_media.edges
                .slice(0, 6)
                .map(e => e?.node?.edge_media_to_caption?.edges?.[0]?.node?.text || "")
            : []
        };
      } catch {
        return null;
      }
    });

    const bioText = [data.bioText, enriched?.bioText].filter(Boolean).join("\n");
    const captions = (enriched?.recentCaptions || []).filter(Boolean);

    // Extract emails/phones from bio + captions
    const emailMatches = (bioText + "\n" + captions.join("\n")).match(EMAIL_RE) || [];
    const phoneMatches = (bioText + "\n" + captions.join("\n")).match(PHONE_RE) || [];

    const emailsFound = uniq(emailMatches);
    const phonesFound = uniq(phoneMatches.map(normalizePhone));

    const payload = {
      ok: true,
      username,
      full_name: enriched?.fullName ?? data.fullName ?? null,
      biography: data.bioText || null,
      external_url: data.externalUrl || null,
      profile_pic_url: enriched?.profilePic ?? data.profilePic ?? null,
      is_private: enriched?.isPrivate ?? null,
      is_verified: enriched?.isVerified ?? null,
      followers: enriched?.followers ?? null,
      following: enriched?.following ?? null,
      posts_count: enriched?.postsCount ?? null,
      emails_found: emailsFound,
      phones_found: phonesFound,
      // we don’t return actual captions to keep payload small; add if needed
    };

    res.setHeader("Cache-Control", "s-maxage=180, stale-while-revalidate=600");
    res.status(200).json(payload);
  } catch (err) {
    console.error("IG OSINT error:", err);
    // Common failures: 404 (no such user) or wall; respond generically
    res.status(503).json({ ok: false, error: "Fetch failed (profile may be private/blocked or rate-limited)" });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
        }
