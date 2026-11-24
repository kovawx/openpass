// Synthetic OTP data using the RFC 4226 sample key and arbitrary secondary key.
const prefix = 'otpauth-migration://offline?data=';

export const migrationLink = prefix + 'Ci0KFDEyMzQ1Njc4OTAxMjM0NTY3ODkwEgVBbGljZRoGR29vZ2xlIAEoATACOAAKQQoO%2B%2B%2F%2FYWJjZDEyMzQ1NjcSGeekuuS%2BizphbGljZUBleGFtcGxlLnRlc3QaDGV4YW1wbGUudGVzdCADKAIwATgqEAIYASAA';

export const migrationParts = [
  prefix + 'Ci0KFDEyMzQ1Njc4OTAxMjM0NTY3ODkwEgVBbGljZRoGR29vZ2xlIAEoATACOAAQAhgCIAAorAI%3D',
  prefix + 'CkEKDvvv%2F2FiY2QxMjM0NTY3EhnnpLrkvos6YWxpY2VAZXhhbXBsZS50ZXN0GgxleGFtcGxlLnRlc3QgAygCMAE4KhACGAIgASisAg%3D%3D'
];
