import { useEffect, useRef } from "react";
import QRCode from "qrcode";

// Build the otpauth:// provisioning URI that authenticator apps understand.
export function totpProvisioningUri(username: string, secret: string): string {
  return `otpauth://totp/gateway-api-ops:${username}?secret=${secret}&issuer=gateway-api-ops`;
}

interface TotpQrCodeProps {
  username: string;
  secret: string;
  size?: number;
}

// Renders the TOTP provisioning URI as a scannable QR code on a <canvas>.
export default function TotpQrCode({ username, secret, size = 200 }: TotpQrCodeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !secret) return;
    const uri = totpProvisioningUri(username, secret);
    // toCanvas returns a promise; a missing 2d context (e.g. jsdom) rejects
    // rather than throwing, so a plain catch keeps the component from breaking.
    try {
      void QRCode.toCanvas(canvas, uri, { width: size }).catch(() => {});
    } catch {
      /* canvas rendering unsupported in this environment */
    }
  }, [username, secret, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      data-testid="totp-qr"
      aria-label="TOTP enrollment QR code"
    />
  );
}
