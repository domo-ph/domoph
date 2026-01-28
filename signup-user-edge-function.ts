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

        const { email, password, mobile_no, full_name, first_name, last_name, invite_token, token } = requestBody

        // Support both 'invite_token' and 'token' parameter names (token is what web page sends)
        const inviteToken = invite_token || token
        console.log('[SIGNUP] Extracted token values - invite_token:', invite_token, 'token:', token, 'final inviteToken:', inviteToken)

        // Normalize inputs first (needed for validation)
        const normalizedEmail = normalizeEmail(email)
        const normalizedMobile = normalizePhone(mobile_no)

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

        // Check for staff invite - prioritize token-based lookup, then fallback to mobile/email matching
        let userRole = 'amo' // Default role
        let staffInviteFound = null

        // Priority 1: Check for invite_token/token parameter (tokenized invite URL)
        if (inviteToken) {
            try {
                console.log('[SIGNUP] Checking invite token:', inviteToken)
                console.log('[SIGNUP] Request body received:', { email, mobile_no, full_name, invite_token, token, inviteToken })

                const rpcResponse = await supabaseAdmin.rpc('consume_invite_token', {
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
                        // Token is valid and consumed - use invite data (include user_id for placeholder reconciliation)
                        // Note: RPC already marked invite as 'done', so we just use the data
                        staffInviteFound = {
                            id: tokenResult.data.id, // BIGINT id from database (not the token UUID)
                            email: tokenResult.data.email,
                            name: tokenResult.data.name || tokenResult.data.nickname,
                            role: tokenResult.data.role,
                            household_id: tokenResult.data.household_id,
                            status: 'done', // Already marked as done by RPC
                            user_id: tokenResult.data.user_id ?? null, // Pending user UUID for migrate_pending_user_to_authenticated
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
                console.error('[SIGNUP] ❌ Exception calling consume_invite_token RPC:', tokenErr)
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
        // If staff invite found, use invite data for name (nickname from invite)
        const inviteName = staffInviteFound?.name || full_name || ''
        const inviteNickname = staffInviteFound?.name || full_name || '' // Use invite name as nickname

        console.log('[SIGNUP] Creating user with role:', userRole, 'Invite found:', !!staffInviteFound, 'Invite name:', inviteName, 'Staff invite:', JSON.stringify(staffInviteFound, null, 2))

        const userMetadata: Record<string, any> = {
            full_name: inviteName || full_name || '',
            first_name: first_name || inviteName?.split(' ')[0] || full_name?.split(' ')[0] || '',
            last_name: last_name || inviteName?.split(' ').slice(1).join(' ') || full_name?.split(' ').slice(1).join(' ') || '',
            mobile_no: normalizedMobile || mobile_no,
            role: userRole, // This should be 'kasambahay' if invite found
            nickname: inviteNickname // Set nickname from invite if available
        }

        // Create auth user using Supabase Admin API
        const authEmail = normalizedEmail || (normalizedMobile ? `${String(normalizedMobile).replace(/\D/g, '')}@domo.ph` : 'noreply@domo.ph')
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email: authEmail, // Use provided email, or mobile-based, or fallback when email-only
            password: password,
            email_confirm: true, // Auto-confirm email
            user_metadata: userMetadata
        })

        if (authError) {
            console.error('Auth user creation error:', authError)
            return new Response(
                JSON.stringify({ error: authError.message }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
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
            // Use invite data if available
            const finalName = staffInviteFound?.name || full_name || ''
            const finalFirstName = first_name || finalName?.split(' ')[0] || ''
            const finalLastName = last_name || finalName?.split(' ').slice(1).join(' ') || ''
            const finalNickname = staffInviteFound?.name || full_name || '' // Use invite name as nickname

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
            // Use invite data if available
            const finalName = staffInviteFound?.name || full_name || existingUser.full_name || ''
            const finalFirstName = first_name || finalName?.split(' ')[0] || existingUser.first_name || ''
            const finalLastName = last_name || finalName?.split(' ').slice(1).join(' ') || existingUser.last_name || ''
            const finalNickname = staffInviteFound?.name || full_name || existingUser.nick_name || ''

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
                    // 3) Ensure household_members entry exists (idempotent)
                    const { data: existingMember, error: memberCheckError } = await supabaseAdmin
                        .from('household_members')
                        .select('id')
                        .eq('household_id', householdId)
                        .eq('user_id', userRow.id)
                        .maybeSingle()

                    if (!existingMember && !memberCheckError) {
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
            const pendingUserId = (staffInviteFound as { user_id?: string }).user_id
            if (pendingUserId && userRow?.id) {
                try {
                    console.log('[SIGNUP] Reconciling placeholder user: migrate_pending_user_to_authenticated(', pendingUserId, ',', userRow.id, ')')
                    const { data: migrationResult, error: migrationError } = await supabaseAdmin.rpc('migrate_pending_user_to_authenticated', {
                        old_user_id: pendingUserId,
                        new_user_id: userRow.id,
                    })
                    if (migrationError) {
                        console.error('[SIGNUP] migrate_pending_user_to_authenticated error:', migrationError)
                    } else if (migrationResult?.success !== false) {
                        const { error: deleteError } = await supabaseAdmin.from('users').delete().eq('id', pendingUserId)
                        if (deleteError) {
                            console.warn('[SIGNUP] Failed to delete placeholder user after migration:', deleteError)
                        } else {
                            console.log('[SIGNUP] Placeholder user deleted after successful migration:', pendingUserId)
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
