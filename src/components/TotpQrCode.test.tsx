import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TotpQrCode, { totpProvisioningUri } from "./TotpQrCode";

const toCanvas = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("qrcode", () => ({ default: { toCanvas } }));

describe("totpProvisioningUri", () => {
  it("builds the otpauth URI for the ops issuer", () => {
    expect(totpProvisioningUri("alice", "S3CRET")).toBe(
      "otpauth://totp/gateway-api-ops:alice?secret=S3CRET&issuer=gateway-api-ops",
    );
  });
});

describe("TotpQrCode", () => {
  it("renders a canvas and draws the QR for the given secret", () => {
    render(<TotpQrCode username="alice" secret="S3CRET" />);

    const canvas = screen.getByTestId("totp-qr");
    expect(canvas.tagName).toBe("CANVAS");
    expect(toCanvas).toHaveBeenCalledWith(
      canvas,
      "otpauth://totp/gateway-api-ops:alice?secret=S3CRET&issuer=gateway-api-ops",
      expect.objectContaining({ width: 200 }),
    );
  });

  it("does not attempt to draw without a secret", () => {
    toCanvas.mockClear();
    render(<TotpQrCode username="alice" secret="" />);
    expect(toCanvas).not.toHaveBeenCalled();
  });
});
