// Supabase Edge Function: handle-signup
// This function handles user signup with role assignment based on staff_invite table
//
// Token-based invite flow (new):
// - Accepts optional 'invite_token' parameter (UUID from staff_invite.id)
// - Calls consume_invite_token RPC to validate and consume token
// - Uses token data to assign household, role, and specific_role
// - Falls back to mobile/email matching if token invalid/not provided (backward compatibility)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/** Migrate household_members from pending user to signed-up user (RPC may not include this). */
async function migratePendingUserHouseholdMembers(
    supabaseAdmin: ReturnType<typeof createClient>,
    pendingUserId: string,
    newUserId: string,
    label: string
) {
    const { data: pendingMembers, error: fetchErr } = await supabaseAdmin
        .from('household_members')
        .select('household_id')
        .eq('user_id', pendingUserId)
    if (fetchErr) {
        console.warn('[SIGNUP][' + label + '] Failed to fetch pending user household_members:', fetchErr)
        return
    }
    if (!pendingMembers?.length) return
    for (const row of pendingMembers) {
        const { data: existing } = await supabaseAdmin
            .from('household_members')
            .select('id')
            .eq('household_id', row.household_id)
            .eq('user_id', newUserId)
            .maybeSingle()
        if (!existing) {
            const { error: insertErr } = await supabaseAdmin
                .from('household_members')
                .insert({ household_id: row.household_id, user_id: newUserId })
            if (insertErr) console.warn('[SIGNUP][' + label + '] Failed to insert household_members:', insertErr)
            else console.log('[SIGNUP][' + label + '] Migrated household_members:', row.household_id, '->', newUserId)
        }
    }
    const { error: deleteErr } = await supabaseAdmin
        .from('household_members')
        .delete()
        .eq('user_id', pendingUserId)
    if (deleteErr) console.warn('[SIGNUP][' + label + '] Failed to delete pending user household_members:', deleteErr)
}

serve(async (req) => {
    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        // Get the authorization header and create Supabase client
        const authHeader = req.headers.get('Authorization')
        if (!authHeader) {
            return new Response(
                JSON.stringify({ error: 'Missing authorization header' }),
                { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }

        // Helpers
        const normalizeEmail = (value?: string | null) =>
            (value || '').trim().toLowerCase() || null

        const normalizePhone = (value?: string | null) => {
            if (!value) return null
            // Remove all spaces and hyphens
            let v = String(value).trim().replace(/[\s-]/g, '')
            // Convert leading 00 to +
            if (v.startsWith('00')) v = `+${v.slice(2)}`
            // Ensure Philippines local numbers are converted to +63 format (best-effort)
            if (/^0\d{10}$/.test(v)) {
                // 11-digits starting with 0 -> assume PH and convert
                v = `+63${v.slice(1)}`
            }
            // If still no plus, but looks like country code-less, keep digits
            return v
        }

        // Create Supabase admin client (for admin operations)
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
            {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false
                }
            }
        )

        // Parse request body
        const requestBody = await req.json()
        console.log('[SIGNUP] Full request body received:', JSON.stringify(requestBody, null, 2))

        const { email, password, mobile_no, full_name, first_name, last_name, invite_token, token, link_existing_user } = requestBody

        // Support both 'invite_token' and 'token' parameter names (token is what web page sends)
        const inviteToken = invite_token || token
        console.log('[SIGNUP] Extracted token values - invite_token:', invite_token, 'token:', token, 'final inviteToken:', inviteToken)

        // Normalize inputs first (needed for validation)
        const normalizedEmail = normalizeEmail(email)
        const normalizedMobile = normalizePhone(mobile_no)

        // Detect OAuth-authenticated flow:
        // - Request comes with a user session JWT in Authorization header (from OAuth sign-in)
        // - Frontend sends a placeholder password
        const jwt = authHeader.replace(/^Bearer\s+/i, '').trim()
        const isOAuthPlaceholderPassword =
            typeof password === 'string' && password === 'oauth_authenticated_user_no_password_required'
        const isOAuthFlow = !!jwt && (isOAuthPlaceholderPassword || !!requestBody.user_id)

        // --- Link existing user (migrate to kas): "Ako 'yan!" flow ---
        if (link_existing_user && inviteToken && (normalizedEmail || normalizedMobile)) {
            try {
                const rpcResponse = await supabaseAdmin.rpc('consume_invite_token', { token_uuid: inviteToken })
                const tokenResult = rpcResponse.data
                const tokenError = rpcResponse.error
                if (tokenError || !tokenResult?.success || !tokenResult?.data) {
                    return new Response(
                        JSON.stringify({ error: tokenResult?.error || tokenError?.message || 'Invalid or expired invite' }),
                        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                    )
                }
                const inv = tokenResult.data
                const householdId = inv.household_id
                const inviteRole = inv.role || null
                const inviteName = inv.name || inv.nickname || ''

                const q = supabaseAdmin.from('users').select('id, authid, household, role')
                const { data: existingUserRow, error: userFindErr } = normalizedEmail
                    ? await q.eq('email', normalizedEmail).maybeSingle()
                    : await q.eq('mobile_no', normalizedMobile).maybeSingle()

                if (userFindErr || !existingUserRow) {
                    return new Response(
                        JSON.stringify({ error: 'Existing user not found for this email or mobile number' }),
                        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                    )
                }

                const { error: updErr } = await supabaseAdmin
                    .from('users')
                    .update({
                        household: householdId,
                        specific_role: inviteRole,
                        nick_name: inviteName,
                        role: 'kasambahay'
                    })
                    .eq('id', existingUserRow.id)

                if (updErr) {
                    console.error('[SIGNUP] link_existing_user update error:', updErr)
                    return new Response(
                        JSON.stringify({ error: updErr.message }),
                        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                    )
                }

                const { data: existingMember } = await supabaseAdmin
                    .from('household_members')
                    .select('id')
                    .eq('household_id', householdId)
                    .eq('user_id', existingUserRow.id)
                    .maybeSingle()

                if (!existingMember) {
                    await supabaseAdmin.from('household_members').insert({
                        household_id: householdId,
                        user_id: existingUserRow.id
                    })
                }

                // Token-based reconciliation (link flow):
                // If the invite had a placeholder/pending user_id, migrate its data to the existing user and delete it.
                const pendingUserId = inv.user_id ?? null
                if (pendingUserId) {
                    try {
                        const { data: pendingUser } = await supabaseAdmin.from('users').select('user_color').eq('id', pendingUserId).maybeSingle()
                        const pendingUserColor = pendingUser?.user_color ?? null
                        if (pendingUserColor) {
                            console.log('[SIGNUP] link_existing_user: Inheriting pending user color:', pendingUserColor)
                        }
                        console.log('[SIGNUP] link_existing_user: migrate_pending_user_to_authenticated(', pendingUserId, ',', existingUserRow.id, ')')
                        const { data: migrationResult, error: migrationError } = await supabaseAdmin.rpc('migrate_pending_user_to_authenticated', {
                            old_user_id: pendingUserId,
                            new_user_id: existingUserRow.id,
                        })
                        if (migrationError) {
                            console.error('[SIGNUP] link_existing_user: migrate_pending_user_to_authenticated error:', migrationError)
                        } else if (migrationResult?.success !== false) {
                            await migratePendingUserHouseholdMembers(supabaseAdmin, pendingUserId, existingUserRow.id, 'link_existing_user')
                            if (pendingUserColor) {
                                const { error: colorErr } = await supabaseAdmin.from('users').update({ user_color: pendingUserColor }).eq('id', existingUserRow.id)
                                if (colorErr) console.warn('[SIGNUP] link_existing_user: Failed to set user_color:', colorErr)
                                else console.log('[SIGNUP] link_existing_user: Set signed-up user color from pending:', pendingUserColor)
                            }
                            const { error: deleteError } = await supabaseAdmin.from('users').delete().eq('id', pendingUserId)
                            if (deleteError) {
                                console.warn('[SIGNUP] link_existing_user: Failed to delete placeholder user after migration:', deleteError)
                            } else {
                                console.log('[SIGNUP] link_existing_user: Placeholder user deleted after successful migration:', pendingUserId)
                            }
                        }
                    } catch (reconcileErr) {
                        console.error('[SIGNUP] link_existing_user: Reconciliation error (non-fatal):', reconcileErr)
                    }
                }

                return new Response(
                    JSON.stringify({
                        success: true,
                        message: 'Account linked successfully. Welcome, kasambahay!',
                        user_id: existingUserRow.id
                    }),
                    { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                )
            } catch (linkErr) {
                console.error('[SIGNUP] link_existing_user error:', linkErr)
                return new Response(
                    JSON.stringify({ error: linkErr?.message || 'Failed to link account' }),
                    { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                )
            }
        }

        // For OAuth flow, we upsert profile for the already-authenticated user.
        // For password signup, we create a new auth user.
        if (!isOAuthFlow) {
            // Validate required fields: password and full_name always; either mobile_no or email required
            if (!password || !full_name) {
                return new Response(
                    JSON.stringify({ error: 'Missing required fields: password and full_name are required' }),
                    { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                )
            }
            if (!normalizedMobile && !normalizedEmail) {
                return new Response(
                    JSON.stringify({ error: 'Either mobile number or email is required' }),
                    { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                )
            }
        }

        // Check for staff invite - prioritize token-based lookup, then fallback to mobile/email matching
        let userRole = 'amo' // Default role
        let staffInviteFound: any = null

        // Priority 1: Check for invite_token/token parameter (tokenized invite URL)
        // Use validate_invite_token (read-only) so token stays valid for "Ako 'yan!" (link_existing_user) if createUser fails
        if (inviteToken) {
            try {
                console.log('[SIGNUP] Validating invite token (no consume):', inviteToken)
                console.log('[SIGNUP] Request body received:', { email, mobile_no, full_name, invite_token, token, inviteToken })

                const rpcResponse = await supabaseAdmin.rpc('validate_invite_token', {
                    token_uuid: inviteToken
                })

                console.log('[SIGNUP] Full RPC response:', JSON.stringify(rpcResponse, null, 2))
                console.log('[SIGNUP] RPC data:', rpcResponse.data)
                console.log('[SIGNUP] RPC error:', rpcResponse.error)

                // Supabase RPC returns { data: <return_value>, error: <error> }
                // Our RPC function returns { success: true, data: {...} } or { success: false, error: "..." }
                const tokenResult = rpcResponse.data
                const tokenError = rpcResponse.error

                if (!tokenError && tokenResult) {
                    console.log('[SIGNUP] Token result structure:', {
                        hasSuccess: 'success' in tokenResult,
                        success: tokenResult.success,
                        hasData: 'data' in tokenResult,
                        data: tokenResult.data,
                        fullResult: tokenResult
                    })

                    if (tokenResult.success && tokenResult.data) {
                        // Token is valid (validate_invite_token does NOT consume) - use invite data
                        staffInviteFound = {
                            id: tokenResult.data.id,
                            email: tokenResult.data.email,
                            name: tokenResult.data.name || tokenResult.data.nickname,
                            role: tokenResult.data.role,
                            household_id: tokenResult.data.household_id,
                            status: tokenResult.data.status || 'new', // Validate returns current status; we mark 'done' after createUser success
                            user_id: tokenResult.data.user_id ?? null,
                        }
                        userRole = 'kasambahay' // Set role to kasambahay for staff invites
                        console.log('[SIGNUP] ✅ Invite token validated successfully. Setting role to kasambahay. Invite data:', JSON.stringify(staffInviteFound, null, 2))
                    } else {
                        // Token invalid/expired/used - log but continue with fallback
                        console.warn('[SIGNUP] ❌ Invite token validation failed. Success:', tokenResult.success, 'Error:', tokenResult.error, 'Full result:', JSON.stringify(tokenResult, null, 2))
                        // Fall through to mobile/email matching as fallback
                    }
                } else {
                    // RPC call itself failed
                    console.error('[SIGNUP] ❌ RPC call failed:', tokenError)
                    // Fall through to mobile/email matching as fallback
                }
            } catch (tokenErr) {
                console.error('[SIGNUP] ❌ Exception calling validate_invite_token RPC:', tokenErr)
                // Fall through to mobile/email matching as fallback
            }
        } else {
            console.log('[SIGNUP] ⚠️ No invite token provided in request. inviteToken:', inviteToken, 'invite_token:', invite_token, 'token:', token)
        }

        // Priority 2: Fallback to mobile/email matching (backward compatibility)
        if (!staffInviteFound) {
            // Check by mobile number first (try exact and basic variants)
            if (normalizedMobile) {
                const { data: inviteByMobile, error: mobileError } = await supabaseAdmin
                    .from('staff_invite')
                    .select('*')
                    .or(`mobile.eq.${normalizedMobile},mobile.eq.${mobile_no}`)
                    .eq('status', 'new')
                    .maybeSingle()

                if (!mobileError && inviteByMobile) {
                    staffInviteFound = inviteByMobile
                    userRole = 'kasambahay'
                }
            }

            // If not found by mobile, check by email (if email is provided)
            if (!staffInviteFound && normalizedEmail) {
                const { data: inviteByEmail, error: emailError } = await supabaseAdmin
                    .from('staff_invite')
                    .select('*')
                    .or(`email.eq.${normalizedEmail},email.eq.${email}`)
                    .eq('status', 'new')
                    .maybeSingle()

                if (!emailError && inviteByEmail) {
                    staffInviteFound = inviteByEmail
                    userRole = 'kasambahay'
                }
            }
        }

        // Prepare user metadata
        // Invite name is used only as nickname; full_name/first_name/last_name come from request
        const inviteNickname = staffInviteFound?.name || full_name || '' // Use invite name as nickname only

        console.log('[SIGNUP] Creating user with role:', userRole, 'Invite found:', !!staffInviteFound, 'Invite name (nickname only):', staffInviteFound?.name, 'Staff invite:', JSON.stringify(staffInviteFound, null, 2))

        const userMetadata: Record<string, any> = {
            full_name: full_name || '',
            first_name: first_name || full_name?.split(' ')[0] || '',
            last_name: last_name || full_name?.split(' ').slice(1).join(' ') || '',
            mobile_no: normalizedMobile || mobile_no,
            role: userRole, // This should be 'kasambahay' if invite found
            nickname: inviteNickname // Set nickname from invite if available
        }

        // OAuth flow: user already exists in auth; fetch user from JWT and upsert profile
        if (isOAuthFlow) {
            const { data: authUserData, error: authUserError } = await supabaseAdmin.auth.getUser(jwt)
            if (authUserError || !authUserData?.user) {
                console.error('[SIGNUP] OAuth getUser error:', authUserError)
                return new Response(
                    JSON.stringify({ error: authUserError?.message || 'Invalid auth session' }),
                    { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                )
            }

            const authUser = authUserData.user
            const oauthEmail = normalizedEmail || normalizeEmail(authUser.email) || null
            const oauthFullName =
                (full_name || authUser.user_metadata?.full_name || authUser.user_metadata?.name || oauthEmail || 'User')

            if (!oauthEmail && !normalizedMobile) {
                return new Response(
                    JSON.stringify({ error: 'Either mobile number or email is required' }),
                    { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                )
            }

            // Upsert user profile row based on authid
            const { data: existingUser, error: fetchError } = await supabaseAdmin
                .from('users')
                .select('*')
                .eq('authid', authUser.id)
                .maybeSingle()

            if (fetchError) {
                console.error('[SIGNUP] OAuth fetch users error:', fetchError)
            }

            const profilePayload = {
                authid: authUser.id,
                email: oauthEmail,
                full_name: oauthFullName,
                first_name: userMetadata.first_name || oauthFullName.split(' ')[0] || '',
                last_name: userMetadata.last_name || oauthFullName.split(' ').slice(1).join(' ') || '',
                nick_name: inviteNickname || userMetadata.nickname || '',
                mobile_no: normalizedMobile || mobile_no || authUser.user_metadata?.mobile_no || null,
                role: userRole,
                onboarded: existingUser?.onboarded ?? false,
                onboarding_page: existingUser?.onboarding_page ?? null,
            }

            if (!existingUser) {
                const { error: insertError } = await supabaseAdmin.from('users').insert(profilePayload)
                if (insertError) {
                    console.error('[SIGNUP] OAuth user profile insert error:', insertError)
                    return new Response(
                        JSON.stringify({ error: insertError.message }),
                        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                    )
                }
            } else {
                const { error: updateError } = await supabaseAdmin
                    .from('users')
                    .update({
                        email: profilePayload.email || existingUser.email,
                        full_name: profilePayload.full_name || existingUser.full_name,
                        first_name: profilePayload.first_name || existingUser.first_name,
                        last_name: profilePayload.last_name || existingUser.last_name,
                        nick_name: profilePayload.nick_name || existingUser.nick_name,
                        mobile_no: profilePayload.mobile_no || existingUser.mobile_no,
                        role: userRole,
                    })
                    .eq('authid', authUser.id)
                if (updateError) {
                    console.error('[SIGNUP] OAuth user profile update error:', updateError)
                }
            }

            // If staff invite was found, assign household, set specific_role, ensure membership, reconcile pending user, and mark invite as done
            if (staffInviteFound) {
                // Resolve pendingUserId early so we can skip household_members insert when reconciling (avoids duplicate row)
                let pendingUserId = (staffInviteFound as { user_id?: string | null }).user_id ?? null
                if (!pendingUserId && staffInviteFound?.id) {
                    const { data: inviteRow } = await supabaseAdmin
                        .from('staff_invite')
                        .select('user_id')
                        .eq('id', staffInviteFound.id)
                        .maybeSingle()
                    pendingUserId = inviteRow?.user_id ?? null
                    if (pendingUserId) {
                        console.log('[SIGNUP][OAuth] Fetched pending user_id from staff_invite:', pendingUserId)
                    }
                }

                const { data: userRow, error: userFetchError } = await supabaseAdmin
                    .from('users')
                    .select('id, household')
                    .eq('authid', authUser.id)
                    .maybeSingle()

                if (userFetchError || !userRow) {
                    console.error('Failed to fetch users row for household assignment:', userFetchError)
                } else {
                    const householdId = staffInviteFound.household_id
                    const inviteNickname = staffInviteFound.name || full_name || ''
                    const { error: userUpdateHouseholdError } = await supabaseAdmin
                        .from('users')
                        .update({
                            household: householdId,
                            specific_role: staffInviteFound.role || null,
                            nick_name: inviteNickname,
                            role: 'kasambahay',
                        })
                        .eq('id', userRow.id)

                    if (userUpdateHouseholdError) {
                        console.error('Failed to update users.household/specific_role:', userUpdateHouseholdError)
                    } else {
                        // Only insert household_members when not reconciling a pending user (reconciliation adds it and avoids duplicate)
                        const { data: existingMember, error: memberCheckError } = await supabaseAdmin
                            .from('household_members')
                            .select('id')
                            .eq('household_id', householdId)
                            .eq('user_id', userRow.id)
                            .maybeSingle()

                        if (!existingMember && !memberCheckError && !pendingUserId) {
                            const { error: insertMemberError } = await supabaseAdmin
                                .from('household_members')
                                .insert({ household_id: householdId, user_id: userRow.id })
                            if (insertMemberError) {
                                console.error('Failed to insert household_members row:', insertMemberError)
                            }
                        }
                    }
                }

                if (!pendingUserId && staffInviteFound?.id) {
                    console.log('[SIGNUP][OAuth] No pending user_id on staff_invite; skipping reconciliation for invite id:', staffInviteFound.id)
                }
                if (pendingUserId && userRow?.id) {
                    try {
                        const { data: pendingUser } = await supabaseAdmin.from('users').select('user_color').eq('id', pendingUserId).maybeSingle()
                        const pendingUserColor = pendingUser?.user_color ?? null
                        if (pendingUserColor) {
                            console.log('[SIGNUP][OAuth] Inheriting pending user color:', pendingUserColor)
                        }
                        console.log('[SIGNUP][OAuth] Reconciling placeholder user: migrate_pending_user_to_authenticated(', pendingUserId, ',', userRow.id, ')')
                        const { data: migrationResult, error: migrationError } = await supabaseAdmin.rpc('migrate_pending_user_to_authenticated', {
                            old_user_id: pendingUserId,
                            new_user_id: userRow.id,
                        })
                        if (migrationError) {
                            console.error('[SIGNUP][OAuth] migrate_pending_user_to_authenticated error:', migrationError)
                        } else if (migrationResult?.success !== false) {
                            await migratePendingUserHouseholdMembers(supabaseAdmin, pendingUserId, userRow.id, 'OAuth')
                            if (pendingUserColor) {
                                const { error: colorErr } = await supabaseAdmin.from('users').update({ user_color: pendingUserColor }).eq('id', userRow.id)
                                if (colorErr) console.warn('[SIGNUP][OAuth] Failed to set user_color:', colorErr)
                                else console.log('[SIGNUP][OAuth] Set signed-up user color from pending:', pendingUserColor)
                            }
                            const { error: deleteError } = await supabaseAdmin.from('users').delete().eq('id', pendingUserId)
                            if (deleteError) {
                                console.warn('[SIGNUP][OAuth] Failed to delete placeholder user after migration:', deleteError)
                            } else {
                                console.log('[SIGNUP][OAuth] Placeholder user deleted after successful migration (OAuth):', pendingUserId)
                            }
                        }
                    } catch (reconcileErr) {
                        console.error('[SIGNUP][OAuth] Reconciliation error (non-fatal):', reconcileErr)
                    }
                }

                if (staffInviteFound.status !== 'done') {
                    const { error: inviteUpdateError } = await supabaseAdmin
                        .from('staff_invite')
                        .update({ status: 'done' })
                        .eq('id', staffInviteFound.id)
                    if (inviteUpdateError) console.error('Staff invite status update error:', inviteUpdateError)
                }
            }

            return new Response(
                JSON.stringify({
                    success: true,
                    user: authUser,
                    role: userRole,
                    message: 'OAuth account processed successfully.',
                }),
                { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }

        // Password signup flow: Create auth user using Supabase Admin API
        const authEmail = normalizedEmail || (normalizedMobile ? `${String(normalizedMobile).replace(/\D/g, '')}@domo.ph` : 'noreply@domo.ph')
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email: authEmail,
            password: password,
            email_confirm: true,
            user_metadata: userMetadata
        })

        if (authError) {
            console.error('Auth user creation error:', authError)
            const msg = (authError.message || '').toLowerCase()
            const isAlreadyRegistered = /already|registered|exists|duplicate/i.test(msg)
            const body = isAlreadyRegistered
                ? { error: 'Email or mobile number already registered. Please log in instead.' }
                : { error: authError.message }
            const status = isAlreadyRegistered ? 409 : 400
            return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
        }

        if (!authData.user) {
            return new Response(
                JSON.stringify({ error: 'Failed to create user' }),
                { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }

        // Wait a moment for database trigger to complete (if exists)
        await new Promise(resolve => setTimeout(resolve, 1000))

        // Check if user profile was created by trigger
        const { data: existingUser, error: fetchError } = await supabaseAdmin
            .from('users')
            .select('*')
            .eq('authid', authData.user.id)
            .maybeSingle()

        // If user profile doesn't exist, create it manually
        if (!existingUser) {
            // Full/first/last from request only; invite name only as nickname
            const finalName = full_name || ''
            const finalFirstName = first_name || finalName?.split(' ')[0] || ''
            const finalLastName = last_name || finalName?.split(' ').slice(1).join(' ') || ''
            const finalNickname = staffInviteFound?.name || full_name || '' // Invite name as nickname only

            const { error: insertError } = await supabaseAdmin
                .from('users')
                .insert({
                    authid: authData.user.id,
                    email: normalizedEmail || null,
                    full_name: finalName,
                    first_name: finalFirstName,
                    last_name: finalLastName,
                    nick_name: finalNickname, // Set nickname from invite
                    mobile_no: normalizedMobile || mobile_no,
                    role: userRole,
                    onboarded: false,
                    onboarding_page: null
                })

            if (insertError) {
                console.error('User profile creation error:', insertError)
                // Don't fail the request - auth user is created, profile can be fixed later
                return new Response(
                    JSON.stringify({
                        success: true,
                        user: authData.user,
                        warning: 'User created but profile setup incomplete. Please contact support.',
                        role: userRole
                    }),
                    { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                )
            }
        } else {
            // Update existing user profile with correct role and mobile_no
            // Full/first/last from request or existing user; invite name only as nickname
            const finalName = full_name || existingUser.full_name || ''
            const finalFirstName = first_name || full_name?.split(' ')[0] || existingUser.first_name || ''
            const finalLastName = last_name || full_name?.split(' ').slice(1).join(' ') || existingUser.last_name || ''
            const finalNickname = staffInviteFound?.name || full_name || existingUser.nick_name || '' // Invite name as nickname only

            const { error: updateError } = await supabaseAdmin
                .from('users')
                .update({
                    mobile_no: normalizedMobile || mobile_no,
                    role: userRole, // This should be 'kasambahay' if invite found
                    email: normalizedEmail || existingUser.email,
                    full_name: finalName,
                    first_name: finalFirstName,
                    last_name: finalLastName,
                    nick_name: finalNickname // Set nickname from invite
                })
                .eq('authid', authData.user.id)

            if (updateError) {
                console.error('User profile update error:', updateError)
            }
        }

        // If staff invite was found, assign household, set specific_role, ensure membership, and mark invite as done
        if (staffInviteFound) {
            // Resolve pendingUserId early so we can skip household_members insert when reconciling (avoids duplicate row)
            let pendingUserId = (staffInviteFound as { user_id?: string | null }).user_id ?? null
            if (!pendingUserId && staffInviteFound?.id) {
                const { data: inviteRow } = await supabaseAdmin
                    .from('staff_invite')
                    .select('user_id')
                    .eq('id', staffInviteFound.id)
                    .maybeSingle()
                pendingUserId = inviteRow?.user_id ?? null
                if (pendingUserId) {
                    console.log('[SIGNUP] Fetched pending user_id from staff_invite (manual signup):', pendingUserId)
                }
            }

            // 1) Fetch the just-created user profile (to get users.id)
            const { data: userRow, error: userFetchError } = await supabaseAdmin
                .from('users')
                .select('id, household')
                .eq('authid', authData.user.id)
                .maybeSingle()

            if (userFetchError || !userRow) {
                console.error('Failed to fetch users row for household assignment:', userFetchError)
            } else {
                const householdId = staffInviteFound.household_id
                // 2) Update users table with household, specific_role, and nickname (idempotent)
                const inviteNickname = staffInviteFound.name || full_name || ''
                console.log('[SIGNUP] Updating user with household:', householdId, 'specific_role:', staffInviteFound.role, 'nickname:', inviteNickname)

                const { error: userUpdateHouseholdError } = await supabaseAdmin
                    .from('users')
                    .update({
                        household: householdId,
                        specific_role: staffInviteFound.role || null,
                        nick_name: inviteNickname, // Set nickname from invite
                        role: 'kasambahay' // Ensure role is kasambahay (in case it wasn't set correctly earlier)
                    })
                    .eq('id', userRow.id)

                if (userUpdateHouseholdError) {
                    console.error('Failed to update users.household/specific_role:', userUpdateHouseholdError)
                } else {
                    // 3) Ensure household_members entry exists (idempotent). Skip when reconciling pending user (migratePendingUserHouseholdMembers adds it).
                    const { data: existingMember, error: memberCheckError } = await supabaseAdmin
                        .from('household_members')
                        .select('id')
                        .eq('household_id', householdId)
                        .eq('user_id', userRow.id)
                        .maybeSingle()

                    if (!existingMember && !memberCheckError && !pendingUserId) {
                        const { error: insertMemberError } = await supabaseAdmin
                            .from('household_members')
                            .insert({ household_id: householdId, user_id: userRow.id })
                        if (insertMemberError) {
                            console.error('Failed to insert household_members row:', insertMemberError)
                        }
                    }
                }
            }

            // 4) Token-based reconciliation: migrate placeholder user to new user, then delete placeholder
            if (!pendingUserId && staffInviteFound?.id) {
                console.log('[SIGNUP] No pending user_id on staff_invite; skipping reconciliation for invite id:', staffInviteFound.id)
            }
            // Use existing userRow.id or re-fetch if initial fetch failed (e.g. trigger delay) so we can still reconcile
            let newUserId = userRow?.id ?? null
            if (pendingUserId && !newUserId && authData?.user?.id) {
                const { data: refetched } = await supabaseAdmin
                    .from('users')
                    .select('id')
                    .eq('authid', authData.user.id)
                    .maybeSingle()
                newUserId = refetched?.id ?? null
                if (newUserId) console.log('[SIGNUP] Re-fetched user row for reconciliation:', newUserId)
            }
            if (pendingUserId && newUserId) {
                try {
                    const { data: pendingUser } = await supabaseAdmin.from('users').select('user_color').eq('id', pendingUserId).maybeSingle()
                    const pendingUserColor = pendingUser?.user_color ?? null
                    if (pendingUserColor) {
                        console.log('[SIGNUP] Inheriting pending user color (manual signup):', pendingUserColor)
                    }
                    console.log('[SIGNUP] Reconciling placeholder user: migrate_pending_user_to_authenticated(', pendingUserId, ',', newUserId, ')')
                    const { data: migrationResult, error: migrationError } = await supabaseAdmin.rpc('migrate_pending_user_to_authenticated', {
                        old_user_id: pendingUserId,
                        new_user_id: newUserId,
                    })
                    if (migrationError) {
                        console.error('[SIGNUP] migrate_pending_user_to_authenticated error:', migrationError)
                    } else if (migrationResult?.success !== false) {
                        await migratePendingUserHouseholdMembers(supabaseAdmin, pendingUserId, newUserId, 'manual signup')
                        if (pendingUserColor) {
                            const { error: colorErr } = await supabaseAdmin.from('users').update({ user_color: pendingUserColor }).eq('id', newUserId)
                            if (colorErr) console.warn('[SIGNUP] Failed to set user_color:', colorErr)
                            else console.log('[SIGNUP] Set signed-up user color from pending (manual signup):', pendingUserColor)
                        }
                        const { error: deleteError } = await supabaseAdmin.from('users').delete().eq('id', pendingUserId)
                        if (deleteError) {
                            console.warn('[SIGNUP] Failed to delete placeholder user after migration:', deleteError)
                        } else {
                            console.log('[SIGNUP] Placeholder user deleted after successful migration (manual signup):', pendingUserId)
                        }
                    }
                } catch (reconcileErr) {
                    console.error('[SIGNUP] Reconciliation error (non-fatal):', reconcileErr)
                }
            }

            // Only update status if not already done (token-based invites are already marked as 'done' by RPC)
            if (staffInviteFound.status !== 'done') {
                const { error: inviteUpdateError } = await supabaseAdmin
                    .from('staff_invite')
                    .update({ status: 'done' })
                    .eq('id', staffInviteFound.id)

                if (inviteUpdateError) {
                    console.error('Staff invite status update error:', inviteUpdateError)
                    // Don't fail the request - this is just a status update
                }
            } else {
                console.log('Invite already marked as done (token-based)')
            }
        }

        // Return success response
        return new Response(
            JSON.stringify({
                success: true,
                user: authData.user,
                role: userRole,
                message: userRole === 'kasambahay'
                    ? 'Account created successfully. Welcome, kasambahay!'
                    : 'Account created successfully. Welcome!'
            }),
            { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )

    } catch (error) {
        console.error('Unexpected error:', error)
        return new Response(
            JSON.stringify({ error: error.message || 'An unexpected error occurred' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }
})
