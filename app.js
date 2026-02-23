// ================================================================
// Comic Pre-Order System — Shared App Logic
// ================================================================
// IMPORTANT: Replace these two values with your own from Supabase
// Project Settings → API
// ================================================================

const SUPABASE_URL      = 'https://plgegklqtdjxeglvyjte.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ShA2TQAvsnJEizW9F7RP6w_HQ5eiVM3';

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
  if (logoutBtn) logoutBtn.addEventListener('click', () => Auth.signOut());

  return { user, profile };
}

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
    const { data } = await db
      .from('catalog')
      .select('publisher')
      .eq('catalog_month', month)
      .order('publisher');
    // Deduplicate
    const seen = new Set();
    return (data || []).filter(r => {
      if (!r.publisher || seen.has(r.publisher)) return false;
      seen.add(r.publisher);
      return true;
    }).map(r => r.publisher);
  },
};

// ── Admin Impersonation State ────────────────────────────────
const AdminContext = {
  activeUserId:   null,
  activeUserName: null,

  set(userId, userName) {
    this.activeUserId   = userId;
    this.activeUserName = userName;
    this.updateBanner();
  },

  clear() {
    this.activeUserId   = null;
    this.activeUserName = null;
    this.updateBanner();
  },

  isActive() { return !!this.activeUserId; },

  resolveUserId(ownUserId) {
    return this.activeUserId || ownUserId;
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

// ── Pre-order API ─────────────────────────────────────────────
const Preorders = {
  async getMyIds(userId) {
    const { data } = await db
      .from('preorders')
      .select('catalog_id')
      .eq('user_id', userId);
    return new Set((data || []).map(r => r.catalog_id));
  },

  async getMy(userId) {
    const { data, error } = await db
      .from('preorders')
      .select(`
        id,
        created_at,
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

  async reserve(userId, catalogId) {
    const { data, error } = await db
      .from('preorders')
      .insert({ user_id: userId, catalog_id: catalogId })
      .select()
      .single();
    return { data, error };
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

function buildComicCard(comic, isReserved) {
  const coverHtml = `<img
    src="${comic.cover_url ? escapeHtml(comic.cover_url) : COVER_PLACEHOLDER}"
    alt="${escapeHtml(comic.title)}"
    loading="lazy"
    onerror="this.src=COVER_PLACEHOLDER;this.onerror=null;"
  >`;

  const reservedBadge = isReserved
    ? `<div class="reserved-indicator">Reserved</div>`
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
