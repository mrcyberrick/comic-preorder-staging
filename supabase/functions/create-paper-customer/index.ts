const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  // Always respond OK to OPTIONS so the browser CORS preflight passes
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')
    const SUPABASE_ANON      = Deno.env.get('SUPABASE_ANON_KEY')
    const SUPABASE_SERVICE   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const FOUNDING_TENANT_ID = Deno.env.get('FOUNDING_TENANT_ID')

    if (!FOUNDING_TENANT_ID) {
      console.warn('create-paper-customer: FOUNDING_TENANT_ID secret not set')
    }

    // ── Parse body ────────────────────────────────────────
    let name: string, email: string
    try {
      const body = await req.json()
      name  = (body.name  || '').trim()
      email = (body.email || '').trim()
    } catch {
      return Response.json(
        { error: 'Invalid request body' },
        { status: 400, headers: corsHeaders }
      )
    }

    if (!name || !email) {
      return Response.json(
        { error: 'name and email are required' },
        { status: 400, headers: corsHeaders }
      )
    }

    // ── Verify caller is authenticated ────────────────────
    const authHeader = req.headers.get('Authorization') || ''
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: authHeader, apikey: SUPABASE_ANON }
    })
    const userData = await userRes.json()
    if (!userRes.ok || !userData.id) {
      return Response.json(
        { error: 'Unauthorized' },
        { status: 401, headers: corsHeaders }
      )
    }

    // ── Verify caller is admin — also fetch tenant_id for F34 fix ─────
    const profileRes = await fetch(
      SUPABASE_URL + '/rest/v1/user_profiles?id=eq.' + userData.id + '&select=is_admin,tenant_id',
      { headers: { Authorization: authHeader, apikey: SUPABASE_ANON, Accept: 'application/json' } }
    )
    const profiles = await profileRes.json()
    if (!Array.isArray(profiles) || !profiles[0]?.is_admin) {
      return Response.json(
        { error: 'Forbidden — admin only' },
        { status: 403, headers: corsHeaders }
      )
    }

    // Resolve the creating admin's tenant — fall back to FOUNDING_TENANT_ID if lookup fails
    const callerTenantId = profiles[0]?.tenant_id || FOUNDING_TENANT_ID

    // ── Create auth user (service role, no email sent) ────
    // We use a random password — paper customers never log in directly.
    // email_confirm: true skips any confirmation email entirely.
    const createRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + SUPABASE_SERVICE,
        apikey:        SUPABASE_SERVICE,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password:      crypto.randomUUID(),   // never used
        email_confirm: true,                  // skip confirmation email
        user_metadata: { full_name: name },
      }),
    })

    const createData = await createRes.json()
    console.log('create user response:', JSON.stringify(createData))

    if (!createRes.ok) {
      const msg = (createData.msg || createData.message || createData.error_description || '').toLowerCase()
      if (msg.includes('already') || msg.includes('duplicate') || msg.includes('exists')) {
        return Response.json(
          { error: 'A user with this email already exists' },
          { status: 409, headers: corsHeaders }
        )
      }
      return Response.json(
        { error: createData.msg || createData.message || 'Failed to create user' },
        { status: 400, headers: corsHeaders }
      )
    }

    const userId = createData.id
    if (!userId) {
      console.error('No user ID in response:', JSON.stringify(createData))
      return Response.json(
        { error: 'User created but ID not returned' },
        { status: 500, headers: corsHeaders }
      )
    }

    // ── Create user_profiles row ──────────────────────────
    // is_paper = true marks this account as admin-managed.
    // status = 'active' so it never appears in the Pending tab.
    // created_by_admin = true matches the pattern in invite-customer.
    // tenant_id scopes the profile to the creating admin's tenant.
    const profRes = await fetch(SUPABASE_URL + '/rest/v1/user_profiles', {
      method: 'POST',
      headers: {
        Authorization:  'Bearer ' + SUPABASE_SERVICE,
        apikey:          SUPABASE_SERVICE,
        'Content-Type': 'application/json',
        Prefer:         'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        id:               userId,
        full_name:        name,
        email:            email,
        status:           'active',
        is_admin:         false,
        is_paper:         true,
        created_by_admin: true,
        tenant_id:        callerTenantId,
      }),
    })

    if (!profRes.ok) {
      const profErr = await profRes.json().catch(() => ({}))
      console.error('user_profiles insert failed:', JSON.stringify(profErr))
      // Auth user was created — don't fail silently, return partial success with warning
      return Response.json(
        { error: 'Auth user created but profile insert failed', user_id: userId },
        { status: 500, headers: corsHeaders }
      )
    }

    console.log('Paper customer created:', userId, name, email)
    return Response.json(
      { success: true, user_id: userId, email },
      { headers: corsHeaders }
    )

  } catch (err) {
    console.error('Unexpected error:', String(err))
    return Response.json(
      { error: String(err) },
      { status: 500, headers: corsHeaders }
    )
  }
})
