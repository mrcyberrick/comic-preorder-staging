/**
 * register-customer — Public Edge Function
 *
 * Called by MailerLite webhook when a new subscriber is confirmed.
 * Creates a pending Supabase account, stores the profile, generates
 * a magic link, and sends a branded "browse while we review" email.
 *
 * Webhook URL to configure in MailerLite:
 *   https://<project>.supabase.co/functions/v1/register-customer?secret=<MAILERLITE_WEBHOOK_SECRET>
 *
 * Required env vars (set in Supabase → Edge Functions → Secrets):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILERSEND_API_KEY
 *   MAILERLITE_WEBHOOK_SECRET   ← shared secret, paste into MailerLite webhook URL
 *   FOUNDING_TENANT_ID          ← UUID of the tenant new users are assigned to
 *
 * MailerLite webhook event: subscriber.created (or subscriber.updated)
 *
 * F34 note: This function intentionally keeps tenant_id = FOUNDING_TENANT_ID.
 * It is webhook-driven (called by MailerLite, not by an admin), so there is no
 * caller context from which to resolve a tenant. All MailerLite subscribers are
 * assumed to belong to the founding tenant. This assumption must be revisited
 * before a second tenant onboards — options include per-tenant webhook URLs,
 * per-tenant MailerLite groups, or a tenant lookup by domain. Until then,
 * this function only works correctly for the founding tenant's MailerLite group.
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
    const SUPABASE_SERVICE   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const MAILERSEND_API_KEY = Deno.env.get('MAILERSEND_API_KEY')
    const WEBHOOK_SECRET     = Deno.env.get('MAILERLITE_WEBHOOK_SECRET')
    const FOUNDING_TENANT_ID = Deno.env.get('FOUNDING_TENANT_ID')

    if (!FOUNDING_TENANT_ID) {
      console.warn('register-customer: FOUNDING_TENANT_ID secret not set')
    }

    // ── Validate webhook secret ─────────────────────────────────
    const url    = new URL(req.url)
    const secret = url.searchParams.get('secret')
    if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
      console.warn('register-customer: invalid webhook secret')
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
    }

    // ── Parse MailerLite webhook body ───────────────────────────
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders })
    }

    // ── Group filter ────────────────────────────────────────────
    // Only process subscribers added to the PULLLIST onboarding group.
    // All other MailerLite groups (newsletters, other landing pages) are ignored.
    const REQUIRED_GROUP = 'Monthly Comics'

    // subscriber.added_to_group payload shape:
    //   body.data.subscriber  — the subscriber object
    //   body.data.group       — the group object { id, name, ... }
    const data        = body?.data as Record<string, unknown> | undefined
    const group       = data?.group as Record<string, unknown> | undefined
    const groupName   = (group?.name as string | undefined)?.trim() || ''

    if (groupName && groupName !== REQUIRED_GROUP) {
      console.log(`register-customer: ignoring group "${groupName}" — not "${REQUIRED_GROUP}"`)
      return Response.json({ success: true, note: 'ignored_group' }, { headers: corsHeaders })
    }

    // ── Parse subscriber ─────────────────────────────────────
    const subscriber: Record<string, unknown> =
      data?.subscriber as Record<string, unknown>
      || body?.subscriber as Record<string, unknown>
      || body

    const email     = (subscriber?.email as string | undefined)?.trim()
    const fields    = subscriber?.fields as Record<string, unknown> | undefined
    const firstName = ((fields?.name ?? subscriber?.name) as string | undefined)?.trim() || ''
    const lastName  = ((fields?.last_name ?? subscriber?.last_name) as string | undefined)?.trim() || ''
    const fullName  = [firstName, lastName].filter(Boolean).join(' ') || email?.split('@')[0] || 'Customer'

    if (!email || !email.includes('@')) {
      console.error('register-customer: no valid email in payload', JSON.stringify(body))
      return Response.json({ error: 'No valid email in payload' }, { status: 400, headers: corsHeaders })
    }

    console.log(`register-customer: processing ${fullName} <${email}> from group "${groupName}")`)

    // ── Create Supabase auth user (no password, email pre-confirmed) ──
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE}`,
        'apikey':        SUPABASE_SERVICE!,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        email,
        email_confirm:  true,
        user_metadata:  { full_name: fullName },
      }),
    })
    const createData = await createRes.json()

    if (!createRes.ok) {
      const msg = ((createData.msg || createData.message || '') as string).toLowerCase()
      if (msg.includes('already') || msg.includes('duplicate') || createData.code === 'email_exists') {
        // Duplicate MailerLite submission — account already created, no action needed
        console.log(`register-customer: duplicate for ${email}, skipping`)
        return Response.json({ success: true, note: 'already_exists' }, { headers: corsHeaders })
      }
      console.error('register-customer: user create failed', JSON.stringify(createData))
      return Response.json({ error: 'Failed to create account' }, { status: 500, headers: corsHeaders })
    }

    const userId = createData.id as string | undefined
    if (!userId) {
      return Response.json({ error: 'No user ID in response' }, { status: 500, headers: corsHeaders })
    }

    // ── Insert user_profiles row (status = 'pending') ────────────
    // tenant_id is FOUNDING_TENANT_ID: this webhook has no caller context from which
    // to resolve the admin's tenant. See F34 note at the top of this file.
    const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE}`,
        'apikey':        SUPABASE_SERVICE!,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        id:        userId,
        full_name: fullName,
        email,
        status:    'pending',
        is_admin:  false,
        tenant_id: FOUNDING_TENANT_ID,
      }),
    })
    if (!profileRes.ok) {
      console.error('register-customer: profile insert failed', await profileRes.text())
    }

    // ── Generate magic link so customer can browse immediately ───
    const linkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE}`,
        'apikey':        SUPABASE_SERVICE!,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        type:        'magiclink',
        email,
        redirect_to: `${APP_BASE_URL}/catalog.html`,
      }),
    })
    const linkData   = await linkRes.json()
    const hashedToken = linkData.hashed_token as string | undefined

    const magicUrl = hashedToken
      ? `${APP_INDEX_URL}?token_hash=${hashedToken}&type=magiclink`
      : `${APP_BASE_URL}/`

    if (!hashedToken) {
      console.warn('register-customer: magic link generation failed', JSON.stringify(linkData))
    }

    // ── Send branded "browse while we review" email ──────────────
    const mailRes = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MAILERSEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    { email: 'noreply@mrcyberrick.us', name: "Ray & Judy's Book Stop" },
        to:      [{ email, name: fullName }],
        subject: "Ray & Judy's Book Stop — Your PULLLIST access is being set up",
        html:    buildPendingEmail(fullName, magicUrl),
      }),
    })

    if (!mailRes.ok) {
      const mailErr = await mailRes.json().catch(() => ({}))
      console.error('register-customer: MailerSend error', JSON.stringify(mailErr))
    }

    console.log(`register-customer: complete for ${email} (userId: ${userId})`)
    return Response.json({ success: true, user_id: userId }, { headers: corsHeaders })

  } catch (err) {
    console.error('register-customer: unexpected error', String(err))
    return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders })
  }
})

// ── Email template ────────────────────────────────────────────────────────────
function buildPendingEmail(name: string, magicUrl: string): string {
  return `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#1a1a1a;color:#f0f0f0;border-radius:8px;overflow:hidden">
  <div style="background:#111;padding:24px 32px;border-bottom:3px solid #e63946">
    <div style="font-size:1.6rem;font-weight:900;letter-spacing:0.08em">PULL<span style="color:#e63946">LIST</span></div>
    <div style="font-size:0.75rem;color:#888;margin-top:2px">Ray &amp; Judy's Book Stop &mdash; Monthly Comics Pre-Order System</div>
  </div>
  <div style="padding:32px">
    <h2 style="margin:0 0 16px;font-size:1.1rem;color:#fff">Hi ${name} — we received your request</h2>
    <p style="color:#ccc;line-height:1.7;margin:0 0 16px">
      Thanks for signing up for the PULLLIST pre-order system at Ray &amp; Judy's Book Stop.
      Your account has been created and is being reviewed.
    </p>
    <p style="color:#ccc;line-height:1.7;margin:0 0 24px">
      In the meantime, click below to browse the upcoming catalog. Once your account is
      approved, you'll be able to reserve titles for your pull list each month.
    </p>
    <a href="${magicUrl}"
       style="display:inline-block;background:#e63946;color:white;padding:13px 28px;
              border-radius:4px;text-decoration:none;font-weight:700;font-size:0.9rem;
              letter-spacing:0.03em">
      Browse the Catalog &rarr;
    </a>
    <div style="margin-top:24px;background:rgba(255,255,255,0.04);
                border-left:3px solid rgba(232,57,70,0.4);padding:12px 16px;
                border-radius:0 4px 4px 0">
      <div style="font-size:0.78rem;color:#aaa;line-height:1.8">
        &#10003;&nbsp; Reservations will be available once your account is confirmed<br>
        &#10003;&nbsp; This link is for your use only &mdash; do not share it<br>
        &#10003;&nbsp; Link expires after use &mdash; use Forgot Password on the login page for a new one<br>
        &#10003;&nbsp; Questions? Call us at (973) 586-9182
      </div>
    </div>
    <p style="margin-top:24px;font-size:0.78rem;color:#666;line-height:1.6">
      Ray &amp; Judy's Book Stop &middot; 40 W Main St. Rockaway, NJ 07866 &middot; (973) 586-9182
    </p>
  </div>
  <div style="background:#111;padding:16px 32px;font-size:0.72rem;color:#555;border-top:1px solid #222">
    Ray &amp; Judy's Book Stop &middot; Sent via the PullList pre-order system
  </div>
</div>`
}
