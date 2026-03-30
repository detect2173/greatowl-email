import {sequence} from './sequence.js';

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
    async scheduled(event, env, ctx) {
        const cron = event.cron;
        if (cron === "0 9 * * *") {
            const day = new Date().getDay();
            if (day === 0) {
                await generateWeeklyPosts(env);
            } else {
                await runSequence(env);
            }
        } else if (cron === "0 12 * * *") {
            await publishScheduledPosts(env);
        }
    },

    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, {headers: CORS_HEADERS});
        }

        if (request.method === "POST" && url.pathname === "/subscribe") {
            return handleSubscribe(request, env, ctx);
        }

        if (request.method === "GET" && url.pathname === "/unsubscribe") {
            return handleUnsubscribe(request, env);
        }

        if (request.method === "GET" && url.pathname === "/recommends/systeme") {
            return Response.redirect("https://systeme.io/?sa=sa00434165389d6671287c296be0b041826abd23d5", 302);
        }

        if (request.method === "POST" && url.pathname === "/broadcast") {
            return handleBroadcast(request, env);
        }

        if (request.method === "GET" && url.pathname === "/stats") {
            return handleStats(request, env);
        }

        if (request.method === "GET" && url.pathname === "/dashboard") {
            return handleDashboard(request, env);
        }

        if (request.method === "POST" && url.pathname === "/posts/approve") {
            return handleApprovePost(request, env);
        }

        if (request.method === "POST" && url.pathname === "/posts/reject") {
            return handleRejectPost(request, env);
        }

        if (request.method === "POST" && url.pathname === "/posts/generate") {
            return handleGeneratePosts(request, env, ctx);
        }

        // Serve static assets (landing page)
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }
        return new Response('Not found', {status: 404});
    },
};

// ─── Subscribe ────────────────────────────────────────────────────────────────

async function handleSubscribe(request, env, ctx) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({error: "Invalid JSON"}, 400);
    }

    const email = (body.email || "").trim().toLowerCase();
    const firstName = (body.first_name || "").trim();
    const source = body.source || "landing_page";

    if (!isValidEmail(email)) {
        return jsonResponse({error: "Invalid email address"}, 400);
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
            return jsonResponse({message: "Welcome back! You've been resubscribed."});
        }
        return jsonResponse({message: "You're already on the list!"});
    }

    // Insert new subscriber
    const result = await env.DB.prepare(
        `INSERT INTO subscribers (email, first_name, source, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?)`
    ).bind(email, firstName, source, ip, ua).run();

    const subscriberId = result.meta.last_row_id;

    // Generate unsubscribe token
    const token = await generateToken(email, env.UNSUBSCRIBE_SECRET);

    // Send welcome email non-blocking — don't await it
    ctx.waitUntil(sendWelcomeEmail(email, firstName, subscriberId, token, env));

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
        return new Response("Invalid unsubscribe link.", {status: 400});
    }

    const expected = await generateToken(email, env.UNSUBSCRIBE_SECRET);
    if (token !== expected) {
        return new Response("Invalid or expired unsubscribe link.", {status: 403});
    }

    await env.DB.prepare(
        "UPDATE subscribers SET status='unsubscribed' WHERE email=?"
    ).bind(email.toLowerCase()).run();

    return new Response(unsubscribePage(), {
        headers: {"Content-Type": "text/html"},
    });
}

// ─── Broadcast (Admin) ────────────────────────────────────────────────────────

async function handleBroadcast(request, env) {
    // Simple API key protection — set BROADCAST_KEY as a secret
    const authHeader = request.headers.get("Authorization") || "";
    if (authHeader !== `Bearer ${env.BROADCAST_KEY}`) {
        return jsonResponse({error: "Unauthorized"}, 401);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({error: "Invalid JSON"}, 400);
    }

    const {subject, html, text, tag} = body;
    if (!subject || !html) {
        return jsonResponse({error: "subject and html are required"}, 400);
    }

    // Fetch active subscribers (optionally filtered by tag)
    let query = "SELECT id, email, first_name FROM subscribers WHERE status='active'";
    const params = [];
    if (tag) {
        query += " AND tags LIKE ?";
        params.push(`%${tag}%`);
    }

    const {results} = await env.DB.prepare(query).bind(...params).all();

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

    return jsonResponse({sent, failed, total: results.length});
}

// ─── Stats (Admin) ────────────────────────────────────────────────────────────

async function handleStats(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");

    if (key !== env.BROADCAST_KEY) {
        return jsonResponse({error: "Unauthorized"}, 401);
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
- Include this exact HTML link near the top after greeting them, on its own line: '<a href="https://greatowlmarketing.com/solopreneur-marketing-stack.pdf" style="color:#c9a84c;font-weight:bold;">Download Your Free Guide →</a>'
- Sign off with "Warmly," followed by "John" and "Great Owl Marketing" on separate lines. Never use placeholder text like [Your name].
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

async function sendViaResend({to, subject, html, text, env}) {
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

function emailTemplate({preheader, body, unsubUrl}) {
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
        headers: {...CORS_HEADERS, "Content-Type": "application/json"},
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
        {name: "HMAC", hash: "SHA-256"},
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(email));
    return Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32);
}

// ─── Sequence Cron ────────────────────────────────────────────────────────────

async function runSequence(env) {
    const {results: subscribers} = await env.DB.prepare(
        "SELECT id, email, first_name, subscribed_at FROM subscribers WHERE status='active'"
    ).all();

    for (const subscriber of subscribers) {
        const subscribedAt = new Date(subscriber.subscribed_at);
        const now = new Date();
        const daysSinceSubscribed = Math.floor(
            (now - subscribedAt) / (1000 * 60 * 60 * 24)
        );

        for (const email of sequence) {
            if (daysSinceSubscribed < email.day) continue;

            const alreadySent = await env.DB.prepare(
                "SELECT id FROM sequence_log WHERE subscriber_id=? AND day=?"
            ).bind(subscriber.id, email.day).first();

            if (alreadySent) continue;

            const name = firstName
                ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
                : 'there';
            const token = await generateToken(subscriber.email, env.UNSUBSCRIBE_SECRET);
            const unsubUrl = `${env.SITE_URL}/unsubscribe?email=${encodeURIComponent(subscriber.email)}&token=${token}`;

            const text = email.text.replace(/{first_name}/g, name);
            const htmlBody = text
                .split('\n\n')
                .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
                .join('');

            const html = emailTemplate({
                preheader: email.subject,
                body: htmlBody,
                unsubUrl,
            });

            const ok = await sendViaResend({
                to: subscriber.email,
                subject: email.subject,
                html,
                text,
                env,
            });

            if (ok) {
                await env.DB.prepare(
                    "INSERT INTO sequence_log (subscriber_id, day) VALUES (?, ?)"
                ).bind(subscriber.id, email.day).run();

                await env.DB.prepare(
                    "INSERT INTO email_log (subscriber_id, email, subject, type) VALUES (?, ?, ?, 'sequence')"
                ).bind(subscriber.id, subscriber.email, email.subject).run();
            }
        }
    }
}

// ─── Content Generation ───────────────────────────────────────────────────────

async function generateWeeklyPosts(env) {
    const postTypes = [
        {
            type: "educational",
            prompt: "Write a short, punchy educational social media post about a marketing tip for solopreneurs. Keep it under 200 words. End with a question to drive engagement. No hashtags."
        },
        {
            type: "tool",
            prompt: `Write a short social media post recommending Systeme.io as a free marketing tool for solopreneurs. Keep it under 150 words. Be genuine and specific about one benefit. Include this link naturally: ${env.SITE_URL}/recommends/systeme. No hashtags.`
        },
        {
            type: "promotional",
            prompt: `Write a short social media post that drives solopreneurs to download a free guide called "The Solopreneur's Marketing Stack" at ${env.SITE_URL}. Keep it under 150 words. Focus on the value, not the sell. No hashtags.`
        },
        {
            type: "educational",
            prompt: "Write a short, punchy educational social media post about email marketing for solopreneurs. Keep it under 200 words. End with a question to drive engagement. No hashtags."
        },
        {
            type: "educational",
            prompt: "Write a short social media post about a common marketing mistake solopreneurs make and how to fix it. Keep it under 200 words. No hashtags."
        },
        {
            type: "promotional",
            prompt: `Write a short social media post about building an email list from scratch. Mention that ${env.SITE_URL} has a free guide. Keep it under 150 words. No hashtags.`
        },
        {
            type: "tool",
            prompt: "Write a short social media post recommending Claude AI (claude.ai) as a free writing tool for solopreneurs who need help with marketing content. Keep it under 150 words. Be specific about one use case. No hashtags."
        },
    ];

    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    for (let i = 0; i < postTypes.length; i++) {
        const {type, prompt} = postTypes[i];

        try {
            const response = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": env.CLAUDE_API_KEY,
                    "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify({
                    model: "claude-sonnet-4-20250514",
                    max_tokens: 300,
                    messages: [{role: "user", content: prompt}],
                }),
            });

            if (response.ok) {
                const data = await response.json();
                const content = data.content[0]?.text || "";

                // Generate image for this post
                const imageUrl = await generatePostImage(content, type, env);

                // Schedule for the corresponding day next week at noon
                const scheduledFor = new Date();
                scheduledFor.setDate(scheduledFor.getDate() + (i + 1));
                scheduledFor.setHours(12, 0, 0, 0);

                await env.DB.prepare(
                    "INSERT INTO posts (content, platform, status, post_type, scheduled_for, image_url) VALUES (?, 'facebook', 'pending', ?, ?, ?)"
                ).bind(content, type, scheduledFor.toISOString(), imageUrl).run();
            }
        } catch (e) {
            console.error(`Error generating post ${i}:`, e);
        }
    }

    // Email notification with posts to review
    await notifyPostsReady(env);
}

async function notifyPostsReady(env) {
    const {results} = await env.DB.prepare(
        "SELECT * FROM posts WHERE status='pending' ORDER BY scheduled_for ASC LIMIT 7"
    ).all();

    if (!results.length) return;

    let emailBody = `<h2 style="color:#c9a84c;">Your Weekly Posts Are Ready to Review</h2>`;
    emailBody += `<p>Go to your dashboard to approve or edit: <a href="${env.SITE_URL}/dashboard?key=${env.BROADCAST_KEY}">${env.SITE_URL}/dashboard</a></p>`;

    for (const post of results) {
        emailBody += `
      <div style="border:1px solid #333;padding:16px;margin:16px 0;border-radius:4px;">
        <p style="color:#888;font-size:12px;">${post.post_type.toUpperCase()} — Scheduled: ${new Date(post.scheduled_for).toDateString()}</p>
        <p>${post.content.replace(/\n/g, '<br>')}</p>
        <a href="${env.SITE_URL}/dashboard?key=${env.BROADCAST_KEY}" style="background:#c9a84c;color:#000;padding:8px 16px;text-decoration:none;border-radius:3px;">Review Posts</a>
      </div>`;
    }

    await sendViaResend({
        to: env.FROM_EMAIL,
        subject: "📋 Your 7 social posts are ready to review",
        html: emailBody,
        text: "Your weekly posts are ready. Visit your dashboard to review them.",
        env,
    });
}

async function publishScheduledPosts(env) {
    // Check token expiry and warn
    const expiryDate = new Date('2026-05-28');
    const today = new Date();
    const daysUntilExpiry = Math.floor((expiryDate - today) / (1000 * 60 * 60 * 24));

    if (daysUntilExpiry === 14 || daysUntilExpiry === 7 || daysUntilExpiry === 3 || daysUntilExpiry === 1) {
        await sendViaResend({
            to: env.FROM_EMAIL,
            subject: `⚠️ Facebook Token expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}`,
            html: `<p>Your Facebook Page Access Token expires in <strong>${daysUntilExpiry} days</strong> (May 28, 2026).</p>
             <p>Go to <a href="https://developers.facebook.com/tools/explorer/">Meta Graph API Explorer</a> to generate a new token and update it with:</p>
             <pre>wrangler secret put FB_PAGE_TOKEN</pre>`,
            text: `Your Facebook Page Access Token expires in ${daysUntilExpiry} days. Renew it at developers.facebook.com/tools/explorer/ then run: wrangler secret put FB_PAGE_TOKEN`,
            env,
        });
    }

    const now = new Date().toISOString();
    const {results} = await env.DB.prepare("SELECT * FROM posts WHERE status='approved' AND scheduled_for <= ? AND posted_at IS NULL").bind(now).all();

    for (const post of results) {
        const posted = await postToFacebook(post.content, post.image_url, env);
        if (posted) {
            await env.DB.prepare(
                "UPDATE posts SET status='posted', posted_at=? WHERE id=?"
            ).bind(now, post.id).run();
        }
    }
}

async function postToFacebook(content, imageUrl, env) {
    try {
        const body = {
            message: content,
            access_token: env.FB_PAGE_TOKEN,
        };

        if (imageUrl) {
            body.link = imageUrl;
        }

        const response = await fetch(
            `https://graph.facebook.com/v25.0/${env.FB_PAGE_ID}/feed`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }
        );
        return response.ok;
    } catch (e) {
        console.error("Facebook post error:", e);
        return false;
    }
}

// ─── Image Generation ─────────────────────────────────────────────────────────

async function generatePostImage(postContent, postType, env) {
    try {
        // Ask Claude for an image prompt
        const promptResponse = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": env.CLAUDE_API_KEY,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: "claude-sonnet-4-20250514",
                max_tokens: 100,
                messages: [{
                    role: "user",
                    content: `Write a short image generation prompt (under 50 words) for a professional marketing social media post image. The post is about: "${postContent.slice(0, 200)}". Style: modern, professional, clean. Dark background with gold accents. No text in the image. Abstract or conceptual visual only. Return only the prompt, nothing else.`
                }],
            }),
        });

        if (!promptResponse.ok) return null;
        const promptData = await promptResponse.json();
        const imagePrompt = promptData.content[0]?.text || "";

        // Generate image with Cloudflare AI
        const imageResponse = await env.AI.run(
            "@cf/black-forest-labs/flux-1-schnell",
            { prompt: imagePrompt }
        );

        if (!imageResponse) return null;

        // Store in R2
        const imageKey = `posts/${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
        await env.IMAGES.put(imageKey, imageResponse, {
            httpMetadata: { contentType: "image/png" },
        });

        return `https://pub-${env.R2_PUBLIC_URL}.r2.dev/${imageKey}`;
    } catch (e) {
        console.error("Image generation error:", e);
        return null;
    }
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

async function handleDashboard(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");

    if (key !== env.BROADCAST_KEY) {
        return new Response("Unauthorized", {status: 401});
    }

    const {results} = await env.DB.prepare(
        "SELECT * FROM posts ORDER BY created_at DESC LIMIT 20"
    ).all();

    const rows = results.map(post => `
    <tr style="border-bottom:1px solid #2e2b26;">
      <td style="padding:12px;color:#7a7265;font-size:11px;">${post.post_type.toUpperCase()}</td>
      <td style="padding:12px;color:#f5f0e8;max-width:400px;">${post.content.replace(/\n/g, '<br>')}</td>
      <td style="padding:12px;">
        <span style="color:${post.status === 'approved' ? '#4caf50' : post.status === 'posted' ? '#2196f3' : post.status === 'rejected' ? '#f44336' : '#c9a84c'};font-size:12px;text-transform:uppercase;">${post.status}</span>
      </td>
      <td style="padding:12px;color:#7a7265;font-size:11px;">${post.scheduled_for ? new Date(post.scheduled_for).toDateString() : '—'}</td>
      <td style="padding:12px;">
        ${post.status === 'pending' ? `
          <button onclick="approvePost(${post.id})" style="background:#c9a84c;color:#000;border:none;padding:6px 12px;cursor:pointer;border-radius:3px;margin-right:4px;">Approve</button>
          <button onclick="rejectPost(${post.id})" style="background:#333;color:#fff;border:none;padding:6px 12px;cursor:pointer;border-radius:3px;">Reject</button>
        ` : '—'}
      </td>
    </tr>
  `).join('');

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Great Owl Marketing — Dashboard</title>
<style>
  body { background:#0f0e0c; font-family: sans-serif; margin:0; padding:32px; }
  h1 { color:#c9a84c; margin-bottom:8px; }
  p { color:#7a7265; margin-bottom:24px; }
  table { width:100%; border-collapse:collapse; background:#1a1814; border-radius:4px; overflow:hidden; }
  th { padding:12px; text-align:left; color:#7a7265; font-size:11px; letter-spacing:2px; text-transform:uppercase; border-bottom:1px solid #2e2b26; }
  .generate-btn { background:#c9a84c; color:#000; border:none; padding:12px 24px; cursor:pointer; border-radius:3px; font-size:14px; font-weight:bold; margin-bottom:24px; }
  .stats { display:flex; gap:24px; margin-bottom:24px; }
  .stat { background:#1a1814; padding:16px 24px; border-radius:4px; }
  .stat-num { color:#c9a84c; font-size:24px; font-weight:bold; }
  .stat-label { color:#7a7265; font-size:12px; }
</style>
</head>
<body>
<h1>🦉 Great Owl Marketing Dashboard</h1>
<p>Review and approve your AI-generated social posts before they go live.</p>
<button class="generate-btn" onclick="generatePosts()">⚡ Generate This Week's Posts Now</button>
<table>
  <thead>
    <tr>
      <th>Type</th>
      <th>Content</th>
      <th>Status</th>
      <th>Scheduled</th>
      <th>Actions</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
<script>
  const KEY = '${key}';
  
  async function approvePost(id) {
    await fetch('/posts/approve', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id, key: KEY})
    });
    location.reload();
  }
  
  async function rejectPost(id) {
    await fetch('/posts/reject', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id, key: KEY})
    });
    location.reload();
  }

  async function generatePosts() {
    document.querySelector('.generate-btn').textContent = 'Generating...';
    await fetch('/posts/generate', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({key: KEY})
    });
    location.reload();
  }
</script>
</body>
</html>`;

    return new Response(html, {headers: {"Content-Type": "text/html"}});
}

async function handleApprovePost(request, env) {
    const {id, key} = await request.json();
    if (key !== env.BROADCAST_KEY) return jsonResponse({error: "Unauthorized"}, 401);
    await env.DB.prepare("UPDATE posts SET status='approved' WHERE id=?").bind(id).run();
    return jsonResponse({success: true});
}

async function handleRejectPost(request, env) {
    const {id, key} = await request.json();
    if (key !== env.BROADCAST_KEY) return jsonResponse({error: "Unauthorized"}, 401);
    await env.DB.prepare("UPDATE posts SET status='rejected' WHERE id=?").bind(id).run();
    return jsonResponse({success: true});
}

async function handleGeneratePosts(request, env, ctx) {
    const { key } = await request.json();
    if (key !== env.BROADCAST_KEY) return jsonResponse({ error: "Unauthorized" }, 401);
    ctx.waitUntil(generateWeeklyPosts(env));
    return jsonResponse({ success: true, message: "Generation started in background" });
}