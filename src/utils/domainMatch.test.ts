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

  it('filters and ranks secrets without changing the stored order', () => {
    const secrets = [
      { site: 'example.com', id: 1 },
      { site: 'github.com', id: 2 },
      { site: 'accounts.github.com', id: 3 }
    ];
    expect(matchSecrets(info.fullUrl, secrets).map(({ id }) => id)).toEqual([3, 2]);
    expect(secrets.map(({ id }) => id)).toEqual([1, 2, 3]);
  });

  it('ranks the current host ahead of a sibling site from the same main domain', () => {
    const secrets = [
      { site: 'https://idc.starmerx.com', id: 'idc' },
      { site: 'jms.yt.starmerx.com', id: 'jump-server' }
    ];
    const url = 'https://jms.yt.starmerx.com/core/auth/login/mfa/?next=/luna/';
    expect(matchSecrets(url, secrets).map(({ id }) => id)).toEqual(['jump-server', 'idc']);
  });

  it('normalizes a site URL with a trailing slash before ranking its domain', () => {
    const secrets = [
      { site: 'github.com', id: 'parent' },
      { site: 'https://accounts.github.com/', id: 'current' }
    ];
    expect(matchSecrets(info.fullUrl, secrets).map(({ id }) => id)).toEqual(['current', 'parent']);
  });

  it('ranks exact URLs and more specific matching paths before the origin', () => {
    const url = 'https://accounts.github.com/settings/security?tab=otp';
    const secrets = [
      { site: 'https://accounts.github.com/', id: 'origin' },
      { site: 'https://accounts.github.com/settings', id: 'settings' },
      { site: 'https://accounts.github.com/settings/security', id: 'security' },
      { site: url, id: 'exact' }
    ];
    expect(matchSecrets(url, secrets).map(({ id }) => id)).toEqual(['exact', 'security', 'settings', 'origin']);
    expect(getSiteMatchPriority(parseUrl('https://accounts.github.com/settings-old')!, secrets[1].site)).toBe(3);
  });

  it('ranks the closest parent before broader parent domains and sibling sites', () => {
    const secrets = [
      { site: 'starmerx.com', id: 'root' },
      { site: 'idc.starmerx.com', id: 'sibling' },
      { site: 'yt.starmerx.com', id: 'parent' }
    ];
    expect(matchSecrets('https://jms.yt.starmerx.com/', secrets).map(({ id }) => id)).toEqual(['parent', 'root', 'sibling']);
  });

  it('preserves the original order and objects for equally matching secrets', () => {
    const secrets = [
      { site: 'accounts.github.com', id: 'first' },
      { site: 'accounts.github.com', id: 'second' }
    ];
    const matched = matchSecrets(info.fullUrl, secrets);
    expect(matched).toEqual(secrets);
    expect(matched).not.toBe(secrets);
    expect(matched[0]).toBe(secrets[0]);
  });
});
