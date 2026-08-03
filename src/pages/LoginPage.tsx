import { useEffect, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Link,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useAuth } from "../contexts/AuthContext";
import TotpQrCode from "../components/TotpQrCode";

export default function LoginPage() {
  const {
    status,
    error,
    signIn,
    submitTotp,
    beginTotpSetup,
    completeTotpSetup,
    completeNewPassword,
  } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  // When Cognito asks the user to enrol a TOTP authenticator, fetch the shared
  // secret so we can render the provisioning QR code.
  useEffect(() => {
    if (status !== "mfaSetupRequired") return;
    let cancelled = false;
    beginTotpSetup()
      .then((s) => {
        if (!cancelled) setSecret(s);
      })
      .catch(() => {
        /* error is surfaced via the auth context */
      });
    return () => {
      cancelled = true;
    };
    // beginTotpSetup is stable for the provider lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  if (status === "signedIn") {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (status === "mfaRequired") {
        await submitTotp(totp);
      } else if (status === "mfaSetupRequired") {
        await completeTotpSetup(totp);
      } else if (status === "newPasswordRequired") {
        await completeNewPassword(newPassword);
      } else {
        await signIn(username, password);
      }
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard?.writeText(secret);
      setCopied(true);
    } catch {
      /* clipboard unavailable */
    }
  }

  const title =
    status === "newPasswordRequired"
      ? "Set a new password"
      : status === "mfaSetupRequired"
        ? "Set up authenticator"
        : status === "mfaRequired"
          ? "Two-factor authentication"
          : "gateway-api ops";

  const buttonLabel =
    status === "newPasswordRequired"
      ? "Set password"
      : status === "mfaRequired" || status === "mfaSetupRequired"
        ? "Verify"
        : "Sign in";

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Card sx={{ width: 380 }}>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <Stack spacing={2}>
              <Typography variant="h5">{title}</Typography>
              {error && <Alert severity="error">{error}</Alert>}

              {status === "newPasswordRequired" && (
                <TextField
                  label="New password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoFocus
                  autoComplete="new-password"
                />
              )}

              {status === "mfaSetupRequired" && (
                <Stack spacing={1} sx={{ alignItems: "center" }}>
                  <Typography variant="body2" color="text.secondary">
                    Scan this QR code with your authenticator app, then enter the
                    6-digit code to confirm.
                  </Typography>
                  {secret ? (
                    <>
                      <TotpQrCode username={username} secret={secret} />
                      <Typography
                        variant="caption"
                        sx={{ wordBreak: "break-all", fontFamily: "monospace" }}
                        data-testid="totp-secret"
                      >
                        {secret}
                      </Typography>
                      <Link component="button" type="button" onClick={copySecret}>
                        {copied ? "Copied!" : "Copy secret"}
                      </Link>
                    </>
                  ) : (
                    <Typography variant="body2">Generating secret…</Typography>
                  )}
                </Stack>
              )}

              {(status === "mfaRequired" || status === "mfaSetupRequired") && (
                <TextField
                  label="Authenticator code"
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                  autoFocus={status === "mfaRequired"}
                  autoComplete="one-time-code"
                  slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 6 } }}
                />
              )}

              {(status === "loading" ||
                status === "signedOut") && (
                <>
                  <TextField
                    label="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                    autoComplete="username"
                  />
                  <TextField
                    label="Password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </>
              )}

              <Button type="submit" variant="contained" disabled={busy}>
                {buttonLabel}
              </Button>
            </Stack>
          </form>
        </CardContent>
      </Card>
    </Box>
  );
}
