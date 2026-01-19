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

        // Check staff_invite table for matching mobile number or email (status=new)
        // Prefer mobile match first, then email
        let userRole = role || 'amo' // Default role (or from request)
        let staffInviteFound = null

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
                console.log('Staff invite found by mobile:', normalizedMobile)
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
                console.log('Staff invite found by email:', normalizedEmail)
            }
        }

        // Prepare user metadata (truncate fields to fit database constraints)
        const userMetadata: Record<string, any> = {
            full_name: full_name || '',
            first_name: truncateString(first_name || full_name?.split(' ')[0] || '', 20),
            last_name: truncateString(last_name || full_name?.split(' ').slice(1).join(' ') || '', 20),
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
                    first_name: truncateString(first_name || full_name?.split(' ')[0] || '', 20),
                    last_name: truncateString(last_name || full_name?.split(' ').slice(1).join(' ') || '', 20),
                    mobile_no: normalizedMobile || mobile_no || null,
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
                    first_name: truncateString(first_name || existingUser.first_name, 20),
                    last_name: truncateString(last_name || existingUser.last_name, 20)
                })
                .eq('authid', authUserId)

            if (updateError) {
                console.error('User profile update error:', updateError)
            }
        }

        // If staff invite was found, assign household, set specific_role, ensure membership, and mark invite as done
        if (staffInviteFound) {
            // 1) Fetch the user profile (to get users.id)
            const { data: userRow, error: userFetchError } = await supabaseAdmin
                .from('users')
                .select('id, household')
                .eq('authid', authUserId)
                .maybeSingle()

            if (userFetchError || !userRow) {
                console.error('Failed to fetch users row for household assignment:', userFetchError)
            } else {
                const householdId = staffInviteFound.household_id
                // 2) Update users table with household and specific_role (idempotent)
                const { error: userUpdateHouseholdError } = await supabaseAdmin
                    .from('users')
                    .update({
                        household: householdId,
                        specific_role: staffInviteFound.role || null,
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

            // Mark staff invite as done
            const { error: inviteUpdateError } = await supabaseAdmin
                .from('staff_invite')
                .update({ status: 'done' })
                .eq('id', staffInviteFound.id)

            if (inviteUpdateError) {
                console.error('Staff invite status update error:', inviteUpdateError)
                // Don't fail the request - this is just a status update
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

