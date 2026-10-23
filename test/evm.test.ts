import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeCoreStats, decodeString, encodeUintCall, readTokenJson, SEL, toHttp, traitsOf } from '../src/tools/evm';

const w = (n: number | bigint): string => BigInt(n).toString(16).padStart(64, '0');

test('encodes a uint256 call', () => {
  assert.equal(encodeUintCall(SEL.tokenURI, 4294967296n), `${SEL.tokenURI}${w(4294967296n)}`);
});

test('decodes an ABI string return value', () => {
  const text = 'data:application/json;base64,eyJhIjoxfQ==';
  const hex = `0x${w(32)}${w(text.length)}${Buffer.from(text).toString('hex').padEnd(Math.ceil(text.length / 32) * 64, '0')}`;
  assert.equal(decodeString(hex), text);
  assert.equal(decodeString('0x'), '');
});

test('decodes ERC-6699 CoreStats (six static words)', () => {
  const hex = `0x${[41724, 38678, 39204, 44379, 1, 0].map(w).join('')}`;
  assert.deepEqual(decodeCoreStats(hex), { str: 41724, agi: 38678, res: 39204, int: 44379, level: 1, xp: 0 });
  assert.equal(decodeCoreStats(`0x${w(1)}`), null);
});

test('reads token JSON from data URIs without the network', async () => {
  const json = { name: 'Halvorne', attributes: [{ trait_type: 'Kind', value: 'God' }, { trait_type: 'Element', value: 'Earth' }] };
  const b64 = `data:application/json;base64,${Buffer.from(JSON.stringify(json)).toString('base64')}`;
  const noFetch = (() => { throw new Error('no network in this test'); }) as unknown as typeof fetch;
  assert.deepEqual(await readTokenJson(b64, 'https://g/ipfs/', noFetch), json);
  assert.deepEqual(await readTokenJson(`data:application/json,${encodeURIComponent(JSON.stringify(json))}`, 'https://g/ipfs/', noFetch), json);
  assert.deepEqual(traitsOf(json), { kind: 'God', element: 'Earth' });
});

test('maps ipfs:// through a gateway and leaves http alone', () => {
  assert.equal(toHttp('ipfs://bafy/1.webp', 'https://ipfs.filebase.io/ipfs/'), 'https://ipfs.filebase.io/ipfs/bafy/1.webp');
  assert.equal(toHttp('ipfs://ipfs/bafy/1.webp', 'https://g/ipfs'), 'https://g/ipfs/bafy/1.webp');
  assert.equal(toHttp('https://x.test/a.png', 'https://g/ipfs/'), 'https://x.test/a.png');
  assert.equal(toHttp('ar://abc', 'https://g/ipfs/'), null);
});
