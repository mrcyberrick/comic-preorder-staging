const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')
    const SUPABASE_ANON      = Deno.env.get('SUPABASE_ANON_KEY')
    const SUPABASE_SERVICE   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const MAILERSEND_API_KEY = Deno.env.get('MAILERSEND_API_KEY')
    const FOUNDING_TENANT_ID = Deno.env.get('FOUNDING_TENANT_ID')

    if (!FOUNDING_TENANT_ID) {
      console.warn('send-my-list: FOUNDING_TENANT_ID secret not set — catalog month query unscoped')
    }

    const authHeaders = {
      Authorization: 'Bearer ' + SUPABASE_SERVICE,
      apikey: SUPABASE_SERVICE,
      Accept: 'application/json',
    }

    // Parse body
    let user_id: string
    try {
      const body = await req.json()
      user_id = body.user_id || ''
    } catch {
      return Response.json({ error: 'Invalid body' }, { status: 400, headers: corsHeaders })
    }

    if (!user_id) {
      return Response.json({ error: 'user_id required' }, { status: 400, headers: corsHeaders })
    }

    // Verify the request is authenticated — the Authorization header must carry
    // a valid session token for the user making the request.
    const authHeader = req.headers.get('Authorization') || ''
    const sessionToken = authHeader.replace('Bearer ', '')
    if (!sessionToken) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
    }

    // Verify the caller's JWT and confirm they are requesting their own list.
    const callerRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: authHeader, apikey: SUPABASE_ANON }
    })
    if (!callerRes.ok) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
    }
    const callerUser = await callerRes.json()
    if (callerUser.id !== user_id) {
      return Response.json({ error: 'Forbidden — can only request your own list' }, { status: 403, headers: corsHeaders })
    }

    // Fetch user email via the admin endpoint (service key required).
    const authUserRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${user_id}`,
      { headers: authHeaders }
    )
    if (!authUserRes.ok) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
    }
    const authUser = await authUserRes.json()
    const email = authUser?.email
    if (!email) {
      return Response.json({ error: 'Could not find user email' }, { status: 404, headers: corsHeaders })
    }

    // Fetch user profile for name and tenant
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${user_id}&select=full_name,tenant_id&limit=1`,
      { headers: authHeaders }
    )
    const profiles = await profileRes.json()
    const fullName = profiles?.[0]?.full_name || 'Valued Customer'
    const callerTenantId = profiles?.[0]?.tenant_id || FOUNDING_TENANT_ID

    // Get the current catalog month scoped to the caller's tenant
    const tenantFilter = `&tenant_id=eq.${callerTenantId}`
    const monthRes = await fetch(
      `${SUPABASE_URL}/rest/v1/catalog?select=catalog_month&order=catalog_month.desc&limit=1` + tenantFilter,
      { headers: authHeaders }
    )
    const monthData = await monthRes.json()
    const catalogMonth = monthData?.[0]?.catalog_month || ''

    if (!catalogMonth) {
      return Response.json({ error: 'No active catalog month' }, { status: 404, headers: corsHeaders })
    }

    // Format month label e.g. "2026-04" → "April 2026"
    const [my, mm] = catalogMonth.split('-').map(Number)
    const monthLabel = new Date(my, mm - 1, 1)
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

    // Fetch the user's preorders for the current catalog month, scoped to their tenant
    const preordersRes = await fetch(
      `${SUPABASE_URL}/rest/v1/preorders?user_id=eq.${user_id}&tenant_id=eq.${callerTenantId}&select=quantity,catalog(title,series_name,publisher,distributor,price_usd,on_sale_date,item_code,catalog_month)`,
      { headers: authHeaders }
    )
    const preorders = await preordersRes.json()

    // Filter to current month and sort by publisher then title
    const items = (preorders || [])
      .filter((p: any) => p.catalog?.catalog_month === catalogMonth)
      .sort((a: any, b: any) => {
        const pub = (a.catalog?.publisher || '').localeCompare(b.catalog?.publisher || '')
        if (pub !== 0) return pub
        return (a.catalog?.title || '').localeCompare(b.catalog?.title || '')
      })

    if (!items.length) {
      return Response.json({ error: 'No reservations found for current month' }, { status: 404, headers: corsHeaders })
    }

    // Calculate totals
    const totalQty   = items.reduce((s: number, p: any) => s + (p.quantity || 1), 0)
    const totalValue = items.reduce((s: number, p: any) =>
      s + ((parseFloat(p.catalog?.price_usd) || 0) * (p.quantity || 1)), 0)

    // Build email subject with dynamic month
    const subject = `Your ${monthLabel} pull list — Ray & Judy's Book Stop`

    // Build item rows for the email table
    const itemRows = items.map((p: any) => {
      const c       = p.catalog
      const qty     = p.quantity || 1
      const price   = parseFloat(c?.price_usd) || 0
      const lineTotal = (price * qty).toFixed(2)
      const onSale  = c?.on_sale_date
        ? new Date(c.on_sale_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '—'
      const dist    = c?.distributor || ''
      const distColor = dist === 'Lunar' ? '#3b82f6' : '#a855f7'

      return `
        <tr style="border-bottom:1px solid #2e2e2e">
          <td style="padding:10px 8px;font-size:0.82rem;color:#f0ece4">
            <div style="font-weight:600">${escHtml(c?.title || '—')}</div>
            ${c?.series_name ? `<div style="font-size:0.75rem;color:#9a9390;margin-top:2px">${escHtml(c.series_name)}</div>` : ''}
          </td>
          <td style="padding:10px 8px;font-size:0.78rem;color:#9a9390;white-space:nowrap">${escHtml(c?.publisher || '—')}</td>
          <td style="padding:10px 8px;text-align:center">
            <span style="font-size:0.68rem;font-weight:700;padding:2px 7px;border-radius:2px;background:${distColor}22;color:${distColor};border:1px solid ${distColor}55">${escHtml(dist)}</span>
          </td>
          <td style="padding:10px 8px;font-size:0.78rem;color:#9a9390;white-space:nowrap;text-align:center">${onSale}</td>
          <td style="padding:10px 8px;text-align:center;font-weight:700;color:${qty > 1 ? '#e8321c' : '#f0ece4'};font-size:0.85rem">${qty}</td>
          <td style="padding:10px 8px;text-align:right;font-weight:600;color:#f0ece4;white-space:nowrap">$${lineTotal}</td>
        </tr>`
    }).join('')

    function escHtml(str: string): string {
      return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    }

    const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#1a1a1a;color:#f0f0f0;border-radius:8px;overflow:hidden">

  <div style="background:#111;padding:24px 32px;border-bottom:3px solid #e63946">
    <div style="font-size:1.6rem;font-weight:900;letter-spacing:0.08em">PULL<span style="color:#e63946">LIST</span></div>
    <div style="font-size:0.75rem;color:#888;margin-top:2px">Ray &amp; Judy's Book Stop &mdash; Monthly Comics Pre-Order System</div>
  </div>

  <div style="padding:28px 32px">
    <h2 style="margin:0 0 6px;font-size:1rem;color:#fff">Hi ${escHtml(fullName)},</h2>
    <p style="color:#ccc;line-height:1.7;margin:0 0 24px;font-size:0.88rem">
      Here's your pull list for <strong style="color:#fff">${monthLabel}</strong>.
      We'll have everything ready for you when it arrives.
    </p>

    <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif">
      <thead>
        <tr style="border-bottom:2px solid #3a3a3a">
          <th style="padding:8px 8px;text-align:left;font-size:0.68rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#666">Title</th>
          <th style="padding:8px 8px;text-align:left;font-size:0.68rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#666">Publisher</th>
          <th style="padding:8px 8px;text-align:center;font-size:0.68rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#666">Dist</th>
          <th style="padding:8px 8px;text-align:center;font-size:0.68rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#666">On Sale</th>
          <th style="padding:8px 8px;text-align:center;font-size:0.68rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#666">Qty</th>
          <th style="padding:8px 8px;text-align:right;font-size:0.68rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#666">Total</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
      <tfoot>
        <tr style="border-top:2px solid #3a3a3a">
          <td colspan="4" style="padding:12px 8px;font-size:0.82rem;color:#888">${totalQty} item${totalQty !== 1 ? 's' : ''} reserved</td>
          <td colspan="2" style="padding:12px 8px;text-align:right;font-weight:700;color:#e8321c;font-size:1rem">$${totalValue.toFixed(2)}</td>
        </tr>
      </tfoot>
    </table>

    <p style="margin-top:24px;font-size:0.78rem;color:#666;line-height:1.6">
      Questions? Stop by or give us a call.<br>
      Ray &amp; Judy's Book Stop &middot; 40 W Main St. Rockaway, NJ 07866 &middot; (973) 586-9182
    </p>
  </div>

  <div style="background:#111;padding:16px 32px;font-size:0.72rem;color:#555;border-top:1px solid #222">
    Ray &amp; Judy's Book Stop &middot; Sent via the PullList pre-order system
  </div>

</div>`

    // Send via MailerSend
    const mailRes = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + MAILERSEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: { email: 'noreply@mrcyberrick.us', name: "Ray & Judy's Book Stop" },
        to: [{ email, name: fullName }],
        subject,
        html,
      }),
    })

    if (!mailRes.ok) {
      const err = await mailRes.json().catch(() => ({}))
      console.error('MailerSend error:', JSON.stringify(err))
      return Response.json({ error: 'Failed to send email' }, { status: 500, headers: corsHeaders })
    }

    console.log(`Pull list confirmation sent to ${email} for ${catalogMonth}`)
    return Response.json({ success: true, sent: 1 }, { headers: corsHeaders })

  } catch (err) {
    console.error('Unexpected error:', String(err))
    return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders })
  }
})
