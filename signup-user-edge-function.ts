// Supabase Edge Function: signup-user
// This function handles user signup with role assignment based on staff_invite table
// Updated to handle existing users with staff invites

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

        const truncateString = (str: string | null | undefined, maxLength: number): string => {
            if (!str) return ''
            return str.length > maxLength ? str.substring(0, maxLength) : str
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
        let { email, password, mobile_no, full_name, first_name, last_name, role } = await req.json()

        // Check if this is an OAuth user FIRST (before validation)
        let isOAuthUser = false
        let existingAuthUser = null
        let authUserId = null

        try {
            // Try to get user from session token
            const token = authHeader.replace('Bearer ', '')
            const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token)
            
            if (!userError && user) {
                isOAuthUser = true
                existingAuthUser = user
                authUserId = user.id
                console.log('OAuth user detected:', user.id)
                
                // For OAuth users, extract name from user metadata if not provided in request
                if (!full_name && user.user_metadata) {
                    const userMeta = user.user_metadata
                    // Google provides: given_name, family_name, name
                    // Apple provides: firstName, lastName, fullName
                    // Facebook provides: first_name, last_name, name
                    full_name = userMeta.full_name || 
                               userMeta.name || 
                               `${userMeta.given_name || userMeta.first_name || userMeta.firstName || ''} ${userMeta.family_name || userMeta.last_name || userMeta.lastName || ''}`.trim() ||
                               user.email?.split('@')[0] || 
                               'User'
                    
                    if (!first_name) {
                        first_name = userMeta.first_name || 
                                    userMeta.given_name || 
                                    userMeta.firstName ||
                                    full_name.split(' ')[0] || 
                                    'User'
                    }
                    
                    if (!last_name) {
                        last_name = userMeta.last_name || 
                                   userMeta.family_name || 
                                   userMeta.lastName || 
                                   full_name.split(' ').slice(1).join(' ') || 
                                   ''
                    }
                    
                    // Also get email from user if not provided
                    if (!email && user.email) {
                        email = user.email
                    }
                    
                    console.log('Extracted OAuth user data:', { full_name, first_name, last_name, email })
                }
            }
        } catch (e) {
            // Not an OAuth user, will create new user
            console.log('Not an OAuth user, proceeding with new user creation')
        }

        // Validate required fields conditionally based on OAuth status
        if (!isOAuthUser) {
            // For regular signup, all fields are required
            if (!password || !mobile_no || !full_name) {
                return new Response(
                    JSON.stringify({ error: 'Missing required fields: password, mobile_no, and full_name are required' }),
                    { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                )
            }
        } else {
            // For OAuth users, only full_name is required initially
            // mobile_no comes later via OTP verification, password is not needed
            if (!full_name) {
                return new Response(
                    JSON.stringify({ error: 'Missing required field: full_name is required' }),
                    { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                )
            }
        }

        // Normalize inputs
        const normalizedEmail = normalizeEmail(email)
        const normalizedMobile = normalizePhone(mobile_no)

        // For OAuth users, always enforce 'kasambahay' role since this is a kasambahay signup path
        // For regular signup, check staff_invite table for matching mobile number or email (status=new)
        // Prefer mobile match first, then email
        let userRole = 'amo' // Default role
        if (isOAuthUser) {
            // OAuth users in this flow are always kasambahay
            userRole = 'kasambahay'
            console.log('OAuth user detected - enforcing kasambahay role')
        } else {
            // For regular signup, use role from request or default to 'amo'
            userRole = role || 'amo'
        }
        let staffInviteFound = null

        // Check by mobile number first (try exact and basic variants)
        if (normalizedMobile) {
            const { data: inviteByMobile, error: mobileError } = await supabaseAdmin
                .from('staff_invite')
                .select('*')
                .or(`mobile.eq.${normalizedMobile},mobile.eq.${mobile_no}`)
                .eq('status', 'new')
                .maybeSingle()

            if (mobileError) {
                console.error('Error looking up staff invite by mobile:', mobileError)
            } else if (!inviteByMobile) {
                console.log('No staff invite found for mobile:', normalizedMobile, 'or', mobile_no)
            } else {
                staffInviteFound = inviteByMobile
                userRole = 'kasambahay'
                console.log('Staff invite found by mobile:', normalizedMobile, 'invite:', inviteByMobile)
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

            if (emailError) {
                console.error('Error looking up staff invite by email:', emailError)
            } else if (!inviteByEmail) {
                console.log('No staff invite found for email:', normalizedEmail, 'or', email)
            } else {
                staffInviteFound = inviteByEmail
                userRole = 'kasambahay'
                console.log('Staff invite found by email:', normalizedEmail, 'invite:', inviteByEmail)
            }
        }

        // Log staff invite lookup result
        console.log('📋 Staff invite lookup result:', {
            staffInviteFound: !!staffInviteFound,
            userRole: userRole,
            staffInviteId: staffInviteFound?.id,
            staffInviteRole: staffInviteFound?.role,
            staffInviteName: staffInviteFound?.name,
            normalizedEmail: normalizedEmail,
            normalizedMobile: normalizedMobile
        })

        // After the initial staff invite lookup, if role is kasambahay but no invite found, try again
        if (userRole === 'kasambahay' && !staffInviteFound) {
            console.warn('⚠️ Role is kasambahay but no staff invite found - attempting lookup again')
            // Retry the lookup with more lenient matching or different status
            if (normalizedEmail) {
                const { data: inviteByEmail, error: emailError } = await supabaseAdmin
                    .from('staff_invite')
                    .select('*')
                    .eq('email', normalizedEmail)
                    .maybeSingle()
                
                if (!emailError && inviteByEmail) {
                    staffInviteFound = inviteByEmail
                    console.log('Staff invite found on retry:', inviteByEmail)
                } else if (emailError) {
                    console.error('Error on retry lookup:', emailError)
                } else {
                    console.log('No staff invite found on retry for email:', normalizedEmail)
                }
            }
            
            // Also try by mobile if available
            if (!staffInviteFound && normalizedMobile) {
                const { data: inviteByMobile, error: mobileError } = await supabaseAdmin
                    .from('staff_invite')
                    .select('*')
                    .eq('mobile', normalizedMobile)
                    .maybeSingle()
                
                if (!mobileError && inviteByMobile) {
                    staffInviteFound = inviteByMobile
                    console.log('Staff invite found on retry by mobile:', inviteByMobile)
                } else if (mobileError) {
                    console.error('Error on retry mobile lookup:', mobileError)
                }
            }
        }

        // Prepare user metadata
        const userMetadata: Record<string, any> = {
            full_name: full_name || '',
            first_name: first_name || full_name?.split(' ')[0] || '',
            last_name: last_name || full_name?.split(' ').slice(1).join(' ') || '',
            mobile_no: normalizedMobile || mobile_no,
            role: userRole
        }

        let authData = null
        let authError = null

        // Handle existing OAuth user (linking mobile number)
        if (isOAuthUser && existingAuthUser) {
            console.log('Handling existing OAuth user - updating profile')
            
            // Update user metadata
            const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
                existingAuthUser.id,
                {
                    user_metadata: {
                        ...existingAuthUser.user_metadata,
                        ...userMetadata
                    }
                }
            )

            if (updateError) {
                console.error('Error updating OAuth user metadata:', updateError)
                return new Response(
                    JSON.stringify({ error: 'Failed to update user profile' }),
                    { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                )
            }

            authData = { user: existingAuthUser }
            authUserId = existingAuthUser.id

        } else {
            // Check if user already exists by email (for non-OAuth signup)
            if (normalizedEmail) {
                try {
                    const { data: existingUserByEmail, error: getUserError } = await supabaseAdmin.auth.admin.getUserByEmail(normalizedEmail)
                    
                    if (!getUserError && existingUserByEmail?.user) {
                        // User exists - check if they have a staff invite
                        if (staffInviteFound) {
                            console.log('User exists with staff invite - updating account')
                            existingAuthUser = existingUserByEmail.user
                            authUserId = existingUserByEmail.user.id
                            
                            // Update existing user's metadata with new info
                            const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
                                existingUserByEmail.user.id,
                                {
                                    user_metadata: {
                                        ...existingUserByEmail.user.user_metadata,
                                        ...userMetadata
                                    }
                                }
                            )

                            if (updateError) {
                                console.error('Error updating existing user:', updateError)
                                return new Response(
                                    JSON.stringify({ error: 'Failed to update user account' }),
                                    { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                                )
                            }

                            authData = { user: existingUserByEmail.user }
                        } else {
                            // User exists but no staff invite - return error
                            return new Response(
                                JSON.stringify({ error: 'A user with this email address has already been registered' }),
                                { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                            )
                        }
                    }
                } catch (e) {
                    // User doesn't exist by email, proceed with creation
                    console.log('User does not exist by email, creating new user')
                }
            }

            // Create new user if not existing
            if (!authData && !existingAuthUser) {
                // Create auth user using Supabase Admin API
                const createResult = await supabaseAdmin.auth.admin.createUser({
                    email: normalizedEmail || `${(normalizedMobile || mobile_no).replace(/\D/g, '')}@domo.ph`,
                    password: password,
                    email_confirm: true, // Auto-confirm email
                    user_metadata: userMetadata
                })

                authData = createResult.data
                authError = createResult.error

                if (authError) {
                    console.error('Auth user creation error:', authError)
                    
                    // If error is "User already registered", check if they have staff invite
                    if (authError.message?.toLowerCase().includes('already registered') || 
                        authError.message?.toLowerCase().includes('already exists')) {
                        
                        // Try to find existing user by email
                        if (normalizedEmail) {
                            try {
                                const { data: existingUserByEmail } = await supabaseAdmin.auth.admin.getUserByEmail(normalizedEmail)
                                
                                if (existingUserByEmail?.user && staffInviteFound) {
                                    // User exists and has staff invite - update instead
                                    console.log('User exists with staff invite - updating account')
                                    existingAuthUser = existingUserByEmail.user
                                    authUserId = existingUserByEmail.user.id
                                    
                                    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
                                        existingUserByEmail.user.id,
                                        {
                                            user_metadata: {
                                                ...existingUserByEmail.user.user_metadata,
                                                ...userMetadata
                                            }
                                        }
                                    )

                                    if (updateError) {
                                        console.error('Error updating existing user:', updateError)
                                        return new Response(
                                            JSON.stringify({ error: 'Failed to update user account' }),
                                            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                                        )
                                    }

                                    authData = { user: existingUserByEmail.user }
                                    authError = null
                                } else {
                                    return new Response(
                                        JSON.stringify({ error: 'A user with this email address has already been registered' }),
                                        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                                    )
                                }
                            } catch (e) {
                                return new Response(
                                    JSON.stringify({ error: authError.message }),
                                    { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                                )
                            }
                        } else {
                            return new Response(
                                JSON.stringify({ error: authError.message }),
                                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                            )
                        }
                    } else {
                        return new Response(
                            JSON.stringify({ error: authError.message }),
                            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                        )
                    }
                }

                if (!authData?.user) {
                    return new Response(
                        JSON.stringify({ error: 'Failed to create user' }),
                        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                    )
                }

                authUserId = authData.user.id
            }
        }

        // =====================================================================================
        // OAuth ghost-user reconciliation (users.is_pending_signup = true AND users.authid IS NULL)
        //
        // Context:
        // - "email/mobile na lang" flow creates a pending users row first (authid NULL).
        // - When the user later completes OAuth, Supabase Auth user already exists, so the DB trigger
        //   migration path may not run (or may not match due to provider-specific fields).
        //
        // Approach (minimal + safe):
        // - Only for OAuth users (we have a real auth user id from the session token).
        // - If there is NOT already a users row for this auth user id, try to find a pending row
        //   matching email first, then mobile.
        // - Priority: Use staff_invite email/mobile if staff invite exists (pending user was likely
        //   created when staff invite was sent), then fall back to OAuth user's email/mobile.
        // - If found, "claim" it by setting authid = authUserId and clearing is_pending_signup.
        //
        // This keeps the original users.id (and therefore preserves FK references) rather than
        // attempting to rewrite ids like the DB trigger does.
        // =====================================================================================
        if (isOAuthUser && authUserId) {
            const { data: alreadyLinkedUser, error: alreadyLinkedUserError } = await supabaseAdmin
                .from('users')
                .select('id')
                .eq('authid', authUserId)
                .maybeSingle()

            if (alreadyLinkedUserError) {
                console.warn('OAuth reconcile: failed to check existing users row:', alreadyLinkedUserError)
            }

            if (!alreadyLinkedUser) {
                let pendingUser: any = null

                // Priority 1: If staff invite found, use its email/mobile to find pending user
                // (pending user was likely created when staff invite was sent)
                if (staffInviteFound) {
                    const inviteEmail = staffInviteFound.email ? normalizeEmail(staffInviteFound.email) : null
                    const inviteMobile = staffInviteFound.mobile ? normalizePhone(staffInviteFound.mobile) : null

                    // Try by staff invite email first
                    if (inviteEmail) {
                        const { data: pendingByInviteEmail, error: inviteEmailError } = await supabaseAdmin
                            .from('users')
                            .select('id, email, mobile_no, household, user_color, role, full_name, first_name, last_name')
                            .eq('is_pending_signup', true)
                            .is('authid', null)
                            .eq('email', inviteEmail)
                            .maybeSingle()

                        if (!inviteEmailError && pendingByInviteEmail) {
                            pendingUser = pendingByInviteEmail
                            console.log('OAuth reconcile: pending user found by staff invite email:', inviteEmail, 'pending_user_id:', pendingUser.id)
                        }
                    }

                    // If not found by invite email, try by invite mobile
                    if (!pendingUser && inviteMobile) {
                        const { data: pendingByInviteMobile, error: inviteMobileError } = await supabaseAdmin
                            .from('users')
                            .select('id, email, mobile_no, household, user_color, role, full_name, first_name, last_name')
                            .eq('is_pending_signup', true)
                            .is('authid', null)
                            .or(`mobile_no.eq.${inviteMobile},mobile_no.eq.${staffInviteFound.mobile}`)
                            .maybeSingle()

                        if (!inviteMobileError && pendingByInviteMobile) {
                            pendingUser = pendingByInviteMobile
                            console.log('OAuth reconcile: pending user found by staff invite mobile:', inviteMobile, 'pending_user_id:', pendingUser.id)
                        }
                    }
                }

                // Priority 2: Fall back to OAuth user's email/mobile if no staff invite match
                if (!pendingUser) {
                    // Prefer matching by normalized email first
                    if (normalizedEmail) {
                        const { data: pendingByEmail, error: pendingByEmailError } = await supabaseAdmin
                            .from('users')
                            .select('id, email, mobile_no, household, user_color, role, full_name, first_name, last_name')
                            .eq('is_pending_signup', true)
                            .is('authid', null)
                            .eq('email', normalizedEmail)
                            .maybeSingle()

                        if (pendingByEmailError) {
                            console.warn('OAuth reconcile: pending-by-email lookup error:', pendingByEmailError)
                        } else if (pendingByEmail) {
                            pendingUser = pendingByEmail
                            console.log('OAuth reconcile: pending user found by email:', normalizedEmail, 'pending_user_id:', pendingUser.id)
                        }
                    }

                    // If not found by email, try matching by normalized mobile
                    if (!pendingUser && normalizedMobile) {
                        const { data: pendingByMobile, error: pendingByMobileError } = await supabaseAdmin
                            .from('users')
                            .select('id, email, mobile_no, household, user_color, role, full_name, first_name, last_name')
                            .eq('is_pending_signup', true)
                            .is('authid', null)
                            .or(`mobile_no.eq.${normalizedMobile},mobile_no.eq.${mobile_no}`)
                            .maybeSingle()

                        if (pendingByMobileError) {
                            console.warn('OAuth reconcile: pending-by-mobile lookup error:', pendingByMobileError)
                        } else if (pendingByMobile) {
                            pendingUser = pendingByMobile
                            console.log('OAuth reconcile: pending user found by mobile:', normalizedMobile, 'pending_user_id:', pendingUser.id)
                        }
                    }
                }

                // Claim pending user row by attaching authid
                if (pendingUser) {
                    const { error: claimError } = await supabaseAdmin
                        .from('users')
                        .update({
                            authid: authUserId,
                            is_pending_signup: false,
                            // backfill basic profile fields if missing
                            email: normalizedEmail || pendingUser.email,
                            mobile_no: normalizedMobile || mobile_no || pendingUser.mobile_no,
                            role: userRole, // Use userRole which is already set correctly by staff invite check
                            full_name: full_name || pendingUser.full_name,
                            first_name: first_name || pendingUser.first_name || '',
                            last_name: last_name || pendingUser.last_name || '',
                            nick_name: staffInviteFound?.name || pendingUser.nick_name || null,
                            specific_role: staffInviteFound ? staffInviteFound.role : pendingUser.specific_role,
                        })
                        .eq('id', pendingUser.id)
                        .eq('is_pending_signup', true)
                        .is('authid', null) // race-safety guard

                    if (claimError) {
                        console.warn('OAuth reconcile: failed to claim pending user row:', claimError)
                    } else {
                        console.log('OAuth reconcile: claimed pending user row successfully:', pendingUser.id, '-> authid:', authUserId)
                    }
                }
            }
        }

        // Wait a moment for database trigger to complete (if exists)
        await new Promise(resolve => setTimeout(resolve, 1000))

        // Check if user profile was created by trigger
        const { data: existingUser, error: fetchError } = await supabaseAdmin
            .from('users')
            .select('*')
            .eq('authid', authUserId)
            .maybeSingle()

        // If user profile doesn't exist, create it manually
        if (!existingUser) {
            const { error: insertError } = await supabaseAdmin
                .from('users')
                .insert({
                    authid: authUserId,
                    email: normalizedEmail || null,
                    full_name: full_name || '',
                    first_name: first_name || full_name?.split(' ')[0] || '',
                    last_name: last_name || full_name?.split(' ').slice(1).join(' ') || '',
                    mobile_no: normalizedMobile || mobile_no || null,
                    role: userRole,
                    nick_name: staffInviteFound?.name || null,
                    specific_role: staffInviteFound ? staffInviteFound.role : null,
                    onboarded: false,
                    onboarding_page: null
                })

            if (insertError) {
                console.error('User profile creation error:', insertError)
                // Don't fail the request - auth user is created, profile can be fixed later
                return new Response(
                    JSON.stringify({
                        success: true,
                        user: authData?.user || existingAuthUser,
                        warning: 'User created but profile setup incomplete. Please contact support.',
                        role: userRole
                    }),
                    { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                )
            }
        } else {
            // Update existing user profile with correct role and mobile_no
            const { error: updateError } = await supabaseAdmin
                .from('users')
                .update({
                    mobile_no: normalizedMobile || mobile_no || existingUser.mobile_no,
                    role: userRole,
                    email: normalizedEmail || existingUser.email,
                    full_name: full_name || existingUser.full_name,
                    first_name: first_name || existingUser.first_name || '',
                    last_name: last_name || existingUser.last_name || '',
                    nick_name: staffInviteFound?.name || existingUser.nick_name || null,
                    specific_role: staffInviteFound ? staffInviteFound.role : existingUser.specific_role
                })
                .eq('authid', authUserId)

            if (updateError) {
                console.error('User profile update error:', updateError)
            }
        }

        // If staff invite was found, assign household, set specific_role, ensure membership, and mark invite as done
        if (staffInviteFound) {
            console.log('✅ Staff invite found - proceeding with household and specific_role assignment:', {
                staffInviteId: staffInviteFound.id,
                staffInviteRole: staffInviteFound.role,
                staffInviteName: staffInviteFound.name,
                staffInviteHouseholdId: staffInviteFound.household_id,
                authUserId: authUserId
            })
            
            // 1) Fetch the user profile (to get users.id)
            const { data: userRow, error: userFetchError } = await supabaseAdmin
                .from('users')
                .select('id, household, specific_role')
                .eq('authid', authUserId)
                .maybeSingle()

            if (userFetchError || !userRow) {
                console.error('❌ Failed to fetch users row for household assignment:', userFetchError)
            } else {
                console.log('📋 Current user row before update:', {
                    userId: userRow.id,
                    currentHousehold: userRow.household,
                    currentSpecificRole: userRow.specific_role
                })
                
                const householdId = staffInviteFound.household_id
                console.log('🔍 Staff invite update - Preparing to update user:', {
                    userId: userRow.id,
                    householdId: householdId,
                    specific_role: staffInviteFound.role,
                    nick_name: staffInviteFound.name,
                    staffInviteId: staffInviteFound.id,
                    staffInviteData: staffInviteFound
                })
                
                // 2) Update users table with household, specific_role, and nick_name (idempotent)
                // specific_role should always match the role from staff_invite
                const { error: userUpdateHouseholdError, data: updateResult } = await supabaseAdmin
                    .from('users')
                    .update({
                        household: householdId,
                        specific_role: staffInviteFound.role,
                        nick_name: staffInviteFound.name || null,
                    })
                    .eq('id', userRow.id)
                    .select('id, household, specific_role, nick_name')

                if (userUpdateHouseholdError) {
                    console.error('❌ Failed to update users.household/specific_role:', userUpdateHouseholdError)
                } else {
                    console.log('✅ Successfully updated user with staff invite data:', updateResult)
                    if (updateResult && updateResult.length > 0) {
                        console.log('📊 Updated user record:', {
                            id: updateResult[0].id,
                            household: updateResult[0].household,
                            specific_role: updateResult[0].specific_role,
                            nick_name: updateResult[0].nick_name
                        })
                    }
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

            // Mark staff invite as done and link user_id
            // FIX: Use defensive update to handle cases where trigger already updated it
            // This prevents deletion and ensures user_id is always set
            if (userRow && userRow.id) {
                // First, check current state of staff_invite
                const { data: currentInvite, error: checkError } = await supabaseAdmin
                    .from('staff_invite')
                    .select('status, user_id')
                    .eq('id', staffInviteFound.id)
                    .maybeSingle()

                if (checkError) {
                    console.error('Error checking staff_invite current state:', checkError)
                }

                // CRITICAL: Always update to ensure user_id is set (prevents CASCADE deletion)
                // Use defensive SET logic to only change status if needed, but always ensure user_id
                const { error: inviteUpdateError, data: inviteUpdateResult } = await supabaseAdmin
                    .from('staff_invite')
                    .update({ 
                        status: currentInvite?.status === 'new' ? 'done' : (currentInvite?.status || 'done'),
                        user_id: userRow.id,  // Always set user_id to prevent deletion
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', staffInviteFound.id)

                if (inviteUpdateError) {
                    console.error('❌ Staff invite status update error:', inviteUpdateError)
                    // Don't fail the request - this is just a status update
                } else {
                    console.log('✅ Staff invite updated: status=done, user_id=' + userRow.id, inviteUpdateResult)
                }
            } else {
                console.warn('⚠️ Cannot update staff_invite: userRow.id not available')
            }
        }

        // Return success response
        return new Response(
            JSON.stringify({
                success: true,
                user: authData?.user || existingAuthUser,
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

