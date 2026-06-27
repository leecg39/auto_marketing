import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  normalizeDate,
  parseCsv,
  parseMoney,
  reconcileRevenueFromRecords
} from '../scripts/reconcile-revenue.mjs';

const execFileAsync = promisify(execFile);

test('parses CSV values with quoted commas', () => {
  const records = parseCsv([
    'date,revenue,note',
    '2026-06-25,"129,000","coupon, welcome"',
    '20260626,"81,000","second row"',
    ''
  ].join('\n'));

  assert.equal(records.length, 2);
  assert.equal(records[0].revenue, '129,000');
  assert.equal(records[0].note, 'coupon, welcome');
  assert.equal(records[1].date, '20260626');
});

test('normalizes common date and money formats', () => {
  assert.equal(normalizeDate('20260625'), '2026-06-25');
  assert.equal(normalizeDate('2026/6/5 10:20:30'), '2026-06-05');
  assert.equal(parseMoney('₩129,000 KRW'), 129000);
  assert.equal(parseMoney('(1,200)'), -1200);
});

test('passes when daily and total GA4 revenue are within threshold', () => {
  const orders = parseCsv([
    'order_date,order_revenue',
    '2026-06-25,129000',
    '2026-06-25,71000',
    '2026-06-26,80000',
    ''
  ].join('\n'));
  const ga4 = parseCsv([
    'event_date,purchase_revenue',
    '20260625,198000',
    '20260626,78000',
    ''
  ].join('\n'));

  const report = reconcileRevenueFromRecords(orders, ga4, { threshold: 0.05 });

  assert.equal(report.ok, true);
  assert.equal(report.totals.order_revenue, 280000);
  assert.equal(report.totals.ga4_revenue, 276000);
  assert.equal(report.days.every((day) => day.within_threshold), true);
});

test('fails when a daily GA4 revenue difference exceeds threshold', () => {
  const orders = parseCsv([
    'date,revenue',
    '2026-06-25,200000',
    '2026-06-26,100000',
    ''
  ].join('\n'));
  const ga4 = parseCsv([
    'date,purchase_revenue',
    '2026-06-25,190000',
    '2026-06-26,80000',
    ''
  ].join('\n'));

  const report = reconcileRevenueFromRecords(orders, ga4, { threshold: 0.05 });

  assert.equal(report.ok, false);
  assert.equal(report.days.find((day) => day.date === '2026-06-26').within_threshold, false);
  assert.equal(report.days.find((day) => day.date === '2026-06-26').diff_percent, 0.2);
});

test('reports dates present in only one source', () => {
  const orders = parseCsv('date,revenue\n2026-06-25,100000\n');
  const ga4 = parseCsv('date,purchase_revenue\n2026-06-26,100000\n');

  const report = reconcileRevenueFromRecords(orders, ga4, { threshold: 0.05 });

  assert.equal(report.ok, false);
  assert.deepEqual(report.missing_dates.orders_only, ['2026-06-25']);
  assert.deepEqual(report.missing_dates.ga4_only, ['2026-06-26']);
});

test('revenue reconciliation CLI prints JSON report', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ma-revenue-'));
  const ordersFile = path.join(tmp, 'orders.csv');
  const ga4File = path.join(tmp, 'ga4.csv');

  try {
    await writeFile(ordersFile, 'order_date,order_revenue\n2026-06-25,100000\n');
    await writeFile(ga4File, 'event_date,purchase_revenue\n20260625,98000\n');

    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../scripts/reconcile-revenue.mjs', import.meta.url)),
      '--orders',
      ordersFile,
      '--ga4',
      ga4File,
      '--threshold',
      '0.05'
    ]);
    const report = JSON.parse(stdout);

    assert.equal(report.ok, true);
    assert.equal(report.totals.diff, -2000);
    assert.equal(report.columns.orders.date, 'order_date');
    assert.equal(report.columns.ga4.revenue, 'purchase_revenue');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
