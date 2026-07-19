import { describe, expect, it } from 'vitest';
import {
  getSiteMatchPriority,
  isSiteMatched,
  matchSecrets,
  NO_MATCH,
  parseUrl
} from './domainMatch';

describe('parseUrl', () => {
  it('normalizes URLs and handles supported multi-part public suffixes', () => {
    expect(parseUrl('https://login.example.co.uk/account')).toMatchObject({
      origin: 'https://login.example.co.uk',
      fullDomain: 'login.example.co.uk',
      mainDomain: 'example.co.uk'
    });
  });

  it('accepts a hostname without a protocol and rejects invalid input', () => {
    expect(parseUrl('accounts.example.com')?.origin).toBe('https://accounts.example.com');
    expect(parseUrl('not a host')).toBeNull();
  });
});

describe('site matching', () => {
  const info = parseUrl('https://accounts.github.com/settings')!;

  it('keeps exact matches ordered by specificity', () => {
    expect(getSiteMatchPriority(info, info.fullUrl)).toBe(1);
    expect(getSiteMatchPriority(info, info.origin)).toBe(2);
    expect(getSiteMatchPriority(info, info.fullDomain)).toBe(3);
    expect(getSiteMatchPriority(info, info.mainDomain)).toBe(4);
  });

  it('matches parent and child domains only at label boundaries', () => {
    expect(isSiteMatched(info, 'github.com')).toBe(true);
    expect(isSiteMatched(info, 'login.accounts.github.com')).toBe(true);
    expect(isSiteMatched(info, 'evilgithub.com')).toBe(false);
    expect(isSiteMatched(info, 'github.com.evil.example')).toBe(false);
  });

  it('does not use arbitrary URL substring matches', () => {
    expect(getSiteMatchPriority(info, 'github')).toBe(NO_MATCH);
    expect(getSiteMatchPriority(info, 'https://evil.example/?next=github.com')).toBe(NO_MATCH);
  });

  it('filters secrets without changing their order', () => {
    const secrets = [
      { site: 'example.com', id: 1 },
      { site: 'github.com', id: 2 },
      { site: 'accounts.github.com', id: 3 }
    ];
    expect(matchSecrets(info.fullUrl, secrets).map(({ id }) => id)).toEqual([2, 3]);
  });
});
