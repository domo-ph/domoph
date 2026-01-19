# Backend Code Changes - Staff Invite Support

## Overview
Updated the `signup-user` Supabase Edge Function to properly handle existing users with staff invites. This allows kasambahay users who have been invited to sign up even if they already have an account.

## Key Changes

### 1. **OAuth User Detection**
- Added logic to detect if the request is from an OAuth-authenticated user (has valid access token)
- If OAuth user, updates their existing account instead of trying to create a new one

### 2. **Existing User Check Before Creation**
- Before attempting to create a new user, checks if a user already exists by email
- If user exists AND has a matching staff invite:
  - Updates their account instead of erroring
  - Assigns them to the household from the staff invite
  - Changes their role to `kasambahay`
- If user exists WITHOUT staff invite:
  - Returns proper 409 error: "A user with this email address has already been registered"

### 3. **Improved Error Handling**
- Handles `createUser()` errors more gracefully
- If `createUser()` fails with "already registered" error, checks if user has staff invite
- If staff invite exists, updates user instead of failing

### 4. **Staff Invite Flow**
The function now supports these scenarios:

#### Scenario A: New User with Staff Invite
1. User signs up with email/mobile that matches `staff_invite` table
2. Creates new user account
3. Assigns `kasambahay` role
4. Links to household from invite
5. Marks invite as `done`

#### Scenario B: Existing User with Staff Invite
1. User already exists (from OAuth or previous signup)
2. Signs up again with email/mobile that matches `staff_invite` table
3. **NEW**: Updates existing account instead of erroring
4. Assigns `kasambahay` role
5. Links to household from invite
6. Marks invite as `done`

#### Scenario C: Existing User without Staff Invite
1. User already exists
2. Tries to sign up again
3. Returns 409 error: "A user with this email address has already been registered"
4. User should login instead

#### Scenario D: OAuth User Linking Mobile
1. User signs up via Google/Apple/FB
2. Later adds mobile number that matches `staff_invite` table
3. Updates their account
4. Assigns `kasambahay` role
5. Links to household from invite

## Implementation Details

### OAuth User Detection
```typescript
// Try to get user from session token
const token = authHeader.replace('Bearer ', '')
const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token)

if (!userError && user) {
    isOAuthUser = true
    existingAuthUser = user
    authUserId = user.id
}
```

### Existing User Check
```typescript
// Check if user already exists by email
if (normalizedEmail) {
    const { data: existingUserByEmail } = await supabaseAdmin.auth.admin.getUserByEmail(normalizedEmail)
    
    if (existingUserByEmail?.user) {
        if (staffInviteFound) {
            // User exists AND has staff invite - update instead of error
            // Update user metadata and assign household
        } else {
            // User exists WITHOUT staff invite - return error
            return new Response(
                JSON.stringify({ error: 'A user with this email address has already been registered' }),
                { status: 409 }
            )
        }
    }
}
```

### Error Recovery
```typescript
// If createUser() fails with "already registered", check for staff invite
if (authError.message?.toLowerCase().includes('already registered')) {
    if (staffInviteFound) {
        // Find existing user and update instead
        // This handles edge cases where user exists but check missed it
    }
}
```

## Deployment Instructions

1. Copy the contents of `signup-user-edge-function.ts` to your Supabase Edge Function
2. Deploy the function to Supabase
3. The function will automatically:
   - Check for staff invites by email or mobile
   - Handle existing users gracefully
   - Assign kasambahay users to their invited households

## Testing Scenarios

Test these scenarios to ensure everything works:

1. ✅ New user signs up with email that has staff invite
2. ✅ New user signs up with mobile that has staff invite
3. ✅ Existing user (from OAuth) signs up again with email that has staff invite
4. ✅ Existing user (manual signup) signs up again with email that has staff invite
5. ✅ OAuth user links mobile number that has staff invite
6. ✅ Existing user without staff invite tries to sign up again (should get 409 error)
7. ✅ New user without staff invite signs up (becomes `amo`)

## Notes

- The function checks `staff_invite` table for entries with `status = 'new'`
- Staff invite is matched by email OR mobile number (whichever matches first)
- If staff invite found, user role is set to `kasambahay` and household is assigned
- Staff invite status is updated to `done` after successful signup
- The function is idempotent - can be called multiple times safely



