import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  generateOtpCode,
  getOtpCooldownSeconds,
  getOtpRecipientRateLimit,
  maskPhone,
  normalizePhoneNumberIntl,
  selectVerificationBackend,
  sendSms,
  startVerification,
} from '../_shared/smsProvider.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Rate-limit defaults added in Phase 1.5 of the API key hardening plan.
// Counts recent rows in signup_codes / password_reset_codes for the recipient
// (mobile_number or email) and rejects sends that exceed the per-recipient
// 24h cap. A cooldown also prevents back-to-back sends from a single
// retry-spam loop.
const DEFAULT_RECIPIENT_LIMIT_PER_24H = 5
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_COOLDOWN_SECONDS = 30

interface RateLimitOk {
  ok: true
}
interface RateLimitDenied {
  ok: false
  status: number
  error: string
}

async function checkRateLimit(
  supabaseAdmin: SupabaseClient,
  purpose: 'signup' | 'password_reset',
  recipientType: 'mobile_number' | 'email',
  recipient: string,
): Promise<RateLimitOk | RateLimitDenied> {
  const defaultLimit = Number(Deno.env.get('OTP_RATE_RECIPIENT_24H') ?? DEFAULT_RECIPIENT_LIMIT_PER_24H) || DEFAULT_RECIPIENT_LIMIT_PER_24H
  const limit = recipientType === 'mobile_number'
    ? getOtpRecipientRateLimit(recipient, defaultLimit)
    : defaultLimit
  const defaultCooldown = Number(Deno.env.get('OTP_COOLDOWN_SECONDS') ?? DEFAULT_COOLDOWN_SECONDS) || DEFAULT_COOLDOWN_SECONDS
  const cooldownSeconds = recipientType === 'mobile_number'
    ? getOtpCooldownSeconds(recipient, defaultCooldown)
    : defaultCooldown

  const table = purpose === 'signup' ? 'signup_codes' : 'password_reset_codes'
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString()

  // 24-hour count
  const { count, error: countErr } = await supabaseAdmin
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(recipientType, recipient)
    .gte('created_at', since)

  if (countErr) {
    console.error(`[send-verification-code] rate-limit count error (${table}):`, countErr.message)
    return { ok: false, status: 500, error: 'Rate limit check failed' }
  }
  if ((count ?? 0) >= limit) {
    return {
      ok: false,
      status: 429,
      error: 'Verification code rate limit exceeded. Please wait before requesting another code.',
    }
  }

  // Cooldown: most recent row must be older than `cooldownSeconds`.
  const { data: latest, error: latestErr } = await supabaseAdmin
    .from(table)
    .select('created_at')
    .eq(recipientType, recipient)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ created_at: string }>()

  if (latestErr) {
    console.error(`[send-verification-code] cooldown lookup error (${table}):`, latestErr.message)
    return { ok: false, status: 500, error: 'Rate limit check failed' }
  }
  if (latest?.created_at) {
    const ageMs = Date.now() - new Date(latest.created_at).getTime()
    if (ageMs < cooldownSeconds * 1000) {
      const retryAfter = Math.ceil((cooldownSeconds * 1000 - ageMs) / 1000)
      return {
        ok: false,
        status: 429,
        error: `Please wait ${retryAfter} seconds before requesting another code.`,
      }
    }
  }

  return { ok: true }
}

/**
 * Generate a random 4-digit numeric code
 */
function generateVerificationCode(): string {
  return Math.floor(1000 + Math.random() * 9000).toString()
}

/**
 * Create verification code message
 */
function createVerificationMessage(code: string, purpose: 'signup' | 'password_reset' = 'signup'): string {
  if (purpose === 'password_reset') {
    return `Your Domo password reset code is: ${code}\n\nThis code will expire in 10 minutes. Do not share this code with anyone.`
  }
  return `Your Domo verification code is: ${code}\n\nThis code will expire in 10 minutes. Do not share this code with anyone.`
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
    const { mobile_number, email, purpose = 'signup' } = requestBody

    // Validate required fields - must have either mobile_number or email, but not both
    if (!mobile_number && !email) {
      return new Response(
        JSON.stringify({ error: 'Missing required field: mobile_number or email must be provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (mobile_number && email) {
      return new Response(
        JSON.stringify({ error: 'Cannot provide both mobile_number and email. Provide only one.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate purpose
    if (purpose !== 'signup' && purpose !== 'password_reset') {
      return new Response(
        JSON.stringify({ error: 'Invalid purpose. Must be "signup" or "password_reset"' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // For password_reset, verify user exists
    if (purpose === 'password_reset') {
      if (mobile_number) {
        const formattedNumber = normalizePhoneNumberIntl(mobile_number)
        if (!formattedNumber) {
          return new Response(
            JSON.stringify({ error: 'Invalid mobile number format' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        const { data: userExists, error: userCheckError } = await supabaseAdmin
          .from('users')
          .select('id')
          .eq('mobile_no', formattedNumber)
          .maybeSingle()

        if (userCheckError) {
          console.error('❌ Error checking user existence:', userCheckError)
          return new Response(
            JSON.stringify({ error: 'Failed to verify user account' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        if (!userExists) {
          // Don't reveal that user doesn't exist (security best practice)
          // Return success but don't actually send SMS
          console.log(`⚠️ Password reset requested for non-existent user: ${formattedNumber}`)
          return new Response(
            JSON.stringify({
              success: true,
              message: 'If an account exists with this mobile number, a verification code has been sent.',
              message_id: 'hidden',
              recipient: formattedNumber,
              expires_in: 600
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
      } else if (email) {
        // Check if user exists by email in auth.users using getUserByEmail
        const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.getUserByEmail(email)

        if (authError && authError.message !== 'User not found') {
          console.error('❌ Error checking user existence:', authError)
          return new Response(
            JSON.stringify({ error: 'Failed to verify user account' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }

        if (!authUser || !authUser.user) {
          // Don't reveal that user doesn't exist (security best practice)
          console.log(`⚠️ Password reset requested for non-existent user: ${email}`)
          return new Response(
            JSON.stringify({
              success: true,
              message: 'If an account exists with this email, a verification code has been sent.',
              message_id: 'hidden',
              recipient: email,
              expires_in: 600
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
      }
    }

    // Resolve canonical recipient up-front so we can rate-limit before
    // generating the code or hitting the SMS provider. Email is left
    // case-sensitive so the rate-limit key matches what gets stored in
    // password_reset_codes.email (the existence check above also reads the
    // raw value).
    let canonicalRecipient: string
    let recipientType: 'mobile_number' | 'email'
    if (mobile_number) {
      const normalized = normalizePhoneNumberIntl(mobile_number)
      if (!normalized) {
        return new Response(
          JSON.stringify({ error: 'Invalid mobile number format' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      canonicalRecipient = normalized
      recipientType = 'mobile_number'
    } else {
      canonicalRecipient = (email as string).trim()
      recipientType = 'email'
    }

    // Phase 1.5 of API key hardening: per-recipient rate limit.
    const rate = await checkRateLimit(
      supabaseAdmin,
      purpose,
      recipientType,
      canonicalRecipient,
    )
    if (!rate.ok) {
      console.warn(`[send-verification-code] rate-limited ${recipientType}=${canonicalRecipient.slice(0, 4)}*** purpose=${purpose}: ${rate.error}`)
      return new Response(
        JSON.stringify({ error: rate.error }),
        { status: rate.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    let sendResponse: Record<string, unknown> | undefined
    let recipient: string
    let verificationCode: string | null = null
    let verifySid: string | null = null
    let otpProvider: 'semaphore' | 'twilio' | 'twilio_verify' | null = null

    if (mobile_number) {
      recipient = canonicalRecipient
      const backend = selectVerificationBackend(recipient)
      console.log(`📤 Sending OTP to ${maskPhone(recipient)} via ${backend}...`)

      if (backend === 'twilio_verify') {
        verificationCode = generateOtpCode()
        const verifyResult = await startVerification(recipient, verificationCode)
        if (!verifyResult.ok) {
          console.error(`❌ Twilio Verify error:`, verifyResult.error)
          const status = verifyResult.status >= 400 && verifyResult.status < 500 ? verifyResult.status : 502
          return new Response(
            JSON.stringify({ error: `SMS sending failed: ${verifyResult.error ?? 'Unknown error'}` }),
            { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          )
        }
        verifySid = verifyResult.sid ?? null
        otpProvider = 'twilio_verify'
        sendResponse = {
          message_id: verifyResult.sid ?? 'unknown',
          recipient,
          provider: 'twilio_verify',
          status: 'SENT',
          created_at: new Date().toISOString(),
        }
      } else {
        verificationCode = generateVerificationCode()
        const message = createVerificationMessage(verificationCode, purpose)
        const smsResult = await sendSms(recipient, message)

        if (!smsResult.ok) {
          console.error(`❌ SMS provider error (${smsResult.provider}):`, smsResult.error)
          const status = smsResult.status >= 400 && smsResult.status < 500 ? smsResult.status : 502
          return new Response(
            JSON.stringify({ error: `SMS sending failed: ${smsResult.error ?? 'Unknown error'}` }),
            { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          )
        }

        otpProvider = smsResult.provider
        sendResponse = {
          message_id: smsResult.messageId ?? 'unknown',
          recipient,
          provider: smsResult.provider,
          status: 'SENT',
          created_at: new Date().toISOString(),
        }
      }
    } else if (email) {
      verificationCode = generateVerificationCode()
      // Email flow
      console.log(`🔐 Generated verification code for ${email}`)
      recipient = email as string

      // Send email via send-email Edge Function (Brevo)
      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
      const sendEmailUrl = `${supabaseUrl}/functions/v1/send-email`
      
      console.log(`📤 Sending email to ${email} via send-email Edge Function...`)

      const emailPayload = {
        to: email,
        templateId: 1, // Password reset template ID in Brevo
        variables: {
          code: verificationCode,
          name: 'User'
        }
      }

      const emailResponse = await fetch(sendEmailUrl, {
        method: 'POST',
        headers: {
          'Authorization': req.headers.get('Authorization') || '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(emailPayload),
      })

      const emailData = await emailResponse.json()

      console.log(`📥 Email API response status: ${emailResponse.status}`)
      console.log(`📥 Email API response data:`, JSON.stringify(emailData, null, 2))

      if (!emailResponse.ok) {
        console.error(`❌ Email sending failed:`, emailData)
        return new Response(
          JSON.stringify({ error: `Email sending failed: ${emailData.error || emailResponse.statusText}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      sendResponse = {
        message_id: emailData.messageId || 'unknown',
        recipient: email,
        status: 'SENT',
        created_at: new Date().toISOString()
      }
    }

    // Store verification code in appropriate table based on purpose
    try {
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 minutes expiry

      if (purpose === 'password_reset') {
        if (mobile_number && otpProvider === 'twilio_verify') {
          await supabaseAdmin
            .from('password_reset_codes')
            .update({ used: true })
            .eq('mobile_number', recipient)
            .eq('provider', 'twilio_verify')
            .eq('used', false)
        }

        const insertData: Record<string, unknown> = {
          code: verificationCode,
          expires_at: expiresAt,
          used: false,
        }

        if (mobile_number) {
          insertData.mobile_number = recipient
          if (otpProvider) insertData.provider = otpProvider
          if (verifySid) insertData.verify_sid = verifySid
        } else if (email) {
          insertData.email = recipient
        }

        const { error: dbError } = await supabaseAdmin
          .from('password_reset_codes')
          .insert(insertData)

        if (dbError) {
          console.warn(`⚠️ Could not store password reset code in database:`, dbError.message)
        } else {
          console.log(`✅ Password reset code stored in password_reset_codes table`)
        }
      } else if (mobile_number && verificationCode) {
        if (otpProvider === 'twilio_verify') {
          await supabaseAdmin
            .from('signup_codes')
            .update({ used: true })
            .eq('mobile_number', recipient)
            .eq('provider', 'twilio_verify')
            .eq('used', false)
        }

        const { error: dbError } = await supabaseAdmin
          .from('signup_codes')
          .insert({
            mobile_number: recipient,
            code: verificationCode,
            expires_at: expiresAt,
            used: false,
            provider: otpProvider ?? undefined,
            verify_sid: verifySid ?? undefined,
          })

        if (dbError) {
          console.warn(`⚠️ Could not store verification code in database:`, dbError.message)
        } else {
          console.log(`✅ Verification code stored in signup_codes table`)
        }
      }
    } catch (dbError) {
      console.warn(`⚠️ Database storage failed:`, dbError)
      // Don't fail the request - code was sent successfully
    }

    console.log(`✅ Verification code sent successfully to ${recipient}`)

    // Return success response (don't include the code in response for security)
    return new Response(
      JSON.stringify({
        success: true,
        message: 'Verification code sent successfully',
        message_id: sendResponse?.message_id || 'unknown',
        recipient: recipient,
        expires_in: 600 // 10 minutes in seconds
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('❌ Unexpected error:', error)
    const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred'
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

