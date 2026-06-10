/**
 * Shared SMS / OTP provider module for Supabase Edge Functions.
 *
 * Philippine (+63): Semaphore Programmable SMS + locally stored OTP codes.
 * International: Twilio Verify with CustomCode (when TWILIO_VERIFY_SERVICE_SID
 * is set and Custom Verification Code is enabled on the Verify Service),
 * otherwise legacy Twilio Programmable SMS fallback.
 *
 * API keys live in Supabase project secrets only — never on the mobile client.
 */

export type SmsProvider = 'semaphore' | 'twilio' | 'twilio_verify'

export type VerificationBackend = 'semaphore' | 'twilio_verify' | 'twilio_sms'

/** Generate a random 4-digit OTP (1000–9999). */
export function generateOtpCode(): string {
  return Math.floor(1000 + Math.random() * 9000).toString()
}

export interface VerifyStartResult {
  ok: boolean
  status: number
  sid?: string
  provider: 'twilio_verify'
  error?: string
  errorCode?: string
}

export interface VerifyCheckResult {
  ok: boolean
  status: number
  approved: boolean
  provider: 'twilio_verify'
  error?: string
  errorCode?: string
}

export interface SmsResult {
  ok: boolean
  status: number
  messageId?: string
  provider: SmsProvider
  error?: string
  errorCode?: string
}

const E164_RE = /^\+[1-9]\d{6,14}$/
const PH_E164_RE = /^\+639\d{8,9}$/
const PH_COUNTRY_CODE = '63'

/** ITU prefixes sorted longest-first for allowlist matching (e.g. 3491 before 34). */
let cachedAllowedCodes: string[] | null = null

function getAllowedCountryCodes(): string[] {
  if (cachedAllowedCodes) return cachedAllowedCodes
  const raw = Deno.env.get('SMS_ALLOWED_COUNTRY_CODES') ?? ''
  cachedAllowedCodes = raw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  return cachedAllowedCodes
}

/**
 * Normalize inbound phone input to E.164.
 * - Already-valid E.164 → returned as-is (PH gets leading-zero cleanup).
 * - Legacy PH local formats (09…, 9…, 63…) → +63…
 * - Otherwise → null
 */
export function normalizePhoneNumber(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null

  const trimmed = raw.trim()
  if (E164_RE.test(trimmed)) {
    if (PH_E164_RE.test(trimmed)) {
      const afterCc = trimmed.slice(3).replace(/^0+/, '')
      return `+63${afterCc}`
    }
    return trimmed
  }

  let cleaned = trimmed.replace(/\D/g, '')
  if (!cleaned) return null

  if (cleaned.startsWith('0')) cleaned = '63' + cleaned.slice(1)
  if (cleaned.startsWith('9') && cleaned.length === 10) cleaned = '63' + cleaned
  if (!cleaned.startsWith('63')) {
    // Only apply PH heuristics when input looks like a local PH number.
    if (cleaned.length >= 9 && cleaned.length <= 11) {
      cleaned = '63' + cleaned.replace(/^0+/, '')
    } else {
      return null
    }
  }

  const candidate = '+' + cleaned
  return PH_E164_RE.test(candidate) ? candidate : null
}

/** Accept any valid E.164 (international) or normalize legacy PH input. */
export function normalizePhoneNumberIntl(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null

  const trimmed = raw.trim()
  if (E164_RE.test(trimmed)) {
    if (PH_E164_RE.test(trimmed)) {
      const afterCc = trimmed.slice(3).replace(/^0+/, '')
      return `+63${afterCc}`
    }
    return trimmed
  }

  return normalizePhoneNumber(raw)
}

export function isPhilippineNumber(e164: string): boolean {
  return PH_E164_RE.test(e164)
}

export function extractCountryCallingCode(e164: string): string | null {
  const digits = e164.replace(/\D/g, '')
  for (const code of getAllowedCountryCodes()) {
    if (digits.startsWith(code)) return code
  }
  // PH always allowed via Semaphore even if absent from Twilio geo list.
  if (digits.startsWith(PH_COUNTRY_CODE)) return PH_COUNTRY_CODE
  // Fallback: try common 1–3 digit ITU prefixes when allowlist is empty.
  if (getAllowedCountryCodes().length === 0) {
    const m = digits.match(/^(\d{1,3})/)
    return m ? m[1] : null
  }
  return null
}

export function selectProvider(e164: string): SmsProvider {
  if (isPhilippineNumber(e164)) return 'semaphore'
  if (isTwilioVerifyEnabled()) return 'twilio_verify'
  return 'twilio'
}

/** OTP send/verify routing: PH → Semaphore; intl → Verify when configured. */
export function selectVerificationBackend(e164: string): VerificationBackend {
  if (isPhilippineNumber(e164)) return 'semaphore'
  if (isTwilioVerifyEnabled()) return 'twilio_verify'
  return 'twilio_sms'
}

/** True when TWILIO_VERIFY_SERVICE_SID (VA…) is set and not explicitly disabled. */
export function isTwilioVerifyEnabled(): boolean {
  const flag = (Deno.env.get('SMS_VERIFY_ENABLED') ?? '').trim().toLowerCase()
  if (flag === 'false' || flag === '0') return false
  const sid = twilioEnv('TWILIO_VERIFY_SERVICE_SID')
  return sid.startsWith('VA')
}

function twilioVerifyServiceSid(): string {
  return twilioEnv('TWILIO_VERIFY_SERVICE_SID')
}

export function isAllowedDestination(e164: string): boolean {
  if (!E164_RE.test(e164)) return false
  if (isPhilippineNumber(e164)) return true
  const allowed = getAllowedCountryCodes()
  if (allowed.length === 0) return true
  const digits = e164.replace(/\D/g, '')
  return allowed.some((code) => digits.startsWith(code))
}

export function maskPhone(e164: string): string {
  if (e164.length <= 6) return '***'
  return `${e164.slice(0, 4)}***${e164.slice(-2)}`
}

async function sendSemaphore(to: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get('SEMAPHORE_API_KEY') ?? ''
  if (!apiKey.trim()) {
    return { ok: false, status: 500, provider: 'semaphore', error: 'SMS provider not configured' }
  }

  const response = await fetch('https://api.semaphore.co/api/v4/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: to, message, apikey: apiKey.trim() }),
  })

  let data: unknown = null
  try {
    data = await response.json()
  } catch {
    // non-JSON body
  }

  if (!response.ok) {
    let errorMessage = `Semaphore error ${response.status}`
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>
      if (Array.isArray(d.apikey) && typeof d.apikey[0] === 'string') {
        errorMessage = `Semaphore API key error: ${d.apikey[0]}`
      } else if (Array.isArray(d.number) && typeof d.number[0] === 'string') {
        errorMessage = `Invalid phone number: ${d.number[0]}`
      } else if (typeof d.message === 'string') {
        errorMessage = `Semaphore: ${d.message}`
      } else if (typeof d.error === 'string') {
        errorMessage = `Semaphore: ${d.error}`
      }
    }
    return { ok: false, status: response.status, provider: 'semaphore', error: errorMessage }
  }

  let messageId: string | undefined
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0] as Record<string, unknown>
    if (typeof first.message_id === 'string') messageId = first.message_id
  } else if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    if (typeof d.message_id === 'string') messageId = d.message_id
  }

  return { ok: true, status: response.status, provider: 'semaphore', messageId }
}

function twilioEnv(name: string): string {
  let v = (Deno.env.get(name) ?? '').trim()
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim()
  }
  return v
}

function buildTwilioAuthHeader():
  | { ok: true; header: string; mode: 'api_key' | 'auth_token' }
  | { ok: false; error: string } {
  const accountSid = twilioEnv('TWILIO_ACCOUNT_SID')
  const apiKeySid = twilioEnv('TWILIO_API_KEY_SID')
  const apiKeySecret = twilioEnv('TWILIO_API_KEY_SECRET')
  const authToken = twilioEnv('TWILIO_AUTH_TOKEN')

  if (!accountSid.startsWith('AC')) {
    return {
      ok: false,
      error: 'TWILIO_ACCOUNT_SID must start with AC (Account SID from Twilio Console → Account Info)',
    }
  }

  // Preferred: API Key SID (SK…) + API Key Secret
  if (apiKeySid.startsWith('SK') && apiKeySecret.length > 0) {
    return {
      ok: true,
      mode: 'api_key',
      header: 'Basic ' + btoa(`${apiKeySid}:${apiKeySecret}`),
    }
  }

  if (apiKeySid.startsWith('AC')) {
    return {
      ok: false,
      error:
        'TWILIO_API_KEY_SID looks like an Account SID (AC…). Use the API Key SID (SK…) from Settings → API keys, or set TWILIO_AUTH_TOKEN instead.',
    }
  }

  // Fallback: Account SID + Auth Token (legacy primary credential)
  if (authToken.length > 0) {
    return {
      ok: true,
      mode: 'auth_token',
      header: 'Basic ' + btoa(`${accountSid}:${authToken}`),
    }
  }

  return {
    ok: false,
    error:
      'Twilio credentials missing. Set TWILIO_API_KEY_SID (SK…) + TWILIO_API_KEY_SECRET, or TWILIO_ACCOUNT_SID (AC…) + TWILIO_AUTH_TOKEN.',
  }
}

export interface TwilioCredentialDiagnostic {
  account_sid_prefix: string
  account_sid_len: number
  api_key_sid_prefix: string
  api_key_sid_len: number
  api_key_secret_len: number
  auth_token_len: number
  messaging_service_sid_prefix: string
  verify_service_sid_prefix: string
  verify_enabled: boolean
  auth_mode: 'api_key' | 'auth_token' | 'none' | 'misconfigured'
  issues: string[]
}

/** Safe metadata for debugging 20003 without exposing secrets. */
export function getTwilioCredentialDiagnostic(): TwilioCredentialDiagnostic {
  const accountSid = twilioEnv('TWILIO_ACCOUNT_SID')
  const apiKeySid = twilioEnv('TWILIO_API_KEY_SID')
  const apiKeySecret = twilioEnv('TWILIO_API_KEY_SECRET')
  const authToken = twilioEnv('TWILIO_AUTH_TOKEN')
  const messagingServiceSid = twilioEnv('TWILIO_MESSAGING_SERVICE_SID')
  const verifyServiceSid = twilioEnv('TWILIO_VERIFY_SERVICE_SID')
  const verifyEnabled = isTwilioVerifyEnabled()
  const issues: string[] = []

  let auth_mode: TwilioCredentialDiagnostic['auth_mode'] = 'none'
  if (apiKeySid.startsWith('SK') && apiKeySecret.length > 0) auth_mode = 'api_key'
  else if (authToken.length > 0 && accountSid.startsWith('AC')) auth_mode = 'auth_token'
  else if (apiKeySid.startsWith('AC')) auth_mode = 'misconfigured'

  if (!accountSid) issues.push('TWILIO_ACCOUNT_SID missing')
  else if (!accountSid.startsWith('AC')) issues.push('TWILIO_ACCOUNT_SID must start with AC')
  if (apiKeySid.startsWith('AC')) {
    issues.push('TWILIO_API_KEY_SID is AC… — must be SK… from API keys page')
  } else if (!apiKeySid.startsWith('SK') && authToken.length === 0) {
    issues.push('TWILIO_API_KEY_SID missing or invalid (expected SK…)')
  }
  if (apiKeySid.startsWith('SK') && apiKeySecret.length === 0) {
    issues.push('TWILIO_API_KEY_SECRET missing')
  }
  if (apiKeySecret.length > 0 && apiKeySecret.length < 20) {
    issues.push(`TWILIO_API_KEY_SECRET looks short (len=${apiKeySecret.length})`)
  }
  if (apiKeySecret.includes(' ')) issues.push('TWILIO_API_KEY_SECRET contains spaces')
  if (verifyEnabled) {
    if (!verifyServiceSid.startsWith('VA')) {
      issues.push('TWILIO_VERIFY_SERVICE_SID should start with VA')
    }
  } else if (!messagingServiceSid && !(Deno.env.get('TWILIO_FROM_NUMBER') ?? '').trim()) {
    issues.push(
      'TWILIO_VERIFY_SERVICE_SID (VA…) missing for intl OTP — or set TWILIO_MESSAGING_SERVICE_SID / TWILIO_FROM_NUMBER for legacy SMS',
    )
  } else if (messagingServiceSid && !messagingServiceSid.startsWith('MG')) {
    issues.push('TWILIO_MESSAGING_SERVICE_SID should start with MG')
  }

  return {
    account_sid_prefix: accountSid.slice(0, 4) || '(empty)',
    account_sid_len: accountSid.length,
    api_key_sid_prefix: apiKeySid.slice(0, 4) || '(empty)',
    api_key_sid_len: apiKeySid.length,
    api_key_secret_len: apiKeySecret.length,
    auth_token_len: authToken.length,
    messaging_service_sid_prefix: messagingServiceSid.slice(0, 4) || '(empty)',
    verify_service_sid_prefix: verifyServiceSid.slice(0, 4) || '(empty)',
    verify_enabled: verifyEnabled,
    auth_mode,
    issues,
  }
}

type TwilioVerifyOk = {
  ok: true
  accountSid: string
  friendlyName?: string
  mode: string
  verify_via: 'verify_service' | 'messaging_service' | 'account'
}

type TwilioVerifyFail = {
  ok: false
  status: number
  error: string
  errorCode?: string
  diagnostic: TwilioCredentialDiagnostic
}

async function fetchTwilioJson<T>(
  url: string,
  authHeader: string,
): Promise<{ ok: boolean; status: number; data: T | null }> {
  const response = await fetch(url, { headers: { Authorization: authHeader } })
  let data: T | null = null
  try {
    data = (await response.json()) as T
  } catch {
    // non-JSON
  }
  return { ok: response.ok, status: response.status, data }
}

/**
 * Preflight check — validates credentials using an endpoint that matches SMS usage.
 * Standard API keys often cannot read /Accounts (returns 20003); Messaging Service works.
 */
export async function verifyTwilioCredentials(): Promise<TwilioVerifyOk | TwilioVerifyFail> {
  const accountSid = twilioEnv('TWILIO_ACCOUNT_SID')
  const messagingServiceSid = twilioEnv('TWILIO_MESSAGING_SERVICE_SID')
  const verifyServiceSid = twilioVerifyServiceSid()
  const diagnostic = getTwilioCredentialDiagnostic()
  const auth = buildTwilioAuthHeader()
  if (!auth.ok) return { ok: false, status: 500, error: auth.error, diagnostic }

  if (verifyServiceSid.startsWith('VA')) {
    const vaUrl = `https://verify.twilio.com/v2/Services/${verifyServiceSid}`
    const va = await fetchTwilioJson<{
      sid?: string
      friendly_name?: string
      message?: string
      code?: number
    }>(vaUrl, auth.header)

    if (va.ok && va.data) {
      return {
        ok: true,
        accountSid,
        friendlyName: va.data.friendly_name,
        mode: auth.mode,
        verify_via: 'verify_service',
      }
    }

    if (!va.ok) {
      const code = va.data?.code
      return {
        ok: false,
        status: va.status,
        error: va.data?.message ?? `Twilio Verify service check failed (${va.status})`,
        errorCode: code != null ? String(code) : undefined,
        diagnostic,
      }
    }
  }

  if (messagingServiceSid.startsWith('MG')) {
    const mgUrl = `https://messaging.twilio.com/v1/Services/${messagingServiceSid}`
    const mg = await fetchTwilioJson<{
      sid?: string
      friendly_name?: string
      message?: string
      code?: number
    }>(mgUrl, auth.header)

    if (mg.ok && mg.data) {
      return {
        ok: true,
        accountSid,
        friendlyName: mg.data.friendly_name,
        mode: auth.mode,
        verify_via: 'messaging_service',
      }
    }

    if (!mg.ok) {
      const code = mg.data?.code
      if (code === 20003 && diagnostic.auth_mode === 'api_key') {
        diagnostic.issues.push(
          'Twilio rejected SK+secret on Messaging API — secret does not match TWILIO_API_KEY_SID, or key lacks SMS permissions',
        )
      }
      return {
        ok: false,
        status: mg.status,
        error: mg.data?.message ?? `Twilio auth check failed (${mg.status})`,
        errorCode: code != null ? String(code) : undefined,
        diagnostic,
      }
    }
  }

  const accountUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`
  const acct = await fetchTwilioJson<{
    friendly_name?: string
    sid?: string
    message?: string
    code?: number
  }>(accountUrl, auth.header)

  if (acct.ok && acct.data) {
    return {
      ok: true,
      accountSid: acct.data.sid ?? accountSid,
      friendlyName: acct.data.friendly_name,
      mode: auth.mode,
      verify_via: 'account',
    }
  }

  if (acct.data?.code === 20003 && diagnostic.auth_mode === 'api_key') {
    diagnostic.issues.push(
      'Account API returned 20003 — if using a Standard API key, ensure TWILIO_MESSAGING_SERVICE_SID is set; or create a Main API key',
    )
  }

  return {
    ok: false,
    status: acct.status,
    error: acct.data?.message ?? `Twilio auth check failed (${acct.status})`,
    errorCode: acct.data?.code != null ? String(acct.data.code) : undefined,
    diagnostic,
  }
}

async function sendTwilio(to: string, message: string): Promise<SmsResult> {
  const accountSid = twilioEnv('TWILIO_ACCOUNT_SID')
  const messagingServiceSid = twilioEnv('TWILIO_MESSAGING_SERVICE_SID')
  const fromNumber = twilioEnv('TWILIO_FROM_NUMBER')

  const auth = buildTwilioAuthHeader()
  if (!auth.ok) {
    return { ok: false, status: 500, provider: 'twilio', error: auth.error }
  }
  if (!messagingServiceSid && !fromNumber) {
    return { ok: false, status: 500, provider: 'twilio', error: 'Twilio sender not configured' }
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`
  const authHeader = auth.header
  const form = new URLSearchParams({ To: to, Body: message })
  if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid)
  else form.set('From', fromNumber)

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  })

  let data: { sid?: string; error_code?: number; message?: string; code?: number } | null = null
  try {
    data = await response.json()
  } catch {
    // non-JSON
  }

  if (!response.ok) {
    const errorCode = data?.error_code ?? data?.code
    return {
      ok: false,
      status: response.status,
      provider: 'twilio',
      errorCode: errorCode != null ? String(errorCode) : undefined,
      error: data?.message ?? `Twilio error ${response.status}`,
    }
  }

  return {
    ok: true,
    status: response.status,
    provider: 'twilio',
    messageId: data?.sid,
  }
}

type TwilioVerifyApiBody = {
  sid?: string
  status?: string
  message?: string
  code?: number
}

/**
 * Start an international OTP via Twilio Verify (SMS channel).
 * Requires Custom Verification Code enabled on the Verify Service; pass the
 * same code you store in the database.
 */
export async function startVerification(to: string, customCode: string): Promise<VerifyStartResult> {
  const serviceSid = twilioVerifyServiceSid()
  if (!serviceSid.startsWith('VA')) {
    return {
      ok: false,
      status: 500,
      provider: 'twilio_verify',
      error: 'TWILIO_VERIFY_SERVICE_SID not configured',
    }
  }

  if (!/^\d{4}$/.test(customCode)) {
    return {
      ok: false,
      status: 400,
      provider: 'twilio_verify',
      error: 'customCode must be exactly 4 digits',
    }
  }

  if (!isAllowedDestination(to)) {
    return {
      ok: false,
      status: 400,
      provider: 'twilio_verify',
      error: 'Unsupported destination country for SMS verification',
    }
  }

  const auth = buildTwilioAuthHeader()
  if (!auth.ok) {
    return { ok: false, status: 500, provider: 'twilio_verify', error: auth.error }
  }

  const url = `https://verify.twilio.com/v2/Services/${serviceSid}/Verifications`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: auth.header,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      To: to,
      Channel: 'sms',
      CustomCode: customCode,
    }).toString(),
  })

  let data: TwilioVerifyApiBody | null = null
  try {
    data = await response.json()
  } catch {
    // non-JSON
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      provider: 'twilio_verify',
      errorCode: data?.code != null ? String(data.code) : undefined,
      error: data?.message ?? `Twilio Verify error ${response.status}`,
    }
  }

  return {
    ok: true,
    status: response.status,
    provider: 'twilio_verify',
    sid: data?.sid,
  }
}

/** Check an international OTP via Twilio Verify. */
export async function checkVerification(to: string, code: string): Promise<VerifyCheckResult> {
  const serviceSid = twilioVerifyServiceSid()
  if (!serviceSid.startsWith('VA')) {
    return {
      ok: false,
      status: 500,
      approved: false,
      provider: 'twilio_verify',
      error: 'TWILIO_VERIFY_SERVICE_SID not configured',
    }
  }

  const auth = buildTwilioAuthHeader()
  if (!auth.ok) {
    return {
      ok: false,
      status: 500,
      approved: false,
      provider: 'twilio_verify',
      error: auth.error,
    }
  }

  const url = `https://verify.twilio.com/v2/Services/${serviceSid}/VerificationCheck`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: auth.header,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, Code: code }).toString(),
  })

  let data: TwilioVerifyApiBody | null = null
  try {
    data = await response.json()
  } catch {
    // non-JSON
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      approved: false,
      provider: 'twilio_verify',
      errorCode: data?.code != null ? String(data.code) : undefined,
      error: data?.message ?? `Twilio Verify check failed (${response.status})`,
    }
  }

  const approved = data?.status === 'approved'
  return {
    ok: true,
    status: response.status,
    approved,
    provider: 'twilio_verify',
    error: approved ? undefined : 'Invalid or expired verification code',
  }
}

/**
 * Send SMS via the appropriate provider. Validates destination allowlist
 * for non-PH numbers before dispatching.
 *
 * For international OTP, prefer `startVerification()` instead of this helper.
 */
export async function sendSms(to: string, message: string): Promise<SmsResult> {
  const backend = selectVerificationBackend(to)

  if (!isAllowedDestination(to)) {
    return {
      ok: false,
      status: 400,
      provider: backend === 'semaphore' ? 'semaphore' : 'twilio',
      error: 'Unsupported destination country for SMS verification',
    }
  }

  if (backend === 'semaphore') {
    return await sendSemaphore(to, message)
  }
  if (backend === 'twilio_verify') {
    return {
      ok: false,
      status: 400,
      provider: 'twilio_verify',
      error: 'Use startVerification() for international OTP when Twilio Verify is enabled',
    }
  }
  return await sendTwilio(to, message)
}

/** Recipient rate-limit cap: stricter for international (Twilio) destinations. */
export function getRecipientRateLimit(e164: string, defaultLimit: number): number {
  if (isPhilippineNumber(e164)) return defaultLimit
  const intlLimit = Number(Deno.env.get('SMS_RATE_RECIPIENT_24H_INTL') ?? '2')
  return intlLimit > 0 ? intlLimit : defaultLimit
}

/** OTP rate-limit cap for send-verification-code. */
export function getOtpRecipientRateLimit(e164: string, defaultLimit: number): number {
  if (isPhilippineNumber(e164)) return defaultLimit
  const intlLimit = Number(Deno.env.get('OTP_RATE_RECIPIENT_24H_INTL') ?? '3')
  return intlLimit > 0 ? intlLimit : defaultLimit
}

/** Cooldown seconds — longer for international OTP resends. */
export function getOtpCooldownSeconds(e164: string, defaultSeconds: number): number {
  if (isPhilippineNumber(e164)) return defaultSeconds
  const intlCooldown = Number(Deno.env.get('OTP_COOLDOWN_SECONDS_INTL') ?? '60')
  return intlCooldown > 0 ? intlCooldown : defaultSeconds
}
