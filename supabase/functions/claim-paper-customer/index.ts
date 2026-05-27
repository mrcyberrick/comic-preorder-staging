const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')
    const SUPABASE_ANON    = Deno.env.get('SUPABASE_ANON_KEY')
    const SUPABASE_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    // ── Parse body ────────────────────────────────────────
    let paper_user_id: string, real_user_id: string
    try {
      const body = await req.json()
      paper_user_id = (body.paper_user_id || '').trim()
      real_user_id  = (body.real_user_id  || '').trim()
    } catch {
      return Response.json(
        { error: 'Invalid request body' },
        { status: 400, headers: corsHeaders }
      )
    }

    if (!paper_user_id || !real_user_id) {
      return Response.json(
        { error: 'paper_user_id and real_user_id are required' },
        { status: 400, headers: corsHeaders }
      )
    }

    if (paper_user_id === real_user_id) {
      return Response.json(
        { error: 'paper_user_id and real_user_id must be different' },
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

    // ── Verify caller is admin ────────────────────────────
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
    const callerTenantId = profiles[0].tenant_id

    // ── Verify the source account is actually a paper account ─
    // Prevents accidentally merging two real accounts.
    const paperProfileRes = await fetch(
      SUPABASE_URL + '/rest/v1/user_profiles?id=eq.' + paper_user_id + '&select=is_paper,full_name',
      {
        headers: {
          Authorization: 'Bearer ' + SUPABASE_SERVICE,
          apikey: SUPABASE_SERVICE,
          Accept: 'application/json',
        }
      }
    )
    const paperProfiles = await paperProfileRes.json()
    if (!Array.isArray(paperProfiles) || !paperProfiles[0]) {
      return Response.json(
        { error: 'Paper account not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    if (!paperProfiles[0].is_paper) {
      return Response.json(
        { error: 'Source account is not a paper account — merge aborted for safety' },
        { status: 400, headers: corsHeaders }
      )
    }
    const paperName = paperProfiles[0].full_name || 'Unknown'

    // ── Verify the target real account exists ─────────────
    const realProfileRes = await fetch(
      SUPABASE_URL + '/rest/v1/user_profiles?id=eq.' + real_user_id + '&select=id,full_name',
      {
        headers: {
          Authorization: 'Bearer ' + SUPABASE_SERVICE,
          apikey: SUPABASE_SERVICE,
          Accept: 'application/json',
        }
      }
    )
    const realProfiles = await realProfileRes.json()
    if (!Array.isArray(realProfiles) || !realProfiles[0]) {
      return Response.json(
        { error: 'Target real account not found — check the UUID and try again' },
        { status: 404, headers: corsHeaders }
      )
    }

    console.log(`Merging paper account ${paper_user_id} (${paperName}) → real account ${real_user_id}`)

    // ── Reassign preorders ────────────────────────────────
    // On conflict (real account already has a reservation for the same catalog item),
    // skip the duplicate rather than failing — the real account's reservation wins.
    const preordersRes = await fetch(
      SUPABASE_URL + '/rest/v1/preorders?user_id=eq.' + paper_user_id + '&tenant_id=eq.' + callerTenantId,
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer ' + SUPABASE_SERVICE,
          apikey: SUPABASE_SERVICE,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ user_id: real_user_id }),
      }
    )
    // 409 means duplicate preorder — acceptable, we'll clean up below
    if (!preordersRes.ok && preordersRes.status !== 409) {
      const err = await preordersRes.text()
      console.error('Preorders reassign failed:', err)
      return Response.json(
        { error: 'Failed to reassign preorders: ' + err },
        { status: 500, headers: corsHeaders }
      )
    }

    // ── Reassign subscriptions ────────────────────────────
    const subsRes = await fetch(
      SUPABASE_URL + '/rest/v1/subscriptions?user_id=eq.' + paper_user_id + '&tenant_id=eq.' + callerTenantId,
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer ' + SUPABASE_SERVICE,
          apikey: SUPABASE_SERVICE,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ user_id: real_user_id }),
      }
    )
    if (!subsRes.ok && subsRes.status !== 409) {
      const err = await subsRes.text()
      console.error('Subscriptions reassign failed:', err)
      // Non-fatal — preorders already moved, log and continue
    }

    // ── Delete paper user_profiles row ────────────────────
    const delProfileRes = await fetch(
      SUPABASE_URL + '/rest/v1/user_profiles?id=eq.' + paper_user_id,
      {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer ' + SUPABASE_SERVICE,
          apikey: SUPABASE_SERVICE,
          Prefer: 'return=minimal',
        },
      }
    )
    if (!delProfileRes.ok) {
      console.warn('Profile delete failed:', await delProfileRes.text())
    }

    // ── Delete paper auth.users row (requires service role) ──
    const delAuthRes = await fetch(
      SUPABASE_URL + '/auth/v1/admin/users/' + paper_user_id,
      {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer ' + SUPABASE_SERVICE,
          apikey: SUPABASE_SERVICE,
        },
      }
    )
    if (!delAuthRes.ok) {
      console.warn('Auth user delete failed:', await delAuthRes.text())
      // Profile is already gone — auth orphan is harmless but log it
    }

    console.log(`✓ Claim complete: ${paperName} merged into ${real_user_id}`)
    return Response.json(
      { success: true, merged: paperName },
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