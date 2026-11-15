import { describe, expect, it } from 'bun:test';
import { authPublicKey, verifyAuthToken } from './authToken';

// Le jeton et la clé de l'API PHP (BoardTrouble-api, tests/run.php) : signés là-bas avec une clé
// fixe, vérifiés ici. Si l'un des deux côtés change de format, ces tests le voient.
const PUBLIC_KEY = '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw';
const TOKEN =
  'eyJ2IjoxLCJzdWIiOiIxMjM0NTY3ODkwMTIzNDU2NzgiLCJuYW1lIjoiQXhpeiIsImF2YXRhciI6bnVsbCwiaWRuIjoiYWJjZGVmZ2hpamtsbW5vcHFyIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDI1OTIwMDB9' +
  '.HahATqO0npLKhN7BQRiWrDx51WwVCX63mBuAh0Asgur6vAI1Hc1OeogBQItnGxL2xcoXM66x2wGRQ56RSjeYBw';
const IDENTITY = 'abcdefghijklmnopqr';
const ISSUED_AT = 1_800_000_000;
const EXPIRES_AT = 1_802_592_000;

const key = authPublicKey(PUBLIC_KEY);

describe('verifyAuthToken', () => {
  it("reconnaît un jeton signé par l'API", () => {
    expect(key).not.toBeNull();
    if (!key) return;
    expect(verifyAuthToken(TOKEN, key, IDENTITY, ISSUED_AT)).toEqual({
      id: '123456789012345678',
      name: 'Axiz',
      avatar: null,
    });
  });

  it('refuse un jeton expiré', () => {
    if (!key) return;
    expect(verifyAuthToken(TOKEN, key, IDENTITY, EXPIRES_AT + 1)).toBeNull();
  });

  it('refuse un jeton présenté par un autre navigateur', () => {
    if (!key) return;
    expect(verifyAuthToken(TOKEN, key, 'zzzzzzzzzzzzzzzzzz', ISSUED_AT)).toBeNull();
  });

  it('refuse un jeton modifié', () => {
    if (!key) return;
    const [body, signature] = TOKEN.split('.');
    const forged = Buffer.from(
      Buffer.from(body ?? '', 'base64url')
        .toString()
        .replace('Axiz', 'Autre'),
    );
    expect(
      verifyAuthToken(`${forged.toString('base64url')}.${signature}`, key, IDENTITY, ISSUED_AT),
    ).toBeNull();
  });

  it('refuse un jeton signé par une autre clé', () => {
    const other = authPublicKey('d-RwaX67Orx9EY0FZCgqN3eNz0mi9A7qOZkKoBvEMYg');
    expect(other).not.toBeNull();
    if (!other) return;
    expect(verifyAuthToken(TOKEN, other, IDENTITY, ISSUED_AT)).toBeNull();
  });
});

describe('authPublicKey', () => {
  it('refuse une clé mal recopiée', () => {
    expect(authPublicKey('pas-une-cle')).toBeNull();
  });
});
