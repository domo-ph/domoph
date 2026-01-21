-- Migration: Fix handle_new_user trigger to normalize provider values
-- This prevents "value too long for type character varying(20)" errors
-- by ensuring primary_auth_method is always a valid short identifier

-- Drop and recreate the function with normalized provider logic
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  random_color text;
  display_name text;
  v_first_name text;
  v_last_name text;
  provider text;
  user_phone text;
  auth_method text;
  user_role text;
  pending_user_record RECORD;
  migration_result JSONB;
  normalized_email TEXT;
  normalized_phone TEXT;
  staff_invite_record RECORD;
  mobile_invite_record RECORD;
  -- Variables for household creation
  new_household_id UUID;
  new_join_code TEXT;
  user_record RECORD;
  user_has_household BOOLEAN;
  user_has_invite BOOLEAN;
  staff_invite_found BOOLEAN := FALSE;
  -- FIX: Use boolean flag to track if pending user was found
  pending_user_found BOOLEAN := FALSE;
  -- Variables for mobile_no conflict resolution
  pending_mobile_backup TEXT;
  pending_user_email_backup TEXT;
BEGIN
  -- ============================================================================
  -- ENHANCED LOGGING: Log trigger start
  -- ============================================================================
  RAISE LOG '🚀 handle_new_user TRIGGER STARTED for auth user: % (email: %, phone: %)', 
    NEW.id, NEW.email, COALESCE(NEW.phone, 'none');
  
  -- ============================================================================
  -- NORMALIZE PROVIDER: Extract and normalize provider to a short identifier
  -- This ensures primary_auth_method fits within VARCHAR(20) constraint
  -- ============================================================================
  provider := COALESCE(
    NEW.raw_user_meta_data->>'provider',
    NEW.raw_user_meta_data->>'provider_id',
    'email'
  );
  
  -- Normalize provider to lowercase and extract base name
  IF provider IS NOT NULL AND provider != '' THEN
    provider := LOWER(TRIM(provider));
    
    -- Extract base provider name from compound identifiers (e.g., "google-oauth2" -> "google")
    IF POSITION('-' IN provider) > 0 THEN
      provider := SPLIT_PART(provider, '-', 1);
    END IF;
    
    -- Map to known allowed values or validate length
    IF provider NOT IN ('email', 'phone', 'google', 'apple', 'facebook', 'github', 'twitter', 
                        'discord', 'azure', 'bitbucket', 'gitlab', 'keycloak', 'linkedin', 
                        'notion', 'twitch', 'slack', 'spotify', 'workos', 'zoom') THEN
      -- If unknown provider and too long, use safe fallback
      IF LENGTH(provider) > 20 THEN
        provider := 'oauth';
      ELSIF LENGTH(provider) > 0 THEN
        -- Keep it if it's short enough and matches pattern (a-z0-9_-)
        IF provider !~ '^[a-z0-9_-]+$' THEN
          provider := 'oauth';
        END IF;
      ELSE
        provider := 'email';
      END IF;
    END IF;
  ELSE
    provider := 'email';
  END IF;
  
  RAISE LOG '🔐 Provider normalized: %', provider;
  
  -- Extract phone number from phone field or metadata
  user_phone := COALESCE(
    NEW.phone,
    NEW.raw_user_meta_data->>'phone',
    NEW.raw_user_meta_data->>'mobile_no'
  );
  
  -- Normalize phone number to ensure consistent format matching
  IF user_phone IS NOT NULL AND user_phone != '' THEN
    user_phone := normalize_phone_number(user_phone);
    normalized_phone := user_phone;
    RAISE LOG '📱 Phone normalized: %', user_phone;
  END IF;
  
  -- Normalize email for matching (lowercase, trimmed)
  IF NEW.email IS NOT NULL AND NEW.email != '' THEN
    normalized_email := LOWER(TRIM(NEW.email));
  END IF;
  
  -- Determine primary auth method (phone takes precedence, then provider)
  auth_method := CASE 
    WHEN user_phone IS NOT NULL AND user_phone != '' THEN 'phone'
    ELSE provider
  END;
  
  RAISE LOG '🔐 Auth method determined: % (provider: %)', auth_method, provider;

  -- ============================================================================
  -- Determine role: Check staff_invite table if phone exists, otherwise use metadata
  -- FIX: Wrap in exception handling to handle missing table gracefully
  -- ============================================================================
  user_role := COALESCE(NEW.raw_user_meta_data->>'role', 'amo');
  
  -- Check staff_invite table if phone number exists
  -- Wrap in exception handling in case table doesn't exist
  BEGIN
    IF normalized_phone IS NOT NULL AND normalized_phone != '' THEN
      RAISE LOG 'Checking staff_invite for normalized phone: %', normalized_phone;
      
      SELECT id, household_id, mobile, email, role, status
      INTO staff_invite_record
      FROM public.staff_invite
      WHERE normalize_phone_number(mobile) = normalized_phone
        AND status = 'new'
      ORDER BY created_at DESC
      LIMIT 1;
      
      IF FOUND THEN
        staff_invite_found := TRUE;
        -- Phone found in staff_invite, user MUST be kasambahay
        user_role := 'kasambahay';
        RAISE LOG '📋 User role set to kasambahay (found in staff_invite: %, phone: %)', 
          staff_invite_record.id, user_phone;
      END IF;
    END IF;
    
    -- Also check by email if no phone match found
    IF NOT staff_invite_found AND normalized_email IS NOT NULL THEN
      SELECT id, household_id, mobile, email, role, status
      INTO staff_invite_record
      FROM public.staff_invite
      WHERE LOWER(TRIM(email)) = normalized_email
        AND status = 'new'
      ORDER BY created_at DESC
      LIMIT 1;
      
      IF FOUND THEN
        staff_invite_found := TRUE;
        user_role := 'kasambahay';
        RAISE LOG '📋 User role set to kasambahay (found in staff_invite by email: %)', 
          staff_invite_record.id;
        
        -- FIX: If mobile becomes available later, prefer mobile match over email match
        -- Check by mobile if available and different from the email match
        IF normalized_phone IS NOT NULL AND normalized_phone != '' THEN
          BEGIN
            SELECT id, household_id, mobile, email, role, status
            INTO mobile_invite_record
            FROM public.staff_invite
            WHERE normalize_phone_number(mobile) = normalized_phone
              AND (status = 'new' OR status = 'done')
            ORDER BY created_at DESC
            LIMIT 1;
            
            IF FOUND AND mobile_invite_record.id != staff_invite_record.id THEN
              -- Mobile match found and it's different from email match - prefer mobile
              staff_invite_record := mobile_invite_record;
              RAISE LOG '📋 Preferring staff_invite by mobile over email: %', staff_invite_record.id;
            ELSIF FOUND AND mobile_invite_record.id = staff_invite_record.id THEN
              -- Same record found by both email and mobile - refresh the record to get latest status
              staff_invite_record := mobile_invite_record;
              RAISE LOG '📋 Same staff_invite found by both email and mobile: %', staff_invite_record.id;
            END IF;
          EXCEPTION WHEN OTHERS THEN
            -- Ignore errors in mobile check, use email match
            RAISE LOG '⚠️ Error checking staff_invite by mobile, using email match: %', SQLERRM;
          END;
        END IF;
      END IF;
    END IF;
  EXCEPTION
    WHEN undefined_table THEN
      -- staff_invite table doesn't exist, default to amo role
      RAISE LOG '⚠️ staff_invite table does not exist, defaulting to amo role for user: %', NEW.email;
      staff_invite_found := FALSE;
      -- user_role already defaults to 'amo' above, so no need to set it
    WHEN OTHERS THEN
      -- Any other error checking staff_invite, log and continue with amo role
      RAISE LOG '⚠️ Error checking staff_invite table: % (SQLSTATE: %). Defaulting to amo role for user: %', 
        SQLERRM, SQLSTATE, NEW.email;
      staff_invite_found := FALSE;
      -- user_role already defaults to 'amo' above, so no need to set it
  END;
  
  RAISE LOG '📋 Final user role determined: %', user_role;

  -- ============================================================================
  -- PHASE 3.1: Detect existing pending user (FIXED: Use boolean flag)
  -- ============================================================================
  pending_user_found := FALSE;  -- Initialize flag
  
  -- Check by email (if email is provided)
  IF normalized_email IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = 'public'
        AND table_name = 'users' 
        AND column_name = 'household'
    ) THEN
      SELECT id, email, mobile_no, full_name, first_name, last_name, role, household, user_color
      INTO pending_user_record
      FROM public.users
      WHERE LOWER(TRIM(email)) = normalized_email
        AND is_pending_signup = TRUE
        AND authid IS NULL
      LIMIT 1;
    ELSE
      SELECT id, email, mobile_no, full_name, first_name, last_name, role, user_color
      INTO pending_user_record
      FROM public.users
      WHERE LOWER(TRIM(email)) = normalized_email
        AND is_pending_signup = TRUE
        AND authid IS NULL
      LIMIT 1;
    END IF;
    
    -- FIX: Use FOUND to set boolean flag instead of checking record
    IF FOUND THEN
      pending_user_found := TRUE;
      RAISE LOG '🔗 Pending user FOUND by email: % (pending_user_id: %)', normalized_email, pending_user_record.id;
    END IF;
  END IF;
  
  -- If not found by email, check by phone (if phone is provided)
  IF NOT pending_user_found AND normalized_phone IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = 'public'
        AND table_name = 'users' 
        AND column_name = 'household'
    ) THEN
      SELECT id, email, mobile_no, full_name, first_name, last_name, role, household, user_color
      INTO pending_user_record
      FROM public.users
      WHERE normalize_phone_number(mobile_no) = normalized_phone
        AND is_pending_signup = TRUE
        AND authid IS NULL
      LIMIT 1;
    ELSE
      SELECT id, email, mobile_no, full_name, first_name, last_name, role, user_color
      INTO pending_user_record
      FROM public.users
      WHERE normalize_phone_number(mobile_no) = normalized_phone
        AND is_pending_signup = TRUE
        AND authid IS NULL
      LIMIT 1;
    END IF;
    
    -- FIX: Use FOUND to set boolean flag instead of checking record
    IF FOUND THEN
      pending_user_found := TRUE;
      RAISE LOG '🔗 Pending user FOUND by phone: % (pending_user_id: %)', normalized_phone, pending_user_record.id;
    END IF;
  END IF;

  -- ============================================================================
  -- PHASE 3.2: Handle pending user migration (FIXED: Use boolean flag)
  -- ============================================================================
  IF pending_user_found THEN
    BEGIN
      RAISE LOG '🔄 Starting pending user migration flow';
      
      random_color := COALESCE(pending_user_record.user_color, NULL);
      
      IF random_color IS NULL THEN
        SELECT color
        INTO random_color
        FROM public.user_colors
        ORDER BY random()
        LIMIT 1;
        
        IF random_color IS NULL THEN
          random_color := '#FF5733';
          RAISE LOG '⚠️ No colors in user_colors table, using default: %', random_color;
        ELSE
          RAISE LOG '🎨 Selected random color: %', random_color;
        END IF;
      ELSE
        RAISE LOG '🎨 Using color from pending user: %', random_color;
      END IF;
      
      display_name := COALESCE(
        pending_user_record.full_name,
        NEW.raw_user_meta_data->>'display_name',
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'name',
        NEW.raw_user_meta_data->>'first_name',
        NEW.email
      );
      
      v_first_name := COALESCE(
        pending_user_record.first_name,
        NEW.raw_user_meta_data->>'first_name',
        NEW.raw_user_meta_data->>'given_name',
        SPLIT_PART(display_name, ' ', 1)
      );
      
      v_last_name := COALESCE(
        pending_user_record.last_name,
        NEW.raw_user_meta_data->>'last_name',
        NEW.raw_user_meta_data->>'family_name',
        CASE 
          WHEN POSITION(' ' IN display_name) > 0 
          THEN SUBSTRING(display_name FROM POSITION(' ' IN display_name) + 1)
          ELSE NULL
        END
      );
      
      RAISE LOG '👤 Creating authenticated user record (id: %, email: %, name: %)', 
        NEW.id, COALESCE(NEW.email, pending_user_record.email), display_name;
      
      -- FIX: Handle mobile_no conflict when pending user exists with same mobile_no
      -- Store backups for rollback if needed
      pending_mobile_backup := pending_user_record.mobile_no;
      pending_user_email_backup := pending_user_record.email;
      
      -- Temporarily clear pending user's mobile_no to avoid unique constraint violation
      -- This is safe because we'll delete the pending user after migration
      UPDATE public.users
      SET mobile_no = NULL
      WHERE id = pending_user_record.id
        AND is_pending_signup = TRUE
        AND authid IS NULL;
      
      RAISE LOG '🔧 Temporarily cleared pending user mobile_no to avoid conflict';
      
      -- Also handle email conflict if same email exists
      IF NEW.email IS NOT NULL AND LOWER(TRIM(pending_user_record.email)) = LOWER(TRIM(NEW.email)) THEN
        -- Temporarily set pending user's email to a unique placeholder to avoid conflict
        UPDATE public.users
        SET email = 'temp-' || pending_user_record.id::TEXT || '@temp-migration.domo.ph'
        WHERE id = pending_user_record.id;
        
        RAISE LOG '🔧 Temporarily changed pending user email to placeholder to avoid conflict';
      END IF;
      
      -- Now INSERT the new authenticated user record (conflicts resolved)
      INSERT INTO public.users (
        id,
        email,
        mobile_no,
        user_color,
        role,
        authid,
        full_name,
        first_name,
        last_name,
        profile_picture,
        primary_auth_method,
        oauth_linked,
        onboarded,
        is_pending_signup,
        household,
        created_at,
        updated_at
      )
      VALUES (
        NEW.id,
        COALESCE(NEW.email, pending_user_email_backup),
        COALESCE(
          user_phone, 
          CASE 
            WHEN pending_mobile_backup IS NOT NULL AND pending_mobile_backup != '' 
            THEN normalize_phone_number(pending_mobile_backup)
            ELSE NULL
          END
        ),
        random_color,
        COALESCE(user_role, pending_user_record.role, 'amo'),
        NEW.id,
        display_name,
        v_first_name,
        v_last_name,
        COALESCE(NEW.raw_user_meta_data->>'profile_picture', NULL),
        auth_method,
        CASE WHEN provider != 'email' THEN TRUE ELSE FALSE END,
        FALSE,
        FALSE,
        pending_user_record.household,
        NOW(),
        NOW()
      )
      ON CONFLICT (id) DO UPDATE
      SET
        email = COALESCE(EXCLUDED.email, users.email),
        mobile_no = COALESCE(EXCLUDED.mobile_no, users.mobile_no),
        authid = NEW.id,
        is_pending_signup = FALSE,
        updated_at = NOW();
      
      RAISE LOG '✅ Created authenticated user record: %', NEW.id;
      
      -- Call migration function to move FK references
      RAISE LOG '🔄 Starting FK migration from pending user % to authenticated user %', 
        pending_user_record.id, NEW.id;
      
      SELECT migrate_pending_user_to_authenticated(
        pending_user_record.id,
        NEW.id
      ) INTO migration_result;
      
      IF migration_result->>'success' = 'true' THEN
        RAISE LOG '✅ Migration successful: %', migration_result;
      ELSE
        RAISE WARNING '⚠️ Migration completed with errors: %', migration_result;
      END IF;
      
      -- Delete the pending user after migration (all FK references have been moved)
      DELETE FROM public.users
      WHERE id = pending_user_record.id
        AND is_pending_signup = TRUE
        AND authid IS NULL;
      
      RAISE LOG '✅ Deleted pending user after migration: %', pending_user_record.id;
      
      -- Update authenticated user with final metadata
      -- NOTE: Household is NOT updated here - it's already set from pending user during INSERT
      UPDATE public.users
      SET
        email = COALESCE(NEW.email, users.email),
        mobile_no = COALESCE(
          user_phone, 
          CASE 
            WHEN pending_mobile_backup IS NOT NULL AND pending_mobile_backup != '' 
            THEN normalize_phone_number(pending_mobile_backup)
            ELSE NULL
          END
        ),
        role = COALESCE(user_role, users.role),
        primary_auth_method = auth_method,
        oauth_linked = CASE WHEN provider != 'email' THEN TRUE ELSE FALSE END,
        updated_at = NOW()
      WHERE id = NEW.id;
      
      RAISE LOG '✅ Updated authenticated user after migration';
      
    EXCEPTION WHEN OTHERS THEN
      -- If something goes wrong, try to restore pending user's mobile_no and email
      IF pending_mobile_backup IS NOT NULL AND pending_user_found THEN
        BEGIN
          UPDATE public.users
          SET mobile_no = pending_mobile_backup
          WHERE id = pending_user_record.id;
          RAISE LOG '🔧 Restored pending user mobile_no after error';
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING '⚠️ Could not restore pending user mobile_no: %', SQLERRM;
        END;
      END IF;
      
      IF pending_user_email_backup IS NOT NULL AND pending_user_found THEN
        BEGIN
          UPDATE public.users
          SET email = pending_user_email_backup
          WHERE id = pending_user_record.id;
          RAISE LOG '🔧 Restored pending user email after error';
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING '⚠️ Could not restore pending user email: %', SQLERRM;
        END;
      END IF;
      
      RAISE WARNING '❌ ERROR during pending user migration: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
      RAISE WARNING 'Continuing with normal user creation flow';
      pending_user_found := FALSE;
    END;
  END IF;

  -- ============================================================================
  -- Create or update user profile (only if not already created during migration)
  -- ============================================================================
  
  IF NOT pending_user_found THEN
    RAISE LOG '📝 Starting normal user creation flow (no pending user found)';
    
    SELECT color
    INTO random_color
    FROM user_colors
    ORDER BY random()
    LIMIT 1;
    
    IF random_color IS NULL THEN
      random_color := '#FF5733';
      RAISE LOG '⚠️ No colors in user_colors table, using default: %', random_color;
    ELSE
      RAISE LOG '🎨 Selected random color: %', random_color;
    END IF;

    display_name := COALESCE(
      NEW.raw_user_meta_data->>'display_name',
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      NEW.raw_user_meta_data->>'first_name',
      NEW.email
    );

    v_first_name := COALESCE(
      NEW.raw_user_meta_data->>'first_name',
      NEW.raw_user_meta_data->>'given_name',
      SPLIT_PART(display_name, ' ', 1)
    );
    
    v_last_name := COALESCE(
      NEW.raw_user_meta_data->>'last_name',
      NEW.raw_user_meta_data->>'family_name',
      CASE 
        WHEN POSITION(' ' IN display_name) > 0 
        THEN SUBSTRING(display_name FROM POSITION(' ' IN display_name) + 1)
        ELSE NULL
      END
    );

    RAISE LOG '👤 Creating user record (id: %, email: %, name: %, role: %)', 
      NEW.id, NEW.email, display_name, user_role;

    -- Create user profile
    INSERT INTO public.users (
      id,
      email,
      mobile_no,
      user_color,
      role,
      authid,
      full_name,
      first_name,
      last_name,
      profile_picture,
      primary_auth_method,
      oauth_linked,
      onboarded,
      is_pending_signup,
      created_at,
      updated_at
    )
    VALUES (
      NEW.id,
      NEW.email,
      user_phone,
      random_color,
      user_role,
      NEW.id,
      display_name,
      v_first_name,
      v_last_name,
      NEW.raw_user_meta_data->>'profile_picture',
      auth_method,
      CASE WHEN provider != 'email' THEN TRUE ELSE FALSE END,
      FALSE,
      FALSE,
      NOW(),
      NOW()
    )
    ON CONFLICT (id) DO UPDATE
    SET
      mobile_no = COALESCE(EXCLUDED.mobile_no, users.mobile_no),
      email = COALESCE(EXCLUDED.email, users.email),
      primary_auth_method = COALESCE(EXCLUDED.primary_auth_method, users.primary_auth_method),
      role = COALESCE(EXCLUDED.role, users.role),
      is_pending_signup = FALSE,
      updated_at = NOW();
    
    RAISE LOG '✅ User record created/updated successfully';
  END IF;

  -- ============================================================================
  -- AUTOMATIC HOUSEHOLD CREATION FOR AMO USERS
  -- ============================================================================
  -- Only create household for 'amo' role users who don't have one and have no staff invite
  
  -- Get the created user record
  SELECT id, household, role INTO user_record
  FROM public.users
  WHERE id = NEW.id;
  
  IF user_record.id IS NULL THEN
    RAISE WARNING '⚠️ User record not found after creation, skipping household creation';
  ELSIF user_record.role != 'amo' THEN
    RAISE LOG '⏭️ Skipping household creation - user role is not amo: %', user_record.role;
  ELSE
    -- Check if user already has household
    user_has_household := (user_record.household IS NOT NULL);
    
    -- Check if user has staff invite (already checked above)
    user_has_invite := staff_invite_found;
    
    IF user_has_household THEN
      RAISE LOG '⏭️ Skipping household creation - user already has household: %', user_record.household;
    ELSIF user_has_invite THEN
      RAISE LOG '⏭️ Skipping household creation - user has staff invite (should be kasambahay): %', 
        CASE WHEN staff_invite_found THEN staff_invite_record.id::TEXT ELSE 'unknown' END;
    ELSE
      -- Create household automatically
      RAISE LOG '🏠 Starting automatic household creation for amo user: %', NEW.id;
      
      BEGIN
        -- Generate unique join code
        LOOP
          new_join_code := UPPER(SUBSTRING(MD5(RANDOM()::TEXT) FROM 1 FOR 6));
          EXIT WHEN NOT EXISTS (SELECT 1 FROM public.households h WHERE h.join_code = new_join_code);
        END LOOP;
        
        RAISE LOG '🔑 Generated join code: %', new_join_code;
        
        -- Create household
        INSERT INTO public.households (name, owner_id, join_code)
        VALUES ('My Domo household', user_record.id, new_join_code)
        RETURNING id INTO new_household_id;
        
        RAISE LOG '✅ Household created: %', new_household_id;
        
        -- Update user's household column
        UPDATE public.users 
        SET household = new_household_id
        WHERE id = user_record.id;
        
        RAISE LOG '✅ User household column updated';
        
        -- Add user to household_members (check if already exists first)
        IF NOT EXISTS (
          SELECT 1 FROM public.household_members 
          WHERE household_id = new_household_id 
          AND user_id = user_record.id
        ) THEN
          INSERT INTO public.household_members (household_id, user_id)
          VALUES (new_household_id, user_record.id);
          RAISE LOG '✅ User added to household_members';
        ELSE
          RAISE LOG '⚠️ User already in household_members, skipping insert';
        END IF;
        
        RAISE LOG '✅✅✅ Automatic household creation completed successfully for user: % (household: %, join_code: %)', 
          NEW.id, new_household_id, new_join_code;
          
      EXCEPTION WHEN OTHERS THEN
        -- Log error but don't fail the trigger - user creation should succeed even if household creation fails
        RAISE WARNING '❌ Error creating household automatically: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
        RAISE LOG '⚠️ User can create household manually later';
      END;
    END IF;
  END IF;

  -- ============================================================================
  -- STAFF INVITE UPDATE: Mark staff_invite as done and link to user
  -- ============================================================================
  -- This ensures staff_invite is updated when OAuth creates a user via trigger
  -- (The edge function also tries to update this, but the trigger runs first)
  IF staff_invite_found AND staff_invite_record.id IS NOT NULL THEN
    BEGIN
      RAISE LOG '📋 Updating staff_invite record: % (household_id: %)', 
        staff_invite_record.id, staff_invite_record.household_id;
      
      -- Ensure we have the user record (refresh it to get latest data)
      SELECT id, household, role INTO user_record
      FROM public.users
      WHERE id = NEW.id;
      
      IF user_record.id IS NULL THEN
        RAISE WARNING '⚠️ User record not found for staff_invite update';
      ELSE
        -- FIX: Update staff_invite more defensively - handle already-updated records
        -- Update status to 'done' if still 'new', and always ensure user_id is set
        -- This prevents deletion and handles cases where edge function updated status first
        -- CRITICAL: Always update when staff_invite is found to ensure user_id is set
        -- This prevents CASCADE deletion if user is somehow deleted/recreated
        UPDATE public.staff_invite
        SET 
          status = CASE WHEN status = 'new' THEN 'done' ELSE status END,
          user_id = COALESCE(user_id, user_record.id),  -- Always ensure user_id is set
          updated_at = NOW()
        WHERE id = staff_invite_record.id;
        
        -- Check if update actually happened
        IF FOUND THEN
          RAISE LOG '✅ Staff invite updated: status=done (or already done), user_id=%', 
            user_record.id;
        ELSE
          -- This should never happen if staff_invite_record.id is valid
          RAISE WARNING '⚠️ Staff invite update found no rows to update (id=%)', 
            staff_invite_record.id;
        END IF;
        
        -- If staff_invite has a household_id, assign it to the user
        IF staff_invite_record.household_id IS NOT NULL THEN
          -- Update user's household if not already set
          IF user_record.household IS NULL THEN
            UPDATE public.users
            SET household = staff_invite_record.household_id
            WHERE id = user_record.id;
            
            RAISE LOG '✅ User household assigned from staff_invite: %', staff_invite_record.household_id;
          ELSE
            RAISE LOG '⚠️ User already has household: %, not overwriting with staff_invite household: %', 
              user_record.household, staff_invite_record.household_id;
          END IF;
          
          -- Ensure household_members entry exists
          IF NOT EXISTS (
            SELECT 1 FROM public.household_members 
            WHERE household_id = staff_invite_record.household_id 
            AND user_id = user_record.id
          ) THEN
            INSERT INTO public.household_members (household_id, user_id)
            VALUES (staff_invite_record.household_id, user_record.id);
            RAISE LOG '✅ User added to household_members from staff_invite';
          ELSE
            RAISE LOG '⚠️ User already in household_members, skipping insert';
          END IF;
        END IF;
      END IF;
      
    EXCEPTION WHEN OTHERS THEN
      -- Log error but don't fail the trigger - user creation should succeed
      RAISE WARNING '❌ Error updating staff_invite: % (SQLSTATE: %)', SQLERRM, SQLSTATE;
      RAISE LOG '⚠️ Staff invite can be updated later by edge function';
    END;
  END IF;

  -- Log successful trigger execution (FIXED: Use boolean flag)
  IF pending_user_found THEN
    RAISE LOG '✅✅✅ handle_new_user TRIGGER COMPLETED SUCCESSFULLY (with migration) for user: % (authid: %, phone: %, role: %, auth_method: %, migrated_from: %)', 
      NEW.email, NEW.id, user_phone, user_role, auth_method, pending_user_record.id;
  ELSE
    RAISE LOG '✅✅✅ handle_new_user TRIGGER COMPLETED SUCCESSFULLY for user: % (authid: %, phone: %, role: %, auth_method: %)', 
      NEW.email, NEW.id, user_phone, user_role, auth_method;
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG '❌❌❌ ERROR in handle_new_user function for user % (authid: %): %', NEW.email, NEW.id, SQLERRM;
    RAISE LOG '❌ SQLSTATE: %', SQLSTATE;
    -- Return NEW to allow the auth user creation to succeed even if profile creation fails
    RETURN NEW;
END;
$$;

-- Update function comment
COMMENT ON FUNCTION public.handle_new_user() IS 'Automatically creates a user profile when a new auth user is created. Enhanced with detailed logging for debugging. Detects existing pending users by email or phone and migrates their data using migrate_pending_user_to_authenticated(). Checks staff_invite table by phone/email to determine role (kasambahay if found, amo otherwise). Assigns a random color from user_colors, extracts display name from metadata, and syncs phone number. Sets primary_auth_method based on phone or provider. Automatically creates household for amo users who don''t have one and have no staff invite. Uses default name "My Domo household" which can be updated later. Robust error handling ensures OAuth and phone auth flows work. Uses SET search_path for proper schema resolution. Fixed mobile_no column error on 2025-01-26 by ensuring proper schema qualification.';

-- Grant execute permission (adjust role as needed)
-- GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated;
-- GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

