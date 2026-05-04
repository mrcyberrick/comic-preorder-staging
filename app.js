// ================================================================
// Comic Pre-Order System — Shared App Logic
// ================================================================
// IMPORTANT: Credentials are loaded from config.js
// See config.js — do not add credentials here
// ================================================================

// ── Supabase Client (CDN version, no npm needed) ─────────────
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================================
// TenantContext — resolves the active tenant for the current page load.
//
// Resolution order (highest priority first):
//   1. Authenticated user's user_profiles.tenant_id
//   2. ?t=<slug> query parameter (persisted to sessionStorage for the tab)
//   3. Founding tenant fallback (raysandjudys)
//
// Phase 3.1: read-only — does not affect writes. Phase 3.2 will make
// app.js writes pass tenant_id explicitly using TenantContext.current().
//
// The slug→id mapping for unauthenticated lookup is hardcoded here
// because the tenants table is not readable by anon. Replaced with
// an RPC in a later sub-deploy once a second tenant exists.
// ============================================================================

const FOUNDING_TENANT = {
  id: '72e29f67-39f7-42bc-a4d5-d6f992f9d790',
  slug: 'raysandjudys',
  display_name: "Ray & Judy's Book Stop",
};

const TENANT_SLUG_MAP = {
  // slug → { id, slug, display_name }
  raysandjudys: FOUNDING_TENANT,
};

const TenantContext = {
  _current: null,
  _source: null,

  async resolve() {
    if (this._current) return this._current;

    // 1. Check for an authenticated session and try the profile route first
    try {
      const { data: { session } } = await db.auth.getSession();
      if (session?.user?.id) {
        const { data: profile } = await db
          .from('user_profiles')
          .select('tenant_id')
          .eq('id', session.user.id)
          .single();

        if (profile?.tenant_id) {
          const { data: tenant } = await db
            .from('tenants')
            .select('id, slug, display_name')
            .eq('id', profile.tenant_id)
            .single();

          if (tenant) {
            this._current = tenant;
            this._source = 'profile';
            return this._current;
          }
        }
      }
    } catch (err) {
      console.warn('TenantContext: profile lookup failed, falling back', err);
    }

    // 2. Check ?t= query parameter (and persist to sessionStorage)
    try {
      const params = new URLSearchParams(window.location.search);
      const fromQuery = params.get('t');
      if (fromQuery) {
        const tenant = TENANT_SLUG_MAP[fromQuery];
        if (tenant) {
          sessionStorage.setItem('pulllist.tenant_slug', fromQuery);
          this._current = tenant;
          this._source = 'query';
          return this._current;
        }
        // Unknown slug — log and fall through
        console.warn('TenantContext: unknown tenant slug in ?t=', fromQuery);
      }

      // 3. Check sessionStorage (carries query-resolved tenant across nav)
      const fromStorage = sessionStorage.getItem('pulllist.tenant_slug');
      if (fromStorage && TENANT_SLUG_MAP[fromStorage]) {
        this._current = TENANT_SLUG_MAP[fromStorage];
        this._source = 'session';
        return this._current;
      }
    } catch (err) {
      console.warn('TenantContext: query/session lookup failed', err);
    }

    // 4. Default fallback — founding tenant
    this._current = FOUNDING_TENANT;
    this._source = 'default';
    return this._current;
  },

  current() {
    if (!this._current) {
      throw new Error('TenantContext.current() called before resolve()');
    }
    return this._current;
  },

  source() {
    return this._source;
  },

  _reset() {
    this._current = null;
    this._source = null;
  },
};

// Expose on window for debugging and for HTML pages to await
window.TenantContext = TenantContext;

// ── Auth Helpers ─────────────────────────────────────────────
const Auth = {
  async getSession() {
    const { data: { session } } = await db.auth.getSession();
    return session;
  },

  async getUser() {
    const session = await this.getSession();
    return session?.user || null;
  },

  async getProfile(userId) {
    const { data } = await db
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single();
    return data;
  },

  async requireAuth(redirectTo = 'index.html') {
    const user = await this.getUser();
    if (!user) {
      window.location.href = redirectTo;
      return null;
    }
    return user;
  },

  async requireAdmin(redirectTo = 'catalog.html') {
    const user = await this.requireAuth();
    if (!user) return null;
    const profile = await this.getProfile(user.id);
    if (!profile?.is_admin) {
      window.location.href = redirectTo;
      return null;
    }
    return { user, profile };
  },

  async signIn(email, password) {
    const result = await db.auth.signInWithPassword({ email, password });
    // Log login event after successful sign-in (non-blocking)
    if (result.data?.user) UsageEvents.login(result.data.user.id);
    return result;
  },

  async signOut() {
    // Log logout before session is destroyed so user_id is still available
    const user = await this.getUser();
    if (user) UsageEvents.logout(user.id);
    await db.auth.signOut();
    window.location.href = 'index.html';
  },
};

// ── Nav Initialization ────────────────────────────────────────
async function initNav() {
  const nav = document.getElementById('main-nav');
  if (!nav) return;

  const user = await Auth.getUser();
  if (!user) {
    window.location.href = 'index.html';
    return;
  }

  const profile = await Auth.getProfile(user.id);
  const nameEl  = nav.querySelector('#nav-username');
  if (nameEl) nameEl.textContent = profile?.full_name || user.email;

  // Show admin link if admin
  const adminLink = nav.querySelector('#nav-admin');
  if (adminLink && profile?.is_admin) {
    adminLink.style.display = 'block';
  }

  // Mark current page active
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  nav.querySelectorAll('.nav-links a').forEach(a => {
    if (a.getAttribute('href') === currentPage) a.classList.add('active');
  });

  // Logout button
  const logoutBtn = nav.querySelector('#btn-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', () => {
    AdminContext.clear(); // clear impersonation on sign out
    Auth.signOut();
  });

  // Restore admin banner on every page load if context is active
  if (profile?.is_admin) AdminContext.restore();

  // Load upcoming items notification bubble
  // Runs async — does not block page load
  NavBubble.load(AdminContext.resolveUserId(user.id));

  // ── Hamburger toggle ──────────────────────────────────
  const hamburger = nav.querySelector('#nav-hamburger');
  const navLinks  = nav.querySelector('.nav-links');
  const navUser   = nav.querySelector('.nav-user');
  if (hamburger) {
    hamburger.addEventListener('click', () => {
      hamburger.classList.toggle('open');
      navLinks.classList.toggle('open');
      navUser.classList.toggle('open');
    });
    // Close menu when a link is clicked
    navLinks.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        hamburger.classList.remove('open');
        navLinks.classList.remove('open');
        navUser.classList.remove('open');
      });
    });
  }

  return { user, profile };
}

// ── Nav Notification Bubble ───────────────────────────────────
// Shows a red badge on the This Week nav link when the active user
// has reserved items with an on_sale_date in the next 7 days.
// Reflects the managed customer when admin context is active.
const NavBubble = {
  async load(userId) {
    try {
      const today = new Date();
      const in7   = new Date(today);
      in7.setDate(today.getDate() + 7);

      const todayStr = today.toISOString().split('T')[0];
      const in7Str   = in7.toISOString().split('T')[0];

      const { data, error } = await db
        .from('preorders')
        .select('id, catalog!inner(on_sale_date)')
        .eq('user_id', userId)
        .gte('catalog.on_sale_date', todayStr)
        .lte('catalog.on_sale_date', in7Str);

      if (error || !data) return;

      this.render(data.length);
    } catch (e) {
      // Bubble is non-critical — fail silently
    }
  },

  render(count) {
    document.querySelectorAll('.nav-bubble').forEach(b => b.remove());
    if (count < 1) return;

    const arrivalsLink = document.querySelector('.nav-links a[href="arrivals.html"]');
    if (!arrivalsLink) return;

    const li = arrivalsLink.parentElement;
    li.style.position = 'relative';
    li.style.display  = 'flex';
    li.style.alignItems = 'center';

    const bubble = document.createElement('span');
    bubble.className = 'nav-bubble';
    bubble.textContent = count > 99 ? '99+' : String(count);
    bubble.title = `${count} reserved item${count !== 1 ? 's' : ''} arriving this week`;
    bubble.style.cssText = [
      'display:inline-flex;align-items:center;justify-content:center;',
      'background:#e74c3c;color:white;',
      'font-size:0.62rem;font-weight:700;',
      'min-width:16px;height:16px;',
      'border-radius:8px;padding:0 4px;',
      'pointer-events:none;line-height:1;',
      'box-shadow:0 1px 4px rgba(0,0,0,0.4);',
      'letter-spacing:0;',
      'flex-shrink:0;',
    ].join('');

    // Append bubble after the <a> tag inside the <li>
    li.appendChild(bubble);
  },

  // Call this when admin context changes to refresh the bubble
  async refresh(userId) {
    document.querySelectorAll('.nav-bubble').forEach(b => b.remove());
    await this.load(userId);
  },
};

// ── Catalog API ───────────────────────────────────────────────
const Catalog = {
  async getLatestMonth() {
    const { data } = await db
      .from('catalog')
      .select('catalog_month')
      .order('catalog_month', { ascending: false })
      .limit(1)
      .single();
    return data?.catalog_month || null;
  },

  async fetch({ month, distributor, publisher, search, hideVariants = false, page = 1, pageSize = 48 }) {
    let query = db.from('catalog').select('*', { count: 'exact' });

    if (month)       query = query.eq('catalog_month', month);
    if (distributor) query = query.eq('distributor', distributor);
    if (publisher)   query = query.eq('publisher', publisher);
    if (search) {
      // item_code included so Lunar codes are searchable everywhere Catalog.fetch() is used,
      // including the Paper Orders typeahead in admin.html.
      query = query.or(
        `title.ilike.%${search}%,series_name.ilike.%${search}%,writer.ilike.%${search}%,publisher.ilike.%${search}%,upc.ilike.%${search}%,isbn.ilike.%${search}%,item_code.ilike.%${search}%`
      );
    }
    // Standard covers only: variant_type IS NULL, 'Standard' (Lunar), or 'Primary Title' (PRH)
    if (hideVariants) {
      query = query.or('variant_type.is.null,variant_type.eq.Standard,variant_type.eq.Primary Title');
    }

    const from = (page - 1) * pageSize;
    query = query
      .order('publisher', { ascending: true })
      .order('series_name', { ascending: true })
      .order('title', { ascending: true })
      .range(from, from + pageSize - 1);

    const { data, error, count } = await query;
    return { items: data || [], error, total: count || 0 };
  },

  async getPublishers(month) {
    // Fetch in two batches to get all publishers across both distributors
    // Supabase default page limit is 1000, catalog has ~1900 rows
    const [batch1, batch2] = await Promise.all([
      db.from('catalog').select('publisher').eq('catalog_month', month)
        .not('publisher', 'is', null).order('publisher').range(0, 999),
      db.from('catalog').select('publisher').eq('catalog_month', month)
        .not('publisher', 'is', null).order('publisher').range(1000, 1999),
    ]);
    const allRows = [...(batch1.data || []), ...(batch2.data || [])];
    const seen = new Set();
    return allRows
      .map(r => r.publisher?.trim())
      .filter(p => {
        if (!p || seen.has(p)) return false;
        seen.add(p);
        return true;
      })
      .sort((a, b) => a.localeCompare(b));
  },
};

// ── Admin Impersonation State ────────────────────────────────
// Persisted in sessionStorage so it survives page navigation
// but clears automatically when the browser tab is closed.
const AdminContext = {
  get activeUserId()   { return sessionStorage.getItem('admin_ctx_id')   || null; },
  get activeUserName() { return sessionStorage.getItem('admin_ctx_name') || null; },

  set(userId, userName) {
    sessionStorage.setItem('admin_ctx_id',   userId);
    sessionStorage.setItem('admin_ctx_name', userName);
    this.updateBanner();
  },

  clear() {
    sessionStorage.removeItem('admin_ctx_id');
    sessionStorage.removeItem('admin_ctx_name');
    this.updateBanner();
  },

  isActive() { return !!this.activeUserId; },

  resolveUserId(ownUserId) {
    return this.activeUserId || ownUserId;
  },

  // Call this on every page load to restore banner if context is active
  restore() {
    if (this.isActive()) this.updateBanner();
  },

  updateBanner() {
    let banner = document.getElementById('admin-impersonation-banner');
    if (this.activeUserId) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'admin-impersonation-banner';
        banner.style.cssText = [
          'position:fixed;top:60px;left:0;right:0;z-index:90;',
          'background:var(--accent);color:white;',
          'padding:8px 24px;font-size:0.82rem;font-weight:600;',
          'display:flex;align-items:center;justify-content:space-between;',
          'letter-spacing:0.03em;box-shadow:0 2px 12px rgba(0,0,0,0.4);'
        ].join('');
        document.body.appendChild(banner);
      }
      const name   = escapeHtml(AdminContext.activeUserName);
      const userId = AdminContext.activeUserId;
      banner.innerHTML =
        '<span style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
          '&#9888; Managing pull list for: <strong>' + name + '</strong>' +
          '<button id="banner-copy-uuid-btn" title="Copy UUID to clipboard — use this when merging into a real account" style="' +
            'background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.35);' +
            'color:white;padding:2px 8px;border-radius:3px;cursor:pointer;' +
            'font-size:0.7rem;font-weight:400;letter-spacing:0.02em;font-family:monospace;' +
            'white-space:nowrap' +
          '">' + userId.slice(0, 8) + '… Copy UUID</button>' +
        '</span>' +
        '<button id="banner-exit-btn" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);color:white;padding:3px 10px;border-radius:3px;cursor:pointer;font-size:0.78rem">' +
        '&#x2715; Back to my account</button>';
      document.getElementById('banner-exit-btn').addEventListener('click', () => {
        AdminContext.clear();
        const sel = document.getElementById('admin-user-select');
        if (sel) sel.value = '';
        window.location.reload();
      });
      document.getElementById('banner-copy-uuid-btn').addEventListener('click', async () => {
        const copyBtn = document.getElementById('banner-copy-uuid-btn');
        try {
          await navigator.clipboard.writeText(userId);
          copyBtn.textContent = '✓ Copied';
          setTimeout(() => { if (copyBtn) copyBtn.textContent = userId.slice(0, 8) + '… Copy UUID'; }, 2000);
        } catch {
          // Fallback for non-HTTPS or permission denied
          const ta = document.createElement('textarea');
          ta.value = userId;
          ta.style.position = 'fixed';
          ta.style.opacity  = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          copyBtn.textContent = '✓ Copied';
          setTimeout(() => { if (copyBtn) copyBtn.textContent = userId.slice(0, 8) + '… Copy UUID'; }, 2000);
        }
      });
    } else if (banner) {
      banner.remove();
    }
  }
};

// ── App Settings API ─────────────────────────────────────────
const Settings = {
  async get(key) {
    const { data } = await db
      .from('app_settings')
      .select('value')
      .eq('key', key)
      .single();
    return data?.value ?? null;
  },

  async set(key, value) {
    const { error } = await db
      .from('app_settings')
      .upsert({
        key,
        value,
        updated_at: new Date().toISOString(),
        tenant_id: TenantContext.current().id,
      });
    return { error };
  },

  async isMaintenanceMode() {
    const val = await this.get('maintenance_mode');
    return val === 'true';
  },

  async setMaintenanceMode(on) {
    return await this.set('maintenance_mode', on ? 'true' : 'false');
  },

  // Order deadline — admin-set date string ('YYYY-MM-DD') or null if unset.
  // The catalog banner reads this and hides itself once the date has passed.
  async getOrderDeadline() {
    const val = await this.get('order_deadline');
    return val || null; // empty string treated as unset
  },

  async setOrderDeadline(dateStr) {
    return await this.set('order_deadline', dateStr || '');
  },
};

// ── Usage Analytics ───────────────────────────────────────────
// Fire-and-forget event logger. Never blocks UI — errors are silent.
// Admin actions and impersonated sessions are not logged to keep
// data clean (events should reflect real customer behaviour only).
const UsageEvents = {
  // Internal: insert one row. Returns immediately — caller does not await.
  _log(userId, eventType, metadata = {}) {
    if (!userId) return;
    // Do not log events triggered while admin is impersonating a customer
    if (AdminContext.isActive()) return;

    // Resolve tenant_id defensively — UsageEvents may be called before
    // TenantContext.resolve() completes (it's fire-and-forget from anywhere).
    // Fall back to the founding tenant constant if TenantContext isn't ready.
    // The DB column default is the final safety net.
    let tenantId;
    try {
      tenantId = TenantContext.current().id;
    } catch {
      tenantId = FOUNDING_TENANT.id;
    }

    db.from('usage_events')
      .insert({ user_id: userId, event_type: eventType, metadata, tenant_id: tenantId })
      .then(() => {})
      .catch(() => {});
  },

  // Public helpers — call these from page scripts
  reserve(userId, catalogItem) {
    this._log(userId, 'reserve', {
      title:         catalogItem?.title        || null,
      publisher:     catalogItem?.publisher    || null,
      series_name:   catalogItem?.series_name  || null,
      distributor:   catalogItem?.distributor  || null,
      catalog_month: catalogItem?.catalog_month || null,
      price_usd:     catalogItem?.price_usd    || null,
    });
  },

  cancel(userId, catalogItem) {
    this._log(userId, 'cancel', {
      title:         catalogItem?.title        || null,
      publisher:     catalogItem?.publisher    || null,
      series_name:   catalogItem?.series_name  || null,
      distributor:   catalogItem?.distributor  || null,
      catalog_month: catalogItem?.catalog_month || null,
    });
  },

  subscribe(userId, seriesName, distributor) {
    this._log(userId, 'subscribe', { series_name: seriesName, distributor });
  },

  unsubscribe(userId, seriesName, distributor) {
    this._log(userId, 'unsubscribe', { series_name: seriesName, distributor });
  },

  catalogView(userId, { catalogMonth, page, search, publisher, distributor } = {}) {
    this._log(userId, 'catalog_view', {
      catalog_month: catalogMonth || null,
      page:          page         || 1,
      search:        search       || null,
      publisher:     publisher    || null,
      distributor:   distributor  || null,
    });
  },

  pageView(userId, page, metadata = {}) {
    // page: 'mylist' | 'arrivals' | 'subscriptions'
    this._log(userId, 'page_view', { page, ...metadata });
  },

  login(userId) {
    // Logged immediately after successful sign-in, before redirect
    this._log(userId, 'login');
  },

  logout(userId) {
    this._log(userId, 'logout');
  },
};

// Check maintenance mode — redirect non-admins to a holding page
async function checkMaintenanceMode(isAdmin) {
  if (isAdmin) return; // admins always get through
  const maint = await Settings.isMaintenanceMode();
  if (maint) {
    document.body.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
                  background:var(--bg);font-family:var(--font-body);">
        <div style="text-align:center;padding:40px;max-width:420px">
          <div style="font-family:var(--font-display);font-size:3rem;
                      letter-spacing:0.05em;margin-bottom:8px">
            PULL<span style="color:var(--accent)">LIST</span>
          </div>
          <div style="font-size:1.6rem;font-weight:600;margin:24px 0 12px;
                      color:var(--text-primary)">Catalog Update In Progress</div>
          <p style="color:var(--text-secondary);line-height:1.7;margin-bottom:28px">
            We're updating the monthly catalog right now.<br>
            The site will be back shortly — please check again in a few minutes.
          </p>
          <div style="font-size:0.78rem;color:var(--text-muted)">
            Questions? Contact the shop directly.
          </div>
        </div>
      </div>`;
    throw new Error('maintenance'); // stop page init
  }
}

// ── Pre-order API ─────────────────────────────────────────────
const Preorders = {
  async getMyIds(userId) {
    const { data } = await db
      .from('preorders')
      .select('catalog_id, quantity')
      .eq('user_id', userId);
    // Returns Map of catalogId -> quantity
    const map = new Map();
    (data || []).forEach(r => map.set(r.catalog_id, r.quantity || 1));
    return map;
  },

  async getMy(userId) {
    const { data, error } = await db
      .from('preorders')
      .select(`
        id,
        created_at,
        quantity,
        notes,
        fulfilled,
        fulfilled_at,
        catalog (
          id, distributor, item_code, title, series_name, publisher,
          issue_number, format, price_usd, foc_date, on_sale_date,
          writer, artist, cover_url, variant_type, catalog_month
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    return { items: data || [], error };
  },

  async reserve(userId, catalogId, quantity = 1) {
    const { data, error } = await db
      .from('preorders')
      .insert({
        user_id: userId,
        catalog_id: catalogId,
        quantity,
        tenant_id: TenantContext.current().id,
      })
      .select()
      .single();
    return { data, error };
  },

  async updateQuantity(userId, catalogId, quantity) {
    const { error } = await db
      .from('preorders')
      .update({ quantity })
      .eq('user_id', userId)
      .eq('catalog_id', catalogId);
    return { error };
  },

  async cancel(userId, catalogId) {
    const { error } = await db
      .from('preorders')
      .delete()
      .eq('user_id', userId)
      .eq('catalog_id', catalogId);
    return { error };
  },

  // Mark a single preorder as fulfilled/unfulfilled (admin only).
  async setFulfilled(preorderId, fulfilled) {
    const { error } = await db
      .from('preorders')
      .update({
        fulfilled,
        fulfilled_at: fulfilled ? new Date().toISOString() : null,
      })
      .eq('id', preorderId);
    return { error };
  },

  // Mark ALL preorders for a catalog item as fulfilled/unfulfilled (admin batch).
  // Used when an entire title arrives — marks every customer's copy at once.
  async setFulfilledByCatalogId(catalogId, fulfilled) {
    const { error } = await db
      .from('preorders')
      .update({
        fulfilled,
        fulfilled_at: fulfilled ? new Date().toISOString() : null,
      })
      .eq('catalog_id', catalogId);
    return { error };
  },

  // Admin only
  async getAll() {
    const { data, error } = await db
      .from('preorders')
      .select(`
        id,
        created_at,
        user_id,
        fulfilled,
        fulfilled_at,
        user_profiles ( full_name ),
        auth_users:user_id ( email ),
        catalog (
          id, distributor, item_code, title, series_name, publisher,
          issue_number, format, price_usd, foc_date, on_sale_date,
          writer, artist, cover_url
        )
      `)
      .order('created_at', { ascending: false });
    return { items: data || [], error };
  },
};

// ── Subscriptions ─────────────────────────────────────────────
const Subscriptions = {
  // Get all subscriptions for a user
  async getAll(userId) {
    const { data, error } = await db
      .from('subscriptions')
      .select('id, series_name, distributor, format, created_at')
      .eq('user_id', userId)
      .order('series_name', { ascending: true });
    return { items: data || [], error };
  },

  // Check if user is subscribed to a specific series
  async isSubscribed(userId, seriesName, distributor) {
    const { data } = await db
      .from('subscriptions')
      .select('id')
      .eq('user_id', userId)
      .eq('series_name', seriesName)
      .eq('distributor', distributor)
      .maybeSingle();
    return !!data;
  },

  // Subscribe to a series
  // format: the catalog format string (e.g. 'Comic Book', 'Trade Paperback').
  // Pass null for legacy/popular-series subscriptions — the import script
  // will default to comic-only matching via isComicFormat().
  async subscribe(userId, seriesName, distributor, format = null) {
    const { data, error } = await db
      .from('subscriptions')
      .insert({
        user_id: userId,
        series_name: seriesName,
        distributor,
        format,
        tenant_id: TenantContext.current().id,
      })
      .select()
      .single();
    if (!error) UsageEvents.subscribe(userId, seriesName, distributor);
    return { data, error };
  },

  // Unsubscribe from a series
  async unsubscribe(userId, seriesName, distributor) {
    const { error } = await db
      .from('subscriptions')
      .delete()
      .eq('user_id', userId)
      .eq('series_name', seriesName)
      .eq('distributor', distributor);
    if (!error) UsageEvents.unsubscribe(userId, seriesName, distributor);
    return { error };
  },

  // Admin: get all subscriptions across all users
  async getAllAdmin() {
    const { data, error } = await db
      .from('subscriptions')
      .select('id, series_name, distributor, format, created_at, user_profiles ( full_name )')
      .order('series_name', { ascending: true });
    return { items: data || [], error };
  },
};

// ── My List Email ─────────────────────────────────────────────
// Sends the customer a confirmation email of their current pull list.
// Called from mylist.html — requires the user's active session token
// so the Edge Function can verify the request is authenticated.
const MyList = {
  async sendConfirmation(userId, sessionToken) {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-my-list`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${sessionToken}`,
        'apikey':        SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ user_id: userId }),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) return { error: result.error || `HTTP ${resp.status}` };
    return { data: result };
  },
};

// ── Recommendations ───────────────────────────────────────────

// ── Users (Admin) ─────────────────────────────────
// Requires admin RLS. Methods use anon-key session allowed by
// the "admins update all profiles" policy added in staging-setup.sql.
const Users = {
  // All pending (self-registered, awaiting approval) accounts
  async getPending() {
    const { data, error } = await db
      .from('user_profiles')
      .select('id, full_name, email, status, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    return { items: data || [], error };
  },

  // Approve: calls approve-customer edge function (status update + email)
  async approve(userId, sessionToken) {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/approve-customer`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${sessionToken}`,
        'apikey':        SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ user_id: userId }),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) return { error: result.error || `HTTP ${resp.status}` };
    return { data: result };
  },

  // Suspend an account (pending or active)
  async suspend(userId) {
    const { error } = await db
      .from('user_profiles')
      .update({ status: 'suspended' })
      .eq('id', userId);
    return { error };
  },

  // Remove profile row — auth user remains but loses all access
  async deleteProfile(userId) {
    const { error } = await db
      .from('user_profiles')
      .delete()
      .eq('id', userId);
    return { error };
  },
};

// ── Paper Customers (Admin) ───────────────────────────────────
// Paper customers are admin-managed accounts for walk-in/phone customers
// whose orders are placed on their behalf. They use placeholder emails
// (@paper.pulllist.local) that are never delivered, and never log in.
//
// Requires:
//   1. ALTER TABLE user_profiles ADD COLUMN is_paper boolean DEFAULT false;
//   2. A "create-paper-customer" Supabase Edge Function (service role)
//      that accepts { name, email }, creates the auth user, inserts the
//      profile with is_paper=true, and returns { user_id, email }.
//      It must NOT send any email.
//   3. A "claim_paper_account(paper_user_id, real_user_id)" SQL RPC
//      that reassigns all preorders/subscriptions and deletes the paper user.
//   4. The notify-customers Edge Function must skip emails ending in
//      '@paper.pulllist.local'.
const PaperCustomers = {
  // Generate a unique placeholder email from a display name.
  // The timestamp suffix prevents collisions between customers with the same name.
  generateEmail(fullName) {
    const slug = fullName.toLowerCase()
      .replace(/[^a-z0-9]/g, '.')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '');
    const ts = Date.now().toString(36);
    return `${slug}.${ts}@paper.pulllist.local`;
  },

  // Create a paper customer — calls the create-paper-customer Edge Function.
  // The edge function uses the service role key to create the auth user,
  // so it bypasses RLS. Returns { data: { user_id, email } } or { error }.
  async create(name, sessionToken) {
    const email = this.generateEmail(name);
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/create-paper-customer`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${sessionToken}`,
        'apikey':        SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ name, email }),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) return { error: result.error || `HTTP ${resp.status}` };
    return { data: result }; // { user_id, email }
  },

  // List all paper customers, sorted by name.
  async list() {
    const { data, error } = await db
      .from('user_profiles')
      .select('id, full_name, created_at')
      .eq('is_paper', true)
      .order('full_name', { ascending: true });
    return { items: data || [], error };
  },

  // Merge a paper account's preorder history into a real (self-registered) account,
  // then delete the paper account. Calls the claim-paper-customer Edge Function
  // (service role required — anon key cannot DELETE from auth.users directly).
  async claim(paperUserId, realUserId, sessionToken) {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/claim-paper-customer`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${sessionToken}`,
        'apikey':        SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ paper_user_id: paperUserId, real_user_id: realUserId }),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) return { error: { message: result.error || `HTTP ${resp.status}` } };
    return { data: result };
  },
};

const Recommendations = {

  // Returns a Set of "series_name||distributor" keys the user has ever reserved.
  // Unions reservation_history (past months, archived) with current live preorders.
  // Both tables are accessible via RLS using the user's own session.
  async _getUserSignal(userId) {
    const [histRes, preorderRes] = await Promise.all([
      db.from('reservation_history')
        .select('series_name, distributor')
        .eq('user_id', userId)
        .not('series_name', 'is', null),
      db.from('preorders')
        .select('catalog(series_name, distributor)')
        .eq('user_id', userId),
    ]);

    const signal = new Set();
    (histRes.data || []).forEach(r => {
      if (r.series_name) signal.add(`${r.series_name}||${r.distributor}`);
    });
    (preorderRes.data || []).forEach(r => {
      const c = r.catalog;
      if (c?.series_name) signal.add(`${c.series_name}||${c.distributor}`);
    });
    return signal; // Set<"series_name||distributor">
  },

  // Returns [{series_name, distributor, reservation_count}] sorted by popularity
  // descending. Uses a SECURITY DEFINER SQL function so the anon-key client can
  // see aggregate counts without RLS exposing individual users' preorder rows.
  async _getPopularSeries(month) {
    const { data } = await db.rpc('get_popular_series', { p_catalog_month: month });
    return data || [];
  },

  // Returns { ids: string[], hasPersonal: boolean }
  //   ids         — catalog IDs for the current month, ordered by relevance:
  //                 Tier 1 (personalized): series the user has reserved before
  //                 Tier 2 (popular):      most-reserved series by all customers
  //   hasPersonal — true if the user had any historical signal (used for UI label)
  //
  // Items with no series affiliation are omitted; the view stays focused on
  // content the customer is likely to care about.
  async getCatalogIds(userId, month) {
    const [userSignal, popularSeries] = await Promise.all([
      this._getUserSignal(userId),
      this._getPopularSeries(month),
    ]);

    // Fetch id + series + variant_type for the full catalog month.
    // variant_type is included so the caller can filter standard covers BEFORE
    // paginating — filtering after slicing causes short pages and empty grid cells.
    const countRes = await db
      .from('catalog')
      .select('*', { count: 'exact', head: true })
      .eq('catalog_month', month)
      .not('series_name', 'is', null);
    const total = countRes.count ?? 0;

    if (!total) return { items: [], hasPersonal: false };

    const [b1, b2] = await Promise.all([
      db.from('catalog')
        .select('id, series_name, distributor, variant_type')
        .eq('catalog_month', month)
        .not('series_name', 'is', null)
        .range(0, 999),
      total > 1000
        ? db.from('catalog')
            .select('id, series_name, distributor, variant_type')
            .eq('catalog_month', month)
            .not('series_name', 'is', null)
            .range(1000, 1999)
        : Promise.resolve({ data: [] }),
    ]);
    const seriesRows = [...(b1.data || []), ...(b2.data || [])];

    // Build series key → [{id, variant_type}] lookup
    const byKey = new Map();
    for (const row of seriesRows) {
      const key = `${row.series_name}||${row.distributor}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ id: row.id, variant_type: row.variant_type });
    }

    const seen         = new Set();
    const personalItems = [];
    const popularItems  = [];

    // Tier 1: items from series the user has reserved before
    for (const key of userSignal) {
      for (const item of (byKey.get(key) || [])) {
        if (!seen.has(item.id)) { personalItems.push(item); seen.add(item.id); }
      }
    }

    // Tier 2: items from the most-reserved series (SQL returns them pre-sorted)
    for (const series of popularSeries) {
      const key = `${series.series_name}||${series.distributor}`;
      for (const item of (byKey.get(key) || [])) {
        if (!seen.has(item.id)) { popularItems.push(item); seen.add(item.id); }
      }
    }

    return {
      items: [...personalItems, ...popularItems], // each: { id, variant_type }
      hasPersonal: userSignal.size > 0,
    };
  },
};

// ── Welcome Modal ─────────────────────────────────────────────
// Shown once to new users on their first visit after account creation.
// Requires has_seen_welcome boolean column on user_profiles (DEFAULT false).
// Not shown to admins or users who have already seen it.
//
// Uses a dual guard:
//   1. localStorage key — instant, reliable on the same device/browser
//   2. DB flag (has_seen_welcome) — persists across devices
// localStorage is checked first so the modal never reappears even if the
// DB write is slow or the profile was fetched before the write committed.
const WelcomeModal = {
  _localKey(userId) { return `pulllist_welcome_seen_${userId}`; },

  async show(userId, profile) {
    if (profile?.is_admin) return;
    if (profile?.has_seen_welcome) return;
    if (localStorage.getItem(this._localKey(userId))) return;

    const overlay = document.createElement('div');
    overlay.id = 'welcome-modal-overlay';
    overlay.className = 'welcome-modal-overlay';
    overlay.innerHTML = `
      <div class="welcome-modal">
        <div class="welcome-modal-logo">PULL<span>LIST</span></div>
        <h2>Welcome to PULLLIST</h2>
        <p>
          Each month, Ray &amp; Judy's Book Stop loads the latest catalog from our distributors.
          Browse the Catalog, reserve what you want, and we'll order it specifically for you.
          Watch the <strong>order deadline</strong> at the top of the Catalog page — that's your
          cutoff to lock in picks for the month. Use <strong>Subscriptions</strong> to
          auto-reserve a series every month without lifting a finger, and check
          <strong>This Week</strong> on Wednesdays to see what's arrived for you.
        </p>
        <p>
          <strong>Important:</strong> When you reserve an item, we order it just for you.
          Please stop in to pick up and pay for your items when they arrive — payment is due at pickup.
        </p>
        <button class="btn btn-primary" id="welcome-got-it">Got it</button>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));

    document.getElementById('welcome-got-it').addEventListener('click', () => {
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 220);
      // Set localStorage immediately — prevents reappearance on this device
      // even before the DB write completes
      localStorage.setItem(this._localKey(userId), '1');
      // Persist to DB for cross-device consistency
      db.from('user_profiles').update({ has_seen_welcome: true }).eq('id', userId).then(() => {});
    });
  },
};


// ── UI Helpers ────────────────────────────────────────────────
function toast(message, type = 'success') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = message;
  container.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Returns true when a FOC date string ('YYYY-MM-DD') is strictly before today.
// Uses local date parts to avoid UTC shift.
function isFocPast(dateStr) {
  if (!dateStr) return false;
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  return dateStr < todayStr;
}

// Returns true when a title's FOC has passed and new reservations/cancellations
// can no longer be accepted. Hard-cutoff mode: identical to isFocPast.
// Named alias so call sites read as intent rather than date mechanics.
function isFocLocked(dateStr) {
  return isFocPast(dateStr);
}

// Returns true when a FOC date string ('YYYY-MM-DD') falls within the current
// calendar month (including today, including future dates this month).
// Uses local date parts to avoid UTC shift.
function isFocThisMonth(dateStr) {
  if (!dateStr) return false;
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const monthPrefix = `${yyyy}-${mm}`;
  return dateStr.startsWith(monthPrefix);
}

function formatPrice(price) {
  if (!price) return '—';
  return `$${parseFloat(price).toFixed(2)}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function renderSkeletons(count = 12, container) {
  container.innerHTML = Array(count).fill(0).map(() => `
    <div class="skeleton">
      <div class="skeleton-cover"></div>
      <div class="skeleton-body">
        <div class="skeleton-line"></div>
        <div class="skeleton-line short"></div>
      </div>
    </div>
  `).join('');
}

// Inline SVG placeholder — shown while image loads and as fallback if it breaks
const COVER_PLACEHOLDER = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='225' viewBox='0 0 150 225'%3E%3Crect width='150' height='225' fill='%23222'/%3E%3Crect x='20' y='20' width='110' height='4' rx='2' fill='%23333'/%3E%3Crect x='20' y='32' width='80' height='4' rx='2' fill='%23333'/%3E%3Crect x='20' y='60' width='110' height='80' rx='4' fill='%23333'/%3E%3Crect x='20' y='156' width='90' height='4' rx='2' fill='%23333'/%3E%3Crect x='20' y='168' width='60' height='4' rx='2' fill='%23333'/%3E%3C/svg%3E`;

function buildComicCard(comic, reservedQty, focLocked = false) {
  const isReserved = reservedQty > 0;
  const coverHtml = `<img
    src="${comic.cover_url ? escapeHtml(comic.cover_url) : COVER_PLACEHOLDER}"
    alt="${escapeHtml(comic.title)}"
    loading="lazy"
    onerror="this.src=COVER_PLACEHOLDER;this.onerror=null;"
  >`;

  const reservedBadge = isReserved
    ? `<div class="reserved-indicator">Qty: ${reservedQty}</div>`
    : '';

  // FOC lock badge — amber pill shown on reserved+locked items so the customer
  // understands this item is committed but can no longer be changed.
  const focBadge = (focLocked && isReserved)
    ? `<div class="foc-locked-indicator" title="Order cutoff passed — cannot be changed">FOC</div>`
    : '';

  const saleDate = comic.on_sale_date ? formatDate(comic.on_sale_date) : '—';

  // Button state: locked items (reserved or not) cannot be toggled.
  const btnClass    = focLocked && !isReserved ? 'btn-reserve foc-locked'
                    : isReserved               ? 'btn-reserve reserved'
                    :                            'btn-reserve';
  const btnText     = focLocked && !isReserved ? '\uD83D\uDD12 FOC Locked'
                    : isReserved               ? '\u2713 Reserved'
                    :                            '+ Reserve';
  const btnDisabled = focLocked ? 'disabled' : '';

  return `
    <div class="comic-card" data-id="${comic.id}">
      <div class="comic-cover">
        <div class="distributor-badge badge-${comic.distributor.toLowerCase()}">${escapeHtml(comic.distributor)}</div>
        ${reservedBadge}${focBadge}
        ${coverHtml}
      </div>
      <div class="comic-info">
        <div class="comic-title">${escapeHtml(comic.title)}</div>
        <div class="comic-series">${escapeHtml(comic.publisher || '')}</div>
        <div class="comic-meta">
          <span class="comic-price">${formatPrice(comic.price_usd)}</span>
          <span class="comic-date">${saleDate}</span>
        </div>
      </div>
      <div class="comic-actions">
        <button class="${btnClass}" data-id="${comic.id}" ${btnDisabled}>
          ${btnText}
        </button>
      </div>
    </div>
  `;
}

// Export to CSV helper (used in admin)
function exportToCsv(rows, filename) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(','),
    ...rows.map(r => headers.map(h => {
      const v = r[h] ?? '';
      return `"${String(v).replace(/"/g, '""')}"`;
    }).join(','))
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}