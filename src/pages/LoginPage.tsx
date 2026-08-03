import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useAuth } from "../contexts/AuthContext";

export default function LoginPage() {
  const { status, error, signIn, submitTotp } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);

  if (status === "signedIn") {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (status === "mfaRequired") {
        await submitTotp(totp);
      } else {
        await signIn(username, password);
      }
    } finally {
      setBusy(false);
    }
  }

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
              <Typography variant="h5">gateway-api ops</Typography>
              {error && <Alert severity="error">{error}</Alert>}
              {status === "mfaRequired" ? (
                <TextField
                  label="Authenticator code"
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                  autoFocus
                  autoComplete="one-time-code"
                  slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 6 } }}
                />
              ) : (
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
                {status === "mfaRequired" ? "Verify" : "Sign in"}
              </Button>
            </Stack>
          </form>
        </CardContent>
      </Card>
    </Box>
  );
}
