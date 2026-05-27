/**
 * approve-customer — Admin-only Edge Function
 *
 * Called from the admin panel Pending tab to approve a pending account.
 * Sets user_profiles.status = 'active' and sends a branded approval
 * email containing a fresh magic link so the customer can log in
 * immediately and start making reservations.
 *
 * Request body: { user_id: string }
 * Auth: Bearer token from the admin's active session (required)
 */

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

    // ── Parse body ──────────────────────────────────────────────
    let user_id: string
    try {
      const body = await req.json()
      user_id = (body.user_id || '').trim()
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders })
    }
    if (!user_id) {
      return Response.json({ error: 'user_id required' }, { status: 400, headers: corsHeaders })
    }

    // ── Verify caller is an authenticated admin ─────────────────
    // Supabase validates the JWT before the function runs (JWT enabled).
    // We still verify is_admin using the service key to confirm the caller
    // is actually an admin, not just any authenticated user.
    const authHeader = req.headers.get('Authorization') || ''

    // Extract user ID from the JWT claims via Supabase auth API
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: authHeader,
        apikey: SUPABASE_SERVICE!,   // use service key — anon key may not be in secrets
      },
    })
    const userData = await userRes.json()
    if (!userRes.ok || !userData.id) {
      console.error('approve-customer: could not resolve caller identity', JSON.stringify(userData))
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
    }

    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userData.id}&select=is_admin`,
      {
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE}`,
          apikey: SUPABASE_SERVICE!,
          Accept: 'application/json',
        },
      }
    )
    const profiles = await profileRes.json()
    if (!Array.isArray(profiles) || !profiles[0]?.is_admin) {
      return Response.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders })
    }

    // ── Fetch target user's profile (need name + email) ─────────
    const targetRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${user_id}&select=id,full_name,email,status`,
      {
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE}`,
          apikey:        SUPABASE_SERVICE!,
          Accept:        'application/json',
        },
      }
    )
    const targets = await targetRes.json()
    const target  = targets?.[0]
    if (!target) {
      return Response.json({ error: 'User not found' }, { status: 404, headers: corsHeaders })
    }
    if (target.status === 'active') {
      return Response.json({ success: true, note: 'already_active' }, { headers: corsHeaders })
    }

    const fullName = target.full_name || 'Customer'
    const email    = target.email

    // ── Set status = 'active' ────────────────────────────────────
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${user_id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE}`,
          apikey:        SUPABASE_SERVICE!,
          'Content-Type': 'application/json',
          Prefer:         'return=minimal',
        },
        body: JSON.stringify({ status: 'active' }),
      }
    )
    if (!updateRes.ok) {
      const txt = await updateRes.text()
      console.error('approve-customer: status update failed', txt)
      return Response.json({ error: 'Failed to update status' }, { status: 500, headers: corsHeaders })
    }

    console.log(`approve-customer: approved ${email} (${user_id})`)

    // ── Send approval email only if we have an email address ─────
    if (!email) {
      console.warn('approve-customer: no email stored for user, skipping notification')
      return Response.json({ success: true, emailed: false }, { headers: corsHeaders })
    }

    // Generate a fresh magic link so they can log in right away
    const linkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${SUPABASE_SERVICE}`,
        apikey:         SUPABASE_SERVICE!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type:        'magiclink',
        email,
        redirect_to: `${APP_BASE_URL}/catalog.html`,
      }),
    })
    const linkData    = await linkRes.json()
    const hashedToken = linkData.hashed_token as string | undefined
    const magicUrl    = hashedToken
      ? `${APP_INDEX_URL}?token_hash=${hashedToken}&type=magiclink`
      : `${APP_BASE_URL}/`

    const mailRes = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${MAILERSEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:    { email: 'noreply@mrcyberrick.us', name: "Ray & Judy's Book Stop" },
        to:      [{ email, name: fullName }],
        subject: "Ray & Judy's Book Stop — You're approved for the pull list!",
        html:    buildApprovalEmail(fullName, magicUrl),
      }),
    })

    if (!mailRes.ok) {
      const mailErr = await mailRes.json().catch(() => ({}))
      console.error('approve-customer: MailerSend error', JSON.stringify(mailErr))
      // Don't fail — approval was saved, just the email didn't send
      return Response.json({ success: true, emailed: false }, { headers: corsHeaders })
    }

    return Response.json({ success: true, emailed: true }, { headers: corsHeaders })

  } catch (err) {
    console.error('approve-customer: unexpected error', String(err))
    return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders })
  }
})

// ── Email template ────────────────────────────────────────────────────────────
function buildApprovalEmail(name: string, magicUrl: string): string {
  return `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#1a1a1a;color:#f0f0f0;border-radius:8px;overflow:hidden">
  <div style="background:#111;padding:24px 32px;border-bottom:3px solid #e63946">
    <div style="font-size:1.6rem;font-weight:900;letter-spacing:0.08em">PULL<span style="color:#e63946">LIST</span></div>
    <div style="font-size:0.75rem;color:#888;margin-top:2px">Ray &amp; Judy's Book Stop &mdash; Monthly Comics Pre-Order System</div>
  </div>
  <div style="padding:32px">
    <h2 style="margin:0 0 16px;font-size:1.1rem;color:#fff">Hi ${name} — you're in!</h2>
    <p style="color:#ccc;line-height:1.7;margin:0 0 16px">
      Your PULLLIST account has been approved by Ray &amp; Judy's Book Stop.
      You can now browse the monthly catalog and reserve your titles before the order deadline.
    </p>
    <p style="color:#ccc;line-height:1.7;margin:0 0 24px">
      Click below to sign in and get started. You can also set a password from the login page
      so you don't need a link each time.
    </p>
    <a href="${magicUrl}"
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