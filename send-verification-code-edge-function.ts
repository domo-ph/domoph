// Supabase Edge Function: send-verification-code
// This function sends OTP verification code to mobile numbers

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
        // Get the authorization header
        const authHeader = req.headers.get('Authorization')
        if (!authHeader) {
            return new Response(
                JSON.stringify({ error: 'Missing authorization header' }),
                { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }

        // Helper function to normalize phone number (matching signup-user logic)
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
        const { mobile_number } = await req.json()

        if (!mobile_number) {
            return new Response(
                JSON.stringify({ error: 'Mobile number is required' }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }

        // Normalize mobile number
        const normalizedMobile = normalizePhone(mobile_number)

        if (!normalizedMobile) {
            return new Response(
                JSON.stringify({ error: 'Invalid mobile number format' }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }

        // TODO: Add your OTP sending logic here
        // This is where you would integrate with your SMS provider (Twilio, etc.)
        // For now, returning a success response
        
        return new Response(
            JSON.stringify({ 
                message: 'OTP sent successfully',
                // Include any additional data your frontend needs
            }),
            { 
                status: 200, 
                headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
            }
        )

    } catch (error) {
        console.error('Error in send-verification-code:', error)
        return new Response(
            JSON.stringify({ 
                error: error instanceof Error ? error.message : 'Internal server error' 
            }),
            { 
                status: 500, 
                headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
            }
        )
    }
})

