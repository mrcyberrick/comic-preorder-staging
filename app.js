// ================================================================
// Comic Pre-Order System — Shared App Logic
// ================================================================
// IMPORTANT: Credentials are loaded from config.js
// See config.js — do not add credentials here
// ================================================================

// ── Supabase Client (CDN version, no npm needed) ─────────────
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
    return await db.auth.signInWithPassword({ email, password });
  },

  async signOut() {
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
      query = query.or(
        `title.ilike.%${search}%,series_name.ilike.%${search}%,writer.ilike.%${search}%,publisher.ilike.%${search}%,upc.ilike.%${search}%,isbn.ilike.%${search}%`
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
      const name = escapeHtml(AdminContext.activeUserName);
      banner.innerHTML =
        '<span>&#9888; Managing pull list for: <strong>' + name + '</strong></span>' +
        '<button id="banner-exit-btn" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);color:white;padding:3px 10px;border-radius:3px;cursor:pointer;font-size:0.78rem">' +
        '&#x2715; Back to my account</button>';
      document.getElementById('banner-exit-btn').addEventListener('click', () => {
        AdminContext.clear();
        const sel = document.getElementById('admin-user-select');
        if (sel) sel.value = '';
        window.location.reload();
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
      .upsert({ key, value, updated_at: new Date().toISOString() });
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
      .insert({ user_id: userId, catalog_id: catalogId, quantity })
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

  // Admin only
  async getAll() {
    const { data, error } = await db
      .from('preorders')
      .select(`
        id,
        created_at,
        user_id,
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
      .select('id, series_name, distributor, created_at')
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
  async subscribe(userId, seriesName, distributor) {
    const { data, error } = await db
      .from('subscriptions')
      .insert({ user_id: userId, series_name: seriesName, distributor })
      .select()
      .single();
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
    return { error };
  },

  // Admin: get all subscriptions across all users
  async getAllAdmin() {
    const { data, error } = await db
      .from('subscriptions')
      .select('id, series_name, distributor, created_at, user_profiles ( full_name )')
      .order('series_name', { ascending: true });
    return { items: data || [], error };
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
          Browse the Catalog, reserve what you want, and we'll have it waiting for you.
          Watch the <strong>order deadline</strong> at the top of the Catalog page — that's your
          cutoff to lock in picks for the month. Use <strong>Subscriptions</strong> to
          auto-reserve a series every month without lifting a finger, and check
          <strong>This Week</strong> on Wednesdays to see what's arrived for you.
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

function buildComicCard(comic, reservedQty) {
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

  const saleDate = comic.on_sale_date ? formatDate(comic.on_sale_date) : '—';

  return `
    <div class="comic-card" data-id="${comic.id}">
      <div class="comic-cover">
        <div class="distributor-badge badge-${comic.distributor.toLowerCase()}">${escapeHtml(comic.distributor)}</div>
        ${reservedBadge}
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
        <button class="btn-reserve ${isReserved ? 'reserved' : ''}" data-id="${comic.id}">
          ${isReserved ? '✓ Reserved' : '+ Reserve'}
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
