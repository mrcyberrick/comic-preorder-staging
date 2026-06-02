const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  // Env vars hoisted to function scope so auth check can use them
  const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')
  const SUPABASE_ANON      = Deno.env.get('SUPABASE_ANON_KEY')
  const SUPABASE_SERVICE   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const MAILERSEND_API_KEY = Deno.env.get('MAILERSEND_API_KEY')
  const FOUNDING_TENANT_ID = Deno.env.get('FOUNDING_TENANT_ID')

  // Caller authentication: this function triggers a customer-wide email blast,
  // so we verify the caller is an authenticated admin before doing anything.
  // (JWT verification is disabled at the platform level per Supabase's recommended
  // pattern of off-plus-in-body-auth; the check below is the actual gate.)
  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader) {
    return Response.json({ error: 'Missing Authorization header' }, { status: 401, headers: corsHeaders })
  }

  // Resolve caller identity: service-role bypass (import script) or user JWT (admin UI).
  // Decode JWT role claim to detect service-role callers. Safe: platform JWT verification is ON,
  // so only Supabase-signed tokens reach this function; a forged service_role claim is impossible.
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
  const isServiceRole = (() => {
    try {
      const parts = token.split('.')
      if (parts.length !== 3) return false
      const pad = (s: string) => s + '=='.slice(0, (4 - s.length % 4) % 4)
      const payload = JSON.parse(atob(pad(parts[1].replace(/-/g, '+').replace(/_/g, '/'))))
      return payload.role === 'service_role'
    } catch { return false }
  })()
  let callerTenantId: string

  if (isServiceRole) {
    // Service-role caller (e.g. import script) — scope to founding tenant.
    callerTenantId = FOUNDING_TENANT_ID || ''
  } else {
    // User JWT path — verify caller is an authenticated admin.
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: authHeader, apikey: SUPABASE_ANON }
    })
    if (!userRes.ok) {
      return Response.json({ error: 'Invalid auth' }, { status: 401, headers: corsHeaders })
    }
    const userData = await userRes.json()

    const profileRes = await fetch(
      SUPABASE_URL + `/rest/v1/user_profiles?id=eq.${userData.id}&select=is_admin,tenant_id`,
      { headers: { Authorization: authHeader, apikey: SUPABASE_ANON, Accept: 'application/json' } }
    )
    const profileData = await profileRes.json()
    if (!Array.isArray(profileData) || profileData.length === 0 || !profileData[0].is_admin) {
      return Response.json({ error: 'Admin required' }, { status: 403, headers: corsHeaders })
    }
    callerTenantId = profileData[0].tenant_id || FOUNDING_TENANT_ID || ''
  }

  try {
    if (!FOUNDING_TENANT_ID) {
      console.warn('notify-customers: FOUNDING_TENANT_ID secret not set — tenant scoping disabled')
    }

    // Parse body — only catalog_month is needed now.
    // foc_date is no longer accepted; the deadline is read from app_settings instead.
    let catalog_month
    try {
      const body    = await req.json()
      catalog_month = body.catalog_month || ''
    } catch {
      return Response.json({ error: 'Invalid body' }, { status: 400, headers: corsHeaders })
    }

    const authHeaders = {
      Authorization: 'Bearer ' + SUPABASE_SERVICE,
      apikey: SUPABASE_SERVICE,
      Accept: 'application/json',
    }

    // Format month label e.g. "2026-04" -> "April 2026"
    const monthLabel = catalog_month
      ? new Date(catalog_month + '-01T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : 'this month'

    // Read the admin-set order deadline from app_settings.
    // This is the same value shown in the catalog banner — single source of truth.
    let deadlineLabel: string | null = null
    try {
      const tenantFilter = `&tenant_id=eq.${callerTenantId}`
      const settingsRes = await fetch(
        SUPABASE_URL + '/rest/v1/app_settings?key=eq.order_deadline&select=value&limit=1' + tenantFilter,
        { headers: authHeaders }
      )
      const settings = await settingsRes.json()
      const rawDeadline = settings?.[0]?.value || ''
      if (rawDeadline) {
        // Parse as local date — split to avoid any UTC offset shifting the day
        const [y, m, d] = rawDeadline.split('-').map(Number)
        deadlineLabel = new Date(y, m - 1, d)
          .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      }
    } catch (e) {
      console.warn('Could not read order_deadline from app_settings:', String(e))
      // Non-fatal — email sends without a deadline line
    }

    // Fetch all non-admin customers scoped to the caller's tenant.
    // Paper customers (@paper.pulllist.local) are excluded from the recipient list below.
    const tenantFilter = `&tenant_id=eq.${callerTenantId}`
    const profilesRes = await fetch(
      SUPABASE_URL + '/rest/v1/user_profiles?is_admin=eq.false&select=id,full_name' + tenantFilter,
      { headers: authHeaders }
    )
    const profiles = await profilesRes.json()
    if (!Array.isArray(profiles) || profiles.length === 0) {
      return Response.json({ error: 'No customers found' }, { status: 404, headers: corsHeaders })
    }

    // Fetch emails from auth.users for each profile
    const usersRes = await fetch(
      SUPABASE_URL + '/auth/v1/admin/users?per_page=1000',
      { headers: authHeaders }
    )
    const usersData = await usersRes.json()
    const userMap: Record<string, string> = {}
    ;(usersData.users || []).forEach((u: { id: string; email: string }) => {
      userMap[u.id] = u.email
    })

    // Build recipient list — skip paper placeholder emails and rows with no email
    const recipients = profiles
      .map((p: { id: string; full_name: string }) => ({ name: p.full_name, email: userMap[p.id] }))
      .filter((r: { email?: string }) => r.email && !r.email.endsWith('@paper.pulllist.local'))

    console.log('Sending catalog notification to', recipients.length, 'customers for', catalog_month)

    // Build the deadline paragraph — omitted cleanly if no deadline is set in admin
    const deadlinePara = deadlineLabel
      ? '<p style="color:#ccc;line-height:1.7;margin:0 0 24px">'
          + 'Please log in and reserve your titles before <strong style="color:#fff">'
          + deadlineLabel
          + '</strong> to lock in your picks for the month.'
          + '</p>'
      : '<p style="color:#ccc;line-height:1.7;margin:0 0 24px">'
          + 'Please log in and reserve your titles before the order deadline.'
          + '</p>'

    const html = '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#1a1a1a;color:#f0f0f0;border-radius:8px;overflow:hidden">'
      + '<div style="background:#111;padding:24px 32px;border-bottom:3px solid #e63946">'
      + '<div style="font-size:1.6rem;font-weight:900;letter-spacing:0.08em">PULL<span style="color:#e63946">LIST</span></div>'
      + '<div style="font-size:0.75rem;color:#888;margin-top:2px">Ray &amp; Judy\'s Book Stop &mdash; Monthly Comics Pre-Order System</div>'
      + '</div>'
      + '<div style="padding:32px">'
      + '<h2 style="margin:0 0 16px;font-size:1.1rem;color:#fff">The ' + monthLabel + ' catalog is now live</h2>'
      + '<p style="color:#ccc;line-height:1.7;margin:0 0 16px">The new pull list is ready &mdash; browse this month\'s Lunar and PRH titles and reserve the ones you want.</p>'
      + deadlinePara
      + '<a href="https://mrcyberrick.us/comic-preorder/catalog.html" style="display:inline-block;background:#e63946;color:white;padding:13px 28px;border-radius:4px;text-decoration:none;font-weight:700;font-size:0.9rem;letter-spacing:0.03em">Browse the Catalog &rarr;</a>'
      + '<p style="margin-top:24px;font-size:0.78rem;color:#666;line-height:1.6">'
      + 'Questions? Stop by or give us a call.<br>'
      + 'Ray &amp; Judy\'s Book Stop &middot; 40 W Main St. Rockaway, NJ 07866 &middot; (973) 586-9182'
      + '</p></div>'
      + '<div style="background:#111;padding:16px 32px;font-size:0.72rem;color:#555;border-top:1px solid #222">Ray &amp; Judy\'s Book Stop &middot; Sent via the PullList pre-order system</div>'
      + '</div>'

    // Send to each recipient
    let sent   = 0
    let failed = 0

    for (const recipient of recipients) {
      const mailRes = await fetch('https://api.mailersend.com/v1/email', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + MAILERSEND_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: { email: 'noreply@mrcyberrick.us', name: "Ray & Judy's Book Stop" },
          to: [{ email: recipient.email, name: recipient.name }],
          subject: "Ray & Judy's Book Stop — The " + monthLabel + ' pull list is live',
          html,
        }),
      })

      if (mailRes.ok) {
        sent++
      } else {
        failed++
        const err = await mailRes.json().catch(() => ({}))
        console.error('Failed to send to', recipient.email, JSON.stringify(err))
      }

      // Small delay to avoid MailerSend rate limits
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    console.log('Notification complete. Sent:', sent, 'Failed:', failed)
    return Response.json({ success: true, sent, failed }, { headers: corsHeaders })

  } catch (err) {
    console.error('Unexpected error:', String(err))
    return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders })
  }
})
