import { describe, expect, test } from 'bun:test';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { makeCertificate } from './tls';

describe('the local HTTPS certificate', () => {
  test('is a valid self-signed certificate for localhost and the LAN addresses', () => {
    const { cert, key } = makeCertificate(['192.168.1.23', '10.0.0.5'], new Date('2026-11-15'));
    const certificate = new X509Certificate(cert);
    // Signé par sa propre clé, et la clé privée va avec.
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.checkPrivateKey(createPrivateKey(key))).toBe(true);
    expect(certificate.subjectAltName).toContain('DNS:localhost');
    expect(certificate.subjectAltName).toContain('IP Address:192.168.1.23');
    expect(certificate.subjectAltName).toContain('IP Address:10.0.0.5');
    expect(new Date(certificate.validTo).getTime()).toBeGreaterThan(
      new Date('2027-11-01').getTime(),
    );
  });
});
