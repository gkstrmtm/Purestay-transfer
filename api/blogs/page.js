const { handleCors } = require('../../lib/vercelApi');
const { listPosts, getPost, getSiteUrl, isoDateOnly } = require('../../lib/blogs');
const { hasKvEnv } = require('../../lib/storage');

function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // default; overridden per-response
  res.setHeader('Cache-Control', 'no-store');
  res.end(html);
}

function setEdgeCache(res, seconds) {
  const s = Math.max(0, Math.min(31536000, Number(seconds || 0)));
  if (!s) {
    res.setHeader('Cache-Control', 'no-store');
    return;
  }
  res.setHeader('Cache-Control', `public, s-maxage=${s}, stale-while-revalidate=86400`);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pageShell({ title, description, canonical, og, jsonLd, body }) {
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
  <meta property="og:title" content="${escapeHtml(og.title)}" />
  <meta property="og:description" content="${escapeHtml(og.description)}" />
  <meta property="og:type" content="${escapeHtml(og.type)}" />
  <meta property="og:url" content="${escapeHtml(og.url)}" />
  <meta property="og:image" content="${escapeHtml(og.image)}" />
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
      --gold:#CEA43C;
      /* Match Home.html brand tokens */
      --maroon:#7A2E26;
      --maroon-700:#66271f;
      --gold:#C79A3B;
      --gold-700:#B78A2F;
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

    .btn{ display:inline-flex; align-items:center; justify-content:center; padding:10px 14px; border-radius:12px; font-weight:950; background:var(--maroon); color:#fff; border:1px solid transparent; box-shadow:0 14px 38px rgba(0,0,0,.10); }
    .btn:hover{ background:var(--maroon-700); text-decoration:none; }

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
    .postLink{ cursor:pointer; }
    .postTitle{ font-weight:950; letter-spacing:-0.015em; font-size:16px; }
    .postMeta{ margin-top:6px; color:var(--muted); font-weight:800; font-size:13px; }
    .postExcerpt{ margin-top:8px; color:#2b2b2b; font-weight:650; line-height:1.55; }

    article{ color:#141414; }
    article h2, article h3{ margin:24px 0 10px; letter-spacing:-0.02em; }
    article p{ margin:12px 0; color:#222; line-height:1.72; font-weight:560; }
    article ul{ margin:10px 0 10px 18px; color:#222; line-height:1.65; font-weight:560; }
    article a{ color:var(--link); }
    article hr{ border:none; border-top:1px solid var(--line); margin:18px 0; }
    article blockquote{ margin:16px 0; padding:14px 14px; border-left:3px solid var(--gold); background:#fbfaf7; border-radius:12px; }
    article .cta{ margin:18px 0; padding:16px; border-radius:16px; background:#fbf8f1; border:1px solid #efe3c7; }

    .sideBox h3{ margin:0; font-size:14px; letter-spacing:-0.01em; }
    .sideBox p{ margin:8px 0 0; color:var(--muted); font-weight:700; line-height:1.55; }
    .sideBox .links{ margin-top:12px; display:grid; gap:10px; }
    .linkBtn{ display:flex; align-items:center; justify-content:space-between; gap:10px; color:var(--ink); font-weight:950; padding:12px 12px; border-radius:14px; border:1px solid var(--line); background:#fff; text-decoration:none; }
    .linkBtn:hover{ box-shadow:0 10px 22px rgba(0,0,0,.06); text-decoration:none; }
    .linkBtn::after{ content:'→'; opacity:.55; font-weight:950; }
    /* Make the buttons clearly tinted (users rely on color cues). */
    .linkBtn.call{ background:rgba(122,46,38,.16); border-color:rgba(122,46,38,.28); color:var(--maroon-700); }
    .linkBtn.call:hover{ background:rgba(122,46,38,.22); border-color:rgba(122,46,38,.36); }
    .linkBtn.core{ background:rgba(199,154,59,.22); border-color:rgba(199,154,59,.34); color:#3d2a10; }
    .linkBtn.core:hover{ background:rgba(199,154,59,.28); border-color:rgba(199,154,59,.42); }
    .linkBtn.culture{ background:rgba(13,110,92,.18); border-color:rgba(13,110,92,.30); color:#0b3d34; }
    .linkBtn.culture:hover{ background:rgba(13,110,92,.24); border-color:rgba(13,110,92,.38); }
    .linkBtn.signature{ background:rgba(67,56,202,.16); border-color:rgba(67,56,202,.28); color:#26236c; }
    .linkBtn.signature:hover{ background:rgba(67,56,202,.22); border-color:rgba(67,56,202,.36); }
    .linkBtn.talk{ background:rgba(16,16,16,.06); border-color:rgba(16,16,16,.14); color:var(--ink); }
    .linkBtn.talk:hover{ background:rgba(16,16,16,.08); border-color:rgba(16,16,16,.18); }

    .foot{ border-top:1px solid var(--line); background:#fff; }
    .footInner{ max-width:1100px; margin:0 auto; padding:18px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
    .footInner span{ color:var(--muted); font-weight:750; font-size:13px; }

    .pager{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:14px; }
    .pager a{ display:inline-flex; align-items:center; justify-content:center; padding:10px 12px; border-radius:12px; border:1px solid var(--line); background:#fff; color:var(--ink); font-weight:950; text-decoration:none; }
    .pager a:hover{ border-color:#dccfae; box-shadow:0 10px 22px rgba(0,0,0,.06); }
    .pager .dim{ opacity:.55; pointer-events:none; }
    .pager .center{ color:var(--muted); font-weight:850; }
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

  <script>
    // Click fallback: ensure cards always navigate.
    (function(){
      try{
        document.querySelectorAll('a.postLink').forEach(function(a){
          a.addEventListener('click', function(e){
            if(!a || !a.getAttribute) return;
            var href = a.getAttribute('href');
            if(!href) return;
            // Let normal navigation happen; this is just a guard.
            if(e.defaultPrevented) window.location.assign(href);
          });
        });
      }catch{}
    })();
  </script>
</body>
</html>`;
}

function blogIndexJsonLd({ siteUrl, posts }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'PureStay Blogs',
    url: `${siteUrl}/blogs`,
    description: 'SEO resources for multifamily resident retention and community engagement.',
    blogPost: (posts || []).map((p) => ({
      '@type': 'BlogPosting',
      headline: p.title,
      url: `${siteUrl}/blogs/${p.slug}`,
      datePublished: p.publishedAt || undefined,
    })),
  };
}

function blogPostJsonLd({ siteUrl, post }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `${siteUrl}/blogs/${post.slug}`,
    },
    headline: post.title,
    description: post.metaDescription || post.excerpt || '',
    datePublished: post.publishedAt,
    dateModified: post.updatedAt || post.publishedAt,
    author: { '@type': 'Organization', name: 'PureStay' },
    publisher: {
      '@type': 'Organization',
      name: 'PureStay',
      logo: { '@type': 'ImageObject', url: `${siteUrl}/brand/purestay_exact_SVG.svg` },
    },
    keywords: Array.isArray(post.keywords) ? post.keywords.join(', ') : undefined,
    wordCount: post.wordCount || undefined,
    timeRequired: post.readingMinutes ? `PT${post.readingMinutes}M` : undefined,
  };
}

function renderIndex({ siteUrl, posts, total, page, perPage }) {
  const title = 'PureStay Blogs | Multifamily Resident Retention';
  const description = 'Practical retention strategies, resident event ideas, and multifamily community-building playbooks from PureStay.';
  const canonical = `${siteUrl}/blogs`;

  const p = Math.max(1, Number(page || 1));
  const pp = Math.max(1, Number(perPage || 10));
  const totalPages = Math.max(1, Math.ceil(Number(total || 0) / pp));
  const prevHref = p > 1 ? `/blogs?page=${p - 1}` : '';
  const nextHref = p < totalPages ? `/blogs?page=${p + 1}` : '';

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
          <div class="metaRow"><span class="chip">${escapeHtml(String(total))} posts</span><span class="chip">Page ${escapeHtml(String(p))} of ${escapeHtml(String(totalPages))}</span></div>
          <div style="height:12px"></div>
          <div class="list">
            ${posts.map((p) => {
              const date = p.publishedAt ? isoDateOnly(p.publishedAt) : '';
              const href = `/blogs/${encodeURIComponent(String(p.slug || ''))}`;
              return `
              <a class="postLink" href="${href}">
                <div class="postTitle">${escapeHtml(p.title || '')}</div>
                <div class="postMeta">${date ? escapeHtml(date) + ' • ' : ''}PureStay</div>
                <div class="postExcerpt">${escapeHtml(p.excerpt || p.metaDescription || '')}</div>
              </a>`;
            }).join('')}
          </div>

          <div class="pager" aria-label="Pagination">
            <a ${prevHref ? `href="${prevHref}"` : ''} class="${prevHref ? '' : 'dim'}">← Prev</a>
            <div class="center">Showing ${escapeHtml(String(Math.min(total, (p - 1) * pp + 1)))} to ${escapeHtml(String(Math.min(total, p * pp)))} of ${escapeHtml(String(total))}</div>
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
            <a class="linkBtn core" href="/core">See Core Package</a>
            <a class="linkBtn culture" href="/culture-shift">See Culture Shift</a>
            <a class="linkBtn signature" href="/signature-stay">See Signature Stay</a>
          </div>
        </div>
      </aside>
    </section>
  </main>`;

  return pageShell({
    title,
    description,
    canonical,
    og: {
      title,
      description,
      type: 'website',
      url: canonical,
      image: `${siteUrl}/brand/PureStay_white.png`,
    },
    jsonLd: blogIndexJsonLd({ siteUrl, posts }),
    body,
  });
}

function renderPost({ siteUrl, post }) {
  const title = `${post.title} | PureStay`;
  const description = post.metaDescription || post.excerpt || 'PureStay blog post.';
  const canonical = `${siteUrl}/blogs/${post.slug}`;
  const date = post.publishedAt ? isoDateOnly(post.publishedAt) : '';

  const faqHtml = Array.isArray(post.faq) && post.faq.length
    ? `
      <div class="hr" style="height:1px;background:var(--line);margin:18px 0"></div>
      <h2>FAQ</h2>
      ${post.faq.map((it) => `
        <p><b>${escapeHtml(it.q)}</b><br/>${escapeHtml(it.a)}</p>
      `).join('')}
    `
    : '';

  const body = `
  <main class="wrap">
    <section class="hero">
      <span class="kicker">PURESTAY BLOG</span>
      <div class="rule"></div>
      <h1>${escapeHtml(post.title)}</h1>
      <p class="sub">${escapeHtml(post.excerpt || post.metaDescription || '')}</p>
      <div class="metaRow">
        ${date ? `<span class="chip">${escapeHtml(date)}</span>` : ''}
        ${post.readingMinutes ? `<span class="chip">${escapeHtml(String(post.readingMinutes))} min read</span>` : ''}
        ${post.primaryKeyword ? `<span class="chip">${escapeHtml(post.primaryKeyword)}</span>` : ''}
      </div>
    </section>

    <section class="grid" aria-label="Blog post">
      <article class="card">
        <div class="cardPad">
          ${post.html || ''}
          ${faqHtml}
          <div class="cta">
            <b>Ready to improve renewals?</b>
            <p style="margin:8px 0 0;">PureStay runs the experiences. You get the resident sentiment and reporting.</p>
            <p style="margin:12px 0 0;"><a class="btn" href="/discovery" style="display:inline-flex;">Book a discovery call</a></p>
          </div>
        </div>
      </article>

      <aside class="card sideBox">
        <div class="cardPad">
          <h3>Want this done-for-you?</h3>
          <p>PureStay runs on-site resident experiences and provides reporting so your team can focus on leasing and renewals.</p>
          <div class="links">
            <a class="linkBtn call" href="/discovery">Book a discovery call</a>
            <a class="linkBtn core" href="/core">See Core Package</a>
            <a class="linkBtn culture" href="/culture-shift">See Culture Shift</a>
            <a class="linkBtn signature" href="/signature-stay">See Signature Stay</a>
          </div>
        </div>
      </aside>
    </section>

    <div style="height:14px"></div>
    <a href="/blogs" style="font-weight:900; color:var(--ink);">← Back to all blogs</a>
  </main>`;

  return pageShell({
    title,
    description,
    canonical,
    og: {
      title,
      description,
      type: 'article',
      url: canonical,
      image: `${siteUrl}/brand/PureStay_white.png`,
    },
    jsonLd: blogPostJsonLd({ siteUrl, post }),
    body,
  });
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendHtml(res, 405, '<h1>Method Not Allowed</h1>');

  const url = new URL(req.url || '/', 'http://localhost');
  const slug = String(url.searchParams.get('slug') || '').trim();
  const siteUrl = getSiteUrl(req);

  const kvEnabled = hasKvEnv();

  if (!slug) {
    // Index page: KV-backed list only.
    const perPage = 10;
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const limit = perPage;
    const offset = (page - 1) * perPage;

    const listing = kvEnabled ? await listPosts({ limit, offset }) : { posts: [], total: 0 };
    setEdgeCache(res, kvEnabled ? 60 * 60 : 60 * 5);
    return sendHtml(res, 200, renderIndex({ siteUrl, posts: listing.posts, total: listing.total, page, perPage }));
  }

  if (!kvEnabled) {
    const html = pageShell({
      title: 'Not Found | PureStay Blogs',
      description: 'This blog post does not exist.',
      canonical: `${siteUrl}/blogs/${encodeURIComponent(slug)}`,
      og: {
        title: 'Not Found | PureStay Blogs',
        description: 'This blog post does not exist.',
        type: 'website',
        url: `${siteUrl}/blogs/${encodeURIComponent(slug)}`,
        image: `${siteUrl}/brand/PureStay_white.png`,
      },
      jsonLd: { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Not Found' },
      body: `
        <main class="wrap">
          <section class="hero">
            <span class="kicker">Blogs</span>
            <h1>Post not found</h1>
            <p class="sub">That link doesn’t match any post we have.</p>
          </section>
          <a class="pill primary" href="/blogs">Go to blogs</a>
        </main>`,
    });
    setEdgeCache(res, 60 * 5);
    return sendHtml(res, 404, html);
  }

  const post = await getPost(slug);

  if (!post) {
    const html = pageShell({
      title: 'Not Found | PureStay Blogs',
      description: 'This blog post does not exist.',
      canonical: `${siteUrl}/blogs/${encodeURIComponent(slug)}`,
      og: {
        title: 'Not Found | PureStay Blogs',
        description: 'This blog post does not exist.',
        type: 'website',
        url: `${siteUrl}/blogs/${encodeURIComponent(slug)}`,
        image: `${siteUrl}/brand/PureStay_white.png`,
      },
      jsonLd: { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Not Found' },
      body: `
        <main class="wrap">
          <section class="hero">
            <span class="kicker">Blogs</span>
            <h1>Post not found</h1>
            <p class="sub">That link doesn’t match any post we have.</p>
          </section>
          <a class="pill primary" href="/blogs">Go to blogs</a>
        </main>`,
    });
    setEdgeCache(res, 60 * 10);
    return sendHtml(res, 404, html);
  }

  // Cache individual post pages aggressively.
  setEdgeCache(res, 60 * 60 * 24 * 365);
  return sendHtml(res, 200, renderPost({ siteUrl, post }));
};
