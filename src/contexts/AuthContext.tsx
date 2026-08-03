import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import * as cognito from "../lib/cognitoClient";
import type { SignInResult } from "../lib/cognitoClient";
import { setUnauthorizedHandler } from "../api/apiClient";
import { stopConnection } from "../lib/hubClient";

export type AuthStatus =
  | "loading"
  | "signedOut"
  | "mfaRequired"
  | "mfaSetupRequired"
  | "newPasswordRequired"
  | "signedIn";

interface AuthContextValue {
  status: AuthStatus;
  error: string | null;
  signIn: (username: string, password: string) => Promise<void>;
  submitTotp: (code: string) => Promise<void>;
  beginTotpSetup: () => Promise<string>;
  completeTotpSetup: (code: string) => Promise<void>;
  completeNewPassword: (newPassword: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Map a Cognito sign-in result onto the auth state machine. Kept in one place
// so signIn() and the new-password continuation transition identically.
const RESULT_STATUS: Record<SignInResult, AuthStatus> = {
  signedIn: "signedIn",
  mfaRequired: "mfaRequired",
  mfaSetupRequired: "mfaSetupRequired",
  newPasswordRequired: "newPasswordRequired",
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cognito
      .hasValidSession()
      .then((valid) => setStatus(valid ? "signedIn" : "signedOut"))
      .catch(() => setStatus("signedOut"));
  }, []);

  async function signIn(username: string, password: string) {
    setError(null);
    try {
      const result = await cognito.signIn(username, password);
      setStatus(RESULT_STATUS[result]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitTotp(code: string) {
    setError(null);
    try {
      await cognito.submitTotp(code);
      setStatus("signedIn");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function beginTotpSetup() {
    setError(null);
    try {
      return await cognito.beginTotpSetup();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function completeTotpSetup(code: string) {
    setError(null);
    try {
      await cognito.completeTotpSetup(code);
      setStatus("signedIn");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function completeNewPassword(newPassword: string) {
    setError(null);
    try {
      const result = await cognito.completeNewPasswordChallenge(newPassword);
      setStatus(RESULT_STATUS[result]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function signOut() {
    cognito.signOut();
    // Tear down the live hub so it stops retrying with a now-invalid token.
    void stopConnection();
    setStatus("signedOut");
  }

  // A 401 from any API call means the session is no longer valid: sign out so
  // RequireAuth bounces the user to /login (preserving where they were). The
  // interceptor lives outside React, so it drives sign-out through this handler.
  useEffect(() => {
    setUnauthorizedHandler(signOut);
    return () => setUnauthorizedHandler(null);
    // signOut is stable (only closes over module-level helpers and setStatus).

  }, []);

  return (
    <AuthContext.Provider
      value={{
        status,
        error,
        signIn,
        submitTotp,
        beginTotpSetup,
        completeTotpSetup,
        completeNewPassword,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
