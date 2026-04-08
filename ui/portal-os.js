(() => {
  const SESSION_KEY = 'portal.os.session.v1';
  const SETTINGS_ROLE_OPTIONS = ['manager', 'territory_specialist', 'account_manager', 'event_coordinator', 'event_host', 'media_team', 'dialer', 'closer', 'remote_setter', 'in_person_setter'];
  const WORKSPACES = [
    { id: 'command', label: 'Overview', icon: 'overview' },
    { id: 'pipeline', label: 'Clients', icon: 'clients' },
    { id: 'operations', label: 'Fulfillment', icon: 'fulfillment' },
    { id: 'workforce', label: 'Workday', icon: 'workday' },
    { id: 'assistant', label: 'Pura', icon: 'assistant' },
  ];
  const SETTINGS_WORKSPACE = { id: 'settings', label: 'Settings', icon: 'settings' };

  function createBootstrapState() {
    return {
      status: 'ready',
      title: '',
      copy: '',
      detail: null,
      approvedRole: '',
      requestedRole: '',
      managerUserId: '',
      journeyId: null,
    };
  }

  function createSettingsState() {
    return {
      tab: 'account',
      account: {
        detail: null,
      },
      admin: {
        bookingCalendarUrl: '',
        stripeCheckoutUrl: '',
        stripePricingUrl: '',
        internalNotes: '',
        bookingPlatformConfigured: false,
        bookingPlatformProvider: '',
        bookingPlatformBaseUrl: '',
        bookingPlatformAccountLinked: false,
        updatedAt: '',
      },
      accessAccounts: [],
      accessEntry: null,
      accessHistory: [],
      selectedUserId: '',
      reviewEntries: [],
      reviewDetail: null,
      selectedReviewUserId: '',
      supports: {},
      lastAccessResult: null,
      lastProfileResult: null,
      lastReviewResult: null,
      loadingEntry: false,
      loadingReviewEntry: false,
    };
  }

  const state = {
    runtimeOrigin: defaultPortalRuntimeOrigin(),
    booting: true,
    authMode: 'password',
    authConfig: { preview: { enabled: false } },
    session: null,
    user: null,
    profile: null,
    person: null,
    capabilities: null,
    roleContext: null,
    activeWorkspace: 'command',
    loading: {},
    notices: {
      auth: '',
      app: '',
    },
    filters: {
      leads: { q: '', status: '' },
      events: { status: '', areaTag: '' },
      tasks: { q: '', status: '', mine: '1' },
    },
    sorts: {
      leads: { key: '', direction: 'asc' },
      events: { key: '', direction: 'asc' },
      tasks: { key: '', direction: 'asc' },
    },
    overview: null,
    leads: [],
    events: [],
    tasks: [],
    taskSource: '',
    taskReady: true,
    threads: [],
    threadsReady: false,
    activeThreadId: '',
    activeThread: null,
    messages: [],
    assistantContextAttached: false,
    assistantContextSource: '',
    assistantMode: 'discuss',
    assistantRequestMode: 'general',
    assistantDraft: '',
    settings: createSettingsState(),
    bootstrap: createBootstrapState(),
    selections: {
      leadId: null,
      eventId: null,
      taskId: null,
      queueKey: '',
    },
    sheet: null,
    toasts: [],
  };

  const refs = {};

  function defaultPortalRuntimeOrigin() {
    const { protocol, hostname, port, origin } = window.location;
    if (/^(localhost|127\.0\.0\.1)$/i.test(hostname) && String(port || '').trim() && String(port) !== '3000') {
      return `${protocol}//${hostname}:3000`;
    }
    return origin;
  }

  function localManagerPreviewAvailable() {
    const { hostname } = window.location;
    return /^(localhost|127\.0\.0\.1)$/i.test(String(hostname || '').trim());
  }

  function runtimeUrl(path) {
    return new URL(path, state.runtimeOrigin).toString();
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/'/g, '&#39;');
  }

  function cleanText(value, fallback = 'Not set') {
    const text = String(value || '').trim();
    return text || fallback;
  }

  function compact(value, max = 120) {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function humanizeLabel(value) {
    const text = String(value || '').trim().replace(/_/g, ' ');
    if (!text) return '';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function csvText(values) {
    return Array.isArray(values) ? values.filter(Boolean).join(', ') : '';
  }

  function splitCsvText(value) {
    return String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('file_read_failed'));
      reader.readAsDataURL(file);
    });
  }

  function primaryManagerUserId(detail) {
    return cleanText(detail?.person?.managerUserId || detail?.employmentProfile?.manager_user_id || state.person?.manager_user_id, '');
  }

  function onboardingRequestedRole(detail) {
    return cleanText(
      detail?.onboardingJourney?.meta?.requestedRole
        || detail?.onboardingJourney?.collectedData?.requestedRole
        || detail?.onboardingJourney?.role,
      ''
    );
  }

  function onboardingApprovedRole(detail) {
    return cleanText(
      detail?.onboardingJourney?.meta?.approvedRole
        || detail?.onboardingJourney?.collectedData?.approvedRole
        || detail?.person?.role
        || state.profile?.role,
      ''
    );
  }

  function profileBasicsComplete(detail) {
    const publicProfile = detail?.talentProfile?.public || {};
    return !!(
      cleanText(publicProfile.displayName, '')
      && cleanText(publicProfile.homeBaseCity, '')
      && cleanText(publicProfile.homeBaseState, '')
    );
  }

  function deriveBootstrapState(detail) {
    const journey = detail?.onboardingJourney || {};
    const requestedRole = onboardingRequestedRole(detail);
    const approvedRole = onboardingApprovedRole(detail);
    const approvalStatus = cleanText(journey?.meta?.approvalStatus, approvedRole ? 'approved' : 'pending').toLowerCase();
    const stageKey = cleanText(journey?.stageKey, '').toLowerCase();
    const profileReady = profileBasicsComplete(detail);
    const managerUserId = primaryManagerUserId(detail);
    const needsReview = approvalStatus !== 'approved' || (requestedRole && approvedRole && requestedRole !== approvedRole) || ['pending_role_review', 'pending_review'].includes(stageKey);
    const needsSetup = !profileReady || ['access_setup', 'profile_setup', 'intake'].includes(stageKey) || !journey?.id;

    if (needsReview) {
      return {
        status: 'review',
        title: 'Pending review',
        copy: 'Your setup is saved, but your routed workspace is waiting on role or readiness review before full access opens.',
        detail,
        approvedRole,
        requestedRole,
        managerUserId,
        journeyId: journey?.id || null,
      };
    }

    if (needsSetup) {
      return {
        status: 'setup',
        title: 'Complete setup',
        copy: 'Finish your employee profile and confirm your working role before the full workspace opens.',
        detail,
        approvedRole,
        requestedRole: requestedRole || approvedRole,
        managerUserId,
        journeyId: journey?.id || null,
      };
    }

    return {
      status: 'ready',
      title: '',
      copy: '',
      detail,
      approvedRole,
      requestedRole: requestedRole || approvedRole,
      managerUserId,
      journeyId: journey?.id || null,
    };
  }

  function workspaceIconMarkup(icon) {
    if (icon === 'clients') {
      return "<svg viewBox='0 0 16 16' fill='none' aria-hidden='true'><path d='M3 4.25h10M3 8h10M3 11.75h6' stroke='currentColor' stroke-width='1.2' stroke-linecap='round'></path><circle cx='11.5' cy='11.75' r='1.5' stroke='currentColor' stroke-width='1.2'></circle></svg>";
    }
    if (icon === 'fulfillment') {
      return "<svg viewBox='0 0 16 16' fill='none' aria-hidden='true'><path d='M3.25 12.75h9.5V5.5L10.4 3.25h-7.15v9.5Z' stroke='currentColor' stroke-width='1.2' stroke-linejoin='round'></path><path d='M10.25 3.25v2.5h2.5' stroke='currentColor' stroke-width='1.2' stroke-linejoin='round'></path></svg>";
    }
    if (icon === 'workday') {
      return "<svg viewBox='0 0 16 16' fill='none' aria-hidden='true'><rect x='2.5' y='3.25' width='11' height='10.25' rx='2' stroke='currentColor' stroke-width='1.2'></rect><path d='M5.25 2.5v2M10.75 2.5v2M2.5 6.25h11' stroke='currentColor' stroke-width='1.2' stroke-linecap='round'></path></svg>";
    }
    if (icon === 'assistant') {
      return "<svg viewBox='0 0 16 16' fill='none' aria-hidden='true'><path d='M3.25 4.75a2.5 2.5 0 0 1 2.5-2.5h4.5a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 0 1-2.5 2.5H7.5L4 13.5v-3.25a2.49 2.49 0 0 1-.75-1.8v-3.7Z' stroke='currentColor' stroke-width='1.2' stroke-linejoin='round'></path><path d='M6 6.75h4M6 9h2.5' stroke='currentColor' stroke-width='1.2' stroke-linecap='round'></path></svg>";
    }
    if (icon === 'settings') {
      return "<svg viewBox='0 0 16 16' fill='none' aria-hidden='true'><path d='M6.9 1.4h2.2l.35 1.7c.38.12.74.27 1.08.45l1.48-.9 1.56 1.56-.9 1.48c.18.34.33.7.45 1.08l1.7.35v2.2l-1.7.35c-.12.38-.27.74-.45 1.08l.9 1.48-1.56 1.56-1.48-.9c-.34.18-.7.33-1.08.45l-.35 1.7H6.9l-.35-1.7a5.57 5.57 0 0 1-1.08-.45l-1.48.9-1.56-1.56.9-1.48a5.57 5.57 0 0 1-.45-1.08l-1.7-.35V6.9l1.7-.35c.12-.38.27-.74.45-1.08l-.9-1.48L4 2.43l1.48.9c.34-.18.7-.33 1.08-.45l.34-1.48Z' stroke='currentColor' stroke-width='1.1' stroke-linejoin='round'></path><circle cx='8' cy='8' r='2.2' stroke='currentColor' stroke-width='1.1'></circle></svg>";
    }
    return "<svg viewBox='0 0 16 16' fill='none' aria-hidden='true'><rect x='2.75' y='2.75' width='4.25' height='4.25' rx='1' stroke='currentColor' stroke-width='1.2'></rect><rect x='9' y='2.75' width='4.25' height='4.25' rx='1' stroke='currentColor' stroke-width='1.2'></rect><rect x='2.75' y='9' width='4.25' height='4.25' rx='1' stroke='currentColor' stroke-width='1.2'></rect><rect x='9' y='9' width='4.25' height='4.25' rx='1' stroke='currentColor' stroke-width='1.2'></rect></svg>";
  }

  function formatDate(value) {
    if (!value) return 'No date';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value);
    const now = new Date();
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    });
  }

  function formatDateTime(value) {
    if (!value) return 'No time';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const timeLabel = date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
    if (
      date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate()
    ) return `Today, ${timeLabel}`;
    if (
      date.getFullYear() === yesterday.getFullYear()
      && date.getMonth() === yesterday.getMonth()
      && date.getDate() === yesterday.getDate()
    ) return `Yesterday, ${timeLabel}`;
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function formatMoneyFromCents(value) {
    const cents = Number(value || 0);
    if (!Number.isFinite(cents)) return '$0';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  }

  function formatDollarsInputFromCents(value) {
    const cents = Number(value);
    if (!Number.isFinite(cents) || cents === 0) return '';
    const dollars = cents / 100;
    return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
  }
  function statusTone(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!key) return 'default';
    if (['failed', 'blocked', 'cancelled', 'at_risk', 'overdue', 'not_ready'].includes(key)) return 'danger';
    if (['ready', 'open', 'active', 'assigned', 'accepted', 'completed', 'confirmed'].includes(key)) return 'accent';
    if (['pending', 'new', 'draft', 'queued', 'in_progress', 'submitted', 'planned'].includes(key)) return 'gold';
    return 'default';
  }

  function serializeSession() {
    if (!state.session || !state.user || !state.profile) return;
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      session: state.session,
      user: state.user,
      profile: state.profile,
    }));
  }

  function restoreSession() {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      state.session = parsed.session || null;
      state.user = parsed.user || null;
      state.profile = parsed.profile || null;
    } catch {
      localStorage.removeItem(SESSION_KEY);
    }
  }

  function clearSession() {
    state.session = null;
    state.user = null;
    state.profile = null;
    state.person = null;
    state.capabilities = null;
    state.roleContext = null;
    state.overview = null;
    state.leads = [];
    state.events = [];
    state.tasks = [];
    state.threads = [];
    state.threadsReady = false;
    state.activeThreadId = '';
    state.activeThread = null;
    state.messages = [];
    state.assistantContextAttached = false;
    state.assistantContextSource = '';
    state.assistantMode = 'discuss';
    state.assistantRequestMode = 'general';
    state.assistantDraft = '';
    state.settings = createSettingsState();
    state.bootstrap = createBootstrapState();
    localStorage.removeItem(SESSION_KEY);
  }

  function queueToast(message, tone = 'accent') {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    state.toasts = state.toasts.concat([{ id, message, tone }]).slice(-4);
    renderToasts();
    window.setTimeout(() => {
      state.toasts = state.toasts.filter((entry) => entry.id !== id);
      renderToasts();
    }, 2800);
  }

  function activeLead() {
    return state.leads.find((lead) => String(lead.id) === String(state.selections.leadId)) || null;
  }

  function activeEvent() {
    return state.events.find((event) => String(event.id) === String(state.selections.eventId)) || null;
  }

  function activeTask() {
    return state.tasks.find((task) => String(task.id) === String(state.selections.taskId)) || null;
  }

  async function api(path, options = {}) {
    const { method = 'GET', auth = true, body, retry = true } = options;
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (auth && state.session?.access_token) headers.set('Authorization', `Bearer ${state.session.access_token}`);

    const response = await fetch(runtimeUrl(path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const payload = await response.json().catch(() => ({}));

    if (response.status === 401 && auth && retry && state.session?.refresh_token) {
      const refreshed = await refreshSession();
      if (refreshed) return api(path, Object.assign({}, options, { retry: false }));
    }

    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.error || `request_failed_${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  async function refreshSession() {
    if (!state.session?.refresh_token) return false;
    try {
      const refreshed = await api('/api/portal/refresh', {
        method: 'POST',
        auth: false,
        retry: false,
        body: { refreshToken: state.session.refresh_token },
      });
      applyAuthPayload(refreshed);
      return true;
    } catch {
      clearSession();
      render();
      return false;
    }
  }

  function applyAuthPayload(payload) {
    state.session = payload.session || null;
    state.user = payload.user || null;
    state.profile = payload.profile || null;
    serializeSession();
  }

  async function loadAuthConfig() {
    try {
      const payload = await api('/api/portal/auth_config', { auth: false, retry: false });
      const previewEnabled = !!payload?.preview?.enabled || localManagerPreviewAvailable();
      state.authConfig = Object.assign({}, payload, {
        preview: Object.assign({}, payload?.preview || {}, {
          enabled: previewEnabled,
        }),
      });
      if (previewEnabled && !state.session) state.authMode = 'preview';
    } catch {
      const previewEnabled = localManagerPreviewAvailable();
      state.authConfig = { preview: { enabled: previewEnabled } };
      if (previewEnabled && !state.session) state.authMode = 'preview';
    }
  }

  async function renameThread(threadId, title) {
    const id = String(threadId || '').trim();
    const nextTitle = cleanText(title, 'New thread');
    if (!id || !nextTitle) return;
    const payload = await api('/api/portal/ai/threads', {
      method: 'PATCH',
      body: { threadId: id, title: nextTitle },
    });
    const updated = payload.thread || null;
    if (!updated) return;
    state.threads = state.threads.map((thread) => String(thread.id) === id ? Object.assign({}, thread, updated) : thread);
    if (String(state.activeThreadId || '') === id) {
      state.activeThread = Object.assign({}, state.activeThread || {}, updated);
    }
    render();
  }

  async function hydrateSession() {
    const me = await api('/api/portal/me');
    state.user = me.user || state.user;
    state.profile = me.profile || state.profile;
    state.person = me.person || null;
    state.capabilities = me.capabilities || null;
    state.roleContext = me.roleContext || null;
    const detail = state.user?.id ? await api(`/api/portal/people?userId=${encodeURIComponent(state.user.id)}`) : null;
    if (detail) {
      state.settings.account.detail = detail;
      state.bootstrap = deriveBootstrapState(detail);
    } else {
      state.bootstrap = createBootstrapState();
    }
    serializeSession();
  }

  function setLoading(key, value) {
    state.loading[key] = value;
    render();
  }

  function ensureSelection(list, key, selectionKey) {
    if (!Array.isArray(list) || !list.length) {
      state.selections[selectionKey] = null;
      return;
    }
    const found = list.some((row) => String(row[key]) === String(state.selections[selectionKey]));
    if (!found) state.selections[selectionKey] = list[0][key];
  }

  async function loadOverview(force = false) {
    if (state.loading.command && !force) return;
    setLoading('command', true);
    try {
      const payload = await api('/api/portal/overview');
      state.overview = payload || null;
      state.notices.app = '';
    } catch (error) {
      state.notices.app = humanizeError(error);
    } finally {
      setLoading('command', false);
    }
  }

  async function loadLeads(force = false) {
    if (state.loading.pipeline && !force) return;
    setLoading('pipeline', true);
    try {
      const params = new URLSearchParams({ limit: '120' });
      if (state.filters.leads.q) params.set('q', state.filters.leads.q);
      if (state.filters.leads.status) params.set('status', state.filters.leads.status);
      const payload = await api(`/api/portal/leads?${params.toString()}`);
      state.leads = Array.isArray(payload.leads) ? payload.leads : [];
      ensureSelection(state.leads, 'id', 'leadId');
      state.notices.app = '';
    } catch (error) {
      state.notices.app = humanizeError(error);
    } finally {
      setLoading('pipeline', false);
    }
  }

  async function loadEvents(force = false) {
    if (state.loading.operations && !force) return;
    setLoading('operations', true);
    try {
      const params = new URLSearchParams({ limit: '120' });
      if (state.filters.events.status) params.set('status', state.filters.events.status);
      if (state.filters.events.areaTag) params.set('areaTag', state.filters.events.areaTag);
      const payload = await api(`/api/portal/events?${params.toString()}`);
      state.events = Array.isArray(payload.events) ? payload.events : [];
      ensureSelection(state.events, 'id', 'eventId');
      state.notices.app = '';
    } catch (error) {
      state.notices.app = humanizeError(error);
    } finally {
      setLoading('operations', false);
    }
  }
  async function loadTasks(force = false) {
    if (state.loading.workforce && !force) return;
    setLoading('workforce', true);
    try {
      const params = new URLSearchParams({ limit: '120' });
      if (state.filters.tasks.q) params.set('q', state.filters.tasks.q);
      if (state.filters.tasks.status) params.set('status', state.filters.tasks.status);
      if (state.filters.tasks.mine) params.set('mine', state.filters.tasks.mine);
      const payload = await api(`/api/portal/tasks?${params.toString()}`);
      state.tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      state.taskSource = payload.source || '';
      state.taskReady = payload.ready !== false;
      ensureSelection(state.tasks, 'id', 'taskId');
      state.notices.app = '';
    } catch (error) {
      state.notices.app = humanizeError(error);
    } finally {
      setLoading('workforce', false);
    }
  }

  async function loadThreads(options = {}) {
    const params = new URLSearchParams({ limit: '50', messageLimit: '120' });
    if (options.threadId) params.set('threadId', options.threadId);
    const payload = await api(`/api/portal/ai/threads?${params.toString()}`);
    state.threadsReady = !!payload.ready;
    state.threads = Array.isArray(payload.threads) ? payload.threads : [];
    state.activeThread = payload.thread || null;
    state.activeThreadId = payload.thread?.id || state.activeThreadId || '';
    state.messages = Array.isArray(payload.messages) ? payload.messages : state.messages;
    if (!options.threadId && !state.activeThreadId && state.threads[0]?.id) {
      await loadThreads({ threadId: state.threads[0].id });
      return;
    }
    render();
  }

  function settingsTabs() {
    const tabs = [
      { id: 'account', label: 'Account', audience: 'You' },
    ];
    if (state.capabilities?.canManageUsers) tabs.push({ id: 'review', label: 'Review', audience: 'Managers' });
    if (state.capabilities?.canManageUserAccess) tabs.push({ id: 'access', label: 'User access', audience: 'Managers' });
    if (state.capabilities?.canManageAdmin) tabs.push({ id: 'admin', label: 'Admin', audience: 'Managers' });
    return tabs;
  }

  function normalizeSettingsTab(tab = state.settings?.tab || 'account') {
    const tabs = settingsTabs();
    return tabs.some((item) => item.id === tab) ? tab : tabs[0]?.id || 'account';
  }

  function reviewRequestedRole(submission, journey, fallback = '') {
    return cleanText(
      submission?.normalizedData?.requestedRole
      || submission?.meta?.requestedRole
      || submission?.subjectRole
      || journey?.collectedData?.requestedRole
      || journey?.meta?.requestedRole,
      fallback,
    );
  }

  function reviewApprovedRole(submission, journey, fallback = '') {
    return cleanText(
      journey?.meta?.approvedRole
      || journey?.collectedData?.approvedRole
      || submission?.normalizedData?.approvedRole
      || submission?.meta?.approvedRole,
      fallback,
    );
  }

  function reviewApprovalStatus(submission, journey) {
    const metaStatus = cleanText(
      submission?.meta?.approvalStatus
      || submission?.normalizedData?.approvalStatus
      || journey?.meta?.approvalStatus,
      '',
    ).toLowerCase();
    if (metaStatus) return metaStatus;
    const submissionStatus = cleanText(submission?.status, '').toLowerCase();
    return ['approved', 'rejected', 'in_review'].includes(submissionStatus) ? submissionStatus : '';
  }

  function buildSettingsReviewEntries(accounts, onboardingPayload) {
    const accountByUserId = new Map((Array.isArray(accounts) ? accounts : []).map((account) => [String(account.userId || '').trim(), account]));
    const latestSubmissionByUserId = new Map();
    const latestJourneyByUserId = new Map();

    (Array.isArray(onboardingPayload?.submissions) ? onboardingPayload.submissions : []).forEach((submission) => {
      const userId = String(submission?.personUserId || '').trim();
      if (!userId || latestSubmissionByUserId.has(userId)) return;
      latestSubmissionByUserId.set(userId, submission);
    });

    (Array.isArray(onboardingPayload?.journeys) ? onboardingPayload.journeys : []).forEach((journey) => {
      const userId = String(journey?.personUserId || '').trim();
      if (!userId || latestJourneyByUserId.has(userId)) return;
      latestJourneyByUserId.set(userId, journey);
    });

    const userIds = new Set([
      ...accountByUserId.keys(),
      ...latestSubmissionByUserId.keys(),
      ...latestJourneyByUserId.keys(),
    ]);

    return Array.from(userIds).map((userId) => {
      const account = accountByUserId.get(userId) || {};
      const submission = latestSubmissionByUserId.get(userId) || null;
      const journey = latestJourneyByUserId.get(userId) || null;
      const submissionStatus = cleanText(submission?.status, '').toLowerCase();
      const journeyStatus = cleanText(journey?.status, '').toLowerCase();
      const stageKey = cleanText(journey?.stageKey, '').toLowerCase();
      const approvalStatus = reviewApprovalStatus(submission, journey);
      const requestedRole = reviewRequestedRole(submission, journey, '');
      const approvedRole = reviewApprovedRole(submission, journey, cleanText(account.role, ''));
      const readinessStatus = cleanText(account.readinessStatus, '').toLowerCase();
      const needsDecision = ['submitted', 'in_review'].includes(submissionStatus)
        || approvalStatus === 'in_review'
        || stageKey === 'pending_role_review';
      const restricted = readinessStatus === 'restricted' || journeyStatus === 'blocked' || approvalStatus === 'rejected';
      const activationPending = !needsDecision && !restricted && !!journey
        && ['pending', 'queued', 'active'].includes(journeyStatus)
        && !['ready', 'workspace_ready', 'completed'].includes(stageKey);

      if (!needsDecision && !restricted && !activationPending) return null;

      const tone = needsDecision ? 'gold' : restricted ? 'danger' : 'default';
      const attentionLabel = needsDecision ? 'Role review' : restricted ? 'Held' : 'Release';
      const summary = needsDecision
        ? compact(`Requested ${humanizeLabel(requestedRole || 'role')}`, 78)
        : restricted
          ? compact(`Release held${approvedRole ? ` • ${humanizeLabel(approvedRole)}` : ''}`, 78)
          : compact(`Pending ${humanizeLabel(stageKey || journeyStatus || 'release')}`, 78);

      return {
        userId,
        fullName: cleanText(account.fullName, userId),
        email: cleanText(account.email, ''),
        currentRole: cleanText(account.role, ''),
        requestedRole,
        approvedRole,
        approvalStatus,
        submissionStatus,
        journeyStatus,
        stageKey,
        readinessStatus,
        employmentStatus: cleanText(account.employmentStatus, ''),
        managerUserId: cleanText(account.managerUserId || journey?.managerUserId, ''),
        submissionId: submission?.id || null,
        journeyId: journey?.id || null,
        updatedAt: submission?.updatedAt || journey?.updatedAt || account.updatedAt || account.createdAt || '',
        tone,
        attentionLabel,
        summary,
        sortWeight: needsDecision ? 0 : restricted ? 1 : 2,
        submission,
        journey,
      };
    }).filter(Boolean).sort((left, right) => {
      const weight = Number(left.sortWeight || 0) - Number(right.sortWeight || 0);
      if (weight) return weight;
      const leftTime = Date.parse(left.updatedAt || '') || 0;
      const rightTime = Date.parse(right.updatedAt || '') || 0;
      return rightTime - leftTime;
    });
  }

  function selectedSettingsReviewEntry() {
    const entries = Array.isArray(state.settings.reviewEntries) ? state.settings.reviewEntries : [];
    return entries.find((entry) => String(entry.userId) === String(state.settings.selectedReviewUserId || '')) || entries[0] || null;
  }

  async function loadSettingsAccessEntry(userId) {
    const cleanUserId = String(userId || '').trim();
    state.settings.selectedUserId = cleanUserId;
    state.settings.accessEntry = null;
    state.settings.accessHistory = [];
    if (!cleanUserId || !state.capabilities?.canManageUserAccess) return;

    state.settings.loadingEntry = true;
    render();
    try {
      const params = new URLSearchParams({ userId: cleanUserId });
      const payload = await api(`/api/portal/user_access?${params.toString()}`);
      state.settings.accessEntry = payload.entry || null;
      state.settings.accessHistory = Array.isArray(payload.history) ? payload.history : [];
      state.notices.app = '';
    } catch (error) {
      state.notices.app = humanizeError(error);
    } finally {
      state.settings.loadingEntry = false;
      render();
    }
  }

  async function loadSettingsReviewEntry(userId) {
    const cleanUserId = String(userId || '').trim();
    state.settings.selectedReviewUserId = cleanUserId;
    state.settings.reviewDetail = null;
    if (!cleanUserId || !state.capabilities?.canManageUsers) return;

    state.settings.loadingReviewEntry = true;
    render();
    try {
      const payload = await api(`/api/portal/people?userId=${encodeURIComponent(cleanUserId)}`);
      state.settings.reviewDetail = payload || null;
      state.notices.app = '';
    } catch (error) {
      state.notices.app = humanizeError(error);
    } finally {
      state.settings.loadingReviewEntry = false;
      render();
    }
  }

  async function loadSettings(force = false) {
    if (state.loading.settings && !force) return;
    state.settings.tab = normalizeSettingsTab(state.settings.tab);
    state.loading.settings = true;
    render();
    try {
      const accountPayload = await api(`/api/portal/people?userId=${encodeURIComponent(state.user?.id || '')}`);
      state.settings.account.detail = accountPayload || null;

      if (state.capabilities?.canManageAdmin) {
        const adminPayload = await api('/api/portal/admin_settings');
        state.settings.admin = Object.assign({}, state.settings.admin, adminPayload.settings || {});
      }

      if (state.capabilities?.canManageUserAccess) {
        const accessPayload = await api('/api/portal/user_access');
        state.settings.accessAccounts = Array.isArray(accessPayload.accounts) ? accessPayload.accounts : [];
        state.settings.supports = accessPayload.supports || {};
        const selectedUserId = state.settings.selectedUserId || state.settings.accessAccounts[0]?.userId || '';
        if (selectedUserId) {
          await loadSettingsAccessEntry(selectedUserId);
        }
      }

      if (state.capabilities?.canManageUsers) {
        const onboardingPayload = await api('/api/portal/onboarding?limit=120');
        state.settings.reviewEntries = buildSettingsReviewEntries(state.settings.accessAccounts, onboardingPayload);
        const selectedReviewUserId = state.settings.selectedReviewUserId || state.settings.reviewEntries[0]?.userId || '';
        if (selectedReviewUserId) {
          await loadSettingsReviewEntry(selectedReviewUserId);
        }
      }

      state.notices.app = '';
    } catch (error) {
      state.notices.app = humanizeError(error);
    } finally {
      state.loading.settings = false;
      render();
    }
  }

  async function loadWorkspace(workspaceId, force = false) {
    state.activeWorkspace = workspaceId;
    render();
    if (workspaceId === 'command') await loadOverview(force);
    if (workspaceId === 'pipeline') await loadLeads(force);
    if (workspaceId === 'operations') await loadEvents(force);
    if (workspaceId === 'workforce') await loadTasks(force);
    if (workspaceId === 'settings') await loadSettings(force);
    if (workspaceId === 'assistant') {
      state.loading.assistant = true;
      render();
      try {
        await loadThreads({ threadId: state.activeThreadId || '' });
        state.notices.app = '';
      } catch (error) {
        state.notices.app = humanizeError(error);
      } finally {
        state.loading.assistant = false;
        render();
      }
    }
  }

  function humanizeError(error) {
    const code = error?.payload?.error || error?.message || 'Request failed';
    const detail = error?.payload?.detail ? ` ${error.payload.detail}` : '';
    return `${String(code).replace(/_/g, ' ')}${detail}`.trim();
  }

  async function handleLogin(form) {
    const data = new FormData(form);
    state.notices.auth = '';
    render();
    try {
      const body = state.authMode === 'preview'
        ? { previewCode: String(data.get('previewCode') || '').trim() }
        : {
            email: String(data.get('email') || '').trim(),
            password: String(data.get('password') || '').trim(),
          };
      const payload = await api('/api/portal/login', {
        method: 'POST',
        auth: false,
        retry: false,
        body,
      });
      applyAuthPayload(payload);
      await hydrateSession();
      await loadWorkspace('command', true);
      queueToast('Session established');
    } catch (error) {
      state.notices.auth = humanizeError(error);
      render();
    }
  }

  async function saveAdminSettings(form) {
    const data = new FormData(form);
    const payload = await api('/api/portal/admin_settings', {
      method: 'POST',
      body: {
        bookingCalendarUrl: String(data.get('bookingCalendarUrl') || '').trim(),
        stripeCheckoutUrl: String(data.get('stripeCheckoutUrl') || '').trim(),
        stripePricingUrl: String(data.get('stripePricingUrl') || '').trim(),
        internalNotes: String(data.get('internalNotes') || '').trim(),
      },
    });
    state.settings.admin = Object.assign({}, state.settings.admin, payload.settings || {});
    queueToast('Admin settings saved');
    render();
  }

  async function provisionSettingsAccess(form) {
    const data = new FormData(form);
    const payload = await api('/api/portal/user_access', {
      method: 'POST',
      body: {
        action: 'provision',
        fullName: String(data.get('fullName') || '').trim(),
        email: String(data.get('email') || '').trim(),
        role: String(data.get('role') || '').trim() || 'dialer',
        managerUserId: String(data.get('managerUserId') || '').trim(),
      },
    });
    state.settings.lastAccessResult = {
      label: 'Access provisioned',
      copy: payload.user?.email
        ? `${payload.user.email} has an activation link and a profile setup journey ready.`
        : 'Access and onboarding have been provisioned.',
      link: payload.access?.actionLink || '',
    };
    queueToast(payload.createdNew ? 'User provisioned' : 'Access refreshed');
    await loadSettings(true);
  }

  async function saveSettingsProfile(form) {
    const data = new FormData(form);
    const avatarFile = data.get('avatarFile');
    let avatarDataUrl = '';

    if (avatarFile instanceof File && avatarFile.size > 0) {
      if (!/^image\/(png|jpeg)$/i.test(String(avatarFile.type || ''))) {
        throw new Error('Only PNG and JPEG profile images are supported right now.');
      }
      avatarDataUrl = await readFileAsDataUrl(avatarFile);
    }

    await api('/api/portal/talent_profiles', {
      method: 'POST',
      body: {
        profile: {
          public: {
            displayName: String(data.get('displayName') || '').trim(),
            bio: String(data.get('bio') || '').trim(),
            homeBaseCity: String(data.get('homeBaseCity') || '').trim(),
            homeBaseState: String(data.get('homeBaseState') || '').trim(),
            specialties: splitCsvText(data.get('specialties')),
            tone: splitCsvText(data.get('tone')),
            gear: splitCsvText(data.get('gear')),
            avatarDataUrl,
          },
        },
      },
    });

    state.settings.lastProfileResult = {
      label: 'Profile updated',
      copy: 'Your employee profile is now live in the portal settings surface.',
    };
    queueToast('Profile saved');
    await loadSettings(true);
  }

  async function saveSettingsReview(form, submitter) {
    const data = new FormData(form);
    if (submitter?.name) data.set(submitter.name, submitter.value || '');
    const entry = selectedSettingsReviewEntry();
    const detail = state.settings.reviewDetail || {};
    const journey = entry?.journey || detail.onboardingJourney || {};
    const submission = entry?.submission || {};
    const userId = String(data.get('userId') || entry?.userId || '').trim();
    if (!userId) throw new Error('Missing review target.');

    const action = String(data.get('reviewAction') || 'save').trim() || 'save';
    const requestedRole = reviewRequestedRole(submission, journey, cleanText(detail.person?.role || entry?.currentRole, ''));
    const approvedRole = String(data.get('approvedRole') || detail.person?.role || entry?.approvedRole || entry?.currentRole || 'dialer').trim() || 'dialer';
    const employmentStatus = String(data.get('employmentStatus') || detail.person?.employmentStatus || entry?.employmentStatus || 'candidate').trim() || 'candidate';
    const selectedReadiness = String(data.get('readinessStatus') || detail.person?.readinessStatus || entry?.readinessStatus || 'not_started').trim() || 'not_started';
    const canBeAssigned = String(data.get('canBeAssigned') || (detail.person?.canBeAssigned === false ? '0' : '1')).trim() === '1';
    const nextReadinessStatus = action === 'approve' ? 'ready' : selectedReadiness;
    const nextCanBeAssigned = action === 'approve' ? true : canBeAssigned;
    const reviewNotes = String(data.get('reviewNotes') || '').trim();
    const managerUserId = String(data.get('managerUserId') || detail.person?.managerUserId || entry?.managerUserId || '').trim();

    await api('/api/portal/users', {
      method: 'PATCH',
      body: {
        userId,
        fullName: String(data.get('fullName') || detail.person?.fullName || entry?.fullName || '').trim(),
        role: approvedRole,
        employmentStatus,
        readinessStatus: nextReadinessStatus,
        managerUserId,
        homeBaseCity: String(data.get('homeBaseCity') || detail.person?.homeBaseCity || '').trim(),
        homeBaseState: String(data.get('homeBaseState') || detail.person?.homeBaseState || '').trim(),
        canBeAssigned: nextCanBeAssigned,
      },
    });

    const approvalStatus = action === 'approve' ? 'approved' : 'in_review';
    const submissionId = Number(data.get('submissionId') || entry?.submissionId || 0) || 0;
    const journeyId = Number(data.get('journeyId') || entry?.journeyId || 0) || 0;

    if (submissionId) {
      await api('/api/portal/onboarding', {
        method: 'PATCH',
        body: {
          id: submissionId,
          status: action === 'approve' ? 'approved' : 'in_review',
          meta: Object.assign({}, submission.meta || {}, {
            requestedRole,
            approvedRole,
            approvalStatus,
            reviewNotes,
          }),
          normalizedData: Object.assign({}, submission.normalizedData || {}, {
            requestedRole,
            approvedRole,
            approvalStatus,
          }),
        },
      });
    }

    if (journeyId) {
      await api('/api/portal/onboarding', {
        method: 'PATCH',
        body: {
          journeyId,
          journeyStatus: action === 'approve'
            ? 'completed'
            : (nextReadinessStatus === 'restricted' || !nextCanBeAssigned ? 'blocked' : 'pending'),
          stageKey: action === 'approve'
            ? 'workspace_ready'
            : (requestedRole && requestedRole !== approvedRole ? 'pending_role_review' : 'access_setup'),
          checklist: Object.assign({}, journey.checklist || {}, {
            roleConfirmed: !requestedRole || requestedRole === approvedRole,
            profileCompleted: profileBasicsComplete(detail),
          }),
          collectedData: Object.assign({}, journey.collectedData || {}, {
            requestedRole,
            approvedRole,
            reviewNotes,
          }),
          meta: Object.assign({}, journey.meta || {}, {
            requestedRole,
            approvedRole,
            approvalStatus,
          }),
          notes: reviewNotes || journey.notes || '',
          completedAt: action === 'approve' ? new Date().toISOString() : '',
        },
      });
    }

    state.settings.lastReviewResult = {
      label: action === 'approve' ? 'Review approved' : 'Review updated',
      copy: action === 'approve'
        ? `${cleanText(detail.person?.fullName || entry?.fullName, 'Team member')} is released into the approved workspace role.`
        : 'Approved role, readiness, and review notes were saved without releasing the workspace yet.',
    };
    queueToast(action === 'approve' ? 'Review approved' : 'Review updated');
    await loadSettings(true);
  }

  async function saveBootstrapSetup(form) {
    const data = new FormData(form);
    const requestedRole = String(data.get('requestedRole') || '').trim() || state.bootstrap.approvedRole || state.profile?.role || 'dialer';
    const approvedRole = state.bootstrap.approvedRole || state.profile?.role || requestedRole;
    const avatarFile = data.get('avatarFile');
    let avatarDataUrl = '';

    if (avatarFile instanceof File && avatarFile.size > 0) {
      if (!/^image\/(png|jpeg)$/i.test(String(avatarFile.type || ''))) {
        throw new Error('Only PNG and JPEG profile images are supported right now.');
      }
      avatarDataUrl = await readFileAsDataUrl(avatarFile);
    }

    await api('/api/portal/talent_profiles', {
      method: 'POST',
      body: {
        profile: {
          public: {
            displayName: String(data.get('displayName') || '').trim(),
            bio: String(data.get('bio') || '').trim(),
            homeBaseCity: String(data.get('homeBaseCity') || '').trim(),
            homeBaseState: String(data.get('homeBaseState') || '').trim(),
            specialties: splitCsvText(data.get('specialties')),
            tone: splitCsvText(data.get('tone')),
            gear: splitCsvText(data.get('gear')),
            avatarDataUrl,
          },
        },
      },
    });

    const baseChecklist = Object.assign({}, state.bootstrap.detail?.onboardingJourney?.checklist || {}, {
      accessActivated: true,
      profileCompleted: true,
      roleConfirmed: requestedRole === approvedRole,
    });
    const baseCollectedData = Object.assign({}, state.bootstrap.detail?.onboardingJourney?.collectedData || {}, {
      requestedRole,
      approvedRole,
      profileCompleted: true,
    });

    if (requestedRole !== approvedRole) {
      await api('/api/portal/onboarding', {
        method: 'POST',
        body: {
          intakeType: 'employee_onboarding',
          status: 'submitted',
          subjectRole: requestedRole,
          title: 'Role review requested',
          description: `Requested role change from ${approvedRole} to ${requestedRole}.`,
          normalizedData: {
            requestedRole,
            approvedRole,
            approvalStatus: 'in_review',
          },
          meta: {
            requestedRole,
            approvedRole,
            approvalStatus: 'in_review',
            requestSource: 'first_login_setup',
          },
          tags: ['role_review', requestedRole, approvedRole].filter(Boolean),
        },
      });
    }

    if (state.bootstrap.journeyId) {
      await api('/api/portal/onboarding', {
        method: 'PATCH',
        body: {
          journeyId: state.bootstrap.journeyId,
          journeyStatus: requestedRole === approvedRole ? 'completed' : 'pending',
          stageKey: requestedRole === approvedRole ? 'workspace_ready' : 'pending_role_review',
          checklist: baseChecklist,
          collectedData: baseCollectedData,
          meta: Object.assign({}, state.bootstrap.detail?.onboardingJourney?.meta || {}, {
            requestedRole,
            approvedRole,
            approvalStatus: requestedRole === approvedRole ? 'approved' : 'in_review',
            profileCompleted: true,
          }),
          notes: requestedRole === approvedRole
            ? 'Initial setup completed and workspace is ready.'
            : `Profile saved. Waiting for manager review on requested role ${requestedRole}.`,
          completedAt: requestedRole === approvedRole ? new Date().toISOString() : '',
        },
      });
    }

    await hydrateSession();
    if (state.bootstrap.status === 'ready') {
      queueToast('Setup complete');
      await loadWorkspace('command', true);
      return;
    }
    queueToast('Setup submitted for review');
    render();
  }

  async function runSettingsAccessAction(action, userId, email = '') {
    const payload = await api('/api/portal/user_access', {
      method: 'POST',
      body: {
        action,
        userId,
        email,
      },
    });
    const labelMap = {
      reset_password: 'Password reset link generated',
      resend_invite: 'Invite resent',
      suspend_access: 'Access suspended',
      restore_access: 'Access restored',
    };
    state.settings.lastAccessResult = {
      label: labelMap[action] || 'Access updated',
      copy: payload.user?.email ? payload.user.email : 'Access action completed.',
      link: payload.access?.actionLink || '',
    };
    queueToast(labelMap[action] || 'Access updated');
    await loadSettings(true);
  }

  async function saveLead(form) {
    const data = new FormData(form);
    const id = String(data.get('id') || '').trim();
    const payload = {
      firstName: String(data.get('firstName') || '').trim(),
      lastName: String(data.get('lastName') || '').trim(),
      email: String(data.get('email') || '').trim(),
      phone: String(data.get('phone') || '').trim(),
      company: String(data.get('company') || '').trim(),
      propertyName: String(data.get('propertyName') || '').trim(),
      address: String(data.get('address') || '').trim(),
      city: String(data.get('city') || '').trim(),
      state: String(data.get('state') || '').trim(),
      postalCode: String(data.get('postalCode') || '').trim(),
      status: String(data.get('status') || '').trim() || 'new',
      assignedRole: String(data.get('assignedRole') || '').trim(),
      assignedUserId: String(data.get('assignedUserId') || '').trim(),
      notes: String(data.get('notes') || '').trim(),
    };
    if (id) payload.id = Number(id);
    const method = id ? 'PATCH' : 'POST';
    const response = await api('/api/portal/leads', { method, body: payload });
    state.selections.leadId = response.lead?.id || state.selections.leadId;
    state.sheet = null;
    await loadLeads(true);
    queueToast(id ? 'Lead updated' : 'Lead created');
  }

  async function saveEvent(form) {
    const data = new FormData(form);
    const id = String(data.get('id') || '').trim();
    const payload = {
      title: String(data.get('title') || '').trim(),
      status: String(data.get('status') || '').trim() || 'open',
      eventDate: String(data.get('eventDate') || '').trim(),
      startTime: String(data.get('startTime') || '').trim(),
      endTime: String(data.get('endTime') || '').trim(),
      areaTag: String(data.get('areaTag') || '').trim(),
      eventKind: String(data.get('eventKind') || '').trim(),
      assignedRole: String(data.get('assignedRole') || '').trim(),
      assignedUserId: String(data.get('assignedUserId') || '').trim(),
      accountId: toNullableNumber(data.get('accountId')),
      locationId: toNullableNumber(data.get('locationId')),
      payoutCents: (() => {
        const raw = String(data.get('payoutDollars') || '').trim();
        if (!raw) return null;
        const dollars = Number(raw.replace(/[$,]/g, ''));
        return Number.isFinite(dollars) ? Math.round(dollars * 100) : null;
      })(),
      city: String(data.get('city') || '').trim(),
      state: String(data.get('state') || '').trim(),
      address: String(data.get('address') || '').trim(),
      postalCode: String(data.get('postalCode') || '').trim(),
      executionStatus: String(data.get('executionStatus') || '').trim(),
      logisticsStatus: String(data.get('logisticsStatus') || '').trim(),
      reportStatus: String(data.get('reportStatus') || '').trim(),
      notes: String(data.get('notes') || '').trim(),
    };
    if (id) payload.id = Number(id);
    const method = id ? 'PATCH' : 'POST';
    const response = await api('/api/portal/events', { method, body: payload });
    if (response.event?.id) state.selections.eventId = response.event.id;
    state.sheet = null;
    await loadEvents(true);
    queueToast(id ? 'Event updated' : 'Event created');
  }

  async function saveTask(form) {
    const data = new FormData(form);
    const id = String(data.get('id') || '').trim();
    const payload = {
      title: String(data.get('title') || '').trim(),
      taskType: String(data.get('taskType') || '').trim(),
      status: String(data.get('status') || '').trim(),
      priority: toNullableNumber(data.get('priority')) ?? 0,
      dueAt: String(data.get('dueAt') || '').trim(),
      assignedUserId: String(data.get('assignedUserId') || '').trim(),
      leadId: toNullableNumber(data.get('leadId')),
      eventId: toNullableNumber(data.get('eventId')),
      accountId: toNullableNumber(data.get('accountId')),
      description: String(data.get('description') || '').trim(),
    };
    if (id) payload.id = Number(id);
    const method = id ? 'PATCH' : 'POST';
    const response = await api('/api/portal/tasks', { method, body: payload });
    if (response.task?.id) state.selections.taskId = response.task.id;
    state.sheet = null;
    await loadTasks(true);
    queueToast(id ? 'Task updated' : 'Task created');
  }

  function toNullableNumber(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const number = Number(raw);
    return Number.isFinite(number) ? number : null;
  }

  async function handleAssistantMessage(form) {
    const data = new FormData(form);
    const message = String(data.get('message') || '').trim();
    if (!message) return;
    const fallbackRequestMode = state.assistantMode === 'operational' ? 'next_move' : 'general';
    const requestMode = String(data.get('requestMode') || state.assistantRequestMode || fallbackRequestMode).trim() || fallbackRequestMode;
    state.assistantRequestMode = requestMode;

    const history = state.messages
      .slice(-10)
      .map((entry) => ({ role: entry.role, content: entry.content }));

    const context = buildAssistantContext(requestMode);

    try {
      state.loading.assistantSend = true;
      render();
      const payload = await api('/api/portal/ai/chat', {
        method: 'POST',
        body: {
          message,
          threadId: state.activeThreadId || undefined,
          history,
          context,
        },
      });
      if (payload.thread?.id) {
        state.activeThreadId = payload.thread.id;
        state.activeThread = payload.thread;
      }
      state.messages = state.messages
        .concat(payload.userMessage ? [payload.userMessage] : [])
        .concat(payload.message ? [payload.message] : []);
      if (payload.ready) {
        await loadThreads({ threadId: state.activeThreadId || payload.thread?.id || '' });
      } else {
        render();
      }
    } catch (error) {
      queueToast(humanizeError(error), 'danger');
    } finally {
      state.loading.assistantSend = false;
      state.assistantDraft = '';
      render();
      form.reset();
    }
  }

  function assistantContextSourceWorkspaceId() {
    if (WORKSPACES.some((workspace) => workspace.id === state.assistantContextSource)) {
      return state.assistantContextSource;
    }
    if (activeLead()) return 'pipeline';
    if (activeEvent()) return 'operations';
    if (activeTask()) return 'workforce';
    return 'assistant';
  }

  function assistantContextRecords() {
    const lead = activeLead();
    const event = activeEvent();
    const task = activeTask();

    const records = [];
    if (lead) {
      const leadName = `${cleanText(lead.first_name, '')} ${cleanText(lead.last_name, '')}`.trim() || `Lead ${lead.id}`;
      records.push({
        kind: 'lead',
        label: 'Lead',
        title: leadName,
        meta: cleanText(lead.company || lead.property_name || lead.email || lead.phone, 'Contact record'),
      });
    }
    if (event) {
      records.push({
        kind: 'event',
        label: 'Event',
        title: cleanText(event.title, `Event ${event.id}`),
        meta: cleanText(event.account?.name || event.location?.location_name || formatDateTime(event.starts_at || event.event_date), 'Scheduled record'),
      });
    }
    if (task) {
      records.push({
        kind: 'task',
        label: 'Task',
        title: cleanText(task.title, `Task ${task.id}`),
        meta: cleanText(task.description || task.taskType || task.task_type, 'Work item'),
      });
    }
    return records;
  }

  function threadDisplayTitle(thread, fallback = 'New thread') {
    const title = String(thread?.title || '').trim();
    const messageCount = Number(thread?.messageCount || 0) || 0;
    if ((!title || /^new conversation$/i.test(title)) && messageCount < 2) return fallback;
    return cleanText(title, fallback);
  }

  function threadDisplaySummary(thread) {
    const summary = compact(thread?.summary, 72);
    if (summary) return summary;
    const messageCount = Number(thread?.messageCount || 0) || 0;
    if (messageCount < 2) return 'Start a grounded thread';
    return `Updated ${formatDateTime(thread?.lastMessageAt || thread?.updatedAt)}`;
  }

  function assistantIntentOptions() {
    return state.assistantMode === 'operational'
      ? [
        { value: 'next_move', label: 'Next move' },
        { value: 'risk_review', label: 'Risk' },
        { value: 'summary', label: 'Handoff' },
      ]
      : [
        { value: 'general', label: 'Think through' },
        { value: 'reply_draft', label: 'Draft' },
        { value: 'summary', label: 'Brief' },
      ];
  }

  function workdayEmptyCopy() {
    return `
      <div class='empty-inline-block'>
        <strong>No work items yet</strong>
        <span>Work usually appears after an onboarding form is submitted or when a CRM-side meeting or follow-up needs to be scheduled and carried through here.</span>
      </div>
    `;
  }

  function buildAssistantContext(requestMode = state.assistantRequestMode) {
    const lead = activeLead();
    const event = activeEvent();
    const task = activeTask();
    const includeRecords = !!state.assistantContextAttached;

    const sourceWorkspaceId = assistantContextSourceWorkspaceId();
    const sourceWorkspace = workspaceDefinition(sourceWorkspaceId);

    return {
      view: {
        activeTab: sourceWorkspaceId,
        activeLabel: sourceWorkspace.label,
        role: state.roleContext?.effectiveRole || state.profile?.role || '',
        realRole: state.profile?.role || '',
        counts: {
          leads: state.leads.length,
          events: state.events.length,
          tasks: state.tasks.length,
        },
      },
      request: {
        mode: requestMode || 'general',
        assistantMode: state.assistantMode || 'discuss',
      },
      lead: includeRecords && lead ? {
        id: lead.id,
        name: `${cleanText(lead.first_name, '')} ${cleanText(lead.last_name, '')}`.trim() || `Lead ${lead.id}`,
        company: cleanText(lead.company, ''),
        propertyName: cleanText(lead.property_name, ''),
        city: cleanText(lead.city, ''),
        state: cleanText(lead.state, ''),
        phone: cleanText(lead.phone, ''),
        email: cleanText(lead.email, ''),
        status: cleanText(lead.status, ''),
        source: cleanText(lead.source, ''),
        nextTouch: cleanText(lead.meta?.followup || lead.followup_at, ''),
        assignedRole: cleanText(lead.assigned_role, ''),
        notes: cleanText(lead.notes, ''),
      } : null,
      event: includeRecords && event ? {
        id: event.id,
        title: cleanText(event.title, `Event ${event.id}`),
        city: cleanText(event.city, ''),
        state: cleanText(event.state, ''),
        date: cleanText(event.event_date || event.starts_at, ''),
        startTime: cleanText(event.start_time || event.starts_at, ''),
        endTime: cleanText(event.end_time || event.ends_at, ''),
        status: cleanText(event.status, ''),
        assignedRole: cleanText(event.assigned_role, ''),
        logistics: {
          vendorNeeds: cleanText(event.area_tag, ''),
          pointOfContact: cleanText(event.account?.primary_contact || event.location?.manager_name, ''),
        },
      } : null,
      task: includeRecords && task ? {
        id: task.id,
        title: cleanText(task.title, `Task ${task.id}`),
        taskType: cleanText(task.taskType || task.task_type, ''),
        status: cleanText(task.status, ''),
        priority: Number(task.priority ?? 0) || 0,
        dueAt: cleanText(task.dueAt || task.due_at, ''),
        assignedRole: cleanText(task.assignedRole || task.assigned_role, ''),
        description: cleanText(task.description, ''),
      } : null,
    };
  }

  function openSheet(kind, record = null) {
    state.sheet = { kind, record };
    renderSheet();
  }

  function closeSheet() {
    state.sheet = null;
    renderSheet();
  }

  function render() {
    renderAuth();
    renderApp();
    renderSheet();
    renderToasts();
  }

  function renderAuth() {
    refs.authScreen.hidden = !!state.session && !!state.profile;
    if (refs.authScreen.hidden) {
      refs.authScreen.innerHTML = '';
      return;
    }

    const previewEnabled = !!state.authConfig?.preview?.enabled;
    const previewEntry = previewEnabled ? `
      <div class='auth-helper'>
        <div class='auth-helper__copy'>
          <strong>Manager preview</strong>
          <span>Local manager access uses the preview path. It does not go through the standard work email form.</span>
        </div>
        ${state.authMode === 'preview'
          ? `<span class='auth-helper__state'>Manager preview active</span>`
          : `<button type='button' class='ghost-button compact-button' data-action='set-auth-mode' data-mode='preview'>Use manager preview</button>`}
      </div>
    ` : '';
    const authNotice = state.notices.auth
      ? `<div class='status-banner is-danger'>${escapeHtml(state.notices.auth)}</div>`
      : `<div class='form-note'>Use the existing PureStay access model. Sessions, permissions, and backend rules stay intact.</div>`;

    refs.authScreen.innerHTML = `
      <div class='auth-panel'>
        <section class='auth-card'>
          <div class='auth-brand'>
            <div class='brand-mark'>
              <div class='brand-mark__text'>
                <div class='brand-mark__label'>PureStay</div>
                <div class='brand-mark__sub'>Internal workspace</div>
              </div>
            </div>
          </div>
          <h1 class='auth-title'>Sign in</h1>
          <p class='auth-copy'>Acquisition, onboarding, fulfillment, reporting, and day-to-day team work live here.</p>
          <div class='auth-list'>
            <div class='auth-list-item'>Sales and client movement</div>
            <div class='auth-list-item'>Onboarding checkpoints and scheduling</div>
            <div class='auth-list-item'>Fulfillment, meetings, and reporting</div>
          </div>
          <div class='auth-mode-toggle'>
            <button type='button' class='mode-chip ${state.authMode === 'password' ? 'is-active' : ''}' data-action='set-auth-mode' data-mode='password'>Work email</button>
            ${previewEnabled ? `<button type='button' class='mode-chip ${state.authMode === 'preview' ? 'is-active' : ''}' data-action='set-auth-mode' data-mode='preview'>Manager preview</button>` : ''}
          </div>
          ${previewEntry}
          ${authNotice}
          <form id='loginForm' class='auth-form'>
            ${state.authMode === 'preview' && previewEnabled ? `
              <div class='field-grid'>
                <label class='field'>
                  <span class='field-label'>Manager preview code</span>
                  <input name='previewCode' autocomplete='one-time-code' placeholder='Enter manager preview code' required />
                </label>
                <div class='form-note'>Use the manager preview access code for the local manager session.</div>
              </div>
            ` : `
              <div class='field-grid'>
                <label class='field'>
                  <span class='field-label'>Email</span>
                  <input name='email' type='email' autocomplete='username' placeholder='name@purestaync.com' required />
                </label>
                <label class='field'>
                  <span class='field-label'>Password</span>
                  <input name='password' type='password' autocomplete='current-password' placeholder='Password' required />
                </label>
              </div>
            `}
            <div class='section-actions'>
              <button class='primary-button' type='submit'>Enter workspace</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  function renderApp() {
    const authenticated = !!state.session && !!state.profile;
    refs.appScreen.hidden = !authenticated;
    if (!authenticated) return;

    const bootstrapActive = state.bootstrap?.status && state.bootstrap.status !== 'ready';

    const activeWorkspace = workspaceDefinition();

    refs.workspaceNav.innerHTML = bootstrapActive ? '' : WORKSPACES.map((workspace) => `
      <button type='button' class='workspace-tab ${workspace.id === state.activeWorkspace ? 'is-active' : ''}' data-action='switch-workspace' data-workspace='${workspace.id}' data-label='${escapeHtml(workspace.label)}' aria-label='${escapeHtml(workspace.label)}' title='${escapeHtml(workspace.label)}' aria-current='${workspace.id === state.activeWorkspace ? 'page' : 'false'}'>
        <span class='workspace-tab__icon'>${workspaceIconMarkup(workspace.icon)}</span>
        <span class='workspace-tab__label'>${escapeHtml(workspace.label)}</span>
      </button>
    `).join('');

    refs.userChip.innerHTML = `
      <strong>${escapeHtml(cleanText(state.profile?.fullName, state.user?.email || 'Portal user'))}</strong>
      <span class='user-chip__meta'>${escapeHtml(cleanText(state.roleContext?.effectiveRole || state.profile?.role || '', 'Session active'))}</span>
    `;

    const settingsButton = document.querySelector(".utility-icon-button[data-workspace='settings']");
    if (settingsButton) {
      settingsButton.classList.toggle('is-active', state.activeWorkspace === 'settings');
      settingsButton.hidden = !!bootstrapActive;
    }

    if (refs.shellTitle) refs.shellTitle.textContent = bootstrapActive ? state.bootstrap.title : activeWorkspace.label;
    if (refs.shellMeta) refs.shellMeta.textContent = workspaceShellMeta();

    refs.workspaceStage.innerHTML = renderWorkspace();
  }

  function renderWorkspace() {
    if (state.bootstrap?.status && state.bootstrap.status !== 'ready') return renderBootstrapWorkspace();
    if (state.activeWorkspace === 'command') return renderCommandWorkspace();
    if (state.activeWorkspace === 'pipeline') return renderPipelineWorkspace();
    if (state.activeWorkspace === 'operations') return renderOperationsWorkspace();
    if (state.activeWorkspace === 'workforce') return renderWorkforceWorkspace();
    if (state.activeWorkspace === 'settings') return renderSettingsWorkspace();
    return renderAssistantWorkspace();
  }

  function workspaceDefinition(id = state.activeWorkspace) {
    if (id === 'settings') return SETTINGS_WORKSPACE;
    return WORKSPACES.find((workspace) => workspace.id === id) || WORKSPACES[0];
  }

  function workspaceShellMeta() {
    if (state.bootstrap?.status === 'setup') return 'Complete profile, confirm role, enter workspace';
    if (state.bootstrap?.status === 'review') return 'Waiting on manager review and role routing';
    if (state.activeWorkspace === 'command') {
      return `${String(state.overview?.summary?.pipeline?.new ?? '—')} new leads | ${String(state.overview?.summary?.events?.upcoming ?? '—')} upcoming`;
    }
    if (state.activeWorkspace === 'pipeline') return `${String(state.leads.length)} clients in view`;
    if (state.activeWorkspace === 'operations') return `${String(state.events.length)} scheduled items in review`;
    if (state.activeWorkspace === 'workforce') return `${String(state.tasks.length)} tasks in scope`;
    if (state.activeWorkspace === 'settings') return `${humanizeLabel(normalizeSettingsTab())} utility`;
    return 'Grounded assistant workspace';
  }

  function hasActiveFilters(filters) {
    return Object.values(filters || {}).some((value) => String(value || '').trim());
  }

  function clearWorkspaceFilters(workspaceId) {
    if (workspaceId === 'pipeline') state.filters.leads = { q: '', status: '' };
    if (workspaceId === 'operations') state.filters.events = { status: '', areaTag: '' };
    if (workspaceId === 'workforce') state.filters.tasks = { q: '', status: '', mine: '1' };
  }

  function toggleSort(scope, key) {
    const current = state.sorts[scope] || { key: '', direction: 'asc' };
    if (current.key === key) {
      state.sorts[scope] = {
        key,
        direction: current.direction === 'asc' ? 'desc' : 'asc',
      };
      return;
    }
    state.sorts[scope] = { key, direction: 'asc' };
  }

  function compareValues(left, right) {
    const leftDate = Date.parse(left);
    const rightDate = Date.parse(right);
    if (Number.isFinite(leftDate) && Number.isFinite(rightDate)) return leftDate - rightDate;

    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && `${left}` !== '' && `${right}` !== '') {
      return leftNumber - rightNumber;
    }

    return String(left || '').localeCompare(String(right || ''), undefined, { numeric: true, sensitivity: 'base' });
  }

  function sortRows(scope, rows) {
    const activeSort = state.sorts[scope] || { key: '', direction: 'asc' };
    if (!activeSort.key) return rows;

    const extractors = {
      leads: {
        contact: (lead) => `${cleanText(lead.first_name, '')} ${cleanText(lead.last_name, '')}`.trim() || `Lead ${lead.id}`,
        property: (lead) => cleanText(lead.property_name || lead.company, ''),
        status: (lead) => cleanText(lead.status, ''),
        owner: (lead) => cleanText(lead.assigned_role || lead.assigned_user_id, ''),
      },
      events: {
        event: (event) => cleanText(event.title, `Event ${event.id}`),
        date: (event) => event.starts_at || event.event_date || '',
        status: (event) => cleanText(event.status, ''),
        role: (event) => cleanText(event.assigned_role || event.event_kind, ''),
      },
      tasks: {
        task: (task) => cleanText(task.title, `Task ${task.id}`),
        type: (task) => cleanText(task.taskType || task.task_type, ''),
        status: (task) => cleanText(task.status, ''),
        due: (task) => task.dueAt || task.due_at || '',
      },
    };

    const extractor = extractors[scope]?.[activeSort.key];
    if (!extractor) return rows;

    return rows.slice().sort((left, right) => {
      const compared = compareValues(extractor(left), extractor(right));
      return activeSort.direction === 'desc' ? compared * -1 : compared;
    });
  }

  function renderSortableHeader(scope, columns) {
    const activeSort = state.sorts[scope] || { key: '', direction: 'asc' };
    return `<tr>${columns.map((column) => {
      const isActive = activeSort.key === column.key;
      const arrow = isActive ? (activeSort.direction === 'asc' ? '↑' : '↓') : '↕';
      return `
        <th>
          <button type='button' class='sort-button ${isActive ? 'is-active' : ''}' data-action='sort-table' data-scope='${escapeHtml(scope)}' data-key='${escapeHtml(column.key)}'>
            <span>${escapeHtml(column.label)}</span>
            <span class='sort-button__arrow'>${escapeHtml(arrow)}</span>
          </button>
        </th>
      `;
    }).join('')}</tr>`;
  }

  function renderSelectionBar(title, meta, actions) {
    const items = (Array.isArray(actions) ? actions : []).filter(Boolean);
    return `
      <div class='selection-bar'>
        <div class='selection-bar__copy'>
          <span class='selection-bar__label'>Focused record</span>
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(meta)}</span>
        </div>
        <div class='selection-bar__actions'>
          ${items.map((item) => `<button type='button' class='ghost-button' data-action='${escapeHtml(item.action)}'>${escapeHtml(item.label)}</button>`).join('')}
        </div>
      </div>
    `;
  }

  function pipelineViewId() {
    const filters = state.filters.leads;
    if (filters.q) return 'custom';
    if (!filters.status) return 'all';
    if (filters.status === 'new') return 'new';
    if (['qualified', 'proposal'].includes(filters.status)) return 'qualified';
    if (filters.status === 'won') return 'won';
    return 'custom';
  }

  function operationsViewId() {
    const filters = state.filters.events;
    if (!filters.status && !filters.areaTag) return 'all';
    if (filters.status === 'open' && !filters.areaTag) return 'open';
    if (filters.status === 'assigned' && !filters.areaTag) return 'assigned';
    if (filters.areaTag === 'dispatch' && !filters.status) return 'dispatch';
    if (filters.areaTag === 'media' && !filters.status) return 'media';
    return 'custom';
  }

  function workforceViewId() {
    const filters = state.filters.tasks;
    if (filters.q) return 'custom';
    if (!filters.status && filters.mine === '1') return 'mine';
    if (!filters.status && filters.mine === '') return 'all';
    if (filters.status === 'blocked' && filters.mine === '1') return 'blocked';
    if (filters.status === 'completed' && filters.mine === '') return 'completed';
    return 'custom';
  }

  function applyWorkspacePreset(workspaceId, viewId) {
    if (workspaceId === 'pipeline') {
      if (viewId === 'all') state.filters.leads = { q: '', status: '' };
      if (viewId === 'new') state.filters.leads = { q: '', status: 'new' };
      if (viewId === 'qualified') state.filters.leads = { q: '', status: 'qualified' };
      if (viewId === 'won') state.filters.leads = { q: '', status: 'won' };
      return;
    }
    if (workspaceId === 'operations') {
      if (viewId === 'all') state.filters.events = { status: '', areaTag: '' };
      if (viewId === 'open') state.filters.events = { status: 'open', areaTag: '' };
      if (viewId === 'assigned') state.filters.events = { status: 'assigned', areaTag: '' };
      if (viewId === 'dispatch') state.filters.events = { status: '', areaTag: 'dispatch' };
      if (viewId === 'media') state.filters.events = { status: '', areaTag: 'media' };
      return;
    }
    if (workspaceId === 'workforce') {
      if (viewId === 'mine') state.filters.tasks = { q: '', status: '', mine: '1' };
      if (viewId === 'all') state.filters.tasks = { q: '', status: '', mine: '' };
      if (viewId === 'blocked') state.filters.tasks = { q: '', status: 'blocked', mine: '1' };
      if (viewId === 'completed') state.filters.tasks = { q: '', status: 'completed', mine: '' };
    }
  }

  function renderPresetViews(workspaceId, views, activeViewId) {
    const activeKnown = (Array.isArray(views) ? views : []).some((view) => view.id === activeViewId);
    return `
      <div class='preset-row' role='tablist' aria-label='View controls'>
        ${views.map((view) => `
          <button
            type='button'
            class='preset-chip ${view.id === activeViewId ? 'is-active' : ''}'
            data-action='apply-view'
            data-workspace='${escapeHtml(workspaceId)}'
            data-view='${escapeHtml(view.id)}'
            aria-pressed='${view.id === activeViewId ? 'true' : 'false'}'
            title='${escapeHtml(view.copy || view.label)}'
          >
            <strong>${escapeHtml(view.label)}</strong>
          </button>
        `).join('')}
        ${activeViewId === 'custom' || !activeKnown ? `<span class='preset-chip preset-chip--static is-active'>Custom</span>` : ''}
      </div>
    `;
  }

  function renderTableEmptyState(copy) {
    return `
      <div class='table-empty-state'>
        <div class='table-caption'>Queue clear</div>
        <strong>No records are active in this view</strong>
        <span>${escapeHtml(copy)}</span>
      </div>
    `;
  }

  function renderFilterChipGroup(workspaceId, key, label, options, selectedValue) {
    const normalized = [{ value: '', label: 'All' }].concat((Array.isArray(options) ? options : []).map((option) => (
      typeof option === 'string' ? { value: option, label: humanizeLabel(option) } : option
    )));
    return `
      <div class='field-stack filter-group'>
        <span class='field-label'>${escapeHtml(label)}</span>
        <input type='hidden' name='${escapeHtml(key)}' value='${escapeHtml(String(selectedValue || ''))}' />
        <div class='filter-chip-row'>
          ${normalized.map((option) => `
            <button
              type='button'
              class='filter-chip ${String(option.value || '') === String(selectedValue || '') ? 'is-active' : ''}'
              data-action='set-filter-value'
              data-workspace='${escapeHtml(workspaceId)}'
              data-key='${escapeHtml(key)}'
              data-value='${escapeHtml(String(option.value || ''))}'
            >
              ${escapeHtml(option.label || 'All')}
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderChoiceChipField(name, label, options, selectedValue) {
    const normalized = (Array.isArray(options) ? options : []).map((option) => (
      typeof option === 'string' ? { value: option, label: humanizeLabel(option) } : option
    ));
    return `
      <div class='field-stack filter-group'>
        <span class='field-label'>${escapeHtml(label)}</span>
        <input type='hidden' name='${escapeHtml(name)}' value='${escapeHtml(String(selectedValue || normalized[0]?.value || ''))}' />
        <div class='filter-chip-row'>
          ${normalized.map((option) => `
            <button
              type='button'
              class='filter-chip ${String(option.value || '') === String(selectedValue || normalized[0]?.value || '') ? 'is-active' : ''}'
              data-action='set-choice-value'
              data-choice-name='${escapeHtml(name)}'
              data-value='${escapeHtml(String(option.value || ''))}'
            >
              ${escapeHtml(option.label || '')}
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderToolbarState(countLabel, filters, labels) {
    const chips = Object.entries(labels || {}).reduce((items, [key, label]) => {
      const rawValue = String(filters?.[key] || '').trim();
      if (!rawValue) return items;
      const value = key === 'mine'
        ? (rawValue === '1' ? 'Mine' : 'All visible')
        : humanizeLabel(rawValue);
      items.push(`<span class='toolbar-chip'><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</span>`);
      return items;
    }, []);
    return `
      <div class='toolbar-state'>
        <span class='toolbar-count'>${escapeHtml(countLabel)}</span>
        ${chips.length ? chips.join('') : `<span class='toolbar-chip is-muted'>All visible</span>`}
      </div>
    `;
  }

  function renderSurfaceHeader(title, copy, countLabel) {
    return `
      <div class='table-toolbar table-toolbar--surface'>
        <div class='table-toolbar__primary'>
          <div class='table-caption'>${escapeHtml(title)}</div>
          <div class='muted'>${escapeHtml(copy)}</div>
        </div>
        <div class='table-toolbar__actions'>
          <span class='toolbar-count'>${escapeHtml(countLabel)}</span>
        </div>
      </div>
    `;
  }

  function renderInspectorList(title, items) {
    const rows = (Array.isArray(items) ? items : []).filter((item) => item && item.label);
    if (!rows.length) return '';
    return `
      <section class='inspector-section'>
        <div class='table-caption'>${escapeHtml(title)}</div>
        <div class='inspector-list'>
          ${rows.map((item) => `
            <div class='inspector-list__row'>
              <span>${escapeHtml(item.label)}</span>
              <strong>${escapeHtml(cleanText(item.value, '—'))}</strong>
            </div>
          `).join('')}
        </div>
      </section>
    `;
  }

  function renderActionHints(title, items) {
    const rows = (Array.isArray(items) ? items : []).filter(Boolean);
    if (!rows.length) return '';
    return `
      <section class='inspector-section'>
        <div class='table-caption'>${escapeHtml(title)}</div>
        <div class='next-action-list'>
          ${rows.map((item) => `<div class='next-action-item'>${escapeHtml(item)}</div>`).join('')}
        </div>
      </section>
    `;
  }

  function renderAttachedContextRecords() {
    const records = state.assistantContextAttached ? assistantContextRecords() : [];
    if (!records.length) return renderInlineEmpty('No record is attached right now. Add the current lead, event, or task when the reply needs to stay grounded.');

    return `
      <div class='attached-records'>
        ${records.map((record) => `
          <article class='attached-record'>
            <div class='attached-record__label'>${escapeHtml(record.label)}</div>
            <strong>${escapeHtml(record.title)}</strong>
            <span>${escapeHtml(compact(record.meta, 90))}</span>
          </article>
        `).join('')}
      </div>
    `;
  }

  function renderMetricCard(label, value, copy, action, workspace) {
    return `
      <article class='signal-card'>
        <div class='metric-label'>${escapeHtml(label)}</div>
        <div class='metric-number'>${escapeHtml(String(value))}</div>
        <p class='metric-copy'>${escapeHtml(copy)}</p>
        ${action ? `<button type='button' class='metric-button' data-action='switch-workspace' data-workspace='${workspace}'>${escapeHtml(action)}</button>` : ''}
      </article>
    `;
  }

  function queueRecordKey(item) {
    if (!item || typeof item !== 'object') return '';
    const keys = ['leadId', 'eventId', 'taskId', 'accountId', 'userId', 'journeyId', 'submissionId', 'workflowEventId', 'notificationId', 'id'];
    for (const key of keys) {
      const value = item[key];
      if (value !== undefined && value !== null && String(value).trim()) return `${key}:${String(value).trim()}`;
    }
    return compact(item.label || item.meta || '', 80);
  }

  function mergeQueueItems(...groups) {
    const rows = [];
    const seen = new Set();
    for (const group of groups) {
      for (const item of Array.isArray(group) ? group : []) {
        const key = queueRecordKey(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        rows.push(item);
      }
    }
    return rows;
  }

  function renderCommandMetric(label, value, meta, workspace) {
    return `
      <button type='button' class='command-metric' data-action='switch-workspace' data-workspace='${escapeHtml(workspace)}'>
        <span class='command-metric__label'>${escapeHtml(label)}</span>
        <strong>${escapeHtml(String(value))}</strong>
        <span class='command-metric__meta'>${escapeHtml(meta)}</span>
      </button>
    `;
  }

  function renderQueue(title, copy, items, dataQueueKey, workspace = '') {
    const rows = (Array.isArray(items) ? items : []).slice(0, 6);
    return `
      <article class='queue-card'>
        <div class='queue-card__header'>
          <div>
            <div class='section-kicker'>${escapeHtml(title)}</div>
            <p class='workspace-copy'>${escapeHtml(copy)}</p>
          </div>
          <span class='count-badge'>${escapeHtml(String(rows.length))} items</span>
        </div>
        <div class='queue-list'>
          ${rows.length ? rows.map((item) => `
            <button type='button' class='queue-item' data-action='queue-jump' data-queue='${escapeHtml(dataQueueKey)}' data-workspace='${escapeHtml(workspace)}' data-id='${escapeHtml(String(item.id || ''))}' data-lead-id='${escapeHtml(String(item.leadId || ''))}' data-event-id='${escapeHtml(String(item.eventId || ''))}' data-task-id='${escapeHtml(String(item.taskId || ''))}' data-account-id='${escapeHtml(String(item.accountId || ''))}' data-user-id='${escapeHtml(String(item.userId || ''))}' data-journey-id='${escapeHtml(String(item.journeyId || ''))}' data-submission-id='${escapeHtml(String(item.submissionId || ''))}' data-workflow-event-id='${escapeHtml(String(item.workflowEventId || ''))}' data-notification-id='${escapeHtml(String(item.notificationId || ''))}'>
              <strong>${escapeHtml(cleanText(item.label, 'Untitled item'))}</strong>
              <span>${escapeHtml(cleanText(item.meta, 'Open record'))}</span>
            </button>
          `).join('') : `<div class='queue-empty'>Clear right now</div>`}
        </div>
      </article>
    `;
  }

  function renderOverviewTable(columns, rows, emptyCopy) {
    const headers = Array.isArray(columns) ? columns : [];
    const entries = Array.isArray(rows) ? rows : [];
    if (!headers.length) return '';
    if (!entries.length) return renderTableEmptyState(emptyCopy);
    return `
      <div class='table-scroll table-scroll--compact'>
        <table class='data-table data-table--compact'>
          <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
          <tbody>${entries.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cleanText(cell, '—'))}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>
    `;
  }

  const lifecycleStages = ['Intake', 'Onboarding', 'Fulfillment', 'Reporting', 'Continuity'];

  function workflowStageState(currentIndex, stageIndex) {
    if (stageIndex < currentIndex) return 'is-complete';
    if (stageIndex === currentIndex) return 'is-current';
    return 'is-upcoming';
  }

  function renderWorkflowBand(items) {
    const rows = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!rows.length) return '';
    return `
      <section class='workflow-band'>
        ${rows.map((item) => `
          <button type='button' class='workflow-stage-card ${item.isActive ? 'is-active' : ''}' data-action='switch-workspace' data-workspace='${escapeHtml(item.workspace || 'command')}'>
            <span class='workflow-stage-card__label'>${escapeHtml(item.label)}</span>
            <strong>${escapeHtml(String(item.value ?? 0))}</strong>
            <span class='workflow-stage-card__meta'>${escapeHtml(item.meta || '')}</span>
          </button>
        `).join('')}
      </section>
    `;
  }

  function renderWorkflowSnapshot(title, summary, currentIndex, details) {
    const rows = (Array.isArray(details) ? details : []).filter((item) => item && item.label && item.value);
    return `
      <section class='inspector-section workflow-panel'>
        <div class='table-caption'>${escapeHtml(title)}</div>
        <div class='workflow-panel__summary'>
          <strong>${escapeHtml(summary || 'Workflow context is being established.')}</strong>
          <span>${escapeHtml(lifecycleStages[Math.max(0, Math.min(currentIndex, lifecycleStages.length - 1))] || 'Intake')}</span>
        </div>
        <div class='workflow-track'>
          ${lifecycleStages.map((stage, stageIndex) => `
            <div class='workflow-step ${workflowStageState(currentIndex, stageIndex)}'>
              <span class='workflow-step__marker'></span>
              <span class='workflow-step__label'>${escapeHtml(stage)}</span>
            </div>
          `).join('')}
        </div>
        ${rows.length ? `
          <div class='workflow-detail-list'>
            ${rows.map((item) => `
              <div class='workflow-detail-item'>
                <span>${escapeHtml(item.label)}</span>
                <strong>${escapeHtml(item.value)}</strong>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </section>
    `;
  }

  function leadWorkflowProfile(lead) {
    const status = String(lead?.status || '').toLowerCase();
    let currentIndex = 0;
    let summary = 'Client intake is active and still needs cadence, ownership, and handoff clarity.';
    if (['qualified', 'proposal'].includes(status)) {
      currentIndex = 1;
      summary = 'The relationship is moving through onboarding readiness before scheduled fulfillment takes over.';
    }
    if (status === 'won') {
      currentIndex = 2;
      summary = 'The client is ready for scheduled fulfillment, staffing, and delivery planning.';
    }
    return {
      currentIndex,
      summary,
      details: [
        { label: 'Current owner', value: cleanText(lead?.assigned_role || lead?.assigned_user_id, 'Unassigned') },
        { label: 'Cadence checkpoint', value: lead?.meta?.followup ? formatDateTime(lead.meta.followup) : 'Follow-up not scheduled' },
        { label: 'Next move', value: status === 'won' ? 'Attach kickoff and downstream fulfillment owner' : (status === 'new' ? 'Confirm first meeting and qualification path' : 'Lock onboarding owner and next milestone') },
      ],
    };
  }

  function eventWorkflowProfile(event) {
    const reportStatus = String(event?.report_status || '').toLowerCase();
    const eventStatus = String(event?.status || '').toLowerCase();
    let currentIndex = 2;
    let summary = 'This record sits inside fulfillment, where scheduling, staffing, and execution must stay visible.';
    if (reportStatus && reportStatus !== 'not_started') {
      currentIndex = 3;
      summary = 'Delivery is in motion or complete, and reporting closeout now controls the next move.';
    }
    if (reportStatus === 'complete') {
      currentIndex = 4;
      summary = 'Reporting is closed and the account can move into continuity, recap, and next-cycle planning.';
    }
    return {
      currentIndex,
      summary,
      details: [
        { label: 'Linked account', value: cleanText(event?.account?.name || event?.account_name, 'No account linked') },
        { label: 'Execution date', value: formatDateTime(event?.starts_at || event?.event_date) },
        { label: 'Reporting state', value: humanizeLabel(cleanText(event?.report_status, 'not_started')) },
        { label: 'Next move', value: eventStatus === 'open' ? 'Confirm readiness and ownership before execution' : (reportStatus === 'complete' ? 'Carry recap into continuity and renewal planning' : 'Close reporting and follow-through after delivery') },
      ],
    };
  }

  function taskWorkflowProfile(task) {
    const taskType = String(task?.taskType || task?.task_type || '').toLowerCase();
    let currentIndex = 4;
    let summary = 'This task is part of continuity work, where follow-up, maintenance, and ownership protection stay active.';
    if (taskType === 'account') {
      currentIndex = 1;
      summary = 'This task belongs to onboarding and readiness, where owners need clean context and next checkpoints.';
    }
    if (taskType === 'event') {
      currentIndex = 2;
      summary = 'This task belongs to fulfillment, where staffing, timing, and execution pressure need active ownership.';
    }
    if (taskType === 'followup') {
      currentIndex = 3;
      summary = 'This task belongs to reporting and closeout, where recap, feedback, and follow-up protect the relationship.';
    }
    return {
      currentIndex,
      summary,
      details: [
        { label: 'Owner', value: cleanText(task?.assignedUserId || task?.assigned_user_id, 'Unassigned') },
        { label: 'Due checkpoint', value: formatDateTime(task?.dueAt || task?.due_at) },
        { label: 'Linked lead', value: String(task?.leadId || task?.lead_id || '—') },
        { label: 'Linked event', value: String(task?.eventId || task?.event_id || '—') },
      ],
    };
  }

  function renderInlineEmpty(copy) {
    return `<div class='form-note'>${escapeHtml(copy)}</div>`;
  }

  function renderCommandWorkspace() {
    const summary = state.overview?.summary || {};
    const queues = state.overview?.queues || {};
    const highlights = state.overview?.highlights || {};
    const operations = state.overview?.operations || {};
    const loading = !!state.loading.command;
    const intakeOpen = Number(summary.pipeline?.intake ?? (
      Number(summary.pipeline?.new || 0)
      + Number(summary.pipeline?.working || 0)
      + Number(summary.pipeline?.booked || 0)
    ));
    const onboardingLive = Number(summary.onboarding?.submissionsPending || 0)
      + Number(summary.onboarding?.journeysActive || 0)
      + Number(summary.onboarding?.journeysBlocked || 0);
    const fulfillmentDue = Number(summary.events?.upcoming || 0);
    const openWork = Number(summary.tasks?.open || 0);
    const salesQueue = mergeQueueItems(highlights.recentLeads).slice(0, 3);
    const onboardingQueue = mergeQueueItems(queues.pendingSubmissions, queues.blockedJourneys, queues.ownerlessAccounts).slice(0, 3);
    const fulfillmentQueue = mergeQueueItems(queues.upcomingEvents, queues.staffingRiskEvents, queues.reportPendingEvents).slice(0, 3);
    const workdayQueue = mergeQueueItems(queues.overdueTasks, queues.unassignedTasks, queues.blockedTasks).slice(0, 3);
    const lifecycleFlow = [
      { label: 'Intake', value: intakeOpen, meta: 'Sales forms, first contact, qualification', workspace: 'pipeline', isActive: intakeOpen > 0 },
      { label: 'Onboarding', value: onboardingLive, meta: 'Kickoff readiness, owner, and handoff', workspace: 'pipeline', isActive: onboardingLive > 0 },
      { label: 'Fulfillment', value: fulfillmentDue, meta: 'Scheduled work, staffing, and execution', workspace: 'operations', isActive: fulfillmentDue > 0 },
      { label: 'Reporting', value: summary.events?.reportPending ?? 0, meta: 'Recaps, surveys, and closeout loops', workspace: 'operations', isActive: Number(summary.events?.reportPending ?? 0) > 0 },
      { label: 'Continuity', value: openWork, meta: 'Follow-up, maintenance, and next-cycle work', workspace: 'workforce', isActive: openWork > 0 },
    ];
    const territoryRows = Array.isArray(operations.territoryLoad) ? operations.territoryLoad : [];
    const topTerritory = territoryRows[0] || null;
    const pressureCandidates = [
      {
        label: 'Intake',
        value: intakeOpen,
        copy: intakeOpen
          ? `${String(intakeOpen)} client records still need qualification or handoff.`
          : 'Client intake is stable right now.',
        action: 'Review clients',
        workspace: 'pipeline',
      },
      {
        label: 'Onboarding',
        value: onboardingLive,
        copy: onboardingLive
          ? `${String(onboardingLive)} onboarding records still need release or cleanup.`
          : 'Onboarding release is stable right now.',
        action: 'Review clients',
        workspace: 'pipeline',
      },
      {
        label: 'Fulfillment',
        value: fulfillmentDue,
        copy: fulfillmentDue
          ? `${String(fulfillmentDue)} scheduled records need execution attention.`
          : 'Fulfillment load is stable right now.',
        action: 'Route fulfillment',
        workspace: 'operations',
      },
      {
        label: 'Reporting',
        value: Number(summary.events?.reportPending ?? 0),
        copy: Number(summary.events?.reportPending ?? 0)
          ? `${String(summary.events?.reportPending ?? 0)} records still need reporting closeout.`
          : 'Reporting closeout is stable right now.',
        action: 'Route fulfillment',
        workspace: 'operations',
      },
      {
        label: 'Continuity',
        value: openWork,
        copy: openWork
          ? `${String(openWork)} open tasks still need owner follow-through.`
          : 'Continuity work is stable right now.',
        action: 'Review workday',
        workspace: 'workforce',
      },
    ];
    const priorityPressure = pressureCandidates.reduce((best, candidate) => {
      if (!best) return candidate;
      return Number(candidate.value || 0) > Number(best.value || 0) ? candidate : best;
    }, null);
    const notice = state.notices.app && state.activeWorkspace === 'command'
      ? `<div class='status-banner is-danger'>${escapeHtml(state.notices.app)}</div>`
      : '';

    return `
      <section class='workspace-frame'>
        <header class='workspace-header'>
          <div class='workspace-header__text'>
            <div class='section-kicker'>Manager view</div>
            <h1 class='workspace-title'>Overview</h1>
            <p class='workspace-copy'>Lifecycle posture, regional pressure, and the next place to work.</p>
          </div>
          <div class='workspace-meta'>
            <div class='meta-pill'>Live reporting</div>
            <div class='meta-pill'>Generated ${escapeHtml(formatDateTime(state.overview?.generatedAt || Date.now()))}</div>
          </div>
        </header>
        ${notice}
        ${loading && !summary ? renderLoadingState('Refreshing overview') : ''}
        ${renderWorkflowBand(lifecycleFlow)}
        <div class='metric-grid'>
          ${renderMetricCard(
            'Regional priority',
            topTerritory ? String(topTerritory.upcoming || 0) : '0',
            topTerritory
              ? `${topTerritory.state} is carrying ${String(topTerritory.upcoming || 0)} upcoming, ${String(topTerritory.staffingRisk || 0)} at risk, and ${String(topTerritory.reportPending || 0)} reports due.`
              : 'Regional demand will surface here as locations and fulfillment pressure build.',
            'Open fulfillment',
            'operations',
          )}
          ${renderMetricCard(
            'Primary pressure',
            priorityPressure ? String(priorityPressure.value || 0) : '0',
            priorityPressure ? priorityPressure.copy : 'No active pressure is dominating the system right now.',
            priorityPressure ? priorityPressure.action : 'Open overview',
            priorityPressure ? priorityPressure.workspace : 'command',
          )}
          ${renderMetricCard(
            'Planning discovery',
            'Contextual',
            'Vendor fit and event design should open from live client or event work, or from guided help in Pura, not from the landing screen.',
            'Open Pura',
            'assistant',
          )}
        </div>
        <div class='queue-grid'>
          ${renderQueue('Intake', 'Early client movement.', salesQueue, 'sales-intake', 'pipeline')}
          ${renderQueue('Onboarding', 'Setup and release.', onboardingQueue, 'onboarding', 'pipeline')}
          ${renderQueue('Fulfillment', 'Delivery and closeout risk.', fulfillmentQueue, 'fulfillment', 'operations')}
          ${renderQueue('Team work', 'Blocked, overdue, or unowned.', workdayQueue, 'team-work', 'workforce')}
        </div>
        <section class='table-wrap'>
          ${renderSurfaceHeader('Territory load', 'Regional demand and delivery pressure by market.', `${String(territoryRows.length)} markets`) }
          ${renderOverviewTable(
            ['State', 'Locations', 'Upcoming', 'Risk', 'Reports'],
            territoryRows.map((row) => [row.state, String(row.locations), String(row.upcoming), String(row.staffingRisk), String(row.reportPending)]),
            'No territory load is available yet. This becomes useful once locations and fulfillment records are live.',
          )}
        </section>
      </section>
    `;
  }

  function renderTableHeader(columns) {
    return `<tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr>`;
  }

  function renderLeadRow(lead) {
    const selected = String(state.selections.leadId) === String(lead.id);
    const name = `${cleanText(lead.first_name, '')} ${cleanText(lead.last_name, '')}`.trim() || `Lead ${lead.id}`;
    return `
      <tr class='table-row ${selected ? 'is-selected' : ''}' data-action='select-lead' data-id='${escapeHtml(String(lead.id))}'>
        <td>
          <div class='data-primary'>${escapeHtml(name)}</div>
          <div class='data-secondary'>${escapeHtml(cleanText(lead.email || lead.phone, 'No contact'))}</div>
        </td>
        <td>
          <div class='data-primary'>${escapeHtml(cleanText(lead.property_name || lead.company, 'Unassigned property'))}</div>
          <div class='data-secondary'>${escapeHtml(cleanText([lead.city, lead.state].filter(Boolean).join(', '), 'No location'))}</div>
        </td>
        <td><span class='status-pill' data-tone='${statusTone(lead.status)}'>${escapeHtml(humanizeLabel(cleanText(lead.status, 'new')))}</span></td>
        <td><span class='inline-pill'>${escapeHtml(cleanText(lead.assigned_role || lead.assigned_user_id, 'Open'))}</span></td>
      </tr>
    `;
  }

  function renderLeadInspector() {
    const lead = activeLead();
    if (!lead) return renderEmptyPanel('No client selected', 'Choose a client from the table to inspect contact detail, handoff posture, and the next lifecycle move.');
    const name = `${cleanText(lead.first_name, '')} ${cleanText(lead.last_name, '')}`.trim() || `Lead ${lead.id}`;
    const workflow = leadWorkflowProfile(lead);
    const nextSteps = [];
    if (!lead.assigned_user_id && !lead.assigned_role) nextSteps.push('Assign an owner before routing the lead forward.');
    if (!lead.email && !lead.phone) nextSteps.push('Capture a direct contact method so follow-up is not blocked.');
    if (!lead.property_name && !lead.company) nextSteps.push('Attach property or company context before proposal work.');
    if (String(lead.status || '').toLowerCase() === 'new') nextSteps.push('Confirm the next meeting, cadence, budget shape, and property scope.');
    return `
      <div class='inspector-card'>
        <div>
          <div class='section-kicker'>Client record</div>
          <h2 class='thread-title'>${escapeHtml(name)}</h2>
          <p class='workspace-copy'>${escapeHtml(cleanText(lead.company || lead.property_name, 'No company or property attached.'))}</p>
        </div>
        <div class='inspector-actions'>
          <button type='button' class='primary-button' data-action='edit-lead'>Edit client</button>
          <button type='button' class='ghost-button' data-action='open-assistant-from-selection'>Plan next move</button>
        </div>
        <div class='data-points'>
          <div class='data-point'><div class='field-label'>Stage</div><strong>${escapeHtml(humanizeLabel(cleanText(lead.status, 'new')))}</strong></div>
          <div class='data-point'><div class='field-label'>Assigned</div><strong>${escapeHtml(cleanText(lead.assigned_role || lead.assigned_user_id, 'Open'))}</strong></div>
          <div class='data-point'><div class='field-label'>Company</div><strong>${escapeHtml(cleanText(lead.company || lead.property_name, 'Unassigned'))}</strong></div>
          <div class='data-point'><div class='field-label'>Location</div><strong>${escapeHtml(cleanText([lead.city, lead.state].filter(Boolean).join(', '), 'No location'))}</strong></div>
        </div>
        ${renderInspectorList('Client details', [
          { label: 'Email', value: cleanText(lead.email, 'No email') },
          { label: 'Phone', value: cleanText(lead.phone, 'No phone') },
          { label: 'Client id', value: String(lead.id || '—') },
          { label: 'Assigned user', value: cleanText(lead.assigned_user_id, 'Unassigned') },
        ])}
        ${renderWorkflowSnapshot('Lifecycle continuity', workflow.summary, workflow.currentIndex, workflow.details)}
        <section class='inspector-section'>
          <div class='table-caption'>Notes</div>
          <p class='workspace-copy'>${escapeHtml(cleanText(lead.notes, 'No notes yet.'))}</p>
        </section>
        ${renderActionHints('Next actions', nextSteps)}
      </div>
    `;
  }

  function renderPipelineWorkspace() {
    const loading = !!state.loading.pipeline;
    const rows = sortRows('leads', state.leads);
    const lead = activeLead();
    return `
      <section class='workspace-frame'>
        <header class='workspace-header'>
          <div class='workspace-header__text'>
            <div class='section-kicker'>Client lifecycle</div>
            <h1 class='workspace-title'>Clients</h1>
            <p class='workspace-copy'>This surface tracks client entry, meeting cadence, and handoff readiness. Events are downstream of this work, not the whole story.</p>
          </div>
          <div class='section-actions'>
            <button type='button' class='primary-button' data-action='new-lead'>New client</button>
          </div>
        </header>
        <div class='workspace-card workspace-card--toolbar'>
          ${renderPresetViews('pipeline', [
            { id: 'all', label: 'All', copy: 'Full client queue' },
            { id: 'new', label: 'New', copy: 'Fresh intake' },
            { id: 'qualified', label: 'Qualified', copy: 'Meeting path active' },
            { id: 'won', label: 'Won', copy: 'Ready for handoff' },
          ], pipelineViewId())}
          <div class='toolbar-row'>
            <div class='toolbar-heading'>
              <div class='table-caption'>Clients</div>
              <div class='muted'>Routing should narrow the queue, not redraw it.</div>
            </div>
            <form id='leadFilters' class='toolbar-form'>
              <div class='toolbar-form__groups'>
                <label class='field-stack field-stack--search'>
                  <span class='field-label'>Search</span>
                  <input name='q' value='${escapeHtml(state.filters.leads.q)}' placeholder='Name, company, property, contact' />
                </label>
                ${renderFilterChipGroup('pipeline', 'status', 'Status', ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'], state.filters.leads.status)}
              </div>
              <div class='toolbar-form__actions'>
                ${hasActiveFilters(state.filters.leads) ? `<button class='ghost-button compact-button' type='button' data-action='clear-filters' data-workspace='pipeline'>Clear filters</button>` : ''}
                <button class='secondary-button compact-button' type='submit'>Refresh view</button>
              </div>
            </form>
          </div>
          ${renderToolbarState(`${String(rows.length)} visible`, state.filters.leads, { q: 'Search', status: 'Stage' })}
        </div>
        <div class='split-layout'>
          <div class='table-wrap'>
            ${renderSurfaceHeader('Client queue', 'Selection keeps the client record active while edits stay off-surface in the drawer.', `${String(rows.length)} visible`)}
            ${lead ? renderSelectionBar(
              `${cleanText(lead.first_name, '')} ${cleanText(lead.last_name, '')}`.trim() || `Lead ${lead.id}`,
              cleanText(lead.company || lead.property_name || lead.email || lead.phone, 'Client context attached'),
              [{ action: 'edit-lead', label: 'Edit client' }, { action: 'open-assistant-from-selection', label: 'Plan next move' }],
            ) : ''}
            <div class='table-scroll'>
              ${loading && !rows.length ? renderLoadingState('Refreshing client queue') : `
                <table class='data-table'>
                  <thead>${renderSortableHeader('leads', [
                    { label: 'Contact', key: 'contact' },
                    { label: 'Property', key: 'property' },
                    { label: 'Status', key: 'status' },
                    { label: 'Owner', key: 'owner' },
                  ])}</thead>
                  <tbody>${rows.length ? rows.map(renderLeadRow).join('') : `<tr><td colspan='4'>${renderTableEmptyState('No clients match the current scope. Adjust the view or filters without leaving the table.')}</td></tr>`}</tbody>
                </table>
              `}
            </div>
          </div>
          ${renderLeadInspector()}
        </div>
      </section>
    `;
  }

  function renderEventRow(event) {
    const selected = String(state.selections.eventId) === String(event.id);
    const location = [event.city, event.state].filter(Boolean).join(', ');
    return `
      <tr class='table-row ${selected ? 'is-selected' : ''}' data-action='select-event' data-id='${escapeHtml(String(event.id))}'>
        <td>
          <div class='data-primary'>${escapeHtml(cleanText(event.title, `Event ${event.id}`))}</div>
          <div class='data-secondary'>${escapeHtml(cleanText(event.account?.name || event.account_name || event.location?.location_name || location, 'No account context'))}</div>
        </td>
        <td>${escapeHtml(formatDate(event.starts_at || event.event_date))}</td>
        <td><span class='status-pill' data-tone='${statusTone(event.status)}'>${escapeHtml(humanizeLabel(cleanText(event.status, 'open')))}</span></td>
        <td><span class='inline-pill'>${escapeHtml(humanizeLabel(cleanText(event.assigned_role || event.event_kind, 'Open')))}</span></td>
      </tr>
    `;
  }

  function renderEventInspector() {
    const event = activeEvent();
    if (!event) return renderEmptyPanel('No event selected', 'Choose a fulfillment record to inspect timing, staffing, logistics, and post-event follow-through.');
    const workflow = eventWorkflowProfile(event);
    const staffing = event.staffing || {};
    const staffingGap = Number(staffing.requiredPeople ?? 0) - Number(staffing.acceptedPeople ?? 0);
    const nextSteps = [];
    if (Number.isFinite(staffingGap) && staffingGap > 0) nextSteps.push(`Close the staffing gap for ${staffingGap} more ${staffingGap === 1 ? 'person' : 'people'}.`);
    if (String(event.logistics_status || '').toLowerCase() !== 'complete') nextSteps.push('Confirm logistics readiness before execution begins.');
    if (String(event.report_status || '').toLowerCase() !== 'complete') nextSteps.push('Keep report follow-through visible so execution does not close unfinished.');
    return `
      <div class='inspector-card'>
        <div>
          <div class='section-kicker'>Fulfillment record</div>
          <h2 class='thread-title'>${escapeHtml(cleanText(event.title, `Event ${event.id}`))}</h2>
          <p class='workspace-copy'>${escapeHtml(cleanText(event.account?.name || event.location?.location_name || [event.city, event.state].filter(Boolean).join(', '), 'No account or location linked.'))}</p>
        </div>
        <div class='inspector-actions'>
          <button type='button' class='primary-button' data-action='edit-event'>Edit event</button>
          <button type='button' class='ghost-button' data-action='open-assistant-from-selection'>Route logistics</button>
        </div>
        <div class='data-points'>
          <div class='data-point'><div class='field-label'>Date</div><strong>${escapeHtml(formatDateTime(event.starts_at || event.event_date))}</strong></div>
          <div class='data-point'><div class='field-label'>Payout</div><strong>${escapeHtml(formatMoneyFromCents(event.payout_cents || 0))}</strong></div>
          <div class='data-point'><div class='field-label'>Staffing required</div><strong>${escapeHtml(String(staffing.requiredPeople ?? '—'))}</strong></div>
          <div class='data-point'><div class='field-label'>Staffing accepted</div><strong>${escapeHtml(String(staffing.acceptedPeople ?? '—'))}</strong></div>
        </div>
        ${renderInspectorList('Execution state', [
          { label: 'Execution', value: humanizeLabel(cleanText(event.execution_status, 'planned')) },
          { label: 'Logistics', value: humanizeLabel(cleanText(event.logistics_status, 'not_started')) },
          { label: 'Report', value: humanizeLabel(cleanText(event.report_status, 'not_started')) },
          { label: 'Assigned role', value: humanizeLabel(cleanText(event.assigned_role || event.event_kind, 'Open')) },
        ])}
        ${renderWorkflowSnapshot('Workflow continuity', workflow.summary, workflow.currentIndex, workflow.details)}
        <section class='inspector-section'>
          <div class='table-caption'>Notes</div>
          <p class='workspace-copy'>${escapeHtml(cleanText(event.notes, 'No notes attached.'))}</p>
        </section>
        ${renderActionHints('Next actions', nextSteps)}
      </div>
    `;
  }

  function renderOperationsWorkspace() {
    const loading = !!state.loading.operations;
    const rows = sortRows('events', state.events);
    const event = activeEvent();
    const summary = state.overview?.summary || {};
    const queues = state.overview?.queues || {};
    const exposureQueue = mergeQueueItems(queues.staffingRiskEvents, queues.upcomingEvents);
    const closeoutQueue = mergeQueueItems(queues.reportPendingEvents, queues.blockedTasks, queues.unassignedTasks);
    const benchQueue = mergeQueueItems(queues.readyIdlePeople, queues.peopleNotReady);
    return `
      <section class='workspace-frame'>
        <header class='workspace-header'>
          <div class='workspace-header__text'>
            <div class='section-kicker'>Fulfillment cadence</div>
            <h1 class='workspace-title'>Fulfillment</h1>
            <p class='workspace-copy'>Meetings, scheduled delivery, staffing, and reporting follow-through live here. This is the day-to-day fulfillment view.</p>
          </div>
          <div class='section-actions'>
            <button type='button' class='primary-button' data-action='new-event'>New event</button>
          </div>
        </header>
        <div class='command-strip'>
          ${renderCommandMetric('Scheduled', summary.events?.upcoming ?? 0, 'Upcoming meetings and delivery', 'operations')}
          ${renderCommandMetric('Staffing risk', summary.events?.staffingRisk ?? 0, 'Coverage gaps approaching', 'operations')}
          ${renderCommandMetric('Reports due', summary.events?.reportPending ?? 0, 'Post-delivery reporting still open', 'operations')}
          ${renderCommandMetric('Open support', summary.tasks?.unassigned ?? 0, 'Unassigned support work', 'workforce')}
        </div>
        <div class='queue-grid'>
          ${renderQueue('Scheduled now', 'Upcoming fulfillment needing coordination.', exposureQueue, 'operations-exposure', 'operations')}
          ${renderQueue('Follow-through', 'Reports and support still open.', closeoutQueue, 'operations-closeout', 'workforce')}
          ${renderQueue('Coverage', 'Deployable now or not ready.', benchQueue, 'operations-bench', 'workforce')}
        </div>
        <div class='workspace-card workspace-card--toolbar'>
          ${renderPresetViews('operations', [
            { id: 'all', label: 'All', copy: 'Full fulfillment queue' },
            { id: 'open', label: 'Open', copy: 'Needs routing' },
            { id: 'assigned', label: 'Assigned', copy: 'Live handoff' },
            { id: 'dispatch', label: 'Dispatch', copy: 'Field ops' },
            { id: 'media', label: 'Media', copy: 'Content support' },
          ], operationsViewId())}
          <div class='toolbar-row'>
            <div class='toolbar-heading'>
              <div class='table-caption'>Fulfillment</div>
              <div class='muted'>Routing should support scheduled work, not compete with it.</div>
            </div>
            <form id='eventFilters' class='toolbar-form'>
              <div class='toolbar-form__groups'>
                ${renderFilterChipGroup('operations', 'status', 'Status', [{ value: 'open', label: 'Open' }, { value: 'assigned', label: 'Assigned' }, { value: 'in_progress', label: 'Active' }, { value: 'completed', label: 'Done' }, { value: 'cancelled', label: 'Closed' }], state.filters.events.status)}
                ${renderFilterChipGroup('operations', 'areaTag', 'Area', ['dispatch', 'events', 'media', 'ops'], state.filters.events.areaTag)}
              </div>
              ${hasActiveFilters(state.filters.events) ? `<div class='toolbar-form__actions'><button class='ghost-button' type='button' data-action='clear-filters' data-workspace='operations'>Clear filters</button></div>` : ''}
            </form>
          </div>
          ${renderToolbarState(`${String(rows.length)} visible`, state.filters.events, { status: 'Status', areaTag: 'Area' })}
        </div>
        <div class='split-layout'>
          <div class='table-wrap'>
            ${renderSurfaceHeader('Scheduled execution queue', 'Use the table for scheduled work, then use the surrounding signals to understand readiness, staffing, and closeout pressure.', `${String(rows.length)} visible`)}
            ${event ? renderSelectionBar(
              cleanText(event.title, `Event ${event.id}`),
              cleanText(event.account?.name || event.location?.location_name || [event.city, event.state].filter(Boolean).join(', '), 'Fulfillment context attached'),
              [{ action: 'edit-event', label: 'Edit event' }, { action: 'open-assistant-from-selection', label: 'Route logistics' }],
            ) : ''}
            <div class='table-scroll'>
              ${loading && !rows.length ? renderLoadingState('Refreshing fulfillment queue') : `
                <table class='data-table'>
                  <thead>${renderSortableHeader('events', [
                    { label: 'Event', key: 'event' },
                    { label: 'Date', key: 'date' },
                    { label: 'Status', key: 'status' },
                    { label: 'Role', key: 'role' },
                  ])}</thead>
                  <tbody>${rows.length ? rows.map(renderEventRow).join('') : `<tr><td colspan='4'>${renderTableEmptyState('No fulfillment records match this view right now. Keep the shell stable and change scope from the compact controls above.')}</td></tr>`}</tbody>
                </table>
              `}
            </div>
          </div>
          ${renderEventInspector()}
        </div>
      </section>
    `;
  }

  function renderTaskRow(task) {
    const selected = String(state.selections.taskId) === String(task.id);
    return `
      <tr class='table-row ${selected ? 'is-selected' : ''}' data-action='select-task' data-id='${escapeHtml(String(task.id))}'>
        <td>
          <div class='data-primary'>${escapeHtml(cleanText(task.title, `Task ${task.id}`))}</div>
          <div class='data-secondary'>${escapeHtml(cleanText(task.description, 'No description'))}</div>
        </td>
        <td>${escapeHtml(humanizeLabel(cleanText(task.taskType || task.task_type, 'admin')))}</td>
        <td><span class='status-pill' data-tone='${statusTone(task.status)}'>${escapeHtml(humanizeLabel(cleanText(task.status, 'open')))}</span></td>
        <td>${escapeHtml(formatDateTime(task.dueAt || task.due_at))}</td>
      </tr>
    `;
  }

  function renderTaskInspector() {
    const task = activeTask();
    if (!task) return renderEmptyPanel('No task selected', 'Choose a task to inspect ownership, dependencies, due timing, and the record it is protecting.');
    const workflow = taskWorkflowProfile(task);
    const dueValue = task.dueAt || task.due_at;
    const dueDate = dueValue ? new Date(dueValue) : null;
    const isOverdue = dueDate && Number.isFinite(dueDate.getTime()) && dueDate.getTime() < Date.now() && String(task.status || '').toLowerCase() !== 'completed';
    const nextSteps = [];
    if (isOverdue) nextSteps.push('Reset ownership or due timing before this task slips further.');
    if (String(task.status || '').toLowerCase() === 'blocked') nextSteps.push('Clear the blocker and capture the dependency in the task record.');
    if (!task.assignedUserId && !task.assigned_user_id) nextSteps.push('Assign a responsible owner before opening more related work.');
    return `
      <div class='inspector-card'>
        <div>
          <div class='section-kicker'>Task inspector</div>
          <h2 class='thread-title'>${escapeHtml(cleanText(task.title, `Task ${task.id}`))}</h2>
          <p class='workspace-copy'>${escapeHtml(cleanText(task.description, 'No description attached.'))}</p>
        </div>
        <div class='inspector-actions'>
          ${state.taskReady ? `<button type='button' class='primary-button' data-action='edit-task'>Edit task</button>` : ''}
          <button type='button' class='ghost-button' data-action='open-assistant-from-selection'>Work the blocker</button>
        </div>
        <div class='data-points'>
          <div class='data-point'><div class='field-label'>Status</div><strong>${escapeHtml(humanizeLabel(cleanText(task.status, 'open')))}</strong></div>
          <div class='data-point'><div class='field-label'>Type</div><strong>${escapeHtml(humanizeLabel(cleanText(task.taskType || task.task_type, 'admin')))}</strong></div>
          <div class='data-point'><div class='field-label'>Priority</div><strong>${escapeHtml(String(task.priority ?? 0))}</strong></div>
          <div class='data-point'><div class='field-label'>Due</div><strong>${escapeHtml(formatDateTime(task.dueAt || task.due_at))}</strong></div>
        </div>
        ${renderInspectorList('Operational context', [
          { label: 'Assigned', value: cleanText(task.assignedUserId || task.assigned_user_id, 'Unassigned') },
          { label: 'Source', value: cleanText(task.source, state.taskSource || 'portal_tasks') },
          { label: 'Lead', value: String(task.leadId || task.lead_id || '—') },
          { label: 'Event', value: String(task.eventId || task.event_id || '—') },
        ])}
        ${renderWorkflowSnapshot('Workflow continuity', workflow.summary, workflow.currentIndex, workflow.details)}
        <section class='inspector-section'>
          <div class='table-caption'>Description</div>
          <p class='workspace-copy'>${escapeHtml(cleanText(task.description, 'No description attached.'))}</p>
        </section>
        ${renderActionHints('Next actions', nextSteps)}
      </div>
    `;
  }

  function renderWorkforceWorkspace() {
    const loading = !!state.loading.workforce;
    const rows = sortRows('tasks', state.tasks);
    const task = activeTask();
    const sourceNote = !state.taskReady
      ? `<div class='status-banner is-accent'>This queue is still reading from dispatch while the dedicated flow lands.</div>`
      : '';
    return `
      <section class='workspace-frame'>
        <header class='workspace-header'>
          <div class='workspace-header__text'>
            <div class='section-kicker'>Team execution</div>
            <h1 class='workspace-title'>Workday queue</h1>
            <p class='workspace-copy'>Read today’s work, move ownership quickly, and keep blockers visible.</p>
          </div>
        </header>
        ${sourceNote}
        <div class='workspace-card workspace-card--toolbar'>
          ${renderPresetViews('workforce', [
            { id: 'mine', label: 'Mine', copy: 'Default scope' },
            { id: 'blocked', label: 'Blocked', copy: 'Needs unblock' },
            { id: 'all', label: 'Team', copy: 'Shared inventory' },
            { id: 'completed', label: 'Done', copy: 'Closure review' },
          ], workforceViewId())}
          <div class='toolbar-row'>
            <div class='toolbar-heading'>
              <div class='table-caption'>Team work</div>
              <div class='muted'>Scope reroutes the queue in place.</div>
            </div>
            <form id='taskFilters' class='toolbar-form'>
              <div class='toolbar-form__groups'>
                <label class='field-stack field-stack--search'>
                  <span class='field-label'>Search</span>
                  <input name='q' value='${escapeHtml(state.filters.tasks.q)}' placeholder='Title or detail' />
                </label>
                ${renderFilterChipGroup('workforce', 'status', 'Status', [{ value: 'open', label: 'Open' }, { value: 'in_progress', label: 'Active' }, { value: 'blocked', label: 'Blocked' }, { value: 'completed', label: 'Done' }, { value: 'cancelled', label: 'Closed' }], state.filters.tasks.status)}
                ${renderFilterChipGroup('workforce', 'mine', 'Scope', [{ value: '1', label: 'Mine' }, { value: '', label: 'Team' }], state.filters.tasks.mine)}
              </div>
              <div class='toolbar-form__actions'>
                ${hasActiveFilters(Object.assign({}, state.filters.tasks, { mine: state.filters.tasks.mine === '1' ? '' : state.filters.tasks.mine })) ? `<button class='ghost-button compact-button' type='button' data-action='clear-filters' data-workspace='workforce'>Clear filters</button>` : ''}
                <button class='secondary-button compact-button' type='submit'>Refresh view</button>
              </div>
            </form>
          </div>
          ${renderToolbarState(`${String(rows.length)} visible`, state.filters.tasks.mine === '1' ? { q: state.filters.tasks.q, status: state.filters.tasks.status } : state.filters.tasks, { q: 'Search', status: 'Status', mine: 'Scope' })}
        </div>
        <div class='split-layout'>
          <div class='table-wrap'>
            ${renderSurfaceHeader('Daily task queue', 'Table first. Right rail for owner and blocker context.', `${String(rows.length)} visible`)}
            ${task ? renderSelectionBar(
              cleanText(task.title, `Task ${task.id}`),
              cleanText(task.description || task.taskType || task.task_type || state.taskSource, 'Task context attached'),
              [{ action: 'edit-task', label: 'Edit task' }, { action: 'open-assistant-from-selection', label: 'Work the blocker' }],
            ) : ''}
            <div class='table-scroll'>
              ${loading && !rows.length ? renderLoadingState('Refreshing team queue') : `
                <table class='data-table'>
                  <thead>${renderSortableHeader('tasks', [
                    { label: 'Task', key: 'task' },
                    { label: 'Type', key: 'type' },
                    { label: 'Status', key: 'status' },
                    { label: 'Due', key: 'due' },
                  ])}</thead>
                  <tbody>${rows.length ? rows.map(renderTaskRow).join('') : `<tr><td colspan='4'>${renderTableEmptyState('No tasks match this scope right now. Reset status or ownership filters and the queue fills in place.')}</td></tr>`}</tbody>
                </table>
              `}
            </div>
          </div>
          ${renderTaskInspector()}
        </div>
      </section>
    `;
  }

  function renderSettingsActionResult() {
    const result = state.settings.lastAccessResult;
    if (!result) return '';
    return `
      <div class='settings-note' role='status'>
        <strong>${escapeHtml(cleanText(result.label, 'Access action'))}</strong>
        <span>${escapeHtml(cleanText(result.copy, 'Completed.'))}</span>
        ${result.link ? `<a class='inline-link' href='${escapeHtml(result.link)}' target='_blank' rel='noreferrer'>Open action link</a>` : ''}
      </div>
    `;
  }

  function renderSettingsProfileResult() {
    const result = state.settings.lastProfileResult;
    if (!result) return '';
    return `
      <div class='settings-note' role='status'>
        <strong>${escapeHtml(cleanText(result.label, 'Profile updated'))}</strong>
        <span>${escapeHtml(cleanText(result.copy, 'Profile saved.'))}</span>
      </div>
    `;
  }

  function renderSettingsReviewResult() {
    const result = state.settings.lastReviewResult;
    if (!result) return '';
    return `
      <div class='settings-note' role='status'>
        <strong>${escapeHtml(cleanText(result.label, 'Review updated'))}</strong>
        <span>${escapeHtml(cleanText(result.copy, 'Manager review updated.'))}</span>
      </div>
    `;
  }

  function renderSettingsRows(items) {
    return `
      <div class='settings-row-list'>
        ${items.map((item) => `
          <div class='settings-row'>
            <div class='settings-row__label'>${escapeHtml(item.label)}</div>
            <div class='settings-row__value'>${escapeHtml(cleanText(item.value, 'Not set'))}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderSettingsAccountPanel() {
    const roleContext = state.roleContext || {};
    const person = state.person || {};
    const detail = state.settings.account.detail || {};
    const publicProfile = detail.talentProfile?.public || {};
    const authIdentity = detail.authIdentity || {};
    const onboardingJourney = detail.onboardingJourney || {};
    const trainingSummary = detail.trainingSummary || {};
    const displayName = cleanText(publicProfile.displayName, state.profile?.fullName || state.user?.email || 'Portal user');
    const avatarDataUrl = cleanText(publicProfile.avatarDataUrl, '');
    return `
      <section class='settings-surface'>
        <div class='settings-surface__header'>
          <div>
            <div class='section-kicker'>Account</div>
            <h2 class='thread-title'>${escapeHtml(displayName)}</h2>
          </div>
          <div class='settings-inline-actions'>
            <button type='button' class='secondary-button compact-button' data-action='settings-self-reset-password'>Send reset link</button>
          </div>
        </div>
        <form id='settingsProfileForm' class='settings-form'>
          <div class='settings-profile-shell'>
            <div class='settings-avatar-card'>
              ${avatarDataUrl ? `<img class='settings-avatar' src='${escapeHtml(avatarDataUrl)}' alt='${escapeHtml(displayName)}' />` : `<div class='settings-avatar settings-avatar--placeholder'>${escapeHtml(displayName.slice(0, 2).toUpperCase())}</div>`}
              <label class='field'>
                <span class='field-label'>Profile image</span>
                <input name='avatarFile' type='file' accept='image/png,image/jpeg' />
                <span class='field-help'>PNG or JPG.</span>
              </label>
            </div>
            <div class='field-stack'>
              <div class='field-grid two'>
                <label class='field'>
                  <span class='field-label'>Display name</span>
                  <input name='displayName' value='${escapeHtml(publicProfile.displayName || state.profile?.fullName || '')}' placeholder='How your name should appear' />
                </label>
                <label class='field'>
                  <span class='field-label'>Approved role</span>
                  <input value='${escapeHtml(humanizeLabel(cleanText(roleContext.effectiveRole || state.profile?.role, 'active')))}' disabled />
                </label>
              </div>
              <div class='field-grid two'>
                <label class='field'>
                  <span class='field-label'>Home base city</span>
                  <input name='homeBaseCity' value='${escapeHtml(publicProfile.homeBaseCity || '')}' placeholder='Charlotte' />
                </label>
                <label class='field'>
                  <span class='field-label'>Home base state</span>
                  <input name='homeBaseState' value='${escapeHtml(publicProfile.homeBaseState || '')}' placeholder='NC' />
                </label>
              </div>
              <label class='field'>
                <span class='field-label'>Bio</span>
                <textarea name='bio' placeholder='Short internal intro for your portal profile'>${escapeHtml(publicProfile.bio || '')}</textarea>
              </label>
              <div class='field-grid two'>
                <label class='field'>
                  <span class='field-label'>Specialties</span>
                  <input name='specialties' value='${escapeHtml(csvText(publicProfile.specialties))}' placeholder='Resident events, client recovery, outreach' />
                </label>
                <label class='field'>
                  <span class='field-label'>Tone</span>
                  <input name='tone' value='${escapeHtml(csvText(publicProfile.tone))}' placeholder='Calm, direct, friendly' />
                </label>
              </div>
              <label class='field'>
                <span class='field-label'>Gear and equipment</span>
                <input name='gear' value='${escapeHtml(csvText(publicProfile.gear))}' placeholder='Camera, branded kit, iPad' />
              </label>
            </div>
          </div>
          <div class='section-actions'>
            <button class='primary-button' type='submit'>Save profile</button>
          </div>
        </form>
        ${renderSettingsProfileResult()}
        <div class='settings-split'>
          <section>
            <div class='table-caption'>Identity</div>
            ${renderSettingsRows([
              { label: 'Email', value: cleanText(state.user?.email, 'No email') },
              { label: 'Manager', value: cleanText(person.manager_user_id, 'Not assigned') },
              { label: 'Access', value: humanizeLabel(cleanText(authIdentity.status, state.session?.preview ? 'preview' : 'active')) },
            ])}
          </section>
          <section>
            <div class='table-caption'>Readiness</div>
            ${renderSettingsRows([
              { label: 'Onboarding stage', value: humanizeLabel(cleanText(onboardingJourney.stageKey, 'Not started')) },
              { label: 'Readiness', value: humanizeLabel(cleanText(person.readiness_status, 'Not tracked')) },
              { label: 'Training', value: trainingSummary.requiredCount ? `${Number(trainingSummary.passedCount || 0)}/${Number(trainingSummary.requiredCount || 0)} required complete` : 'No required modules' },
            ])}
          </section>
        </div>
        ${renderSettingsActionResult()}
      </section>
    `;
  }

  function renderSettingsAccessPanel() {
    const accounts = state.settings.accessAccounts;
    const entry = state.settings.accessEntry;
    const suspended = entry
      ? String(entry.authIdentity?.status || '').toLowerCase() === 'suspended'
        || (!!entry.accessAudit?.suspendedAt && !entry.accessAudit?.restoredAt)
      : false;
    return `
      <section class='settings-surface'>
        <div class='settings-surface__header'>
          <div>
            <div class='section-kicker'>User access</div>
            <h2 class='thread-title'>Team identity and access</h2>
            <p class='workspace-copy'>Manage login, role, and release.</p>
          </div>
        </div>
        ${state.capabilities?.canManageUsers ? `
          <form id='accessProvisionForm' class='settings-form settings-form--compact'>
            <label class='field'>
              <span class='field-label'>Full name</span>
              <input name='fullName' placeholder='Team member name' required />
            </label>
            <label class='field'>
              <span class='field-label'>Email</span>
              <input name='email' type='email' placeholder='name@purestaync.com' required />
            </label>
            ${renderChoiceChipField('role', 'Role', SETTINGS_ROLE_OPTIONS, 'dialer')}
            <label class='field'>
              <span class='field-label'>Manager user ID</span>
              <input name='managerUserId' placeholder='Optional owner user id' />
            </label>
            <div class='section-actions'>
              <button class='primary-button' type='submit'>Provision and send activation</button>
            </div>
          </form>
        ` : ''}
        ${renderSettingsActionResult()}
        <div class='settings-access-shell'>
          <aside class='settings-directory'>
            <div class='settings-directory__header'>
              <div>
                <div class='table-caption'>Directory</div>
                <strong>${String(accounts.length)} people</strong>
              </div>
              <span class='muted'>Select a person.</span>
            </div>
            <div class='settings-list'>
              ${accounts.length ? accounts.map((account) => `
                <button type='button' class='access-user ${String(state.settings.selectedUserId) === String(account.userId) ? 'is-selected' : ''}' data-action='select-settings-user' data-user-id='${escapeHtml(account.userId)}'>
                  <strong>${escapeHtml(cleanText(account.fullName, account.email || account.userId))}</strong>
                  <span>${escapeHtml(compact([account.userId, humanizeLabel(account.role), account.email].filter(Boolean).join(' • '), 108))}</span>
                </button>
              `).join('') : renderInlineEmpty('No managed accounts have been provisioned yet.')}
            </div>
          </aside>
          <section class='settings-detail'>
            ${entry ? `
              <div class='settings-detail__header'>
                <div>
                  <div class='table-caption'>Selected person</div>
                  <h2 class='thread-title'>${escapeHtml(cleanText(entry.fullName, entry.email || entry.userId))}</h2>
                  <p class='workspace-copy'>${escapeHtml(cleanText(entry.email, 'No email recorded'))}</p>
                </div>
                <div class='settings-inline-actions'>
                  <button type='button' class='secondary-button compact-button' data-action='settings-access-action' data-access-action='reset_password' data-user-id='${escapeHtml(entry.userId)}'>Reset password</button>
                  ${entry.supports?.invite ? `<button type='button' class='ghost-button compact-button' data-action='settings-access-action' data-access-action='resend_invite' data-user-id='${escapeHtml(entry.userId)}'>Resend invite</button>` : ''}
                  ${entry.userId !== state.user?.id ? `<button type='button' class='ghost-button compact-button' data-action='settings-access-action' data-access-action='${suspended ? 'restore_access' : 'suspend_access'}' data-user-id='${escapeHtml(entry.userId)}'>${suspended ? 'Restore access' : 'Suspend access'}</button>` : ''}
                </div>
              </div>
              <div class='settings-split'>
                <section>
                  <div class='table-caption'>Profile</div>
                  ${renderSettingsRows([
                    { label: 'Role', value: humanizeLabel(cleanText(entry.role, 'unassigned')) },
                    { label: 'Status', value: humanizeLabel(cleanText(entry.authIdentity?.status, 'unknown')) },
                    { label: 'Employment', value: humanizeLabel(cleanText(entry.employmentStatus, 'Not tracked')) },
                  ])}
                </section>
                <section>
                  <div class='table-caption'>Release</div>
                  ${renderSettingsRows([
                    { label: 'Manager', value: cleanText(entry.managerName || entry.managerUserId, 'Not assigned') },
                    { label: 'Readiness', value: humanizeLabel(cleanText(entry.readinessStatus, 'Not tracked')) },
                  ])}
                </section>
              </div>
              <section class='settings-history-block'>
                <div class='table-caption'>Recent access history</div>
                <div class='settings-history'>
                  ${state.settings.loadingEntry ? renderLoadingState('Refreshing access history') : ''}
                  ${state.settings.accessHistory.length ? state.settings.accessHistory.map((item) => `
                    <div class='next-action-item'>
                      <strong>${escapeHtml(cleanText(item.actionLabel, 'Action'))}</strong>
                      <span>${escapeHtml(compact([formatDateTime(item.createdAt), item.actorName || item.actorUserId].filter(Boolean).join(' • '), 120))}</span>
                    </div>
                  `).join('') : renderInlineEmpty('No recorded access actions for this person yet.')}
                </div>
              </section>
            ` : renderEmptyPanel('No access record selected', 'Choose a person to inspect login access and release state.')}
          </section>
        </div>
      </section>
    `;
  }

  function renderSettingsReviewPanel() {
    const entries = Array.isArray(state.settings.reviewEntries) ? state.settings.reviewEntries : [];
    const entry = selectedSettingsReviewEntry();
    const detail = state.settings.reviewDetail || {};
    const person = detail.person || {};
    const authIdentity = detail.authIdentity || {};
    const journey = entry?.journey || detail.onboardingJourney || {};
    const submission = entry?.submission || {};
    const requestedRole = reviewRequestedRole(submission, journey, cleanText(person.role || entry?.currentRole, 'Not set'));
    const approvedRole = reviewApprovedRole(submission, journey, cleanText(person.role || entry?.approvedRole || entry?.currentRole, 'dialer'));
    const decisionCount = entries.filter((item) => item.sortWeight === 0).length;
    const queueSummary = decisionCount
      ? `${String(decisionCount)} role ${decisionCount === 1 ? 'decision' : 'decisions'}`
      : entries.length
        ? `${String(entries.length)} active review items`
        : 'Queue clear';

    return `
      <section class='settings-surface'>
        <div class='settings-surface__header'>
          <div>
            <div class='section-kicker'>Review</div>
            <h2 class='thread-title'>Onboarding and role release</h2>
            <p class='workspace-copy'>Approve role and release.</p>
          </div>
          <div class='settings-surface__meta'>
            <span class='status-pill' data-tone='${entries.some((item) => item.sortWeight === 0) ? 'gold' : 'default'}'>${escapeHtml(queueSummary)}</span>
          </div>
        </div>
        <div class='settings-access-shell settings-access-shell--review'>
          <aside class='settings-directory'>
            <div class='settings-directory__header'>
              <div>
                <div class='table-caption'>Review queue</div>
                <strong>${String(entries.length)} active</strong>
              </div>
            </div>
            <div class='settings-list'>
              ${entries.length ? entries.map((item) => `
                <button type='button' class='access-user ${String((entry || {}).userId) === String(item.userId) ? 'is-selected' : ''}' data-action='select-settings-review-user' data-user-id='${escapeHtml(item.userId)}'>
                  <strong>${escapeHtml(cleanText(item.fullName, item.userId))}</strong>
                  <span>${escapeHtml(compact([item.summary, item.updatedAt ? formatDateTime(item.updatedAt) : ''].filter(Boolean).join(' • '), 96))}</span>
                </button>
              `).join('') : renderInlineEmpty('No review items are waiting right now.')}
            </div>
          </aside>
          <section class='settings-detail'>
            ${entry ? `
              <div class='settings-detail__header'>
                <div>
                  <div class='table-caption'>Selected review</div>
                  <h2 class='thread-title'>${escapeHtml(cleanText(person.fullName || entry.fullName, entry.userId))}</h2>
                  <p class='workspace-copy'>${escapeHtml(cleanText(authIdentity.email || person.email || entry.email, 'No email recorded'))}</p>
                </div>
                <div class='settings-inline-actions'>
                  <span class='status-pill' data-tone='${escapeHtml(entry.tone || statusTone(entry.approvalStatus || entry.submissionStatus || entry.journeyStatus))}'>${escapeHtml(entry.attentionLabel || 'Tracked')}</span>
                </div>
              </div>
              <div class='settings-split'>
                <section>
                    <div class='table-caption'>Role decision</div>
                  ${renderSettingsRows([
                    { label: 'Requested role', value: humanizeLabel(cleanText(requestedRole, 'Not set')) },
                    { label: 'Approved role', value: humanizeLabel(cleanText(approvedRole, person.role || entry.currentRole || 'Not set')) },
                  ])}
                </section>
                <section>
                    <div class='table-caption'>Release state</div>
                  ${renderSettingsRows([
                    { label: 'Readiness', value: humanizeLabel(cleanText(person.readinessStatus || entry.readinessStatus, 'Not tracked')) },
                    { label: 'Employment', value: humanizeLabel(cleanText(person.employmentStatus || entry.employmentStatus, 'Not tracked')) },
                    { label: 'Assignments', value: person.canBeAssigned === false ? 'Held from assignment' : 'Released to assignments' },
                  ])}
                </section>
              </div>
              ${submission.title || submission.description || journey.notes ? `
                <div class='settings-review-note'>
                    <strong>${escapeHtml(cleanText(submission.title, 'Request note'))}</strong>
                  <span>${escapeHtml(cleanText(submission.description || journey.notes, 'No additional request note supplied.'))}</span>
                </div>
              ` : ''}
              <form id='settingsReviewForm' class='settings-form'>
                <input type='hidden' name='userId' value='${escapeHtml(entry.userId)}' />
                <input type='hidden' name='submissionId' value='${escapeHtml(String(entry.submissionId || ''))}' />
                <input type='hidden' name='journeyId' value='${escapeHtml(String(entry.journeyId || ''))}' />
                ${renderChoiceChipField('approvedRole', 'Approved role', SETTINGS_ROLE_OPTIONS, approvedRole || person.role || entry.currentRole || 'dialer')}
                ${renderChoiceChipField('employmentStatus', 'Employment status', ['candidate', 'active', 'contractor', 'inactive', 'alumni'], person.employmentStatus || entry.employmentStatus || 'candidate')}
                ${renderChoiceChipField('readinessStatus', 'Readiness', ['not_started', 'in_training', 'shadowing', 'ready', 'restricted'], person.readinessStatus || entry.readinessStatus || 'not_started')}
                ${renderChoiceChipField('canBeAssigned', 'Assignment release', [
                  { value: '1', label: 'Released to assignments' },
                  { value: '0', label: 'Hold assignments' },
                ], person.canBeAssigned === false ? '0' : '1')}
                <label class='field'>
                  <span class='field-label'>Manager owner</span>
                  <input name='managerUserId' value='${escapeHtml(person.managerUserId || entry.managerUserId || '')}' placeholder='Owner user id' />
                </label>
                <label class='field'>
                  <span class='field-label'>Release note</span>
                  <textarea name='reviewNotes' placeholder='What changed or why release is held.'>${escapeHtml(journey.notes || submission.meta?.reviewNotes || '')}</textarea>
                </label>
                <div class='section-actions'>
                  <button class='secondary-button compact-button' type='submit' name='reviewAction' value='save'>Save review</button>
                  <button class='primary-button' type='submit' name='reviewAction' value='approve'>Approve and release</button>
                </div>
              </form>
              ${renderSettingsReviewResult()}
            ` : (state.settings.loadingReviewEntry ? renderLoadingState('Opening review detail') : renderEmptyPanel('No review selected', 'Choose a review item to set role, readiness, and release.'))}
          </section>
        </div>
      </section>
    `;
  }

  function renderSettingsAdminPanel() {
    const admin = state.settings.admin || {};
    const bookingTone = admin.bookingPlatformConfigured ? 'accent' : 'gold';
    const bookingSummary = admin.bookingPlatformConfigured
      ? `Booking API connected${admin.bookingPlatformProvider ? ` · ${admin.bookingPlatformProvider}` : ''}${admin.bookingPlatformAccountLinked ? ' · account linked' : ''}`
      : 'Booking API key not loaded yet';
    const bookingDetail = admin.bookingPlatformBaseUrl
      ? `<span class='muted'>Base URL ${escapeHtml(admin.bookingPlatformBaseUrl)}</span>`
      : `<span class='muted'>Secrets stay server-side and never write back into admin settings.</span>`;
    return `
      <section class='settings-surface'>
        <div class='settings-surface__header'>
          <div>
            <div class='section-kicker'>Admin</div>
            <h2 class='thread-title'>Operating links and internal credentials</h2>
            <p class='workspace-copy'>Store operating links here. Secrets stay server-side.</p>
          </div>
          <div class='settings-surface__meta'>
            <span class='status-pill' data-tone='${bookingTone}'>${escapeHtml(bookingSummary)}</span>
            ${bookingDetail}
          </div>
        </div>
        <form id='adminSettingsForm' class='settings-form'>
          <label class='field'>
            <span class='field-label'>Booking calendar URL</span>
            <input name='bookingCalendarUrl' value='${escapeHtml(admin.bookingCalendarUrl || '')}' placeholder='https://…' />
          </label>
          <div class='field-grid two'>
            <label class='field'>
              <span class='field-label'>Checkout URL</span>
              <input name='stripeCheckoutUrl' value='${escapeHtml(admin.stripeCheckoutUrl || '')}' placeholder='https://…' />
            </label>
            <label class='field'>
              <span class='field-label'>Pricing URL</span>
              <input name='stripePricingUrl' value='${escapeHtml(admin.stripePricingUrl || '')}' placeholder='https://…' />
            </label>
          </div>
          <label class='field'>
            <span class='field-label'>Internal notes</span>
            <textarea name='internalNotes'>${escapeHtml(admin.internalNotes || '')}</textarea>
          </label>
          <div class='section-actions'>
            <button class='primary-button' type='submit'>Save admin settings</button>
            ${admin.updatedAt ? `<span class='muted'>Updated ${escapeHtml(formatDateTime(admin.updatedAt))}</span>` : ''}
          </div>
        </form>
      </section>
    `;
  }

  function renderSettingsWorkspace() {
    const activeTab = normalizeSettingsTab();
    const tabs = settingsTabs();
    const notice = state.notices.app && state.activeWorkspace === 'settings'
      ? `<div class='status-banner is-danger'>${escapeHtml(state.notices.app)}</div>`
      : '';
    const panel = activeTab === 'review'
      ? renderSettingsReviewPanel()
      : activeTab === 'access'
      ? renderSettingsAccessPanel()
      : activeTab === 'admin'
        ? renderSettingsAdminPanel()
        : renderSettingsAccountPanel();

    return `
      <section class='workspace-frame settings-workspace'>
        <header class='workspace-header'>
          <div class='workspace-header__text'>
            <div class='section-kicker'>Utility</div>
            <h1 class='workspace-title'>Settings</h1>
            <p class='workspace-copy'>Account, access, and operating links live here.</p>
          </div>
        </header>
        ${notice}
        <div class='settings-utility-shell'>
          <aside class='settings-rail'>
            <div class='settings-rail__header'>
              <div class='table-caption'>Areas</div>
              <p class='workspace-copy'>Personal first. Manager tools follow.</p>
            </div>
            <div class='settings-rail__nav'>
              ${tabs.map((tab) => `
                <button type='button' class='settings-rail__button ${tab.id === activeTab ? 'is-active' : ''}' data-action='select-settings-tab' data-tab='${escapeHtml(tab.id)}'>
                  <strong>${escapeHtml(tab.label)}</strong>
                  <span class='settings-tag'>${escapeHtml(tab.audience)}</span>
                </button>
              `).join('')}
            </div>
          </aside>
          <section class='settings-panel'>
            ${state.loading.settings ? renderLoadingState('Opening settings utility') : panel}
          </section>
        </div>
      </section>
    `;
  }

  function renderAssistantWorkspace() {
    const loading = !!state.loading.assistant;
    const threadList = state.threads;
    const activeThread = state.activeThread;
    const availableRecords = assistantContextRecords();
    const attachedRecords = state.assistantContextAttached ? availableRecords : [];
    const intentOptions = assistantIntentOptions();
    const activeIntent = intentOptions.some((item) => item.value === state.assistantRequestMode)
      ? state.assistantRequestMode
      : intentOptions[0]?.value || 'general';
    const composerNote = attachedRecords.length
      ? 'Replies stay bounded to the attached records and suggested next actions.'
      : availableRecords.length
        ? (state.assistantMode === 'operational'
          ? 'Route-work mode stays advisory until you ground the reply to the selected record.'
          : 'A selected record is available if you want this grounded.')
        : (state.assistantMode === 'operational'
          ? 'Without a live record, route-work replies stay general and missing facts stay explicit.'
          : 'Use this for meeting prep, sequencing, drafting, and next-step thinking.');
    const modePlaceholder = state.assistantMode === 'operational'
      ? 'Ask what to do, who owns it, and what happens next.'
      : 'Ask for meeting prep, client reading, or the next move.';
    const quickStarts = state.assistantMode === 'operational'
      ? [
          { title: 'Run record triage', copy: 'Decision, owner, due point', prompt: 'Triage this record operationally. Return the decision to make now, the owner, the blocker, and the next checkpoint.', requestMode: 'next_move' },
          { title: 'Surface delivery risk', copy: 'Cadence, staffing, closeout', prompt: 'Review this record operationally and surface the cadence, staffing, and closeout risks in priority order.', requestMode: 'risk_review' },
          { title: 'Write the handoff', copy: 'Send the next owner clean context', prompt: 'Prepare a concise handoff for the next owner with current state, blocker, and exact next action.', requestMode: 'summary' },
        ]
      : [
          { title: 'Review client health', copy: 'Read the relationship clearly', prompt: 'Review this client and tell me what matters most now, what is drifting, and what should happen next.', requestMode: 'general' },
          { title: 'Plan the next touch', copy: 'Cadence plus purpose', prompt: 'Map the next touchpoint for this client and what that conversation should accomplish.', requestMode: 'next_move' },
          { title: 'Draft the follow-up', copy: 'Client-ready language', prompt: 'Draft the next follow-up for this client in clean, direct language based on the current context.', requestMode: 'reply_draft' },
        ];
    return `
      <section class='workspace-frame'>
        <header class='workspace-header'>
          <div class='workspace-header__text'>
            <div class='section-kicker'>Assistant workspace</div>
            <h1 class='workspace-title'>Ask, plan, or route work</h1>
            <p class='workspace-copy'>Sales prep, sequence thinking, fulfillment support, and grounded next-step help.</p>
          </div>
        </header>
        <div class='assistant-layout'>
          <aside class='thread-column'>
            <div class='thread-column__header'>
              <div class='thread-column__copy'>
                <div class='section-kicker'>Threads</div>
                <span class='muted'>Resume work or start a new line of thinking.</span>
              </div>
              <button type='button' class='ghost-button compact-button' data-action='new-thread'>New thread</button>
            </div>
            <div class='thread-list'>
              ${loading && !threadList.length ? renderInlineEmpty('Loading chats…') : ''}
              ${threadList.length ? threadList.map((thread) => `
                <button type='button' class='thread-item ${thread.id === state.activeThreadId ? 'is-selected' : ''}' data-action='select-thread' data-id='${escapeHtml(thread.id)}' title='Right-click to rename'>
                  <strong>${escapeHtml(threadDisplayTitle(thread))}</strong>
                  <span class='thread-item__summary'>${escapeHtml(threadDisplaySummary(thread))}</span>
                </button>
              `).join('') : renderInlineEmpty('Start a thread when you need prep, grounded next steps, or a clean handoff.')}
            </div>
          </aside>
          <section class='thread-stage'>
            <div class='thread-stage__header'>
              <div class='thread-stage__copy'>
                <div class='section-kicker'>Current thread</div>
                <h2 class='thread-title'>${escapeHtml(threadDisplayTitle(activeThread, 'New thread'))}</h2>
              </div>
              <div class='thread-stage__meta'>
                <span class='status-pill' data-tone='${attachedRecords.length ? 'accent' : state.assistantMode === 'operational' ? 'gold' : 'default'}'>${escapeHtml(attachedRecords.length ? `Grounded to ${String(attachedRecords.length)} ${attachedRecords.length === 1 ? 'record' : 'records'}` : 'Advisory until grounded')}</span>
                <span class='inline-pill'>${escapeHtml(state.assistantMode === 'operational' ? 'Route work' : 'Think through')}</span>
              </div>
            </div>
            <div class='assistant-policy-strip'>
              <span class='inline-pill'>No silent changes</span>
              <span class='inline-pill'>Missing facts stay explicit</span>
              <span class='inline-pill'>${escapeHtml(attachedRecords.length ? 'Replies limited to attached records' : 'Attach a record for exact guidance')}</span>
            </div>
            <div class='message-list'>
              ${state.messages.length ? state.messages.map(renderMessage).join('') : `
                <div class='assistant-empty'>
                  ${renderEmptyPanel('Start from the current decision', state.assistantMode === 'operational' ? 'Use route-work mode to triage the record, surface the blocker, or prepare the handoff.' : 'Use Pura for meeting prep, account reading, sequence thinking, or drafting.', 'Assistant idle', attachedRecords.length ? 'Replies stay bounded to the attached records and suggested next actions.' : 'Attach a client, event, or task when the next move needs exact record context.')}
                  <div class='quick-start-block'>
                    <div class='table-caption'>Suggested starts</div>
                    <div class='quick-start-row'>
                      ${quickStarts.map((item) => `
                        <button
                          type='button'
                          class='quick-start-chip'
                          data-action='seed-assistant-prompt'
                          data-prompt='${escapeHtml(item.prompt)}'
                          data-request-mode='${escapeHtml(item.requestMode)}'
                          data-assistant-mode='${escapeHtml(state.assistantMode)}'
                        >
                          <strong>${escapeHtml(item.title)}</strong>
                        </button>
                      `).join('')}
                    </div>
                  </div>
                </div>
              `}
            </div>
            <form id='assistantComposer' class='composer'>
              ${attachedRecords.length ? `
                <div class='context-drawer'>
                  <div class='context-drawer__header'>
                    <div>
                      <div class='table-caption'>Attached context</div>
                      <div class='muted'>Replies stay anchored to the records shown here.</div>
                    </div>
                    <button type='button' class='ghost-button compact-button' data-action='toggle-assistant-context'>Remove context</button>
                  </div>
                  ${renderAttachedContextRecords()}
                </div>
              ` : ''}
              <div class='composer-shell'>
                <div class='composer-topbar'>
                  <div class='assistant-mode-toggle'>
                    <button type='button' class='assistant-mode-chip ${state.assistantMode === 'discuss' ? 'is-active' : ''}' data-action='set-assistant-mode' data-mode='discuss'>Think through</button>
                    <button type='button' class='assistant-mode-chip ${state.assistantMode === 'operational' ? 'is-active' : ''}' data-action='set-assistant-mode' data-mode='operational'>Route work</button>
                  </div>
                  ${availableRecords.length && !attachedRecords.length ? `<button type='button' class='ghost-button compact-button' data-action='toggle-assistant-context'>Ground to record</button>` : ''}
                </div>
                <div class='assistant-intent'>
                  <span class='field-label'>Input type</span>
                  <input type='hidden' name='requestMode' value='${escapeHtml(activeIntent)}' />
                  <div class='assistant-intent__chips'>
                    ${intentOptions.map((item) => `
                      <button
                        type='button'
                        class='assistant-mode-chip ${item.value === activeIntent ? 'is-active' : ''}'
                        data-action='set-choice-value'
                        data-choice-name='requestMode'
                        data-value='${escapeHtml(item.value)}'
                      >
                        ${escapeHtml(item.label)}
                      </button>
                    `).join('')}
                  </div>
                </div>
                <div class='composer-note ${state.assistantMode === 'operational' && !attachedRecords.length ? 'composer-note--warning' : ''}'>${escapeHtml(composerNote)}</div>
                <div class='composer-input'>
                  <textarea name='message' placeholder='${escapeHtml(modePlaceholder)}' required>${escapeHtml(state.assistantDraft)}</textarea>
                  <button class='composer-submit' type='submit' aria-label='Send request' ${state.loading.assistantSend ? 'disabled' : ''}>
                    ${state.loading.assistantSend ? `<span class='composer-submit__label'>...</span>` : `
                      <svg viewBox='0 0 16 16' fill='none' aria-hidden='true'>
                        <path d='M2.5 3.5 13.5 8l-11 4.5 2.2-4L2.5 3.5Z' fill='currentColor'></path>
                      </svg>
                    `}
                  </button>
                </div>
              </div>
            </form>
          </section>
        </div>
      </section>
    `;
  }

  function renderMessage(message) {
    const actions = Array.isArray(message.actions) ? message.actions : [];
    const role = String(message.role || 'assistant');
    return `
      <article class='message' data-role='${escapeHtml(role)}'>
        <div class='message__body'>${escapeHtml(cleanText(message.content, ''))}</div>
        ${actions.length ? `<div class='message-actions'><div class='message-actions__label'>Suggested moves</div>${actions.map((action) => `<span class='inline-pill'>${escapeHtml(cleanText(action.label, action.type || 'Action'))}</span>`).join('')}</div>` : ''}
      </article>
    `;
  }

  function renderEmptyPanel(title, copy, kicker = 'Inspector idle', footnote = 'The rail stays stable so context loads here without shifting the work surface.') {
    return `
      <div class='inspector-card empty-state'>
        <div class='empty-state__inner'>
          <div class='section-kicker'>${escapeHtml(kicker)}</div>
          <h2 class='empty-title'>${escapeHtml(title)}</h2>
          <p class='empty-copy'>${escapeHtml(copy)}</p>
          <p class='empty-footnote'>${escapeHtml(footnote)}</p>
        </div>
      </div>
    `;
  }

  function renderLoadingState(copy) {
    return `
      <div class='loading-state' role='status'>
        <span class='loading-state__label'>Loading</span>
        <strong>${escapeHtml(copy)}</strong>
      </div>
    `;
  }

  function renderBootstrapWorkspace() {
    const bootstrap = state.bootstrap || createBootstrapState();
    const detail = bootstrap.detail || {};
    const publicProfile = detail.talentProfile?.public || {};
    const approvedRole = bootstrap.approvedRole || state.profile?.role || '';
    const requestedRole = bootstrap.requestedRole || approvedRole || '';
    const managerLabel = cleanText(detail.person?.managerUserId || bootstrap.managerUserId, 'Manager not assigned');
    const journey = detail.onboardingJourney || {};

    if (bootstrap.status === 'review') {
      return `
        <section class='workspace-frame bootstrap-workspace'>
          <header class='workspace-header'>
            <div class='workspace-header__text'>
              <div class='section-kicker'>Pending review</div>
              <h1 class='workspace-title'>Access is waiting on role confirmation</h1>
              <p class='workspace-copy'>Your setup is saved. The platform is holding full workspace access until the role and readiness review is resolved.</p>
            </div>
          </header>
          <section class='bootstrap-panel'>
            <div class='bootstrap-panel__header'>
              <div>
                <div class='table-caption'>Current state</div>
                <h2 class='thread-title'>Review in progress</h2>
              </div>
              <span class='status-pill' data-tone='gold'>Pending manager review</span>
            </div>
            <div class='settings-split'>
              <section>
                <div class='table-caption'>Role routing</div>
                ${renderSettingsRows([
                  { label: 'Approved role', value: humanizeLabel(cleanText(approvedRole, 'Not set')) },
                  { label: 'Requested role', value: humanizeLabel(cleanText(requestedRole, approvedRole || 'Not set')) },
                  { label: 'Journey stage', value: humanizeLabel(cleanText(journey.stageKey, 'Pending review')) },
                  { label: 'Manager owner', value: managerLabel },
                ])}
              </section>
              <section>
                <div class='table-caption'>What happens next</div>
                <div class='settings-note bootstrap-note'>
                  <strong>The portal will route you automatically once review is complete.</strong>
                  <span>Managers can correct the role, update readiness, and release the correct dashboard without recreating your account.</span>
                </div>
                ${renderSettingsRows([
                  { label: 'Profile saved', value: profileBasicsComplete(detail) ? 'Complete' : 'Still incomplete' },
                  { label: 'Readiness', value: humanizeLabel(cleanText(detail.person?.readinessStatus, 'Not tracked')) },
                  { label: 'Access status', value: humanizeLabel(cleanText(detail.authIdentity?.status, 'Active')) },
                ])}
              </section>
            </div>
          </section>
        </section>
      `;
    }

    return `
      <section class='workspace-frame bootstrap-workspace'>
        <header class='workspace-header'>
          <div class='workspace-header__text'>
            <div class='section-kicker'>First-time setup</div>
            <h1 class='workspace-title'>Finish your portal profile</h1>
            <p class='workspace-copy'>This is the guided setup state. Confirm the working role, add the core profile fields, and then the app can route you into the right workspace.</p>
          </div>
        </header>
        <section class='bootstrap-panel'>
          <div class='bootstrap-panel__header'>
            <div>
              <div class='table-caption'>Activation</div>
              <h2 class='thread-title'>Complete setup before entering the workspace</h2>
            </div>
            <span class='status-pill' data-tone='accent'>Approved role ${escapeHtml(humanizeLabel(cleanText(approvedRole, 'Not set')))}</span>
          </div>
          <form id='bootstrapSetupForm' class='settings-form'>
            <div class='settings-profile-shell'>
              <div class='settings-avatar-card'>
                ${publicProfile.avatarDataUrl ? `<img class='settings-avatar' src='${escapeHtml(publicProfile.avatarDataUrl)}' alt='${escapeHtml(cleanText(publicProfile.displayName, state.profile?.fullName || 'Profile'))}' />` : `<div class='settings-avatar settings-avatar--placeholder'>${escapeHtml(cleanText(publicProfile.displayName || state.profile?.fullName || state.user?.email, 'PU').slice(0, 2).toUpperCase())}</div>`}
                <label class='field'>
                  <span class='field-label'>Profile image</span>
                  <input name='avatarFile' type='file' accept='image/png,image/jpeg' />
                </label>
              </div>
              <div class='field-stack'>
                <div class='field-grid two'>
                  <label class='field'>
                    <span class='field-label'>Display name</span>
                    <input name='displayName' value='${escapeHtml(publicProfile.displayName || state.profile?.fullName || '')}' placeholder='How your name should appear' required />
                  </label>
                  <label class='field'>
                    <span class='field-label'>Approved role</span>
                    <input value='${escapeHtml(humanizeLabel(cleanText(approvedRole, 'Not set')))}' disabled />
                  </label>
                </div>
                ${renderChoiceChipField('requestedRole', 'What role are you actually starting in?', SETTINGS_ROLE_OPTIONS, requestedRole || approvedRole || 'dialer')}
                <div class='field-grid two'>
                  <label class='field'>
                    <span class='field-label'>Home base city</span>
                    <input name='homeBaseCity' value='${escapeHtml(publicProfile.homeBaseCity || detail.person?.homeBaseCity || '')}' placeholder='Charlotte' required />
                  </label>
                  <label class='field'>
                    <span class='field-label'>Home base state</span>
                    <input name='homeBaseState' value='${escapeHtml(publicProfile.homeBaseState || detail.person?.homeBaseState || '')}' placeholder='NC' required />
                  </label>
                </div>
                <label class='field'>
                  <span class='field-label'>Short profile</span>
                  <textarea name='bio' placeholder='Short internal intro for your team profile'>${escapeHtml(publicProfile.bio || '')}</textarea>
                </label>
                <div class='field-grid two'>
                  <label class='field'>
                    <span class='field-label'>Specialties</span>
                    <input name='specialties' value='${escapeHtml(csvText(publicProfile.specialties))}' placeholder='Outreach, resident engagement, logistics' />
                  </label>
                  <label class='field'>
                    <span class='field-label'>Working tone</span>
                    <input name='tone' value='${escapeHtml(csvText(publicProfile.tone))}' placeholder='Calm, direct, upbeat' />
                  </label>
                </div>
                <label class='field'>
                  <span class='field-label'>Gear or equipment</span>
                  <input name='gear' value='${escapeHtml(csvText(publicProfile.gear))}' placeholder='Laptop, iPad, camera, branded kit' />
                </label>
              </div>
            </div>
            <div class='bootstrap-summary'>
              <div class='settings-note bootstrap-note'>
                <strong>If you choose a different role than the approved role, the portal will hold access and send that difference into manager review.</strong>
                <span>Your account stays intact. The platform just routes the mismatch into approval instead of silently putting you in the wrong dashboard.</span>
              </div>
            </div>
            <div class='section-actions'>
              <button class='primary-button' type='submit'>Finish setup</button>
            </div>
          </form>
        </section>
      </section>
    `;
  }

  function renderOptions(options, selectedValue) {
    const normalized = Array.isArray(options)
      ? options.map((option) => typeof option === 'string' ? { value: option, label: option ? humanizeLabel(option) : 'All' } : option)
      : [];
    return normalized.map((option) => {
      const value = String(option.value || '');
      const label = option.label === ''
        ? 'All'
        : String(option.label || humanizeLabel(option.value) || 'All');
      const selected = value === String(selectedValue || '') ? 'selected' : '';
      return `<option value='${escapeHtml(value)}' ${selected}>${escapeHtml(label || 'All')}</option>`;
    }).join('');
  }

  function renderSheet() {
    const sheet = state.sheet;
    refs.sheetBackdrop.hidden = !sheet;
    if (!sheet) {
      refs.sheetHost.innerHTML = '';
      return;
    }
    refs.sheetHost.innerHTML = renderSheetContent(sheet);
  }

  function renderSheetContent(sheet) {
    if (sheet.kind === 'lead') return renderLeadSheet(sheet.record);
    if (sheet.kind === 'event') return renderEventSheet(sheet.record);
    return renderTaskSheet(sheet.record);
  }

  function renderLeadSheet(record) {
    const lead = record || {};
    return `
      <section class='sheet'>
        <div class='sheet-header'>
          <div>
            <div class='section-kicker'>Client record</div>
            <h2 class='sheet-title'>${escapeHtml(lead.id ? 'Edit client' : 'Create client')}</h2>
            <p class='sheet-copy'>Fresh form composition. No inherited modal chrome.</p>
          </div>
          <button type='button' class='ghost-button' data-action='close-sheet'>Close</button>
        </div>
        <form id='sheetForm' class='sheet-form' data-sheet-kind='lead'>
          <input type='hidden' name='id' value='${escapeHtml(String(lead.id || ''))}' />
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>First name</span><input name='firstName' value='${escapeHtml(lead.first_name || '')}' /></label>
            <label class='field'><span class='field-label'>Last name</span><input name='lastName' value='${escapeHtml(lead.last_name || '')}' /></label>
          </div>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>Email</span><input name='email' value='${escapeHtml(lead.email || '')}' /></label>
            <label class='field'><span class='field-label'>Phone</span><input name='phone' value='${escapeHtml(lead.phone || '')}' /></label>
          </div>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>Company</span><input name='company' value='${escapeHtml(lead.company || '')}' /></label>
            <label class='field'><span class='field-label'>Property</span><input name='propertyName' value='${escapeHtml(lead.property_name || '')}' /></label>
          </div>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>City</span><input name='city' value='${escapeHtml(lead.city || '')}' /></label>
            <label class='field'><span class='field-label'>State</span><input name='state' value='${escapeHtml(lead.state || '')}' /></label>
          </div>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>Postal code</span><input name='postalCode' value='${escapeHtml(lead.postal_code || '')}' /></label>
            <label class='field'><span class='field-label'>Address</span><input name='address' value='${escapeHtml(lead.address || '')}' /></label>
          </div>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>Status</span><select name='status'>${renderOptions(['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'], lead.status || 'new')}</select></label>
            <label class='field'><span class='field-label'>Assigned role</span><input name='assignedRole' value='${escapeHtml(lead.assigned_role || '')}' placeholder='dialer, account_manager' /></label>
          </div>
          <label class='field'><span class='field-label'>Assigned user</span><input name='assignedUserId' value='${escapeHtml(lead.assigned_user_id || '')}' /></label>
          <label class='field'><span class='field-label'>Notes</span><textarea name='notes'>${escapeHtml(lead.notes || '')}</textarea></label>
          <div class='section-actions'>
            <button class='primary-button' type='submit'>Save client</button>
            <button class='secondary-button' type='button' data-action='close-sheet'>Cancel</button>
          </div>
        </form>
      </section>
    `;
  }

  function renderEventSheet(record) {
    const event = record || {};
    return `
      <section class='sheet'>
        <div class='sheet-header'>
          <div>
            <div class='section-kicker'>Operations editor</div>
            <h2 class='sheet-title'>${escapeHtml(event.id ? 'Edit event' : 'Create event')}</h2>
            <p class='sheet-copy'>The editing surface stays temporary so the operations table remains primary.</p>
          </div>
          <button type='button' class='ghost-button' data-action='close-sheet'>Close</button>
        </div>
        <form id='sheetForm' class='sheet-form' data-sheet-kind='event'>
          <input type='hidden' name='id' value='${escapeHtml(String(event.id || ''))}' />
          <label class='field'><span class='field-label'>Title</span><input name='title' value='${escapeHtml(event.title || '')}' required /></label>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>Status</span><select name='status'>${renderOptions(['open', 'assigned', 'in_progress', 'completed', 'cancelled'], event.status || 'open')}</select></label>
            <label class='field'><span class='field-label'>Area</span><input name='areaTag' value='${escapeHtml(event.area_tag || '')}' placeholder='dispatch, events, media' /></label>
          </div>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>Date</span><input name='eventDate' type='date' value='${escapeHtml(event.event_date || '')}' /></label>
            <label class='field'><span class='field-label'>Start time</span><input name='startTime' type='time' value='${escapeHtml(event.start_time || '')}' /></label>
          </div>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>End time</span><input name='endTime' type='time' value='${escapeHtml(event.end_time || '')}' /></label>
            <label class='field'><span class='field-label'>Event kind</span><select name='eventKind'>${renderOptions(['', 'appointment', 'delivery', 'dispatch', 'internal'], event.event_kind || '')}</select></label>
          </div>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>Assigned role</span><input name='assignedRole' value='${escapeHtml(event.assigned_role || '')}' /></label>
            <label class='field'><span class='field-label'>Assigned user</span><input name='assignedUserId' value='${escapeHtml(event.assigned_user_id || '')}' /></label>
          </div>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>Account ID</span><input name='accountId' value='${escapeHtml(String(event.account_id || ''))}' /></label>
            <label class='field'><span class='field-label'>Location ID</span><input name='locationId' value='${escapeHtml(String(event.location_id || ''))}' /></label>
          </div>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>City</span><input name='city' value='${escapeHtml(event.city || '')}' /></label>
            <label class='field'><span class='field-label'>State</span><input name='state' value='${escapeHtml(event.state || '')}' /></label>
          </div>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>Postal code</span><input name='postalCode' value='${escapeHtml(event.postal_code || '')}' /></label>
            <label class='field'><span class='field-label'>Postal code</span><input name='postalCode' value='${escapeHtml(event.postal_code || '')}' /></label>
            <label class='field'><span class='field-label'>Payout dollars</span><input name='payoutDollars' inputmode='decimal' value='${escapeHtml(formatDollarsInputFromCents(event.payout_cents))}' placeholder='250' /></label>
          </div>
          <label class='field'><span class='field-label'>Address</span><input name='address' value='${escapeHtml(event.address || '')}' /></label>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>Execution</span><select name='executionStatus'>${renderOptions(['planned', 'ready', 'in_progress', 'complete'], event.execution_status || 'planned')}</select></label>
            <label class='field'><span class='field-label'>Logistics</span><select name='logisticsStatus'>${renderOptions(['not_started', 'in_progress', 'ready', 'complete'], event.logistics_status || 'not_started')}</select></label>
          </div>
          <label class='field'><span class='field-label'>Report</span><select name='reportStatus'>${renderOptions(['not_started', 'draft', 'queued', 'pending', 'complete'], event.report_status || 'not_started')}</select></label>
          <label class='field'><span class='field-label'>Notes</span><textarea name='notes'>${escapeHtml(event.notes || '')}</textarea></label>
          <div class='section-actions'>
            <button class='primary-button' type='submit'>Save event</button>
            <button class='secondary-button' type='button' data-action='close-sheet'>Cancel</button>
          </div>
        </form>
      </section>
    `;
  }

  function renderTaskSheet(record) {
    const task = record || {};
    return `
      <section class='sheet'>
        <div class='sheet-header'>
          <div>
            <div class='section-kicker'>Task details</div>
            <h2 class='sheet-title'>${escapeHtml(task.id ? 'Update task' : 'Manual task override')}</h2>
            <p class='sheet-copy'>Most work should arrive through routing. Use this only when ownership, timing, or notes need a direct correction.</p>
          </div>
          <button type='button' class='ghost-button' data-action='close-sheet'>Close</button>
        </div>
        <form id='sheetForm' class='sheet-form' data-sheet-kind='task'>
          <input type='hidden' name='id' value='${escapeHtml(String(task.id || ''))}' />
          <label class='field'><span class='field-label'>Title</span><input name='title' value='${escapeHtml(task.title || '')}' required /></label>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>Task type</span><select name='taskType'>${renderOptions(['dispatch', 'media', 'followup', 'account', 'training', 'event', 'lead', 'admin'], task.taskType || task.task_type || 'admin')}</select></label>
            <label class='field'><span class='field-label'>Status</span><select name='status'>${renderOptions(['open', 'in_progress', 'blocked', 'completed', 'cancelled'], task.status || 'open')}</select></label>
          </div>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>Priority</span><input name='priority' type='number' value='${escapeHtml(String(task.priority ?? 0))}' /></label>
            <label class='field'><span class='field-label'>Due at</span><input name='dueAt' type='datetime-local' value='${escapeHtml(toDatetimeLocal(task.dueAt || task.due_at || ''))}' /></label>
          </div>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>Assigned user</span><input name='assignedUserId' value='${escapeHtml(task.assignedUserId || task.assigned_user_id || '')}' /></label>
            <label class='field'><span class='field-label'>Lead ID</span><input name='leadId' value='${escapeHtml(String(task.leadId || task.lead_id || ''))}' /></label>
          </div>
          <div class='field-grid two'>
            <label class='field'><span class='field-label'>Event ID</span><input name='eventId' value='${escapeHtml(String(task.eventId || task.event_id || ''))}' /></label>
            <label class='field'><span class='field-label'>Account ID</span><input name='accountId' value='${escapeHtml(String(task.accountId || task.account_id || ''))}' /></label>
          </div>
          <label class='field'><span class='field-label'>Description</span><textarea name='description'>${escapeHtml(task.description || '')}</textarea></label>
          <div class='section-actions'>
            <button class='primary-button' type='submit'>${escapeHtml(task.id ? 'Save changes' : 'Create manual task')}</button>
            <button class='secondary-button' type='button' data-action='close-sheet'>Cancel</button>
          </div>
        </form>
      </section>
    `;
  }

  function toDatetimeLocal(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const yyyy = String(date.getFullYear()).padStart(4, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
  }

  function renderToasts() {
    refs.toastStack.innerHTML = state.toasts.map((toast) => `<div class='toast is-${escapeHtml(toast.tone)}'>${escapeHtml(toast.message)}</div>`).join('');
  }

  async function onAction(action, source) {
    if (action === 'set-auth-mode') {
      state.authMode = source.dataset.mode || 'password';
      renderAuth();
      return;
    }
    if (action === 'switch-workspace') {
      if (state.bootstrap?.status && state.bootstrap.status !== 'ready') return;
      await loadWorkspace(source.dataset.workspace || 'command');
      return;
    }
    if (action === 'select-settings-tab') {
      state.settings.tab = normalizeSettingsTab(source.dataset.tab || 'account');
      render();
      return;
    }
    if (action === 'select-settings-user') {
      await loadSettingsAccessEntry(source.dataset.userId || '');
      return;
    }
    if (action === 'select-settings-review-user') {
      await loadSettingsReviewEntry(source.dataset.userId || '');
      return;
    }
    if (action === 'sort-table') {
      toggleSort(source.dataset.scope || '', source.dataset.key || '');
      render();
      return;
    }
    if (action === 'set-choice-value') {
      const form = source.closest('form');
      const name = String(source.dataset.choiceName || '').trim();
      if (!form || !name) return;
      const hidden = form.querySelector(`input[type="hidden"][name="${name}"]`);
      if (!hidden) return;
      hidden.value = String(source.dataset.value || '').trim();
      form.querySelectorAll(`[data-choice-name="${name}"]`).forEach((button) => {
        button.classList.toggle('is-active', button === source);
      });
      return;
    }
    if (action === 'set-assistant-mode') {
      const nextMode = source.dataset.mode === 'operational' ? 'operational' : 'discuss';
      const modeChanged = nextMode !== state.assistantMode;
      state.assistantMode = nextMode;
      if (modeChanged) {
        if (nextMode === 'operational' && state.assistantRequestMode === 'general') state.assistantRequestMode = 'next_move';
        if (nextMode === 'discuss' && ['next_move', 'risk_review'].includes(state.assistantRequestMode)) state.assistantRequestMode = 'general';
      }
      render();
      return;
    }
    if (action === 'seed-assistant-prompt') {
      state.assistantDraft = source.dataset.prompt || '';
      state.assistantRequestMode = source.dataset.requestMode || state.assistantRequestMode;
      state.assistantMode = source.dataset.assistantMode === 'operational' ? 'operational' : state.assistantMode;
      render();
      return;
    }
    if (action === 'apply-view') {
      const workspace = source.dataset.workspace || state.activeWorkspace;
      applyWorkspacePreset(workspace, source.dataset.view || 'all');
      await loadWorkspace(workspace, true);
      return;
    }
    if (action === 'clear-filters') {
      const workspace = source.dataset.workspace || state.activeWorkspace;
      clearWorkspaceFilters(workspace);
      await loadWorkspace(workspace, true);
      return;
    }
    if (action === 'set-filter-value') {
      const workspace = source.dataset.workspace || state.activeWorkspace;
      const key = String(source.dataset.key || '').trim();
      const value = String(source.dataset.value || '').trim();
      if (workspace === 'operations' && key) state.filters.events[key] = value;
      if (workspace === 'workforce' && key) state.filters.tasks[key] = value;
      if (workspace === 'pipeline' && key) state.filters.leads[key] = value;
      await loadWorkspace(workspace, true);
      return;
    }
    if (action === 'sign-out') {
      clearSession();
      render();
      return;
    }
    if (action === 'settings-self-reset-password') {
      await runSettingsAccessAction('reset_password', state.user?.id || '', state.user?.email || '');
      return;
    }
    if (action === 'settings-access-action') {
      await runSettingsAccessAction(source.dataset.accessAction || '', source.dataset.userId || '', source.dataset.email || '');
      return;
    }
    if (action === 'new-lead') return openSheet('lead');
    if (action === 'edit-lead') return openSheet('lead', activeLead());
    if (action === 'new-event') return openSheet('event');
    if (action === 'edit-event') return openSheet('event', activeEvent());
    if (action === 'new-task') return openSheet('task');
    if (action === 'edit-task') return openSheet('task', activeTask());
    if (action === 'close-sheet') return closeSheet();
    if (action === 'select-lead') {
      state.selections.leadId = source.dataset.id || null;
      render();
      return;
    }
    if (action === 'select-event') {
      state.selections.eventId = source.dataset.id || null;
      render();
      return;
    }
    if (action === 'select-task') {
      state.selections.taskId = source.dataset.id || null;
      render();
      return;
    }
    if (action === 'select-thread') {
      state.activeThreadId = source.dataset.id || '';
      state.messages = [];
      state.activeThread = null;
      render();
      await loadThreads({ threadId: state.activeThreadId });
      return;
    }
    if (action === 'new-thread') {
      state.activeThreadId = '';
      state.activeThread = null;
      state.messages = [];
      state.assistantDraft = '';
      render();
      return;
    }
    if (action === 'toggle-assistant-context') {
      const availableRecords = assistantContextRecords();
      if (!availableRecords.length) return;
      state.assistantContextAttached = !state.assistantContextAttached;
      if (state.assistantContextAttached) state.assistantContextSource = assistantContextSourceWorkspaceId();
      render();
      return;
    }
    if (action === 'queue-jump') {
      state.selections.queueKey = source.dataset.queue || '';
      if (source.dataset.leadId) {
        state.selections.leadId = source.dataset.leadId;
        await loadWorkspace('pipeline', true);
        return;
      }
      if (source.dataset.eventId) {
        state.selections.eventId = source.dataset.eventId;
        await loadWorkspace('operations', true);
        return;
      }
      if (source.dataset.taskId) {
        state.selections.taskId = source.dataset.taskId;
        await loadWorkspace('workforce', true);
        return;
      }
      if (source.dataset.accountId) {
        await loadWorkspace(source.dataset.workspace || 'pipeline', true);
        return;
      }
      if (source.dataset.userId || source.dataset.journeyId || source.dataset.submissionId) {
        await loadWorkspace(source.dataset.workspace || 'workforce', true);
        return;
      }
      if (source.dataset.workflowEventId || source.dataset.notificationId) {
        await loadWorkspace(source.dataset.workspace || 'command', true);
        return;
      }
      if (source.dataset.workspace) {
        await loadWorkspace(source.dataset.workspace, true);
        return;
      }
      await loadWorkspace('command', true);
      return;
    }
    if (action === 'open-assistant-from-selection') {
      state.assistantContextAttached = true;
      state.assistantContextSource = state.activeWorkspace;
      await loadWorkspace('assistant');
    }
  }

  function bindEvents() {
    document.addEventListener('click', async (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      event.preventDefault();
      await onAction(target.dataset.action, target);
    });

    document.addEventListener('submit', async (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      event.preventDefault();

      try {
        if (form.id === 'loginForm') return await handleLogin(form);
        if (form.id === 'leadFilters') {
          const data = new FormData(form);
          state.filters.leads.q = String(data.get('q') || '').trim();
          state.filters.leads.status = String(data.get('status') || '').trim();
          return await loadLeads(true);
        }
        if (form.id === 'eventFilters') {
          const data = new FormData(form);
          state.filters.events.status = String(data.get('status') || '').trim();
          state.filters.events.areaTag = String(data.get('areaTag') || '').trim();
          return await loadEvents(true);
        }
        if (form.id === 'taskFilters') {
          const data = new FormData(form);
          state.filters.tasks.q = String(data.get('q') || '').trim();
          state.filters.tasks.status = String(data.get('status') || '').trim();
          state.filters.tasks.mine = String(data.get('mine') || '').trim();
          return await loadTasks(true);
        }
        if (form.id === 'adminSettingsForm') return await saveAdminSettings(form);
        if (form.id === 'accessProvisionForm') return await provisionSettingsAccess(form);
        if (form.id === 'bootstrapSetupForm') return await saveBootstrapSetup(form);
        if (form.id === 'settingsProfileForm') return await saveSettingsProfile(form);
        if (form.id === 'settingsReviewForm') return await saveSettingsReview(form, event.submitter);
        if (form.id === 'sheetForm') {
          const kind = form.dataset.sheetKind;
          if (kind === 'lead') return await saveLead(form);
          if (kind === 'event') return await saveEvent(form);
          if (kind === 'task') return await saveTask(form);
        }
        if (form.id === 'assistantComposer') return await handleAssistantMessage(form);
      } catch (error) {
        queueToast(humanizeError(error), 'danger');
      }
    });

    document.addEventListener('contextmenu', async (event) => {
      const trigger = event.target.closest('.thread-item[data-id]');
      if (!(trigger instanceof HTMLElement)) return;
      event.preventDefault();
      const threadId = String(trigger.dataset.id || '').trim();
      const current = state.threads.find((thread) => String(thread.id) === threadId) || null;
      if (!threadId || !current) return;
      const nextTitle = window.prompt('Rename chat', threadDisplayTitle(current));
      if (nextTitle == null) return;
      const compact = String(nextTitle).trim();
      if (!compact || compact === threadDisplayTitle(current)) return;
      try {
        await renameThread(threadId, compact);
        queueToast('Chat renamed');
      } catch (error) {
        queueToast(humanizeError(error), 'danger');
      }
    });

  }

  async function boot() {
    refs.authScreen = document.getElementById('authScreen');
    refs.appScreen = document.getElementById('appScreen');
    refs.workspaceNav = document.getElementById('workspaceNav');
    refs.workspaceStage = document.getElementById('workspaceStage');
    refs.sheetBackdrop = document.getElementById('sheetBackdrop');
    refs.sheetHost = document.getElementById('sheetHost');
    refs.toastStack = document.getElementById('toastStack');
    refs.userChip = document.getElementById('userChip');
    refs.shellTitle = document.getElementById('shellTitle');
    refs.shellMeta = document.getElementById('shellMeta');

    bindEvents();
    render();

    await loadAuthConfig();
    restoreSession();

    if (state.session?.access_token) {
      try {
        await hydrateSession();
        await loadWorkspace('command', true);
      } catch {
        clearSession();
      }
    }

    state.booting = false;
    render();
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
