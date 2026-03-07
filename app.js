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
// Shows a red badge on the My List nav link when the active user
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

      const count = data.length;
      this.render(count);
    } catch (e) {
      // Bubble is non-critical — fail silently
    }
  },

render(count) {
    document.querySelectorAll('.nav-bubble').forEach(b => b.remove());
    if (count < 1) return;

    const myListLink = document.querySelector('.nav-links a[href="mylist.html"]');
    if (!myListLink) return;

    const li = myListLink.parentElement;
    li.style.position = 'relative';

    const bubble = document.createElement('span');
    bubble.className = 'nav-bubble';
    bubble.textContent = count > 99 ? '99+' : String(count);
    bubble.title = `${count} reserved item${count !== 1 ? 's' : ''} on sale within 7 days`;

    const isMobile = window.innerWidth <= 640;
    if (isMobile) {
      bubble.style.cssText = [
        'display:inline-flex;align-items:center;justify-content:center;',
        'background:#e74c3c;color:white;',
        'font-size:0.62rem;font-weight:700;',
        'min-width:16px;height:16px;',
        'border-radius:8px;padding:0 4px;',
        'margin-left:6px;',
        'pointer-events:none;line-height:1;',
        'box-shadow:0 1px 4px rgba(0,0,0,0.4);',
        'letter-spacing:0;vertical-align:middle;',
      ].join('');
    } else {
      bubble.style.cssText = [
        'position:absolute;top:-6px;right:-18px;',
        'background:#e74c3c;color:white;',
        'font-size:0.62rem;font-weight:700;',
        'min-width:16px;height:16px;',
        'border-radius:8px;padding:0 4px;',
        'display:flex;align-items:center;justify-content:center;',
        'pointer-events:none;line-height:1;',
        'box-shadow:0 1px 4px rgba(0,0,0,0.4);',
        'letter-spacing:0;',
      ].join('');
    }

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

  async fetch({ month, distributor, publisher, search, page = 1, pageSize = 48 }) {
    let query = db.from('catalog').select('*', { count: 'exact' });

    if (month)       query = query.eq('catalog_month', month);
    if (distributor) query = query.eq('distributor', distributor);
    if (publisher)   query = query.eq('publisher', publisher);
    if (search) {
      query = query.or(
        `title.ilike.%${search}%,series_name.ilike.%${search}%,writer.ilike.%${search}%,publisher.ilike.%${search}%`
      );
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
          writer, artist, cover_url, variant_type
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
