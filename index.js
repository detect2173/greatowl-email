/**
 * Great Owl Marketing — Cloudflare Worker
 *
 * Routes:
 *   POST /subscribe          — opt-in form submission
 *   GET  /unsubscribe?token= — one-click unsubscribe
 *   POST /broadcast          — send email to full list (protected)
 *   GET  /stats              — subscriber count (protected)
 *   GET  /*                  — serve static landing page
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ─── Router ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/subscribe") {
      return handleSubscribe(request, env);
    }

    if (request.method === "GET" && url.pathname === "/unsubscribe") {
      return handleUnsubscribe(request, env);
    }

    if (request.method === "POST" && url.pathname === "/broadcast") {
      return handleBroadcast(request, env);
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      return handleStats(request, env);
    }

    // Serve static assets (landing page)
    return env.ASSETS.fetch(request);
  },
};

// ─── Subscribe ────────────────────────────────────────────────────────────────

async function handleSubscribe(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  const firstName = (body.first_name || "").trim();
  const source = body.source || "landing_page";

  if (!isValidEmail(email)) {
    return jsonResponse({ error: "Invalid email address" }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";

  // Check for duplicate
  const existing = await env.DB.prepare(
    "SELECT id, status FROM subscribers WHERE email = ?"
  ).bind(email).first();

  if (existing) {
    if (existing.status === "unsubscribed") {
      // Re-subscribe them
      await env.DB.prepare(
        "UPDATE subscribers SET status='active', subscribed_at=CURRENT_TIMESTAMP WHERE email=?"
      ).bind(email).run();
      return jsonResponse({ message: "Welcome back! You've been resubscribed." });
    }
    return jsonResponse({ message: "You're already on the list!" });
  }

  // Insert new subscriber
  const result = await env.DB.prepare(
    `INSERT INTO subscribers (email, first_name, source, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(email, firstName, source, ip, ua).run();

  const subscriberId = result.meta.last_row_id;

  // Generate unsubscribe token
  const token = await generateToken(email, env.UNSUBSCRIBE_SECRET);

  // Send welcome email (AI-generated, non-blocking)
  const ctx_promise = sendWelcomeEmail(email, firstName, subscriberId, token, env);
  // Use waitUntil so the Worker doesn't close before email is sent
  // (handled in the fetch context — pass ctx if needed)

  await ctx_promise;

  return jsonResponse({
    message: "You're on the list! Check your inbox for a welcome email.",
  });
}

// ─── Unsubscribe ──────────────────────────────────────────────────────────────

async function handleUnsubscribe(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const email = url.searchParams.get("email");

  if (!token || !email) {
    return new Response("Invalid unsubscribe link.", { status: 400 });
  }

  const expected = await generateToken(email, env.UNSUBSCRIBE_SECRET);
  if (token !== expected) {
    return new Response("Invalid or expired unsubscribe link.", { status: 403 });
  }

  await env.DB.prepare(
    "UPDATE subscribers SET status='unsubscribed' WHERE email=?"
  ).bind(email.toLowerCase()).run();

  return new Response(unsubscribePage(), {
    headers: { "Content-Type": "text/html" },
  });
}

// ─── Broadcast (Admin) ────────────────────────────────────────────────────────

async function handleBroadcast(request, env) {
  // Simple API key protection — set BROADCAST_KEY as a secret
  const authHeader = request.headers.get("Authorization") || "";
  if (authHeader !== `Bearer ${env.BROADCAST_KEY}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const { subject, html, text, tag } = body;
  if (!subject || !html) {
    return jsonResponse({ error: "subject and html are required" }, 400);
  }

  // Fetch active subscribers (optionally filtered by tag)
  let query = "SELECT id, email, first_name FROM subscribers WHERE status='active'";
  const params = [];
  if (tag) {
    query += " AND tags LIKE ?";
    params.push(`%${tag}%`);
  }

  const { results } = await env.DB.prepare(query).bind(...params).all();

  let sent = 0;
  let failed = 0;

  for (const subscriber of results) {
    const token = await generateToken(subscriber.email, env.UNSUBSCRIBE_SECRET);
    const unsubUrl = `${env.SITE_URL}/unsubscribe?email=${encodeURIComponent(subscriber.email)}&token=${token}`;

    const emailHtml = html + emailFooter(unsubUrl);

    const ok = await sendViaResend({
      to: subscriber.email,
      subject,
      html: emailHtml,
      text: text || "",
      env,
    });

    if (ok) {
      sent++;
      await env.DB.prepare(
        "INSERT INTO email_log (subscriber_id, email, subject, type) VALUES (?, ?, ?, 'broadcast')"
      ).bind(subscriber.id, subscriber.email, subject).run();
    } else {
      failed++;
    }
  }

  return jsonResponse({ sent, failed, total: results.length });
}

// ─── Stats (Admin) ────────────────────────────────────────────────────────────

async function handleStats(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (key !== env.BROADCAST_KEY) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const total = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM subscribers WHERE status='active'"
  ).first();

  const today = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM subscribers WHERE status='active' AND DATE(subscribed_at) = DATE('now')"
  ).first();

  const thisWeek = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM subscribers WHERE status='active' AND subscribed_at >= DATE('now', '-7 days')"
  ).first();

  return jsonResponse({
    active_subscribers: total.count,
    signed_up_today: today.count,
    signed_up_this_week: thisWeek.count,
  });
}

// ─── Email: Welcome (AI-generated via Claude API) ─────────────────────────────

async function sendWelcomeEmail(email, firstName, subscriberId, token, env) {
  const name = firstName || "there";
  const unsubUrl = `${env.SITE_URL}/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;

  // Ask Claude to write a personalized welcome email
  let aiBody = "";
  try {
    const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: `Write a short, warm, professional welcome email body for a new subscriber named ${name} who just joined the Great Owl Marketing email list. 

Great Owl Marketing helps businesses grow through smart marketing strategy and execution.

Requirements:
- Address them by first name (${name})
- 2-3 short paragraphs
- Conversational but professional tone
- Tell them what to expect (marketing insights, product updates, exclusive offers)
- End with a clear, encouraging call to action to reply and say hi
- NO subject line — just the body
- Plain text only (no markdown, no HTML tags)`,
          },
        ],
      }),
    });

    if (aiResponse.ok) {
      const aiData = await aiResponse.json();
      aiBody = aiData.content[0]?.text || "";
    }
  } catch (e) {
    console.error("Claude API error:", e);
  }

  // Fallback if AI fails
  if (!aiBody) {
    aiBody = `Hi ${name},\n\nWelcome to Great Owl Marketing! We're thrilled to have you.\n\nYou'll be hearing from us with marketing insights, product updates, and exclusive offers — all designed to help you grow.\n\nReply to this email anytime and say hi. We read every message.\n\nWarmly,\nThe Great Owl Marketing Team`;
  }

  // Convert plain text to simple HTML
  const htmlBody = aiBody
    .split("\n\n")
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");

  const html = emailTemplate({
    preheader: `Welcome to Great Owl Marketing, ${name}!`,
    body: htmlBody,
    unsubUrl,
  });

  const ok = await sendViaResend({
    to: email,
    subject: `Welcome to Great Owl Marketing, ${name}! 🦉`,
    html,
    text: aiBody,
    env,
  });

  if (ok) {
    await env.DB.prepare(
      "INSERT INTO email_log (subscriber_id, email, subject, type) VALUES (?, ?, ?, 'welcome')"
    ).bind(subscriberId, email, `Welcome to Great Owl Marketing, ${name}! 🦉`).run();
  }
}

// ─── Resend API ───────────────────────────────────────────────────────────────

async function sendViaResend({ to, subject, html, text, env }) {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`,
        to: [to],
        subject,
        html,
        text,
      }),
    });

    return response.ok;
  } catch (e) {
    console.error("Resend error:", e);
    return false;
  }
}

// ─── Email Templates ──────────────────────────────────────────────────────────

function emailTemplate({ preheader, body, unsubUrl }) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Great Owl Marketing</title>
</head>
<body style="margin:0;padding:0;background:#f5f0eb;font-family:Georgia,serif;">
<div style="display:none;max-height:0;overflow:hidden;">${preheader}</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0eb;padding:40px 20px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:4px;overflow:hidden;">
      <!-- Header -->
      <tr>
        <td style="background:#1a1a1a;padding:32px 48px;">
          <p style="margin:0;color:#c9a84c;font-size:22px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">Great Owl Marketing</p>
        </td>
      </tr>
      <!-- Body -->
      <tr>
        <td style="padding:48px;color:#1a1a1a;font-size:16px;line-height:1.7;">
          ${body}
        </td>
      </tr>
      <!-- Footer -->
      <tr>
        <td style="background:#f5f0eb;padding:24px 48px;font-size:12px;color:#888;text-align:center;line-height:1.6;">
          <p style="margin:0 0 8px;">Great Owl Marketing · greatowlmarketing.com</p>
          <p style="margin:0;">You're receiving this because you subscribed at greatowlmarketing.com.
          <a href="${unsubUrl}" style="color:#888;">Unsubscribe</a></p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function emailFooter(unsubUrl) {
  return `<br><hr style="border:none;border-top:1px solid #eee;margin:32px 0;">
<p style="font-size:12px;color:#888;text-align:center;">
  Great Owl Marketing · greatowlmarketing.com<br>
  <a href="${unsubUrl}" style="color:#888;">Unsubscribe</a>
</p>`;
}

function unsubscribePage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribed</title>
<style>body{font-family:Georgia,serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f0eb;}
.box{text-align:center;padding:48px;background:#fff;border-radius:4px;max-width:400px;}
h1{color:#1a1a1a;font-size:28px;margin-bottom:16px;}
p{color:#555;line-height:1.6;}
a{color:#c9a84c;}</style></head>
<body><div class="box">
<h1>You've been unsubscribed.</h1>
<p>You won't receive any more emails from Great Owl Marketing.</p>
<p>Changed your mind? <a href="/">Subscribe again</a>.</p>
</div></body></html>`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function generateToken(email, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(email));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
