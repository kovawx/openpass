export interface ParsedOtpAuth {
  secret: string;
  site: string;
  name: string;
  digits: number;
}

const BASE32_PATTERN = /^[A-Z2-7]+=*$/;

function normalizeSecret(value: string): string | null {
  const secret = value.trim().toUpperCase().replace(/[\s-]/g, '');
  return BASE32_PATTERN.test(secret) ? secret : null;
}

export function parseOtpAuth(value: string): ParsedOtpAuth | null {
  const raw = value.trim();
  const plainSecret = normalizeSecret(raw);
  if (plainSecret) {
    return { secret: plainSecret, site: '', name: '', digits: 6 };
  }

  if (!raw.toLowerCase().startsWith('otpauth://')) {
    return null;
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== 'otpauth:' || url.hostname.toLowerCase() !== 'totp') {
      return null;
    }

    const secret = normalizeSecret(url.searchParams.get('secret') || '');
    if (!secret) return null;

    const label = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const separator = label.indexOf(':');
    const labelIssuer = separator >= 0 ? label.slice(0, separator).trim() : '';
    const account = (separator >= 0 ? label.slice(separator + 1) : label).trim();
    const issuer = (url.searchParams.get('issuer') || labelIssuer).trim();
    const parsedDigits = Number.parseInt(url.searchParams.get('digits') || '6', 10);

    return {
      secret,
      site: issuer.toLowerCase(),
      name: issuer || account,
      digits: parsedDigits === 8 ? 8 : 6
    };
  } catch {
    return null;
  }
}
