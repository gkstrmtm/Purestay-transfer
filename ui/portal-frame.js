(function(){
  const doc = document;
  const appView = doc.getElementById('appView');
  const oldAppBar = doc.getElementById('appBar');
  const oldLayout = doc.getElementById('appLayout');
  if (!appView || !oldLayout) return;

  const oldMain = oldLayout.querySelector('main');
  if (!(oldMain instanceof HTMLElement)) return;

  const viewShellBar = doc.getElementById('viewShellBar');
  const viewNodes = Array.from(oldMain.children).filter((node) => node !== viewShellBar);

  const nodes = {
    brand: oldAppBar ? oldAppBar.querySelector('.appbrand') : null,
    contextSwitchers: doc.getElementById('contextSwitchers'),
    topUserRail: oldAppBar ? oldAppBar.querySelector('.topUserRail') : null,
    topNav: doc.getElementById('topNav'),
    sidebarEyebrow: doc.getElementById('sidebarEyebrow'),
    sidebarTitle: doc.getElementById('sidebarTitle'),
    sidebarSub: doc.getElementById('sidebarSub'),
    sidebarPills: doc.getElementById('sidebarPills'),
    sidebarNavTitle: doc.getElementById('sidebarNavTitle'),
    sidebarNav: doc.getElementById('sidebarNav'),
    sidebarContextCard: doc.getElementById('sidebarContextCard'),
    sidebarMetricCard: doc.getElementById('sidebarMetricCard'),
    sidebarAttentionCard: doc.getElementById('sidebarAttentionCard'),
    chatSidebarShell: doc.getElementById('chatSidebarShell'),
    viewShellBar,
  };

  function fallbackBrand(){
    const wrap = doc.createElement('div');
    wrap.className = 'appbrand';
    wrap.innerHTML = '<div class="sidebarAreaBrand" aria-hidden="true">PS</div><div><div class="t">Portal</div><div id="roleLine" class="roleLinePill">PureStay</div></div>';
    return wrap;
  }

  function append(slot, node){
    if (!(slot instanceof HTMLElement) || !(node instanceof HTMLElement)) return;
    slot.appendChild(node);
  }

  const newAppBar = doc.createElement('header');
  newAppBar.id = 'appBar';
  newAppBar.className = 'appbar portalCommandBar';
  newAppBar.innerHTML = [
    '<div class="portalCommandBarInner">',
    '  <div class="portalBrandZone">',
    '    <div class="portalBrandSlot" data-slot="brand"></div>',
    '    <div class="portalBrandMeta">',
    '      <span class="portalBrandKicker">Operations portal reset</span>',
    '      <span class="portalBrandKicker">Shell v2</span>',
    '    </div>',
    '  </div>',
    '  <div class="portalUtilityZone">',
    '    <div data-slot="context"></div>',
    '    <div data-slot="tools"></div>',
    '  </div>',
    '</div>'
  ].join('');

  append(newAppBar.querySelector('[data-slot="brand"]'), nodes.brand instanceof HTMLElement ? nodes.brand : fallbackBrand());
  append(newAppBar.querySelector('[data-slot="context"]'), nodes.contextSwitchers);
  append(newAppBar.querySelector('[data-slot="tools"]'), nodes.topUserRail);

  const newLayout = doc.createElement('div');
  newLayout.id = 'appLayout';
  newLayout.className = 'layout portalWorkspace';
  newLayout.innerHTML = [
    '<aside class="sidebar portalSidebar" aria-label="Portal navigation and context">',
    '  <div class="portalSidebarRail" aria-hidden="true">',
    '    <div class="portalRailLabel">Areas</div>',
    '    <div data-slot="top-nav"></div>',
    '  </div>',
    '  <div class="sidebarShell portalSidebarMain">',
    '    <section class="portalSidebarIdentity">',
    '      <div data-slot="eyebrow"></div>',
    '      <div data-slot="title"></div>',
    '      <div data-slot="sub"></div>',
    '      <div data-slot="pills"></div>',
    '    </section>',
    '    <section class="portalSurface portalNavSurface" aria-labelledby="sidebarNavTitle">',
    '      <div class="portalSurfaceHeader" data-slot="nav-title"></div>',
    '      <nav data-slot="nav"></nav>',
    '    </section>',
    '    <section data-slot="context-card"></section>',
    '    <section data-slot="chat"></section>',
    '    <section data-slot="metric-card"></section>',
    '    <section data-slot="attention-card"></section>',
    '  </div>',
    '</aside>',
    '<main id="mainContent" class="main portalMain" tabindex="-1" aria-labelledby="viewTitle">',
    '  <section class="portalWorkspaceHeader" data-slot="view-shell"></section>',
    '  <div class="portalWorkspaceContent" data-slot="views"></div>',
    '</main>'
  ].join('');

  append(newLayout.querySelector('[data-slot="top-nav"]'), nodes.topNav);
  append(newLayout.querySelector('[data-slot="eyebrow"]'), nodes.sidebarEyebrow);
  append(newLayout.querySelector('[data-slot="title"]'), nodes.sidebarTitle);
  append(newLayout.querySelector('[data-slot="sub"]'), nodes.sidebarSub);
  append(newLayout.querySelector('[data-slot="pills"]'), nodes.sidebarPills);
  append(newLayout.querySelector('[data-slot="nav-title"]'), nodes.sidebarNavTitle);
  append(newLayout.querySelector('[data-slot="nav"]'), nodes.sidebarNav);
  append(newLayout.querySelector('[data-slot="context-card"]'), nodes.sidebarContextCard);
  append(newLayout.querySelector('[data-slot="metric-card"]'), nodes.sidebarMetricCard);
  append(newLayout.querySelector('[data-slot="attention-card"]'), nodes.sidebarAttentionCard);
  append(newLayout.querySelector('[data-slot="chat"]'), nodes.chatSidebarShell);
  append(newLayout.querySelector('[data-slot="view-shell"]'), nodes.viewShellBar);

  const viewsSlot = newLayout.querySelector('[data-slot="views"]');
  if (viewsSlot instanceof HTMLElement) {
    for (const node of viewNodes) viewsSlot.appendChild(node);
  }

  if (oldAppBar instanceof HTMLElement) oldAppBar.replaceWith(newAppBar);
  if (oldLayout instanceof HTMLElement) oldLayout.replaceWith(newLayout);

  doc.body.classList.add('portal-shell-reset');
  doc.body.setAttribute('data-shell-version', '2');
  doc.getElementById('viewOverview')?.classList.add('portal-view-overview');
  doc.getElementById('viewLeads')?.classList.add('portal-view-leads');
  doc.getElementById('viewChat')?.classList.add('portal-view-chat');
})();
