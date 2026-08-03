import { beforeEach, describe, expect, it, vi } from "vitest";

// Controllable stand-in for amazon-cognito-identity-js. Every CognitoUser
// instance shares these spies, so the module-level pendingUser created inside
// signIn() is the same object the setup helpers act on.
const h = vi.hoisted(() => ({
  authenticateUser: vi.fn(),
  sendMFACode: vi.fn(),
  associateSoftwareToken: vi.fn(),
  verifySoftwareToken: vi.fn(),
  completeNewPasswordChallenge: vi.fn(),
  signOut: vi.fn(),
  getCurrentUser: vi.fn(),
}));

vi.mock("amazon-cognito-identity-js", () => {
  class CognitoUserPool {
    getCurrentUser() {
      return h.getCurrentUser();
    }
  }
  class CognitoUser {
    authenticateUser = h.authenticateUser;
    sendMFACode = h.sendMFACode;
    associateSoftwareToken = h.associateSoftwareToken;
    verifySoftwareToken = h.verifySoftwareToken;
    completeNewPasswordChallenge = h.completeNewPasswordChallenge;
    signOut = h.signOut;
  }
  class AuthenticationDetails {}
  return { CognitoUserPool, CognitoUser, AuthenticationDetails };
});

import * as cognito from "./cognitoClient";

beforeEach(() => {
  vi.stubEnv("VITE_COGNITO_POOL_ID", "pool-1");
  vi.stubEnv("VITE_COGNITO_CLIENT_ID", "client-1");
  vi.clearAllMocks();
});

describe("cognitoClient signIn challenges", () => {
  it("resolves signedIn on success", async () => {
    h.authenticateUser.mockImplementation((_d, cb) => cb.onSuccess({}));
    await expect(cognito.signIn("u", "p")).resolves.toBe("signedIn");
  });

  it("resolves mfaRequired when a TOTP code is needed", async () => {
    h.authenticateUser.mockImplementation((_d, cb) => cb.totpRequired());
    await expect(cognito.signIn("u", "p")).resolves.toBe("mfaRequired");
  });

  it("resolves mfaSetupRequired on the MFA_SETUP challenge", async () => {
    h.authenticateUser.mockImplementation((_d, cb) => cb.mfaSetup("MFA_SETUP", {}));
    await expect(cognito.signIn("u", "p")).resolves.toBe("mfaSetupRequired");
  });

  it("resolves newPasswordRequired on a forced password change", async () => {
    h.authenticateUser.mockImplementation((_d, cb) => cb.newPasswordRequired({}, {}));
    await expect(cognito.signIn("u", "p")).resolves.toBe("newPasswordRequired");
  });

  it("rejects on authentication failure", async () => {
    h.authenticateUser.mockImplementation((_d, cb) => cb.onFailure(new Error("bad")));
    await expect(cognito.signIn("u", "p")).rejects.toThrow("bad");
  });

  it("throws when the pool is not configured", () => {
    vi.stubEnv("VITE_COGNITO_POOL_ID", "");
    expect(() => cognito.signIn("u", "p")).toThrow(/not configured/);
  });
});

describe("cognitoClient TOTP setup", () => {
  it("beginTotpSetup returns the associated secret", async () => {
    h.authenticateUser.mockImplementation((_d, cb) => cb.mfaSetup("MFA_SETUP", {}));
    await cognito.signIn("u", "p");

    h.associateSoftwareToken.mockImplementation((cb) =>
      cb.associateSecretCode("SECRET123"),
    );
    await expect(cognito.beginTotpSetup()).resolves.toBe("SECRET123");
  });

  it("completeTotpSetup verifies the code and completes sign-in", async () => {
    h.authenticateUser.mockImplementation((_d, cb) => cb.mfaSetup("MFA_SETUP", {}));
    await cognito.signIn("u", "p");

    h.verifySoftwareToken.mockImplementation((code, device, cb) => {
      expect(code).toBe("123456");
      expect(device).toBe("gateway-api-ops");
      cb.onSuccess({});
    });
    await expect(cognito.completeTotpSetup("123456")).resolves.toBeUndefined();
  });

  it("completeTotpSetup rejects on a bad code", async () => {
    h.authenticateUser.mockImplementation((_d, cb) => cb.mfaSetup("MFA_SETUP", {}));
    await cognito.signIn("u", "p");

    h.verifySoftwareToken.mockImplementation((_c, _d, cb) =>
      cb.onFailure(new Error("code mismatch")),
    );
    await expect(cognito.completeTotpSetup("000000")).rejects.toThrow("code mismatch");
  });

  it("rejects setup calls when no sign-in is in progress", async () => {
    cognito.signOut();
    await expect(cognito.beginTotpSetup()).rejects.toThrow("No sign-in in progress");
    await expect(cognito.completeTotpSetup("1")).rejects.toThrow(
      "No sign-in in progress",
    );
  });
});

describe("cognitoClient new-password challenge", () => {
  it("completes the challenge and can chain into MFA setup", async () => {
    h.authenticateUser.mockImplementation((_d, cb) => cb.newPasswordRequired({}, {}));
    await cognito.signIn("u", "p");

    h.completeNewPasswordChallenge.mockImplementation((_pw, _attrs, cb) =>
      cb.mfaSetup("MFA_SETUP", {}),
    );
    await expect(cognito.completeNewPasswordChallenge("Newpass1!")).resolves.toBe(
      "mfaSetupRequired",
    );
  });

  it("completes the challenge straight to signedIn", async () => {
    h.authenticateUser.mockImplementation((_d, cb) => cb.newPasswordRequired({}, {}));
    await cognito.signIn("u", "p");

    h.completeNewPasswordChallenge.mockImplementation((_pw, _attrs, cb) =>
      cb.onSuccess({}),
    );
    await expect(cognito.completeNewPasswordChallenge("Newpass1!")).resolves.toBe(
      "signedIn",
    );
  });
});
