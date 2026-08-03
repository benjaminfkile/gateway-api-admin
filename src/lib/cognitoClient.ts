import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";

// Thin wrapper around amazon-cognito-identity-js for the ops user pool.
// The pool requires TOTP MFA, so sign-in is a two-step flow:
//   signIn() -> "mfaRequired" -> submitTotp() -> "signedIn"

const poolId = import.meta.env.VITE_COGNITO_POOL_ID as string | undefined;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;

let pool: CognitoUserPool | null = null;
let pendingUser: CognitoUser | null = null;

function getPool(): CognitoUserPool {
  if (!poolId || !clientId) {
    throw new Error(
      "Cognito is not configured: set VITE_COGNITO_POOL_ID and VITE_COGNITO_CLIENT_ID",
    );
  }
  pool ??= new CognitoUserPool({ UserPoolId: poolId, ClientId: clientId });
  return pool;
}

export type SignInResult = "signedIn" | "mfaRequired" | "newPasswordRequired";

export function signIn(username: string, password: string): Promise<SignInResult> {
  const user = new CognitoUser({ Username: username, Pool: getPool() });
  pendingUser = user;
  return new Promise((resolve, reject) => {
    user.authenticateUser(
      new AuthenticationDetails({ Username: username, Password: password }),
      {
        onSuccess: () => resolve("signedIn"),
        onFailure: reject,
        totpRequired: () => resolve("mfaRequired"),
        newPasswordRequired: () => resolve("newPasswordRequired"),
      },
    );
  });
}

export function submitTotp(code: string): Promise<void> {
  const user = pendingUser;
  if (!user) return Promise.reject(new Error("No sign-in in progress"));
  return new Promise((resolve, reject) => {
    user.sendMFACode(
      code,
      { onSuccess: () => resolve(), onFailure: reject },
      "SOFTWARE_TOKEN_MFA",
    );
  });
}

function getSession(): Promise<CognitoUserSession | null> {
  const user = getPool().getCurrentUser();
  if (!user) return Promise.resolve(null);
  return new Promise((resolve) => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      resolve(err ? null : session);
    });
  });
}

export async function getAccessToken(): Promise<string | null> {
  const session = await getSession();
  return session?.isValid() ? session.getAccessToken().getJwtToken() : null;
}

export async function hasValidSession(): Promise<boolean> {
  return (await getAccessToken()) !== null;
}

export function signOut(): void {
  getPool().getCurrentUser()?.signOut();
  pendingUser = null;
}
