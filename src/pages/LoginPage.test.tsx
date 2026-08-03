import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import LoginPage from "./LoginPage";
import { AuthProvider } from "../contexts/AuthContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";

// Drive the auth state machine through a fully mocked cognito client.
const c = vi.hoisted(() => ({
  hasValidSession: vi.fn(() => Promise.resolve(false)),
  signIn: vi.fn(),
  submitTotp: vi.fn(() => Promise.resolve()),
  beginTotpSetup: vi.fn(() => Promise.resolve("SECRET123")),
  completeTotpSetup: vi.fn(() => Promise.resolve()),
  completeNewPasswordChallenge: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("../lib/cognitoClient", () => c);
vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn(() => Promise.resolve()) } }));

function renderLogin() {
  return render(
    <ThemeModeProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={["/login"]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<div>dashboard</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </ThemeModeProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  c.hasValidSession.mockResolvedValue(false);
  c.beginTotpSetup.mockResolvedValue("SECRET123");
  c.submitTotp.mockResolvedValue(undefined);
  c.completeTotpSetup.mockResolvedValue(undefined);
});

describe("LoginPage", () => {
  it("renders username and password fields", async () => {
    renderLogin();
    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("transitions signedOut -> mfaSetupRequired -> signedIn", async () => {
    const user = userEvent.setup();
    c.signIn.mockResolvedValue("mfaSetupRequired");
    renderLogin();

    await user.type(await screen.findByLabelText(/username/i), "alice");
    await user.type(screen.getByLabelText(/password/i), "pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    // Secret is fetched and shown alongside the QR canvas.
    expect(await screen.findByTestId("totp-qr")).toBeInTheDocument();
    expect(c.beginTotpSetup).toHaveBeenCalled();
    expect(screen.getByTestId("totp-secret")).toHaveTextContent("SECRET123");

    await user.type(screen.getByLabelText(/authenticator code/i), "123456");
    await user.click(screen.getByRole("button", { name: /verify/i }));

    expect(c.completeTotpSetup).toHaveBeenCalledWith("123456");
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
  });

  it("shows the TOTP prompt for the mfaRequired challenge", async () => {
    const user = userEvent.setup();
    c.signIn.mockResolvedValue("mfaRequired");
    renderLogin();

    await user.type(await screen.findByLabelText(/username/i), "alice");
    await user.type(screen.getByLabelText(/password/i), "pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await user.type(
      await screen.findByLabelText(/authenticator code/i),
      "654321",
    );
    await user.click(screen.getByRole("button", { name: /verify/i }));

    expect(c.submitTotp).toHaveBeenCalledWith("654321");
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
  });

  it("transitions through the newPasswordRequired flow", async () => {
    const user = userEvent.setup();
    c.signIn.mockResolvedValue("newPasswordRequired");
    c.completeNewPasswordChallenge.mockResolvedValue("signedIn");
    renderLogin();

    await user.type(await screen.findByLabelText(/username/i), "alice");
    await user.type(screen.getByLabelText(/password/i), "pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    const newPw = await screen.findByLabelText(/new password/i);
    await user.type(newPw, "Newpass1!");
    await user.click(screen.getByRole("button", { name: /set password/i }));

    expect(c.completeNewPasswordChallenge).toHaveBeenCalledWith("Newpass1!");
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
  });

  it("surfaces sign-in errors", async () => {
    const user = userEvent.setup();
    c.signIn.mockRejectedValue(new Error("wrong password"));
    renderLogin();

    await user.type(await screen.findByLabelText(/username/i), "alice");
    await user.type(screen.getByLabelText(/password/i), "pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() =>
      expect(screen.getByText("wrong password")).toBeInTheDocument(),
    );
  });
});
