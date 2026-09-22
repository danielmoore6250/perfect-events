// Cognito sign-in without an SDK: the user pool's JSON API accepts plain
// fetch calls for the unauthenticated operations we need. Tokens live in
// localStorage so a page refresh does not sign the admin out.

import { API_BASE } from '../config';

const SESSION_KEY = 'pe-admin-session';

let config = null;

export const loadConfig = async () => {
  if (config) return config;
  const res = await fetch(`${API_BASE}/admin/config`);
  if (!res.ok) throw new Error('Could not load admin configuration');
  config = await res.json();
  if (!config.clientId) throw new Error('Admin login is not configured yet');
  return config;
};

const cognitoCall = async (target, payload) => {
  const { region } = await loadConfig();
  const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(friendlyMessage(data));
    error.code = data.__type;
    throw error;
  }
  return data;
};

const friendlyMessage = (data) => {
  const type = String(data.__type || '').split('#').pop();
  switch (type) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return 'Incorrect email or password.';
    case 'InvalidPasswordException':
      return data.message || 'That password does not meet the requirements.';
    case 'PasswordResetRequiredException':
      return 'A password reset is required. Use "Forgot password" in the Cognito console.';
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      return 'Too many attempts. Wait a minute and try again.';
    default:
      return data.message || 'Sign-in failed.';
  }
};

const saveSession = (result, email) => {
  const session = {
    email,
    idToken: result.IdToken,
    refreshToken: result.RefreshToken || getSession()?.refreshToken || null,
    expiresAt: Date.now() + (result.ExpiresIn || 3600) * 1000
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage may be unavailable (private mode); the session still works in memory.
  }
  memorySession = session;
  return session;
};

let memorySession = null;

export const getSession = () => {
  if (memorySession) return memorySession;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    memorySession = raw ? JSON.parse(raw) : null;
  } catch {
    memorySession = null;
  }
  return memorySession;
};

export const clearSession = () => {
  memorySession = null;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
};

// Returns { session } on success, or { challenge, session: cognitoSession }
// when Cognito wants a new password (first sign-in with the temporary one).
export const signIn = async (email, password) => {
  const { clientId } = await loadConfig();
  const data = await cognitoCall('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password }
  });

  if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    return { challenge: 'NEW_PASSWORD_REQUIRED', cognitoSession: data.Session };
  }
  if (!data.AuthenticationResult) {
    throw new Error(`Unsupported sign-in step: ${data.ChallengeName || 'unknown'}`);
  }
  return { session: saveSession(data.AuthenticationResult, email) };
};

export const completeNewPassword = async (email, newPassword, cognitoSession) => {
  const { clientId } = await loadConfig();
  const data = await cognitoCall('RespondToAuthChallenge', {
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    ClientId: clientId,
    Session: cognitoSession,
    ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword }
  });
  if (!data.AuthenticationResult) {
    throw new Error('Password was not accepted.');
  }
  return saveSession(data.AuthenticationResult, email);
};

const refreshSession = async (session) => {
  const { clientId } = await loadConfig();
  const data = await cognitoCall('InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    ClientId: clientId,
    AuthParameters: { REFRESH_TOKEN: session.refreshToken }
  });
  return saveSession(data.AuthenticationResult, session.email);
};

// A token that is valid for at least another minute, refreshing if needed.
// Returns null when there is no usable session, so the caller shows the login.
export const getIdToken = async () => {
  const session = getSession();
  if (!session) return null;
  if (session.expiresAt - Date.now() > 60 * 1000) return session.idToken;
  if (!session.refreshToken) {
    clearSession();
    return null;
  }
  try {
    return (await refreshSession(session)).idToken;
  } catch {
    clearSession();
    return null;
  }
};
