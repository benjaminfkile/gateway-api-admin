import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import * as cognito from "../lib/cognitoClient";

export type AuthStatus =
  | "loading"
  | "signedOut"
  | "mfaRequired"
  | "signedIn";

interface AuthContextValue {
  status: AuthStatus;
  error: string | null;
  signIn: (username: string, password: string) => Promise<void>;
  submitTotp: (code: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

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
      if (result === "mfaRequired") {
        setStatus("mfaRequired");
      } else if (result === "signedIn") {
        setStatus("signedIn");
      } else {
        setError("Password change required — complete it in the AWS console.");
      }
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

  function signOut() {
    cognito.signOut();
    setStatus("signedOut");
  }

  return (
    <AuthContext.Provider value={{ status, error, signIn, submitTotp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
