#!/usr/bin/env node
/*
  Generate REAL static blog HTML files under ./blogs so they are part of the website.

  Supports chunked generation so you can run it until all posts exist.

  Examples:
    # Generate 224 SEO posts matching the existing scheduled placeholders
    node scripts/generate-static-blogs.js --count 224

    # Regenerate only index + sitemaps (fast)
    node scripts/generate-static-blogs.js --count 224 --metaOnly

  Outputs:
    blogs/index.html
    blogs/page/<n>/index.html
    blogs/<slug>/index.html
    sitemap.xml (sitemap index)
    sitemaps/blogs-1.xml, sitemaps/blogs-2.xml, ...

  Notes:
    - Default generator is deterministic SEO content (no AI) so it can run quickly and reliably.
    - Optional: use --ai for AI-written content (requires AI_API_KEY).
*/

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

const { listScheduled, scheduledMeta, intervalDays, yearsBack } = require('../lib/blogSchedule');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[k] = next;
      i += 1;
    } else {
      args[k] = true;
    }
  }
  return args;
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function pad(num, width) {
  const s = String(num);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

function pick(arr, seed) {
  if (!arr.length) return null;
  const idx = Math.abs(Number(seed || 0)) % arr.length;
  return arr[idx];
}

function isoDateOnly(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFileIfChanged(filePath, content) {
  const next = Buffer.from(String(content), 'utf8');
  try {
    const prev = fs.readFileSync(filePath);
    if (Buffer.compare(prev, next) === 0) return false;
  } catch {
    // ignore
  }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, next);
  return true;
}

function pageShell({ title, description, canonical, body, jsonLd }) {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);
  const jsonLdSafe = JSON.stringify(jsonLd || {}).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDesc}" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:type" content="${body.includes('<article') ? 'article' : 'website'}" />
  <meta property="og:url" content="${escapeHtml(canonical)}" />
  <meta property="og:image" content="/brand/PureStay_white.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" href="/brand/purestay_exact_SVG.svg" type="image/svg+xml">
  <style>
    :root{
      --ink:#101010;
      --muted:#5d5b56;
      --bg:#f6f4f1;
      --card:#ffffff;
      --line:#e9e3da;
      --shadow: 0 14px 40px rgba(0,0,0,.06);
      --maroon:#7A2E26;
      --maroon-700:#66271f;
      --gold:#C79A3B;
      --link:#0d4d8b;
    }
    *{ box-sizing:border-box; }
    body{ margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Inter, Helvetica, Arial; color:var(--ink); background:var(--bg); }
    a{ color:var(--link); text-decoration:none; }
    a:hover{ text-decoration:underline; }
    .top{ background:#fff; border-bottom:1px solid var(--line); }
    .topInner{ max-width:1100px; margin:0 auto; padding:14px 18px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
    .homeBtn{ display:inline-flex; align-items:center; gap:10px; padding:10px 12px; border-radius:14px; border:1px solid var(--line); background:#fff; color:var(--ink); box-shadow:0 10px 24px rgba(0,0,0,.06); }
    .homeBtn:hover{ text-decoration:none; border-color:#dccfae; }
    .homeBtn img{ width:30px; height:30px; }
    .homeBtn b{ font-weight:950; letter-spacing:-0.02em; }
    .nav{ display:flex; gap:10px; align-items:center; }
    .ctaBtn{ display:inline-flex; align-items:center; justify-content:center; padding:10px 14px; border-radius:12px; font-weight:950; background:var(--maroon); color:#fff; border:1px solid transparent; box-shadow:0 14px 38px rgba(0,0,0,.10); }
    .ctaBtn:hover{ background:var(--maroon-700); text-decoration:none; }
    .wrap{ max-width:1100px; margin:0 auto; padding:24px 18px 70px; }
    .hero{ padding:6px 0 18px; }
    .kicker{ display:inline-block; font-weight:950; font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--maroon); }
    .rule{ height:3px; width:44px; background:var(--gold); border-radius:999px; margin-top:10px; }
    h1{ margin:14px 0 0; font-size:clamp(30px,4.8vw,48px); letter-spacing:-0.03em; line-height:1.05; }
    .sub{ margin:10px 0 0; color:var(--muted); font-weight:750; max-width:72ch; line-height:1.55; }
    .grid{ display:grid; grid-template-columns: 1.25fr .75fr; gap:18px; margin-top:18px; align-items:start; }
    @media (max-width: 980px){ .grid{ grid-template-columns:1fr; } }
    .card{ background:var(--card); border:1px solid var(--line); border-radius:18px; box-shadow:var(--shadow); overflow:hidden; }
    .cardPad{ padding:18px; }
    .metaRow{ display:flex; gap:10px; flex-wrap:wrap; margin-top:14px; }
    .chip{ font-size:12px; font-weight:900; color:#2b2b2b; background:#faf9f7; border:1px solid var(--line); padding:7px 10px; border-radius:12px; }
    .list{ display:grid; gap:12px; }
    .postLink{ display:block; padding:16px; border-radius:16px; border:1px solid var(--line); background:#fff; color:var(--ink); text-decoration:none; }
    .postLink:hover{ border-color:#dccfae; box-shadow:0 10px 28px rgba(0,0,0,.06); text-decoration:none; }
    .postTitle{ font-weight:950; letter-spacing:-0.015em; font-size:16px; }
    .postMeta{ margin-top:6px; color:var(--muted); font-weight:800; font-size:13px; }
    .postExcerpt{ margin-top:8px; color:#2b2b2b; font-weight:650; line-height:1.55; }
    article{ color:#141414; }
    article h2, article h3{ margin:24px 0 10px; letter-spacing:-0.02em; }
    article p{ margin:12px 0; color:#222; line-height:1.72; font-weight:560; }
    article ul{ margin:10px 0 10px 18px; color:#222; line-height:1.65; font-weight:560; }
    article hr{ border:none; border-top:1px solid var(--line); margin:18px 0; }
    article blockquote{ margin:16px 0; padding:14px 14px; border-left:3px solid var(--gold); background:#fbfaf7; border-radius:12px; }
    article .cta{ margin:18px 0; padding:16px; border-radius:16px; background:#fbf8f1; border:1px solid #efe3c7; }
    .sideBox h3{ margin:0; font-size:14px; letter-spacing:-0.01em; }
    .sideBox p{ margin:8px 0 0; color:var(--muted); font-weight:700; line-height:1.55; }
    .sideBox .links{ margin-top:12px; display:grid; gap:10px; }
    .linkBtn{ display:flex; align-items:center; justify-content:space-between; gap:10px; color:var(--ink); font-weight:950; padding:12px 12px; border-radius:14px; border:1px solid var(--line); background:#fff; text-decoration:none; }
    .linkBtn:hover{ box-shadow:0 10px 22px rgba(0,0,0,.06); text-decoration:none; }
    .linkBtn::after{ content:'→'; opacity:.55; font-weight:950; }
    .linkBtn.call{ background:rgba(122,46,38,.10); border-color:rgba(122,46,38,.22); color:var(--maroon-700); }
    .linkBtn.call:hover{ background:rgba(122,46,38,.14); border-color:rgba(122,46,38,.30); }
    .pager{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:14px; }
    .pager a{ display:inline-flex; align-items:center; justify-content:center; padding:10px 12px; border-radius:12px; border:1px solid var(--line); background:#fff; color:var(--ink); font-weight:950; text-decoration:none; }
    .pager a:hover{ border-color:#dccfae; box-shadow:0 10px 22px rgba(0,0,0,.06); }
    .pager .dim{ opacity:.55; pointer-events:none; }
    .pager .center{ color:var(--muted); font-weight:850; }
    .foot{ border-top:1px solid var(--line); background:#fff; }
    .footInner{ max-width:1100px; margin:0 auto; padding:18px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
    .footInner span{ color:var(--muted); font-weight:750; font-size:13px; }
  </style>
  <script type="application/ld+json">${jsonLdSafe}</script>
</head>
<body>
  <header class="top">
    <div class="topInner">
      <a class="homeBtn" href="/" aria-label="PureStay Home">
        <img src="/brand/purestay_exact_SVG.svg" alt="PureStay" />
        <b>PureStay</b>
      </a>
      <nav class="nav" aria-label="Site">
        <a class="ctaBtn" href="/discovery">Book a call</a>
      </nav>
    </div>
  </header>
  ${body}
  <footer class="foot">
    <div class="footInner">
      <span>© ${new Date().getUTCFullYear()} PureStay • Resident retention experiences</span>
      <a class="ctaBtn" href="/discovery">Book a call</a>
    </div>
  </footer>
</body>
</html>`;
}

function buildDeterministicSeoPostFromMeta({ meta, seed }) {
  const eventIdeas = [
    'Coffee cart + resident shout-outs',
    'Package room “thank-you” station',
    'Dog treat bar + pet photo wall',
    'Local vendor pop-up (fitness, food, mobile detailing)',
    'Move-in welcome table (30 minutes, weekly)',
    'Resident swap shelf + “take one/leave one”',
    'Maintenance appreciation snack wall',
    'Kids craft corner + photo backdrop',
    'Taste-test Tuesday (small samples, big turnout)',
    'Parking lot “windshield thank-you” notes',
  ];

  const metrics = [
    'renewal intent (single-question pulse)',
    'attendance rate (% of households)',
    'RSVP-to-show rate',
    'sentiment quotes (3 per event)',
    'tour-to-lease correlation (when marketing uses event content)',
    'maintenance ticket follow-up satisfaction',
  ];

  const scripts = [
    '“We built this event around what residents asked for — tell us what to do next month.”',
    '“If we ran one small improvement next month, what would you pick?”',
    '“Would something like this make you more likely to renew? Yes/No/Maybe.”',
    '“What’s one neighbor you’d like to meet at a future event?”',
  ];

  const ideaA = pick(eventIdeas, seed + 1);
  const ideaB = pick(eventIdeas, seed + 7);
  const ideaC = pick(eventIdeas, seed + 13);
  const metricA = pick(metrics, seed + 3);
  const metricB = pick(metrics, seed + 11);
  const script = pick(scripts, seed + 5);

  const dateStr = isoDateOnly(meta.publishedAt);

  const html = `
    <h2>What this topic really means on-site</h2>
    <p><b>${escapeHtml(meta.topic)}</b> isn’t a slogan — it’s a repeatable set of touchpoints that make residents feel seen and supported. The goal is to increase renewal confidence without discounting.</p>

    <h2>A simple 3-part retention plan (you can start this week)</h2>
    <ul>
      <li><b>One monthly theme:</b> pick a focus (community, convenience, wellness, local partnerships).</li>
      <li><b>Two touchpoints:</b> one lightweight (digital) + one in-person micro-event.</li>
      <li><b>One metric:</b> track ${escapeHtml(metricA)} and ${escapeHtml(metricB)}.</li>
    </ul>

    <h2>3 micro-events that support this theme</h2>
    <ul>
      <li>${escapeHtml(ideaA)}</li>
      <li>${escapeHtml(ideaB)}</li>
      <li>${escapeHtml(ideaC)}</li>
    </ul>

    <h2>How to promote it (without spamming)</h2>
    <ul>
      <li><b>48 hours:</b> one announcement with a simple benefit.</li>
      <li><b>24 hours:</b> reminder + quick photo from a past moment.</li>
      <li><b>2 hours:</b> short text-style reminder (time + location).</li>
    </ul>

    <blockquote><b>Resident script:</b> ${escapeHtml(script)}</blockquote>

    <h2>How to report results like an operator</h2>
    <p>Don’t just report “we hosted an event.” Report what changed: what residents said, who attended, and whether renewal intent improved. Keep a running monthly scorecard.</p>

    <div class="cta">
      <b>Want PureStay to run this for you?</b>
      <p style="margin:8px 0 0;">We plan and host on-site resident experiences and provide reporting so your team can focus on leasing and renewals.</p>
      <p style="margin:12px 0 0;"><a class="ctaBtn" href="/discovery">Book a discovery call</a></p>
      <p style="margin:10px 0 0;"><a href="/core">Core Package</a> • <a href="/culture-shift">Culture Shift</a> • <a href="/signature-stay">Signature Stay</a></p>
    </div>

    <hr/>
    <h2>FAQ</h2>
    <p><b>How often should we run resident experiences?</b><br/>Small and consistent beats large and rare. Start with two touchpoints per month and improve from there.</p>
    <p><b>What if engagement is low at first?</b><br/>Reduce complexity, partner with a local vendor, and use a single benefit-driven message. Then repeat for 60–90 days.</p>
    <p><b>What should we measure?</b><br/>Track one leading indicator (attendance, sentiment) and one outcome indicator (renewal intent) so leadership sees the connection.</p>

    <h2>Next step</h2>
    <p>Choose one micro-event for this month, assign one owner, and commit to one metric. Then repeat every ${escapeHtml(String(meta.stepDays || intervalDays()))} days.</p>
    <p style="color:#666; font-weight:650;">Published: ${escapeHtml(dateStr)}</p>
  `;

  return {
    slug: meta.slug,
    title: meta.title,
    metaDescription: `Practical multifamily tactics for ${meta.topic}: micro-events, touchpoints, and reporting that improve renewals.`,
    excerpt: meta.excerpt,
    publishedAt: meta.publishedAt,
    html,
    keywords: ['resident retention', 'multifamily', 'apartment renewals', 'resident events', 'community engagement', meta.topic],
    primaryKeyword: 'resident retention',
  };
}

async function buildAiPost({ id, publishedAt, slug, siteUrl }) {
  const { generateBlogPost } = require('../lib/aiBlog');

  const num = pad(id, 6);
  const forcedTitle = `Resident Retention Playbook #${num}: Practical Multifamily Ideas That Drive Renewals`;

  const r = await generateBlogPost({
    sequence: id,
    publishedAt: new Date(publishedAt).toISOString(),
    siteUrl,
    forced: {
      title: forcedTitle,
      slug,
      topic: `resident retention ideas (playbook #${num})`,
      primaryKeyword: 'resident retention',
    },
  });

  if (!r.ok) return { ok: false, error: r.error };

  const p = r.data;
  return {
    ok: true,
    post: {
      id,
      slug,
      title: p.title,
      metaDescription: p.metaDescription,
      excerpt: p.excerpt,
      publishedAt: new Date(publishedAt).toISOString(),
      html: p.html,
      keywords: p.keywords || [],
      primaryKeyword: p.primaryKeyword || 'resident retention',
    },
  };
}

function renderIndexPage({ siteUrl, posts, total, page, perPage }) {
  const title = 'PureStay Blogs | Multifamily Resident Retention';
  const description = 'Practical retention strategies, resident event ideas, and multifamily community-building playbooks from PureStay.';
  const canonical = page <= 1 ? `${siteUrl}/blogs` : `${siteUrl}/blogs/page/${page}`;

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const prevHref = page > 1 ? (page === 2 ? `/blogs` : `/blogs/page/${page - 1}`) : '';
  const nextHref = page < totalPages ? `/blogs/page/${page + 1}` : '';

  const body = `
  <main class="wrap">
    <section class="hero">
      <span class="kicker">PURESTAY BLOG</span>
      <div class="rule"></div>
      <h1>Resident retention strategies for multifamily</h1>
      <p class="sub">Practical, field-tested ideas: resident events, engagement playbooks, and retention systems built for apartment communities.</p>
    </section>

    <section class="grid" aria-label="Blog index">
      <div class="card">
        <div class="cardPad">
          <div class="metaRow"><span class="chip">${escapeHtml(String(total))} posts</span><span class="chip">Page ${escapeHtml(String(page))} of ${escapeHtml(String(totalPages))}</span></div>
          <div style="height:12px"></div>
          <div class="list">
            ${posts.map((p) => {
              const href = `/blogs/${encodeURIComponent(String(p.slug))}`;
              const date = isoDateOnly(p.publishedAt);
              return `
              <a class="postLink" href="${href}">
                <div class="postTitle">${escapeHtml(p.title)}</div>
                <div class="postMeta">${escapeHtml(date)} • PureStay</div>
                <div class="postExcerpt">${escapeHtml(p.excerpt || '')}</div>
              </a>`;
            }).join('')}
          </div>

          <div class="pager" aria-label="Pagination">
            <a ${prevHref ? `href="${prevHref}"` : ''} class="${prevHref ? '' : 'dim'}">← Prev</a>
            <div class="center">Showing ${escapeHtml(String(Math.min(total, (page - 1) * perPage + 1)))}–${escapeHtml(String(Math.min(total, page * perPage)))} of ${escapeHtml(String(total))}</div>
            <a ${nextHref ? `href="${nextHref}"` : ''} class="${nextHref ? '' : 'dim'}">Next →</a>
          </div>
        </div>
      </div>

      <aside class="card sideBox">
        <div class="cardPad">
          <h3>Want this done-for-you?</h3>
          <p>PureStay runs on-site resident experiences and provides reporting so your team can focus on leasing and renewals.</p>
          <div class="links">
            <a class="linkBtn call" href="/discovery">Book a discovery call</a>
            <a class="linkBtn" href="/core">See Core Package</a>
            <a class="linkBtn" href="/culture-shift">See Culture Shift</a>
            <a class="linkBtn" href="/signature-stay">See Signature Stay</a>
          </div>
        </div>
      </aside>
    </section>
  </main>`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'PureStay Blogs',
    url: `${siteUrl}/blogs`,
    description,
  };

  return pageShell({ title, description, canonical, body, jsonLd });
}

function renderPostPage({ siteUrl, post }) {
  const title = `${post.title} | PureStay`;
  const description = post.metaDescription || post.excerpt || 'PureStay blog post.';
  const canonical = `${siteUrl}/blogs/${post.slug}`;
  const date = isoDateOnly(post.publishedAt);

  const body = `
  <main class="wrap">
    <section class="hero">
      <span class="kicker">PURESTAY BLOG</span>
      <div class="rule"></div>
      <h1>${escapeHtml(post.title)}</h1>
      <p class="sub">${escapeHtml(post.excerpt || post.metaDescription || '')}</p>
      <div class="metaRow">
        ${date ? `<span class="chip">${escapeHtml(date)}</span>` : ''}
        <span class="chip">PureStay</span>
      </div>
    </section>

    <section class="grid" aria-label="Blog post">
      <article class="card">
        <div class="cardPad">
          ${post.html}
        </div>
      </article>

      <aside class="card sideBox">
        <div class="cardPad">
          <h3>Want this done-for-you?</h3>
          <p>PureStay runs on-site resident experiences and provides reporting so your team can focus on leasing and renewals.</p>
          <div class="links">
            <a class="linkBtn call" href="/discovery">Book a discovery call</a>
            <a class="linkBtn" href="/core">Core Package</a>
            <a class="linkBtn" href="/culture-shift">Culture Shift</a>
            <a class="linkBtn" href="/signature-stay">Signature Stay</a>
          </div>
        </div>
      </aside>
    </section>

    <div style="height:14px"></div>
    <a href="/blogs" style="font-weight:900; color:var(--ink);">← Back to all blogs</a>
  </main>`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    headline: post.title,
    description,
    datePublished: post.publishedAt,
    dateModified: post.publishedAt,
    author: { '@type': 'Organization', name: 'PureStay' },
    publisher: {
      '@type': 'Organization',
      name: 'PureStay',
      logo: { '@type': 'ImageObject', url: `${siteUrl}/brand/purestay_exact_SVG.svg` },
    },
  };

  return pageShell({ title, description, canonical, body, jsonLd });
}

function renderSitemapIndex({ siteUrl, sitemapUrls }) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.map((loc) => `  <sitemap><loc>${escapeHtml(loc)}</loc><lastmod>${now}</lastmod></sitemap>`).join('\n')}
</sitemapindex>`;
}

function renderSitemapUrlset({ urls }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${escapeHtml(u.loc)}</loc>${u.lastmod ? `<lastmod>${escapeHtml(u.lastmod)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const count = clampInt(args.count, 1, 500000, 224);
  const perPage = clampInt(args.perPage, 1, 100, 10);

  const outDir = path.resolve(ROOT_DIR, String(args.outDir || 'blogs'));
  const sitemapsDir = path.resolve(ROOT_DIR, String(args.sitemapsDir || 'sitemaps'));

  const siteUrl = String(args.siteUrl || process.env.SITE_URL || 'https://purestaync.com').replace(/\/$/, '');

  const useAi = !!args.ai;
  const metaOnly = !!args.metaOnly;

  const stepDays = clampInt(args.stepDays, 1, 14, intervalDays());
  const years = clampInt(args.years, 1, 10, yearsBack());

  console.log(`[static-blogs] generating ${count} scheduled posts into ${path.relative(ROOT_DIR, outDir)} (stepDays=${stepDays}, years=${years}, ai=${useAi ? 'on' : 'off'})`);

  // lib/blogSchedule.listScheduled caps limit at 200, so page results.
  const metas = [];
  let offset = 0;
  while (metas.length < count) {
    const need = count - metas.length;
    const batch = listScheduled({ limit: Math.min(200, need), offset, years, stepDays });
    if (!batch || !Array.isArray(batch.posts) || batch.posts.length === 0) break;
    metas.push(...batch.posts);
    offset += batch.posts.length;
  }
  metas.splice(count);

  let changedPosts = 0;
  if (!metaOnly) {
    for (let i = 0; i < metas.length; i += 1) {
      const meta = metas[i];
      const seed = Number(meta.sequence || i);

      let post;
      if (useAi) {
        const r = await buildAiPost({ id: seed, publishedAt: meta.publishedAt, slug: meta.slug, siteUrl });
        if (!r.ok) throw new Error(`AI generation failed at ${meta.slug}: ${r.error}`);
        post = {
          ...r.post,
          title: meta.title,
          slug: meta.slug,
          excerpt: meta.excerpt,
          publishedAt: meta.publishedAt,
        };
      } else {
        post = buildDeterministicSeoPostFromMeta({ meta, seed });
      }

      const html = renderPostPage({ siteUrl, post });
      const filePath = path.join(outDir, post.slug, 'index.html');
      if (writeFileIfChanged(filePath, html)) changedPosts += 1;

      if ((i + 1) % 25 === 0) console.log(`[static-blogs] generated ${i + 1}/${metas.length}`);
    }
  }

  console.log('[static-blogs] generating index pages + sitemap files');

  const total = metas.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  for (let page = 1; page <= totalPages; page += 1) {
    const start = (page - 1) * perPage;
    const end = Math.min(total, page * perPage);
    const posts = metas.slice(start, end).map((m) => ({
      slug: m.slug,
      title: m.title,
      excerpt: m.excerpt,
      publishedAt: m.publishedAt,
    }));

    const html = renderIndexPage({ siteUrl, posts, total, page, perPage });
    const filePath = page === 1
      ? path.join(outDir, 'index.html')
      : path.join(outDir, 'page', String(page), 'index.html');
    writeFileIfChanged(filePath, html);
  }

  // Sitemaps: max 50k URLs per sitemap.
  const perSitemap = 50000;
  const sitemapCount = Math.ceil(total / perSitemap);

  ensureDir(sitemapsDir);
  const sitemapUrls = [];
  for (let si = 1; si <= sitemapCount; si += 1) {
    const start = (si - 1) * perSitemap;
    const end = Math.min(total, si * perSitemap);
    const urls = metas.slice(start, end).map((m) => ({
      loc: `${siteUrl}/blogs/${m.slug}`,
      lastmod: isoDateOnly(m.publishedAt),
    }));

    const xml = renderSitemapUrlset({ urls });
    const name = `blogs-${si}.xml`;
    const p = path.join(sitemapsDir, name);
    writeFileIfChanged(p, xml);
    sitemapUrls.push(`${siteUrl}/sitemaps/${name}`);
  }

  const sitemapIndexXml = renderSitemapIndex({ siteUrl, sitemapUrls });
  writeFileIfChanged(path.join(ROOT_DIR, 'sitemap.xml'), sitemapIndexXml);

  console.log(`[static-blogs] wrote ${changedPosts} post pages (changed).`);
  console.log('[static-blogs] done');
}

main().catch((e) => {
  console.error('[static-blogs] error:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
