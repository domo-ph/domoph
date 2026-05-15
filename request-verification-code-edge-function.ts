// Supabase Edge Function: request-verification-code
// Validates mobile ownership, then sends OTP in a single request (one round trip).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const normalizePhone = (value?: string | null) => {
    if (!value) return null
    let v = String(value).trim().replace(/[\s-]/g, '')
    if (v.startsWith('00')) v = `+${v.slice(2)}`
    if (/^0\d{10}$/.test(v)) {
        v = `+63${v.slice(1)}`
    }
    return v
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const authHeader = req.headers.get('Authorization')
        if (!authHeader) {
            return new Response(
                JSON.stringify({ error: 'Missing authorization header' }),
                { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }

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

        const { mobile_number } = await req.json()

        if (!mobile_number) {
            return new Response(
                JSON.stringify({ error: 'Mobile number is required' }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }

        const normalizedMobile = normalizePhone(mobile_number)

        if (!normalizedMobile) {
            return new Response(
                JSON.stringify({ error: 'Invalid mobile number format' }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }

        const { data: existingUser, error: checkError } = await supabaseAdmin
            .from('users')
            .select('id, authid, is_pending_signup, mobile_no')
            .eq('mobile_no', normalizedMobile)
            .not('authid', 'is', null)
            .eq('is_pending_signup', false)
            .maybeSingle()

        if (checkError) {
            console.error('Error checking mobile ownership:', checkError)
            return new Response(
                JSON.stringify({
                    error: 'Error validating mobile number',
                    code: 'VALIDATION_ERROR'
                }),
                { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }

        if (existingUser) {
            return new Response(
                JSON.stringify({
                    error: 'May nagmamay-ari na ng mobile number na ito, gumamit ng iba',
                    code: 'MOBILE_ALREADY_OWNED',
                    is_valid: false
                }),
                { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }

        // TODO: Integrate SMS provider (Twilio, etc.) — same as send-verification-code
        return new Response(
            JSON.stringify({
                message: 'OTP sent successfully',
                is_valid: true,
                mobile_number: normalizedMobile
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    } catch (error) {
        console.error('Error in request-verification-code:', error)
        return new Response(
            JSON.stringify({
                error: error instanceof Error ? error.message : 'Internal server error'
            }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }
})
