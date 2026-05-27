const STAGING_BASE       = 'https://mrcyberrick.us/comic-preorder-staging'
const FORGOT_PASSWORD_URL = `${STAGING_BASE}/forgot-password.html`

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')
    const SUPABASE_SERVICE   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const MAILERSEND_API_KEY = Deno.env.get('MAILERSEND_API_KEY')

    let email
    try {
      const body = await req.json()
      email = (body.email || '').trim()
    } catch {
      return Response.json({ error: 'Invalid body' }, { status: 400, headers: corsHeaders })
    }

    if (!email) {
      return Response.json({ error: 'Email required' }, { status: 400, headers: corsHeaders })
    }

    // Generate recovery link (no email sent by Supabase)
    const generateRes = await fetch(SUPABASE_URL + '/auth/v1/admin/generate_link', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + SUPABASE_SERVICE,
        apikey: SUPABASE_SERVICE,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type:        'recovery',
        email:       email,
        redirect_to: FORGOT_PASSWORD_URL,
      }),
    })
    const generateData = await generateRes.json()

    // Always return success — never leak whether an email address exists
    if (!generateRes.ok) {
      console.log('generate_link failed:', generateData.message)
      return Response.json({ success: true }, { headers: corsHeaders })
    }

    // Build reset URL using hashed_token so email security scanners that
    // pre-fetch links don't consume the one-time token before the user clicks.
    // The forgot-password.html page reads token_hash + type from the query
    // string and calls supabase.auth.verifyOtp({ token_hash, type }) to
    // establish the session before prompting for a new password.
    const hashed_token = generateData.hashed_token
    const action_url   = FORGOT_PASSWORD_URL
                       + '?token_hash=' + hashed_token + '&type=recovery'

    const name = generateData.user?.user_metadata?.full_name
              || generateData.email?.split('@')[0]
              || 'there'

    // Send branded reset email — inline HTML, no shared template dependency
    const mailRes = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + MAILERSEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:    { email: 'noreply@mrcyberrick.us', name: "Ray & Judy's Book Stop" },
        to:      [{ email: email, name: name }],
        subject: "Ray & Judy's Book Stop — Reset your password",
        html:    buildResetEmail(name, action_url),
      }),
    })

    if (!mailRes.ok) {
      const mailErr = await mailRes.json().catch(() => ({}))
      console.error('MailerSend error:', JSON.stringify(mailErr))
    }

    return Response.json({ success: true }, { headers: corsHeaders })

  } catch (err) {
    console.error('Unexpected error:', String(err))
    return Response.json({ success: true }, { headers: corsHeaders })
  }
})

// ── Email template ─────────────────────────────────────────────────────────────
function buildResetEmail(name: string, actionUrl: string): string {
  return `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#1a1a1a;color:#f0f0f0;border-radius:8px;overflow:hidden">
  <div style="background:#111;padding:24px 32px;border-bottom:3px solid #e63946">
    <div style="font-size:1.6rem;font-weight:900;letter-spacing:0.08em">PULL<span style="color:#e63946">LIST</span></div>
    <div style="font-size:0.75rem;color:#888;margin-top:2px">Ray &amp; Judy's Book Stop &mdash; Monthly Comics Pre-Order System</div>
  </div>
  <div style="padding:32px">
    <h2 style="margin:0 0 16px;font-size:1.1rem;color:#fff">Hi ${name} — reset your password</h2>
    <p style="color:#ccc;line-height:1.7;margin:0 0 24px">
      We received a request to reset the password for your PULLLIST account.
      Click below to choose a new password. This link expires in 1 hour.
    </p>
    <a href="${actionUrl}"
       style="display:inline-block;background:#e63946;color:white;padding:13px 28px;
              border-radius:4px;text-decoration:none;font-weight:700;font-size:0.9rem;
              letter-spacing:0.03em">
      Reset My Password &rarr;
    </a>
    <p style="margin-top:24px;color:#888;font-size:0.82rem;line-height:1.7">
      If you didn't request a password reset, you can safely ignore this email.
      Your password will not change.
    </p>
    <p style="margin-top:16px;font-size:0.78rem;color:#666;line-height:1.6">
      Questions? Stop by or give us a call.<br>
      Ray &amp; Judy's Book Stop &middot; 40 W Main St. Rockaway, NJ 07866 &middot; (973) 586-9182
    </p>
  </div>
  <div style="background:#111;padding:16px 32px;font-size:0.72rem;color:#555;border-top:1px solid #222">
    Ray &amp; Judy's Book Stop &middot; Sent via the PullList pre-order system
  </div>
</div>`
}
