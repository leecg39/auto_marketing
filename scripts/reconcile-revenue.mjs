import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_THRESHOLD = 0.05;

const COLUMN_ALIASES = {
  date: [
    'date',
    'day',
    'event_date',
    'eventDate',
    'order_date',
    'ordered_at',
    'created_at',
    'transaction_date',
    '날짜',
    '일자'
  ],
  orderRevenue: [
    'order_revenue',
    'revenue',
    'total_revenue',
    'totalRevenue',
    'sales',
    'amount',
    'value',
    'total',
    'sellingPriceKrw',
    'selling_price_krw',
    'paid_amount',
    'payment_amount',
    '매출',
    '주문금액',
    '결제금액'
  ],
  ga4Revenue: [
    'purchase_revenue',
    'purchaseRevenue',
    'total_revenue',
    'totalRevenue',
    'revenue',
    'event_value',
    'eventValue',
    'value',
    '매출',
    '구매수익'
  ]
};

function normalizeHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]/g, '');
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
        continue;
      }

      if (char === '"') {
        inQuotes = false;
        continue;
      }

      field += char;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new Error('CSV quoted field is not closed');
  }

  row.push(field.replace(/\r$/, ''));
  rows.push(row);

  return rows.filter((candidate) => candidate.some((value) => String(value).trim() !== ''));
}

function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0].map((header) => String(header).replace(/^\uFEFF/, '').trim());
  return rows.slice(1).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = String(row[index] ?? '').trim();
    });
    return record;
  });
}

function selectColumn(records, explicitColumn, aliases, label) {
  const headers = Object.keys(records[0] || {});

  if (headers.length === 0) {
    throw new Error(`${label} CSV has no headers`);
  }

  if (explicitColumn) {
    const explicitMatch = headers.find((header) => header === explicitColumn)
      || headers.find((header) => normalizeHeader(header) === normalizeHeader(explicitColumn));

    if (!explicitMatch) {
      throw new Error(`${label} column not found: ${explicitColumn}`);
    }

    return explicitMatch;
  }

  const normalizedAliases = aliases.map(normalizeHeader);
  const match = headers.find((header) => normalizedAliases.includes(normalizeHeader(header)));
  if (!match) {
    throw new Error(`${label} column not found. Headers: ${headers.join(', ')}`);
  }

  return match;
}

function normalizeDate(value) {
  const raw = String(value || '').trim();

  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }

  const separated = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (separated) {
    const [, year, month, day] = separated;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  throw new Error(`Invalid date value: ${raw}`);
}

function parseMoney(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return 0;
  }

  const negative = /^\(.*\)$/.test(raw);
  const cleaned = raw.replace(/[^\d.-]/g, '');
  const parsed = Number(cleaned);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid money value: ${raw}`);
  }

  return negative ? -Math.abs(parsed) : parsed;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundPercent(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function percentDiff(expected, actual) {
  const diff = actual - expected;
  if (expected === 0) {
    return actual === 0 ? 0 : 1;
  }
  return Math.abs(diff) / Math.abs(expected);
}

function aggregateRevenue(records, options) {
  const dateColumn = selectColumn(records, options.dateColumn, COLUMN_ALIASES.date, `${options.label} date`);
  const revenueColumn = selectColumn(records, options.revenueColumn, options.revenueAliases, `${options.label} revenue`);
  const byDate = new Map();

  for (const record of records) {
    const date = normalizeDate(record[dateColumn]);
    const revenue = parseMoney(record[revenueColumn]);
    byDate.set(date, (byDate.get(date) || 0) + revenue);
  }

  return {
    dateColumn,
    revenueColumn,
    byDate
  };
}

function reconcileRevenueFromRecords(orderRecords, ga4Records, options = {}) {
  if (orderRecords.length === 0) {
    throw new Error('Orders CSV has no data rows');
  }

  if (ga4Records.length === 0) {
    throw new Error('GA4 CSV has no data rows');
  }

  const threshold = Number(options.threshold ?? DEFAULT_THRESHOLD);
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error('threshold must be a positive number');
  }

  const orders = aggregateRevenue(orderRecords, {
    label: 'orders',
    dateColumn: options.ordersDateColumn || options.dateColumn,
    revenueColumn: options.ordersRevenueColumn || options.orderRevenueColumn,
    revenueAliases: COLUMN_ALIASES.orderRevenue
  });
  const ga4 = aggregateRevenue(ga4Records, {
    label: 'GA4',
    dateColumn: options.ga4DateColumn || options.dateColumn,
    revenueColumn: options.ga4RevenueColumn,
    revenueAliases: COLUMN_ALIASES.ga4Revenue
  });

  const dates = [...new Set([...orders.byDate.keys(), ...ga4.byDate.keys()])].sort();
  const days = dates.map((date) => {
    const orderRevenue = orders.byDate.get(date) || 0;
    const ga4Revenue = ga4.byDate.get(date) || 0;
    const diff = ga4Revenue - orderRevenue;
    const diffPercent = percentDiff(orderRevenue, ga4Revenue);

    return {
      date,
      order_revenue: roundMoney(orderRevenue),
      ga4_revenue: roundMoney(ga4Revenue),
      diff: roundMoney(diff),
      diff_percent: roundPercent(diffPercent),
      within_threshold: diffPercent <= threshold
    };
  });

  const totalOrderRevenue = [...orders.byDate.values()].reduce((sum, value) => sum + value, 0);
  const totalGa4Revenue = [...ga4.byDate.values()].reduce((sum, value) => sum + value, 0);
  const totalDiff = totalGa4Revenue - totalOrderRevenue;
  const totalDiffPercent = percentDiff(totalOrderRevenue, totalGa4Revenue);
  const ordersOnlyDates = dates.filter((date) => orders.byDate.has(date) && !ga4.byDate.has(date));
  const ga4OnlyDates = dates.filter((date) => ga4.byDate.has(date) && !orders.byDate.has(date));
  const totalWithinThreshold = totalDiffPercent <= threshold;
  const ok = totalWithinThreshold && days.every((day) => day.within_threshold);

  return {
    ok,
    threshold,
    columns: {
      orders: {
        date: orders.dateColumn,
        revenue: orders.revenueColumn
      },
      ga4: {
        date: ga4.dateColumn,
        revenue: ga4.revenueColumn
      }
    },
    totals: {
      order_revenue: roundMoney(totalOrderRevenue),
      ga4_revenue: roundMoney(totalGa4Revenue),
      diff: roundMoney(totalDiff),
      diff_percent: roundPercent(totalDiffPercent),
      within_threshold: totalWithinThreshold
    },
    missing_dates: {
      orders_only: ordersOnlyDates,
      ga4_only: ga4OnlyDates
    },
    days,
    next_step: ok
      ? '주문 DB와 GA4 매출 오차가 기준 이내입니다. GTM/GA4 게시 후 일 단위 모니터링을 유지하세요.'
      : '오차가 기준을 초과했습니다. 누락 이벤트, purchase 중복/미전송, 환불/취소 처리, GA4 지연 수집을 확인하세요.'
  };
}

async function reconcileRevenue(options) {
  const [ordersText, ga4Text] = await Promise.all([
    readFile(options.ordersFile, 'utf8'),
    readFile(options.ga4File, 'utf8')
  ]);

  return reconcileRevenueFromRecords(parseCsv(ordersText), parseCsv(ga4Text), options);
}

function parseArgs(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    if (equalsIndex >= 0) {
      parsed[arg.slice(2, equalsIndex)] = arg.slice(equalsIndex + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/reconcile-revenue.mjs --orders exports/orders.csv --ga4 exports/ga4.csv [--threshold 0.05]',
    '',
    'Optional columns:',
    '  --date-column date',
    '  --orders-date-column order_date',
    '  --orders-revenue-column order_revenue',
    '  --ga4-date-column event_date',
    '  --ga4-revenue-column purchase_revenue'
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.orders || !args.ga4) {
    console.error(usage());
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const report = await reconcileRevenue({
    ordersFile: path.resolve(args.orders),
    ga4File: path.resolve(args.ga4),
    threshold: args.threshold === undefined ? DEFAULT_THRESHOLD : Number(args.threshold),
    dateColumn: args['date-column'],
    ordersDateColumn: args['orders-date-column'],
    ordersRevenueColumn: args['orders-revenue-column'] || args['order-revenue-column'],
    ga4DateColumn: args['ga4-date-column'],
    ga4RevenueColumn: args['ga4-revenue-column']
  });

  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  COLUMN_ALIASES,
  normalizeDate,
  parseCsv,
  parseMoney,
  reconcileRevenue,
  reconcileRevenueFromRecords
};
