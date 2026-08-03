import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
  type IAuthenticationCallback,
} from "amazon-cognito-identity-js";

// Thin wrapper around amazon-cognito-identity-js for the ops user pool.
// The pool requires TOTP MFA, so sign-in is a multi-step flow. Depending on the
// account state, signIn() can resolve to any of these challenges:
//   "mfaRequired"         -> submitTotp(code)                 -> "signedIn"
//   "mfaSetupRequired"    -> beginTotpSetup() / completeTotpSetup(code) -> signedIn
//   "newPasswordRequired" -> completeNewPasswordChallenge(pw) -> (challenge | signedIn)

let pool: CognitoUserPool | null = null;
let pendingUser: CognitoUser | null = null;

function getPool(): CognitoUserPool {
  const poolId = import.meta.env.VITE_COGNITO_POOL_ID as string | undefined;
  const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
  if (!poolId || !clientId) {
    throw new Error(
      "Cognito is not configured: set VITE_COGNITO_POOL_ID and VITE_COGNITO_CLIENT_ID",
    );
  }
  pool ??= new CognitoUserPool({ UserPoolId: poolId, ClientId: clientId });
  return pool;
}

export type SignInResult =
  | "signedIn"
  | "mfaRequired"
  | "mfaSetupRequired"
  | "newPasswordRequired";

// Shared authentication callbacks. Both authenticateUser() and the
// completeNewPasswordChallenge() continuation report progress through the same
// set of challenges, so they resolve the promise to the same SignInResult union.
function authCallbacks(
  resolve: (result: SignInResult) => void,
  reject: (err: unknown) => void,
): IAuthenticationCallback {
  return {
    onSuccess: () => resolve("signedIn"),
    onFailure: reject,
    totpRequired: () => resolve("mfaRequired"),
    mfaSetup: () => resolve("mfaSetupRequired"),
    newPasswordRequired: () => resolve("newPasswordRequired"),
  };
}

export function signIn(username: string, password: string): Promise<SignInResult> {
  const user = new CognitoUser({ Username: username, Pool: getPool() });
  pendingUser = user;
  return new Promise((resolve, reject) => {
    user.authenticateUser(
      new AuthenticationDetails({ Username: username, Password: password }),
      authCallbacks(resolve, reject),
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

// First login against a pool with required TOTP: Cognito returns the MFA_SETUP
// challenge. associateSoftwareToken() yields the shared secret to seed the
// user's authenticator app; verifySoftwareToken() then proves possession and
// completes the sign-in.
export function beginTotpSetup(): Promise<string> {
  const user = pendingUser;
  if (!user) return Promise.reject(new Error("No sign-in in progress"));
  return new Promise((resolve, reject) => {
    user.associateSoftwareToken({
      associateSecretCode: (secret: string) => resolve(secret),
      onFailure: reject,
    });
  });
}

export function completeTotpSetup(code: string): Promise<void> {
  const user = pendingUser;
  if (!user) return Promise.reject(new Error("No sign-in in progress"));
  return new Promise((resolve, reject) => {
    user.verifySoftwareToken(code, "gateway-api-ops", {
      onSuccess: () => resolve(),
      onFailure: reject,
    });
  });
}

export function completeNewPasswordChallenge(
  newPassword: string,
): Promise<SignInResult> {
  const user = pendingUser;
  if (!user) return Promise.reject(new Error("No sign-in in progress"));
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(newPassword, {}, authCallbacks(resolve, reject));
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
