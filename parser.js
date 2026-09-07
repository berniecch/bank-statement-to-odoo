/*
 * Bank Statement → Odoo parser engine.
 * Pure JS. Works in the browser and in Node (for tests).
 *
 * Input: an array of text items { str, x, y, page, width } as produced by pdf.js
 *        (x = left edge, y = baseline, both in PDF points; page is 1-based).
 * Output: { bank, accounts: [ { account, currency, openingBalance, transactions:[...] } ], warnings:[] }
 *   transaction = { date, label, moneyIn, moneyOut, balancePrinted }
 *
 * Odoo target layout (per account sheet):
 *   Number | Date | Label | Dr | Cr | Balance | Cumulative Amount
 *   where Dr = money IN (deposit/credit), Cr = money OUT (withdrawal/debit).
 */
(function (root) {
  'use strict';

  // ---- helpers -----------------------------------------------------------
  function num(t) {
    if (t == null) return null;
    var s = String(t).replace(/[, ]/g, '').replace(/[^0-9.\-]/g, '');
    if (s === '' || s === '-' || s === '.' || s === '-.') return null;
    var v = parseFloat(s);
    return isNaN(v) ? null : v;
  }
  // A token is a "number" (could be an amount) only by its text shape.
  function looksNumeric(s) {
    return /^[-+]?\$?\d{1,3}(,\d{3})*(\.\d+)?[-]?$/.test(s.trim()) ||
           /^[-+]?\d+(\.\d+)?[-]?$/.test(s.trim());
  }

  // group items into visual lines (per page, by rounded y)
  function buildLines(items) {
    var byKey = {};
    items.forEach(function (it) {
      var s = (it.str || '').replace(/ /g, ' ');
      if (!s.trim()) return;
      var key = it.page + ':' + Math.round(it.y);
      (byKey[key] = byKey[key] || []).push({ s: s, x: it.x, y: it.y, page: it.page, w: it.width || 0 });
    });
    var lines = Object.keys(byKey).map(function (k) {
      var toks = byKey[k].sort(function (a, b) { return a.x - b.x; });
      return {
        page: toks[0].page,
        y: toks[0].y,
        tokens: toks,
        text: toks.map(function (t) { return t.s; }).join(' ').replace(/\s+/g, ' ').trim()
      };
    });
    lines.sort(function (a, b) { return a.page - b.page || b.y - a.y; });
    return lines;
  }

  // ---- bank detection ----------------------------------------------------
  // Use letterhead / footer / branding signatures ONLY — never words that can
  // appear inside a transaction description (e.g. HSBC statements list "WISE
  // PAYMENTS" payees; Payoneer lists "HSBC HONGKONG..."; SCB lists "FUSION BANK").
  function detectBank(fullText) {
    var t = fullText;
    if (/www\.payoneer\.com/i.test(t) || /©\s*\d{4}-\d{4}\s*Payoneer/i.test(t)) return 'payoneer';
    if (/wise\.com\/help/i.test(t) || /Wise Payments Limited, trading as Wise/i.test(t) || /Wise Payments Ltd\./i.test(t)) return 'wise';
    if (/HSBC Business Direct Statement/i.test(t)) return 'hsbc';
    if (/富融銀/.test(t) || /Fusion Bank Limited/i.test(t)) return 'fusion';
    if (/pingandb\.com/i.test(t) || /paob\.com/i.test(t)) return 'paob';
    if (/STANDARD CHARTERED BANK/i.test(t)) return 'scb';
    if (/American Express/i.test(t) || /americanexpress\.com/i.test(t)) return 'amex';
    return 'generic';
  }

  // footer / boilerplate lines that must break a running label
  var FOOTER = /(Fusion Bank Limited|Bank Address|Customer Service Hotline|Page No|Thank you for banking|Standard Chartered|americanexpress|Payoneer, All Rights|Wise Payments Limited|The Hongkong and Shanghai Banking Corporation|Important Reminder|重要提|IPSSTM|Statement Date|Account Activities|Portfolio Summary|Total No\. of|Total Deposit Amount|Total Withdrawal Amount|Ending Balance|⼾⼝結餘)/i;

  var MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  function normDate(raw, defaultYear) {
    if (!raw) return raw;
    var s = raw.trim();
    var m;
    // 2026-06-01
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return s;
    // 01-Jun-2026  /  01 Jun 2026  /  28 May, 2026
    if ((m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*,?[-\s](\d{4})$/))) {
      var mm = MONTHS[m[2].toLowerCase()];
      if (mm) return m[3] + '-' + pad(mm) + '-' + pad(+m[1]);
    }
    // 20 May  (no year -> use statement year)  / 1 Jun
    if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*$/))) {
      var mm2 = MONTHS[m[2].toLowerCase()];
      if (mm2 && defaultYear) return defaultYear + '-' + pad(mm2) + '-' + pad(+m[1]);
    }
    // 30 June 2026 (full month)
    if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/))) {
      var mm3 = MONTHS[m[2].slice(0,3).toLowerCase()];
      if (mm3) return m[3] + '-' + pad(mm3) + '-' + pad(+m[1]);
    }
    return s;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  var SKIP_LABEL = /(B\/F BALANCE|BALANCE B\/F|承\s*上\s*結\s*餘|承\s*前\s*轉\s*結|Balance Brought Forward|Brought Forward|Closing Balance|賬戶結餘|C\/F BALANCE|結轉下頁|Total\b)/i;
  function isOpeningLine(text) {
    return /(B\/F BALANCE|BALANCE B\/F|Balance Brought Forward|Brought Forward|承\s*上\s*結\s*餘|承\s*前\s*轉\s*結|Opening Balance)/i.test(text);
  }
  function isClosingLine(text) {
    return /(Closing Balance|C\/F BALANCE|賬戶結餘|結轉下頁|Balance C\/F)/i.test(text);
  }

  // ---- per-bank configuration -------------------------------------------
  // classify(x) maps a numeric token's left-x to a column: 'in' | 'out' | 'bal'
  var BANKS = {
    hsbc: {
      dateRe: /^\d{1,2}\s+[A-Za-z]{3}$/,             // "20 May"
      descStart: 95, amtStart: 335, labelMode: 'leading',
      classify: function (x) { return x < 390 ? 'in' : (x < 462 ? 'out' : 'bal'); },
      activityHeader: /(Transaction Details.*Deposit.*Withdrawal.*Balance)|(CCY\s+Transaction Details.*Balance)|(^Date\s+Deposit\s+Withdrawal$)/i,
      accountFrom: function (text) {
        var m = text.match(/HSBC Business Direct (HKD Current|HKD Savings|Foreign Currency Savings)/i);
        return m ? m[1] : null;
      }
    },
    fusion: {
      dateRe: /^\d{4}-\d{2}-\d{2}$/,
      descStart: 120, amtStart: 300, labelMode: 'trailing',
      classify: function (x) { return x < 405 ? 'in' : (x < 495 ? 'out' : 'bal'); },
      activityHeader: /Transaction Date.*Description.*Deposit.*Withdrawal.*Balance/i,
      accountFrom: function (text) {
        var m = text.match(/Account Number[^:：]*[:：]\s*(\d+)\s*-\s*([A-Z]{3})/);
        return m ? (m[1] + ' ' + m[2]) : null;
      }
    },
    paob: {
      dateRe: /^\d{1,2}-[A-Za-z]{3}-\d{4}$/,
      descStart: 120, amtStart: 340, labelMode: 'trailing',
      classify: function (x) { return x < 415 ? 'out' : (x < 490 ? 'in' : 'bal'); },  // WD | DEP | BAL
      activityHeader: /Description of Transaction.*Withdrawal.*Deposit.*Balance/i,
      accountFrom: function (text) {
        var m = text.match(/Account\s*賬?戶?\s*[:：]\s*(HKD|USD|CNY|EUR|GBP)\s*(Savings|Current|Time|儲蓄)/i);
        if (m) return m[1] + ' ' + (/[A-Za-z]/.test(m[2]) ? m[2].replace(/儲蓄/, 'Savings') : 'Savings');
        return null;
      }
    },
    scb: {
      dateRe: /^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$/,
      descStart: 90, amtStart: 300, labelMode: 'trailing',
      classify: function (x) { return x < 410 ? 'out' : (x < 505 ? 'in' : 'bal'); }, // WD | DEP | BAL
      activityHeader: /Date.*Description.*Withdrawal.*Deposit.*Balance/i,
      accountFrom: function (text) {
        var m = text.match(/Account Number\s+(\d+)/);
        return m ? m[1] : null;
      },
      currencyFrom: function (text) {
        var c = text.match(/Currency\s+([A-Z]{3})/);
        return c ? c[1] : null;
      }
    },
    payoneer: {
      dateRe: /^\d{1,2}\s+[A-Za-z]{3},?\s*\d{0,4}$/,   // "28 May, 2026"
      descStart: 300, amtStart: 1400, labelMode: 'trailing', reverse: true,
      signed: true,                                     // single signed amount column
      classify: function (x) { return x < 1950 ? 'amt' : 'bal'; },
      activityHeader: /Date.*Description.*Amount.*Currency.*Running Balance/i,
      accountFrom: function (text) {
        var m = text.match(/Account\s+([A-Z]{3})\s+balance/i);
        return m ? m[1] + ' account' : null;
      }
    },
    wise: {
      dateRe: /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/,
      descStart: 0, amtStart: 360, labelMode: 'trailing', reverse: true,
      // a fresh entry's human description begins with one of these; refs/dates come after the amount
      leadingDesc: /^(Sent money|Received money|Received|Converted|Card|Topped up|Top up|Balance|Direct debit|Refunded|Cashback|Paid|Wise Charges|Money added)/i,
      classify: function (x) { return x < 420 ? 'in' : (x < 495 ? 'out' : 'bal'); }, // Incoming|Outgoing|Amount(=bal)
      activityHeader: /Description.*Incoming.*Outgoing.*Amount/i,
      accountFrom: function () { return null; }
    }
  };

  // ---- core extraction ---------------------------------------------------
  function extract(items) {
    var lines = buildLines(items);
    var fullText = lines.map(function (l) { return l.text; }).join('\n');
    var bank = detectBank(fullText);
    var cfg = BANKS[bank];
    var warnings = [];

    // statement year (for banks that omit it, e.g. HSBC "20 May")
    var ym = fullText.match(/\b(20\d{2})\b/);
    var defaultYear = ym ? ym[1] : null;

    if (bank === 'amex' || bank === 'generic' || !cfg) {
      return { bank: bank, accounts: [], warnings: ['Automatic extraction is not supported for this document type (' + bank + '). Only bank cash statements (HSBC, Fusion, PAOB, Standard Chartered, Payoneer, Wise) are parsed.'] };
    }

    var descStart = cfg.descStart || 0;

    var accounts = [];
    var cur = null;                 // current account being built
    var curName = null;             // name of current account
    var activity = false;           // have we passed an activity header?
    var pendingAccountName = null;  // account name seen, applied at next header
    var pendingCurrency = null;     // currency seen, applied at next header
    var labelBuf = [];              // leading-mode buffer (desc before amount)
    var lastTxn = null;             // trailing-mode target (desc after amount)
    var curDate = null;

    function openAccount(name, ccy) {
      var full = name || ('Account ' + (accounts.length + 1));
      if (ccy && full.indexOf(ccy) === -1) full = full + ' ' + ccy;
      if (cur && full === curName) return;   // same section continuing across a page break
      cur = { account: full, currency: ccy || null, openingBalance: null, transactions: [] };
      curName = full;
      accounts.push(cur);
      labelBuf = []; lastTxn = null;
    }

    lines.forEach(function (line) {
      var text = line.text;

      // currency identifier line?
      if (cfg.currencyFrom) {
        var ccy = cfg.currencyFrom(text);
        if (ccy) pendingCurrency = ccy;
      }
      // account identifier line? -> a new section is coming; stop parsing until its header
      var accName = cfg.accountFrom(text);
      if (accName) {
        pendingAccountName = accName;
        activity = false;
        labelBuf = []; lastTxn = null;
      }

      // activity header -> start (or continue) a section
      if (cfg.activityHeader.test(text)) {
        activity = true;
        openAccount(pendingAccountName || curName, pendingCurrency);
        pendingAccountName = null; pendingCurrency = null;
        labelBuf = [];
        // keep lastTxn null: a header always breaks a running label
        lastTxn = null;
        return;
      }
      if (!activity || !cur) return;

      // footer / boilerplate breaks any running label
      if (FOOTER.test(text)) { labelBuf = []; lastTxn = null; return; }

      // --- tokenise line into date / label / amounts by x-position ---
      var amounts = { in: null, out: null, bal: null, amt: null };
      var labelToks = [];
      var foundDate = null;

      line.tokens.forEach(function (tk) {
        var s = tk.s.trim();
        if (!s) return;
        if (tk.x >= cfg.amtStart) {                 // amount region: numbers only, else ignore
          if (looksNumeric(s)) {
            var col = cfg.classify(tk.x);
            var v = parseSignedNum(s);
            // sanity: reject values that are really account numbers, not money
            if (v != null && Math.abs(v) < 1e10) amounts[col] = v;
          }
          return;
        }
        if (!foundDate && cfg.dateRe.test(s)) { foundDate = s; return; }
        if (tk.x < descStart) return;               // left gutter noise
        labelToks.push(s);
      });

      if (foundDate) {
        curDate = normDate(foundDate, defaultYear);
        // Wise-style: date printed on the line AFTER the amount → backfill
        if (lastTxn && !lastTxn.date) lastTxn.date = curDate;
      }

      var lbl = labelToks.join(' ').replace(/\s+/g, ' ').trim();

      // opening / closing balance markers
      if (isOpeningLine(text)) {
        var ob = amounts.bal != null ? amounts.bal : amounts.amt;
        // currency marker sitting in the left gutter (HSBC FCY: "USD 20 May B/F ...")
        var ccyTok = null;
        line.tokens.forEach(function (tk) { if (tk.x < descStart && /^[A-Z]{3}$/.test(tk.s.trim())) ccyTok = tk.s.trim(); });
        // A statement account that lists several currencies prints one B/F per
        // currency; split each into its own sub-account so balances stay clean.
        if (cur.transactions.length > 0 && ccyTok) {
          var base = curName.replace(/\s+[A-Z]{3}$/, '');
          openAccount(base, ccyTok);
        } else if (ccyTok && !cur.currency) {
          cur.currency = ccyTok;
          if (curName.indexOf(ccyTok) === -1) { cur.account = curName = curName + ' ' + ccyTok; }
        }
        if (ob != null && cur.openingBalance == null) cur.openingBalance = ob;
        labelBuf = []; lastTxn = null;
        return;
      }
      if (isClosingLine(text)) { labelBuf = []; lastTxn = null; return; }

      // resolve money in/out
      var moneyIn = null, moneyOut = null, printedBal = amounts.bal;
      if (cfg.signed) {
        if (amounts.amt != null && amounts.amt !== 0) {
          if (amounts.amt < 0) moneyOut = Math.abs(amounts.amt); else moneyIn = amounts.amt;
        }
      } else {
        if (amounts.in != null && amounts.in !== 0) moneyIn = Math.abs(amounts.in);
        if (amounts.out != null && amounts.out !== 0) moneyOut = Math.abs(amounts.out);
      }
      var hasMoney = moneyIn != null || moneyOut != null;

      if (hasMoney) {
        var parts = labelBuf.length ? labelBuf.slice() : [];
        if (lbl) parts.push(lbl);
        var full = parts.join(' ').replace(/\s+/g, ' ').trim();
        var txn = {
          date: curDate || '',
          label: full || '(no description)',
          moneyIn: moneyIn, moneyOut: moneyOut, balancePrinted: printedBal
        };
        cur.transactions.push(txn);
        lastTxn = txn;
        labelBuf = [];
      } else {
        // line has no amount: it's part of a multi-line description
        if (lbl && !SKIP_LABEL.test(lbl)) {
          var startsNewEntry = cfg.leadingDesc && cfg.leadingDesc.test(lbl);
          if (cfg.labelMode === 'trailing' && lastTxn && !startsNewEntry) {
            lastTxn.label = (lastTxn.label === '(no description)' ? '' : lastTxn.label + ' ') + lbl;
            lastTxn.label = lastTxn.label.replace(/\s+/g, ' ').trim();
          } else {
            if (startsNewEntry) lastTxn = null;   // this desc belongs to the NEXT amount line
            labelBuf.push(lbl);
          }
        }
        // a lone printed balance attaches to the previous transaction
        if (!lbl && printedBal != null && lastTxn && lastTxn.balancePrinted == null) {
          lastTxn.balancePrinted = printedBal;
        }
      }
    });

    // per-bank ordering (Payoneer lists newest-first)
    if (cfg.reverse) accounts.forEach(function (a) { a.transactions.reverse(); });

    // keep only accounts that actually carry transactions
    accounts = accounts.filter(function (a) { return a.transactions.length > 0; });

    // compute running balances + reconcile against printed balances
    accounts.forEach(function (a) {
      var open = a.openingBalance;
      if (open == null && a.transactions.length && a.transactions[0].balancePrinted != null) {
        open = deriveOpening(a.transactions[0]);
      }
      if (open == null) open = 0;
      a.computedOpening = round2(open);
      var run = open;
      var flagged = 0;
      a.transactions.forEach(function (t) {
        run = round2(run + (t.moneyIn || 0) - (t.moneyOut || 0));
        t.balanceComputed = run;
        t.balance = t.balancePrinted != null ? t.balancePrinted : run;
        if (t.balancePrinted != null && Math.abs(t.balancePrinted - run) > 0.02) { t.reconcileFlag = true; flagged++; }
      });
      if (flagged) warnings.push('Account "' + a.account + '": ' + flagged + ' row(s) where the computed running balance differs from the printed balance — please review.');
    });

    return { bank: bank, accounts: accounts, warnings: warnings };
  }

  function deriveOpening(firstTxn) {
    // if first txn has a printed balance, opening = printed - in + out
    if (firstTxn.balancePrinted == null) return 0;
    return round2(firstTxn.balancePrinted - (firstTxn.moneyIn || 0) + (firstTxn.moneyOut || 0));
  }

  function parseSignedNum(s) {
    s = s.trim();
    var neg = /^-/.test(s) || /-$/.test(s) || /DR$/i.test(s);
    var v = num(s);
    if (v == null) return null;
    v = Math.abs(v);
    return neg ? -v : v;
  }
  function round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }

  var api = { extract: extract, detectBank: detectBank, buildLines: buildLines, BANKS: BANKS, normDate: normDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BankParser = api;
})(typeof window !== 'undefined' ? window : this);
