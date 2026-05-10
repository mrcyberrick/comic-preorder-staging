const STAGING_BASE  = 'https://mrcyberrick.github.io/comic-preorder-staging'
const APP_INDEX_URL = `${STAGING_BASE}/index.html`
const APP_BASE_URL  = STAGING_BASE

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
      console.warn('invite-customer: FOUNDING_TENANT_ID secret not set')
    }

    // Parse body
    let name, email
    try {
      const body = await req.json()
      name  = (body.name  || '').trim()
      email = (body.email || '').trim()
    } catch {
      return Response.json({ error: 'Invalid body' }, { status: 400, headers: corsHeaders })
    }

    if (!name || !email) {
      return Response.json({ error: 'Name and email required' }, { status: 400, headers: corsHeaders })
    }

    // Verify caller is authenticated
    const authHeader = req.headers.get('Authorization') || ''
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: authHeader, apikey: SUPABASE_ANON }
    })
    const userData = await userRes.json()
    if (!userRes.ok || !userData.id) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
    }

    // Verify caller is admin — also fetch tenant_id for F34 fix
    const profileRes = await fetch(
      SUPABASE_URL + '/rest/v1/user_profiles?id=eq.' + userData.id + '&select=is_admin,tenant_id',
      { headers: { Authorization: authHeader, apikey: SUPABASE_ANON, Accept: 'application/json' } }
    )
    const profiles = await profileRes.json()
    if (!Array.isArray(profiles) || !profiles[0] || !profiles[0].is_admin) {
      return Response.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders })
    }

    // Resolve the inviting admin's tenant — fall back to FOUNDING_TENANT_ID if lookup fails
    const callerTenantId = profiles[0]?.tenant_id || FOUNDING_TENANT_ID

    // Generate invite link via Supabase Admin API (no email sent by Supabase)
    const generateRes = await fetch(SUPABASE_URL + '/auth/v1/admin/generate_link', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + SUPABASE_SERVICE,
        apikey: SUPABASE_SERVICE,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type:        'invite',
        email:       email,
        data:        { full_name: name },
        redirect_to: APP_INDEX_URL,
      }),
    })
    const generateData = await generateRes.json()
    console.log('generate_link response:', JSON.stringify(generateData))

    if (!generateRes.ok) {
      const msg = ((generateData.msg || generateData.message) || '').toLowerCase()
      if (msg.includes('already') || msg.includes('duplicate')) {
        return Response.json({ error: 'A user with this email already exists' }, { status: 409, headers: corsHeaders })
      }
      return Response.json({ error: generateData.msg || generateData.message || 'Failed to generate invite' }, { status: 400, headers: corsHeaders })
    }

    // Use Supabase's action_link directly — it routes through the Supabase verify
    // endpoint and then redirects to APP_INDEX_URL. More reliable than constructing
    // a custom URL from hashed_token, which requires the client app to call verifyOtp.
    const action_url = generateData.action_link as string
    const userId     = generateData.user?.id
                    || generateData.data?.user?.id
                    || generateData.id

    console.log('action_url:', action_url, 'userId:', userId)

    if (!action_url) {
      return Response.json({ error: 'Failed to generate invite link' }, { status: 500, headers: corsHeaders })
    }

    // Send branded invite email via MailerSend — inline HTML, no template dependency
    const mailRes = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + MAILERSEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:    { email: 'noreply@mrcyberrick.us', name: "Ray & Judy's Book Stop" },
        to:      [{ email: email, name: name }],
        subject: "Ray & Judy's Book Stop — Your pull list account is ready",
        html:    buildInviteEmail(name, action_url),
      }),
    })

    if (!mailRes.ok) {
      const mailErr = await mailRes.json().catch(() => ({}))
      console.error('MailerSend error:', JSON.stringify(mailErr))
      return Response.json({ error: 'Failed to send invite email' }, { status: 500, headers: corsHeaders })
    }

    // Create user_profiles record — tenant_id scopes the new user to the inviting admin's tenant
    if (userId) {
      await fetch(SUPABASE_URL + '/rest/v1/user_profiles', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + SUPABASE_SERVICE,
          apikey: SUPABASE_SERVICE,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify({
          id:               userId,
          full_name:        name,
          email:            email,
          status:           'active',
          is_admin:         false,
          created_by_admin: true,
          tenant_id:        callerTenantId,
        }),
      })
    } else {
      console.error('Could not extract userId from generateData:', JSON.stringify(generateData))
    }

    return Response.json({ success: true, user_id: userId }, { headers: corsHeaders })

  } catch (err) {
    console.error('Unexpected error:', String(err))
    return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders })
  }
})

// ── Email template ─────────────────────────────────────────────────────────────
function buildInviteEmail(name: string, actionUrl: string): string {
  return `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#1a1a1a;color:#f0f0f0;border-radius:8px;overflow:hidden">
  <div style="background:#111;padding:24px 32px;border-bottom:3px solid #e63946">
    <div style="font-size:1.6rem;font-weight:900;letter-spacing:0.08em">PULL<span style="color:#e63946">LIST</span></div>
    <div style="font-size:0.75rem;color:#888;margin-top:2px">Ray &amp; Judy's Book Stop &mdash; Monthly Comics Pre-Order System</div>
  </div>
  <div style="padding:32px">
    <h2 style="margin:0 0 16px;font-size:1.1rem;color:#fff">Hi ${name} — you're invited!</h2>
    <p style="color:#ccc;line-height:1.7;margin:0 0 16px">
      Ray &amp; Judy's Book Stop has set up a PULLLIST account for you.
      Click below to sign in and start browsing the monthly catalog.
    </p>
    <p style="color:#ccc;line-height:1.7;margin:0 0 24px">
      You can set a password from the login page so you don't need a link each time.
    </p>
    <a href="${actionUrl}"
       style="display:inline-block;background:#e63946;color:white;padding:13px 28px;
              border-radius:4px;text-decoration:none;font-weight:700;font-size:0.9rem;
              letter-spacing:0.03em">
      Go to My Pull List &rarr;
    </a>
    <div style="margin-top:24px;background:rgba(255,255,255,0.04);
                border-left:3px solid rgba(232,57,70,0.4);padding:12px 16px;
                border-radius:0 4px 4px 0">
      <div style="font-size:0.78rem;color:#aaa;line-height:1.8">
        &#10003;&nbsp; This invite was sent personally by Ray &amp; Judy's Book Stop<br>
        &#10003;&nbsp; You will not be charged &mdash; this is a reservation system only<br>
        &#10003;&nbsp; If your link expires, use Forgot Password on the login page
      </div>
    </div>
    <p style="margin-top:24px;font-size:0.78rem;color:#666;line-height:1.6">
      Questions? Stop by or give us a call.<br>
      Ray &amp; Judy's Book Stop &middot; 40 W Main St. Rockaway, NJ 07866 &middot; (973) 586-9182
    </p>
  </div>
  <div style="background:#111;padding:16px 32px;font-size:0.72rem;color:#555;border-top:1px solid #222">
    Ray &amp; Judy's Book Stop &middot; Sent via the PullList pre-order system
  </div>
</div>`
}
