const { handleCors } = require('../../lib/vercelApi');
const { listPosts, getPost, getSiteUrl, isoDateOnly } = require('../../lib/blogs');

function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(html);
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
    :root{ --ink:#101010; --muted:#5a5854; --card:#fff; --line:#ece6dc; --gold:#CEA43C; --bg:#f7f5f2; }
    *{ box-sizing:border-box; }
    body{ margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Inter, Helvetica, Arial; color:var(--ink); background:var(--bg); }
    a{ color:inherit; }
    .top{ background:#fff; border-bottom:1px solid var(--line); }
    .topInner{ max-width:1100px; margin:0 auto; padding:18px 18px; display:flex; align-items:center; justify-content:space-between; gap:14px; }
    .brand{ display:flex; align-items:center; gap:10px; text-decoration:none; }
    .brand img{ width:34px; height:34px; }
    .brand b{ font-weight:1000; letter-spacing:-0.02em; }
    .nav{ display:flex; gap:10px; flex-wrap:wrap; }
    .pill{ display:inline-flex; align-items:center; gap:8px; padding:10px 12px; border-radius:999px; border:1px solid #e6e0d6; background:#fff; text-decoration:none; font-weight:900; }
    .pill.primary{ border-color: transparent; background:linear-gradient(180deg, var(--gold), #ffd98c); color:#1b1208; }

    .wrap{ max-width:1100px; margin:0 auto; padding:22px 18px 70px; }
    .hero{ padding:10px 0 18px; }
    .kicker{ display:inline-flex; align-items:center; gap:8px; font-weight:1000; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:#1b1208;
      background:linear-gradient(180deg, var(--gold), #ffd98c); border-radius:999px; padding:7px 10px; }
    h1{ margin:12px 0 0; font-size:clamp(28px,4.8vw,46px); letter-spacing:-0.02em; line-height:1.06; }
    .sub{ margin:10px 0 0; color:var(--muted); font-weight:800; max-width:70ch; }

    .grid{ display:grid; grid-template-columns: 1.15fr .85fr; gap:16px; margin-top:18px; }
    @media (max-width: 980px){ .grid{ grid-template-columns:1fr; } }
    .card{ background:var(--card); border:1px solid var(--line); border-radius:18px; box-shadow:0 18px 50px rgba(0,0,0,.06); overflow:hidden; }
    .cardPad{ padding:18px; }

    .metaRow{ display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
    .chip{ font-size:12px; font-weight:1000; color:#1b1b1b; background:#faf8f5; border:1px solid var(--line); padding:7px 10px; border-radius:999px; }

    article{ color:#151515; }
    article h2{ margin:22px 0 10px; letter-spacing:-0.02em; }
    article p{ margin:10px 0; color:#2b2b2b; line-height:1.65; font-weight:650; }
    article ul{ margin:10px 0 10px 18px; color:#2b2b2b; line-height:1.6; font-weight:650; }
    article a{ color:#1a4b8c; }
    article .cta{ margin:18px 0; padding:14px; border-radius:16px; background:#faf7ef; border:1px solid #f0e7cf; }

    .list{ display:grid; gap:12px; }
    .postLink{ display:block; padding:14px; border-radius:16px; border:1px solid var(--line); background:#fff; text-decoration:none; }
    .postLink:hover{ border-color:#e0d2ad; box-shadow:0 10px 26px rgba(0,0,0,.06); }
    .postTitle{ font-weight:1000; letter-spacing:-0.01em; }
    .postMeta{ margin-top:6px; color:var(--muted); font-weight:800; font-size:13px; }
    .postExcerpt{ margin-top:8px; color:#2b2b2b; font-weight:650; line-height:1.55; }

    .sideBox h3{ margin:0; font-size:14px; letter-spacing:-0.01em; }
    .sideBox p{ margin:8px 0 0; color:var(--muted); font-weight:750; line-height:1.55; }
    .sideBox .links{ margin-top:12px; display:grid; gap:10px; }

    .foot{ border-top:1px solid var(--line); background:#fff; }
    .footInner{ max-width:1100px; margin:0 auto; padding:18px; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
    .footInner span{ color:var(--muted); font-weight:800; font-size:13px; }
  </style>
  <script type="application/ld+json">${jsonLdSafe}</script>
</head>
<body>
  <header class="top">
    <div class="topInner">
      <a class="brand" href="/" aria-label="PureStay Home">
        <img src="/brand/purestay_exact_SVG.svg" alt="PureStay" />
        <b>PureStay</b>
      </a>
      <nav class="nav" aria-label="Site">
        <a class="pill" href="/discovery">Discovery</a>
        <a class="pill" href="/core">Core</a>
        <a class="pill" href="/culture-shift">Culture Shift</a>
        <a class="pill" href="/signature-stay">Signature Stay</a>
        <a class="pill primary" href="/blogs">Blogs</a>
      </nav>
    </div>
  </header>

  ${body}

  <footer class="foot">
    <div class="footInner">
      <span>© ${new Date().getUTCFullYear()} PureStay • Resident retention experiences</span>
      <a class="pill primary" href="/discovery">Book a call</a>
    </div>
  </footer>
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
    blogPost: posts.map((p) => ({
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

function renderIndex({ siteUrl, posts, total }) {
  const title = 'PureStay Blogs | Multifamily Resident Retention';
  const description = 'Practical retention strategies, resident event ideas, and multifamily community-building playbooks from PureStay.';
  const canonical = `${siteUrl}/blogs`;

  const body = `
  <main class="wrap">
    <section class="hero">
      <span class="kicker">Blogs</span>
      <h1>Resident retention strategies for multifamily</h1>
      <p class="sub">SEO resources about resident events, engagement, and retention systems built for apartment communities.</p>
    </section>

    <section class="grid" aria-label="Blog index">
      <div class="card">
        <div class="cardPad">
          <div class="metaRow"><span class="chip">${escapeHtml(String(total))} posts</span><span class="chip">Updated automatically</span></div>
          <div style="height:12px"></div>
          <div class="list">
            ${posts.map((p) => {
              const date = p.publishedAt ? isoDateOnly(p.publishedAt) : '';
              return `
              <a class="postLink" href="/blogs/${escapeHtml(p.slug)}">
                <div class="postTitle">${escapeHtml(p.title || '')}</div>
                <div class="postMeta">${date ? escapeHtml(date) + ' • ' : ''}PureStay</div>
                <div class="postExcerpt">${escapeHtml(p.excerpt || p.metaDescription || '')}</div>
              </a>`;
            }).join('')}
          </div>
        </div>
      </div>

      <aside class="card sideBox">
        <div class="cardPad">
          <h3>Want this done-for-you?</h3>
          <p>PureStay runs on-site resident experiences and provides reporting so your team can focus on leasing and renewals.</p>
          <div class="links">
            <a class="pill primary" href="/discovery">Book a discovery call</a>
            <a class="pill" href="/core">See Core Package</a>
            <a class="pill" href="/culture-shift">See Culture Shift</a>
            <a class="pill" href="/signature-stay">See Signature Stay</a>
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
      <span class="kicker">PureStay Blog</span>
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
            <p style="margin:10px 0 0;"><a class="pill primary" href="/discovery" style="display:inline-flex;">Book a discovery call</a></p>
          </div>
        </div>
      </article>

      <aside class="card sideBox">
        <div class="cardPad">
          <h3>Packages</h3>
          <p>Pick the level of resident touchpoints and media you want. We handle planning and on-site hosting.</p>
          <div class="links">
            <a class="pill" href="/core">Core Package</a>
            <a class="pill" href="/culture-shift">Culture Shift</a>
            <a class="pill" href="/signature-stay">Signature Stay</a>
            <a class="pill primary" href="/discovery">Talk to us</a>
          </div>
        </div>
      </aside>
    </section>

    <div style="height:14px"></div>
    <a class="pill" href="/blogs">← Back to all blogs</a>
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

  if (!slug) {
    const { posts, total } = await listPosts({ limit: 50, offset: 0 });
    return sendHtml(res, 200, renderIndex({ siteUrl, posts, total }));
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
    return sendHtml(res, 404, html);
  }

  return sendHtml(res, 200, renderPost({ siteUrl, post }));
};
