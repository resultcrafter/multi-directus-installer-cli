import {isCancel, log, password, select, text} from '@clack/prompts'
import {readMe, readItems} from '@directus/sdk'
import {ux} from '@oclif/core'
import process from 'node:process'

import { DEFAULT_DIRECTUS_URL } from '../../lib/constants.js'
import {api} from '../sdk.js'
import catchError from './catch-error.js'
import validateUrl from './validate-url.js'

interface AuthFlags {
  directusToken?: string;
  directusUrl: string;
  userEmail?: string;
  userPassword?: string;
}

export enum FreshDirectusStatus {
  FRESH = 'fresh',
  EXISTING = 'existing',
  UNKNOWN = 'unknown',
}

export async function isFreshDirectus(directusUrl: string): Promise<FreshDirectusStatus> {
  try {
    const response = await fetch(`${directusUrl}/users?limit=1`, {
      method: 'GET',
      headers: {'Content-Type': 'application/json'},
    })

    if (response.status === 401 || response.status === 403) {
      return FreshDirectusStatus.FRESH
    }

    if (response.ok) {
      const data = await response.json()
      if (data.data && data.data.length > 0) {
        return FreshDirectusStatus.EXISTING
      }
    }

    return FreshDirectusStatus.UNKNOWN
  } catch {
    return FreshDirectusStatus.UNKNOWN
  }
}

export async function showOnboardingInstructions(directusUrl: string): Promise<void> {
  log.info('')
  log.info('It looks like this is a fresh Directus instance. Follow these steps to create an admin account:')
  log.info('')
  log.info(`  1. Open Directus: ${directusUrl}`)
  log.info('  2. Create your first admin account (name, email, password)')
  log.info('  3. Log in with your new account')
  log.info('  4. Generate an admin token:')
  log.info('     - Click the user circle icon in the left bottom corner')
  log.info('     - Select "Your Profile"')
  log.info('     - Scroll down to the "Token" section')
  log.info('     - In the empty text field, click the PLUS icon on the right to generate a token')
  log.info('     - Copy and save the generated token in a safe place')
  log.info('     - IMPORTANT: Click the "Save" button (round circle, upper right corner) to save the token')
  log.info('')
}

export async function askFreshDirectusConfirmation(directusUrl: string): Promise<boolean> {
  const response = await select({
    message: 'Is this a fresh Directus instance with no existing admin account?',
    options: [
      {label: 'Yes, guide me through setup', value: 'yes'},
      {label: 'No, I have an existing admin account', value: 'no'},
    ],
  })

  return response === 'yes'
}

/**
 * Get the Directus URL from the user
 * @returns The Directus URL
 */
export async function getDirectusUrl() {
  const directusUrl = await text({
    message: 'What is your Directus URL?',
    placeholder: DEFAULT_DIRECTUS_URL,
  })


  if (isCancel(directusUrl)) {
    log.info('Exiting...')
    process.exit(0)
  }

  if (!directusUrl) {
    ux.warn(`No URL provided, using default: ${DEFAULT_DIRECTUS_URL}`)
    return DEFAULT_DIRECTUS_URL
  }

  // Validate URL
  if (!validateUrl(directusUrl as string)) {
    ux.warn('Invalid URL')
    return getDirectusUrl()
  }

  api.initialize(directusUrl as string)

  return directusUrl
}

/**
 * Get the Directus token from the user
 * @param directusUrl - The Directus URL
 * @param showOnboarding - Whether to show onboarding instructions for fresh Directus
 * @returns The Directus token
 */
export async function getDirectusToken(directusUrl: string, showOnboarding: boolean = false) {
  if (showOnboarding) {
    await showOnboardingInstructions(directusUrl)
  }

  const directusToken = await text({
    message: 'Paste your admin token:',
    placeholder: 'admin-token-here',
  })

  if (isCancel(directusToken)) {
    log.info('Exiting...')
    process.exit(0)
  }

  // Validate token by fetching the user
  try {
    await api.loginWithToken(directusToken as string)
    const response = await api.client.request(readMe())
    return directusToken
  } catch (error) {
    catchError(error, {
      context: {
        directusUrl,
        message: 'Invalid token. Please check and try again.',
        operation: 'getDirectusToken',
      },
    })
    return getDirectusToken(directusUrl, showOnboarding)
  }
}

export async function getDirectusEmailAndPassword() {
  const userEmail = await text({
    message: 'What is your email?',
    validate(value) {
      if (!value) {
        return 'Email is required'
      }
    },
  })

  if (isCancel(userEmail)) {
    log.info('Exiting...')
    process.exit(0)
  }

  const userPassword = await password({
    message: 'What is your password?',
    validate(value) {
      if (!value) {
        return 'Password is required'
      }
    },
  })

  if (isCancel(userPassword)) {
    log.info('Exiting...')
    process.exit(0)
  }

  return {userEmail, userPassword}
}

/**
 * Initialize the Directus API with the provided flags and log in the user
 * @param flags - The validated ApplyFlags
 * @returns {Promise<void>} - Returns nothing
 */
export async function initializeDirectusApi(flags: AuthFlags): Promise<void> {
  api.initialize(flags.directusUrl)

  try {
    if (flags.directusToken) {
      await api.loginWithToken(flags.directusToken)
    } else if (flags.userEmail && flags.userPassword) {
      await api.login(flags.userEmail, flags.userPassword)
    }

    const response = await api.client.request(readMe()) as any
    ux.stdout(`-- Logged in as ${response.first_name} ${response.last_name}`)
  } catch {
    catchError('-- Unable to authenticate with the provided credentials. Please check your credentials.', {
      fatal: true,
    })
  }
}

/**
 * Validate the authentication flags
 * @param flags - The AuthFlags
 * @returns {void} - Errors if the flags are invalid
 */
export function validateAuthFlags(flags: AuthFlags): void {
  if (!flags.directusUrl) {
    ux.error('Directus URL is required.')
  }

  if (!flags.directusToken && (!flags.userEmail || !flags.userPassword)) {
    ux.error('Either Directus token or email and password are required.')
  }
}
