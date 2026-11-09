// Location tiering, pay interpretation and role grouping — the facts both the scorer and the
// board rely on. Cases come from real location strings seen in the corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locationTier, hourlyPay, roleGroup } from '../scripts/lib/derive.mjs';

test('locationTier: California regions, incl. Simplify shorthands', () => {
  const cases = {
    'San Diego, CA': 'sd', 'La Jolla, CA': 'sd', 'SF': 'bay', 'San Francisco, CA': 'bay',
    'Dublin, CA': 'bay', 'Los Angeles, CA': 'ca', 'LA': 'ca', 'Irvine, CA': 'ca',
  };
  for (const [loc, want] of Object.entries(cases)) assert.equal(locationTier({ location: loc }), want, loc);
});

test('locationTier: ambiguous city names only count as California when the string says so', () => {
  assert.equal(locationTier({ location: 'San Marcos, TX' }), 'us');
  assert.equal(locationTier({ location: 'San Marcos, CA' }), 'sd');
  assert.equal(locationTier({ location: 'Dublin, OH' }), 'us');
  assert.equal(locationTier({ location: 'Dublin, Ireland' }), 'nonus');
});

test('locationTier: non-US, remote, and unknown', () => {
  assert.equal(locationTier({ location: 'Toronto, ON, Canada' }), 'nonus');
  assert.equal(locationTier({ location: 'Remote in USA' }), 'remote');
  assert.equal(locationTier({ location: 'Austin, TX' }), 'us');
  assert.equal(locationTier({ location: '' }), 'us', 'unknown is never gated');
  assert.equal(locationTier({ location: 'Unspecified' }), 'us');
});

test('locationTier: a multi-city posting takes its best region', () => {
  assert.equal(locationTier({ location: 'Mountain View, CA • New York, NY' }), 'bay');
  assert.equal(locationTier({ location: 'NYC', raw: JSON.stringify({ locations: ['NYC', 'SF'] }) }), 'bay');
});

test('locationTier: the remote flag never upgrades a non-US posting', () => {
  assert.equal(locationTier({ location: 'Remote in UK', remote: 1 }), 'nonus');
  assert.equal(locationTier({ location: '', remote: 1 }), 'remote');
});

test('hourlyPay: interprets by magnitude and discards implausible values', () => {
  assert.equal(hourlyPay({ pay_min: 26 }), 26);          // labeled "year" by the source, really hourly
  assert.equal(hourlyPay({ pay_min: 52000 }), 25);       // annual → hourly
  for (const v of [6240, 5, 600, -3, null]) assert.equal(hourlyPay({ pay_min: v }), null, String(v));
});

test('roleGroup: part-time grouping uses the title, not the noisy inferred category', () => {
  assert.equal(roleGroup({ track: 'internship', category: 'Software' }), 'Software');
  assert.equal(roleGroup({ track: 'parttime', title: 'Barista' }), 'Retail, food & hospitality');
  assert.equal(roleGroup({ track: 'parttime', title: 'Peer Tutor' }), 'On-campus & student');
  assert.equal(roleGroup({ track: 'parttime', title: 'Night Auditor', category: 'Software' }), 'Other');
});
