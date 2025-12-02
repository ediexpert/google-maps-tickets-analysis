import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import nodemailer from 'nodemailer';

export class GMapsHelper {
  constructor(opts = {}) {
    this.opts = opts;
  }

  // Accept common Google consent dialogs if present on the page or in frames
  async handleConsent(page) {
    if (!page) return false;
    try {
      if (!page.url || !page.url().includes) return false;
    } catch (e) {
      return false;
    }

    if (!page.url().includes('consent.google.com')) return false;

    const selectors = [
      'button[aria-label="Accept all"]',
      'button[aria-label*="Accept"]',
      'button[jsname="b3VHJd"]',
      'button[jsname*="b3"]'
    ];

    const tryClick = async (handle) => {
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
          handle.click().catch(() => {})
        ]);
        return true;
      } catch (e) {
        try { await handle.click().catch(() => {}); return true; } catch (_) { return false; }
      }
    };

    for (const sel of selectors) {
      try {
        const h = await page.$(sel);
        if (h) {
          const ok = await tryClick(h);
          if (ok) return true;
        }
      } catch (e) {}
    }

    try {
      const handles = await page.$x("//button[contains(., 'Accept all') or contains(., 'Accept')]");
      if (handles && handles.length) {
        const ok = await tryClick(handles[0]);
        if (ok) return true;
      }
    } catch (e) {}

    // search inside frames
    for (const frame of page.frames()) {
      try {
        for (const sel of selectors) {
          try {
            const h = await frame.$(sel);
            if (h) { await h.click().catch(() => {}); return true; }
          } catch (e) {}
        }
        const handles = await frame.$x("//button[contains(., 'Accept all') or contains(., 'Accept')]");
        if (handles && handles.length) { await handles[0].click().catch(() => {}); return true; }
      } catch (e) {}
    }

    return false;
  }

  async setViewport(page, width = 1080, height = 1024) {
    if (!page) return;
    try { await page.setViewport({ width, height }); } catch (e) {}
  }

  // Search for a place in the search box and submit it. Returns true if action taken.
  async searchPlace(page, place, { waitForSelector = '#pane', timeout = 10000 } = {}) {
    if (!page || !place) return false;
    try {
      await this.setViewport(page);

      // Try to find input on main page first
      let inputHandle = null;
      try {
        inputHandle = await page.waitForSelector('#searchboxinput', { visible: true, timeout: 5000 });
      } catch (e) {
        // try frames
        for (const frame of page.frames()) {
          try {
            inputHandle = await frame.waitForSelector('#searchboxinput', { visible: true, timeout: 2000 });
            if (inputHandle) break;
          } catch (_) {}
        }
      }

      if (!inputHandle) return false;

      // Focus, clear and type
      try { await inputHandle.click({ clickCount: 3 }); } catch (e) { try { await inputHandle.click(); } catch (_) {} }
      await inputHandle.type(String(place), { delay: 100 });
      // Press Enter via page keyboard (works even when element in a frame if focused)
      await page.keyboard.press('Enter');

      // Wait for known selector that indicates results; be best-effort
      try { await page.waitForSelector(waitForSelector, { timeout }); } catch (_) {}
      return true;
    } catch (e) {
      return false;
    }
  }

  // Try to find and click the Tickets tab
  async clickTickets(page) {
    const selector = 'button[role="tab"][aria-label*="Tickets"]';
    try {
      await page.waitForSelector(selector, { visible: true, timeout: 5000 });
      await page.click(selector);
      return true;
    } catch (e) {
      for (const frame of page.frames()) {
        try {
          const el = await frame.waitForSelector(selector, { visible: true, timeout: 2000 });
          if (el) { await el.click(); return true; }
        } catch (_) {}
      }
    }
    return false;
  }

  // Click the Admission tab by inspecting button[role=tab] descendant divs
  async clickAdmission(page) {
    const clickByDivText = async (context) => {
      try {
        const buttons = await context.$$('button[role="tab"]');
        for (const btn of buttons) {
          try {
            const divs = await btn.$$('div');
            for (const d of divs) {
              const txt = await context.evaluate(el => el.innerText, d).catch(() => '');
              if (txt && txt.trim().includes('Admission')) { await btn.click(); return true; }
            }
          } catch (e) {}
        }
      } catch (e) {}
      return false;
    };

    if (await clickByDivText(page)) return true;
    for (const frame of page.frames()) {
      try { if (await clickByDivText(frame)) return true; } catch (e) {}
    }
    return false;
  }

  // Collect hrefs under the admission area (best-effort)
  async collectAdmissionLinks(page, limit = 7) {
    let hrefs = [];
    try { hrefs = await page.$$eval('#pane a[href]', els => Array.from(new Set(els.map(a => a.href))).filter(Boolean)); } catch (e) { hrefs = []; }
    if (!hrefs.length) {
      try { hrefs = await page.$$eval('a[href]', els => Array.from(new Set(els.map(a => a.href))).filter(Boolean)); } catch (e) { hrefs = []; }
    }
    if (!hrefs.length) {
      for (const frame of page.frames()) {
        try {
          const frameHrefs = await frame.$$eval('a[href]', els => Array.from(new Set(els.map(a => a.href))).filter(Boolean));
          if (frameHrefs && frameHrefs.length) hrefs.push(...frameHrefs);
        } catch (e) {}
      }
      hrefs = Array.from(new Set(hrefs));
    }
    hrefs = hrefs.filter(h => typeof h === 'string' && (h.startsWith('http://') || h.startsWith('https://')));
    return hrefs.slice(0, limit);
  }

  // Attempt to extract price text for a specific href by searching anchors and descendants
  async findPriceInContext(context, href) {
    try {
      return await context.evaluate((href) => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        const a = anchors.find(x => x.href === href);
        if (!a) return null;
        const priceRegex = /[€$£]\s*\d+[\d.,]*/;
        const walker = a.querySelectorAll('*');
        for (const el of walker) {
          const txt = el.innerText && el.innerText.trim();
          if (txt) {
            const m = txt.match(priceRegex);
            if (m) return m[0].trim();
          }
        }
        const m = a.innerText && a.innerText.match(priceRegex);
        if (m) return m[0].trim();
        return null;
      }, href);
    } catch (e) { return null; }
  }

  // Write CSV from results array [{url, price}]
  async writeCsv(results = [], filename = 'admission_links_prices.csv') {
    // Support optional `place` field. If present, include it as first column.
    const hasPlace = results.length > 0 && Object.prototype.hasOwnProperty.call(results[0], 'place');
    const header = hasPlace ? 'place,url,price' : 'url,price';
    const csvLines = [header, ...results.map(r => {
      const place = hasPlace ? `"${(r.place||'').replace(/"/g, '""')}",` : '';
      const url = `"${(r.url||'').replace(/"/g, '""')}"`;
      const price = `"${(r.price||'').replace(/"/g,'""')}"`;
      return `${place}${url},${price}`;
    })];
    await fs.writeFile(filename, csvLines.join('\n'));
    return filename;
  }

  // Open a list of urls in new pages (does not close main browser) and snapshot each
  async openLinksAndScreenshot(browser, urls = [], opts = {}) {
    const shots = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const p = await browser.newPage();
        await p.setViewport({ width: opts.width || 1080, height: opts.height || 1024 });
        await p.goto(url, { waitUntil: 'networkidle2', timeout: opts.timeout || 30000 });
        await new Promise(r => setTimeout(r, opts.pause || 1500));
        const shot = opts.prefix ? `${opts.prefix}-tab-${i+1}.png` : `tab-${i+1}.png`;
        await p.screenshot({ path: shot, fullPage: false });
        shots.push(shot);
        await p.close();
      } catch (e) {
        // ignore individual failures
      }
    }
    return shots;
  }

  // Send results email using environment vars — send only inline table (no attachments)
  async sendResultsEmail({ sendFlag = process.env.SEND_EMAIL, screenshot, place_name, csvPath } = {}) {
    const SEND_EMAIL = (sendFlag || '').toString().toLowerCase() === 'true';
    if (!SEND_EMAIL) return { skipped: true };

    const SMTP_HOST = process.env.SMTP_HOST;
    const SMTP_PORT = process.env.SMTP_PORT;
    const SMTP_USER = process.env.SMTP_USER;
    const SMTP_PASS = process.env.SMTP_PASS;
    const EMAIL_TO = process.env.EMAIL_TO;
    const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER;

    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !EMAIL_TO) {
      return { error: 'SMTP or recipient not configured' };
    }

    // Read CSV to build inline table (use provided csvPath or default)
    const csvToRead = csvPath || 'admission_links_prices.csv';
    let csvContent = '';
    try { csvContent = await fs.readFile(csvToRead, 'utf8'); } catch (e) { csvContent = ''; }

    const parseCsv = (text) => {
      const rows = [];
      if (!text) return rows;
      const lines = text.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const cols = [];
        let cur = '';
        let inQuote = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') {
            if (inQuote && line[i+1] === '"') { cur += '"'; i++; } else { inQuote = !inQuote; }
          } else if (ch === ',' && !inQuote) {
            cols.push(cur); cur = '';
          } else { cur += ch; }
        }
        cols.push(cur);
        rows.push(cols.map(c => (c || '').trim()));
      }
      return rows;
    };

    const rows = parseCsv(csvContent);
    const bodyRows = [];
    for (let i = 1; i < rows.length; i++) {
      const cols = rows[i];
      if (!cols || cols.length === 0) continue;
      const url = cols.length >= 2 ? cols[cols.length - 2] : cols[0];
      const price = cols.length >= 2 ? cols[cols.length - 1] : (cols[1] || '');
      bodyRows.push({ url, price });
    }

    let htmlBody = '<p>No URL/price data found.</p>';
    let textBody = 'No URL/price data found.';
    if (bodyRows.length) {
      htmlBody = '<table border="1" cellpadding="4" cellspacing="0"><thead><tr><th>URL</th><th>Price</th></tr></thead><tbody>' +
        bodyRows.map(r => `<tr><td><a href="${r.url}">${r.url}</a></td><td>${r.price}</td></tr>`).join('') +
        '</tbody></table>';
      textBody = bodyRows.map(r => `${r.url}\t${r.price}`).join('\n');
    }

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    const subjectPrefix = place_name || process.env.PLACE || 'Places';
    const subject = `${subjectPrefix} ${new Date().toLocaleString()}`;

    // Attach the provided screenshot (if exists) as the only attachment
    const attachments = [];
    if (screenshot) {
      try {
        // ensure file exists
        await fs.stat(screenshot);
        attachments.push({ filename: path.basename(screenshot), path: screenshot });
      } catch (e) {
        // ignore missing file
      }
    }

    const mailOptions = { from: EMAIL_FROM, to: EMAIL_TO, subject, text: textBody, html: htmlBody };
    if (attachments.length) mailOptions.attachments = attachments;

    try {
      const info = await transporter.sendMail(mailOptions);
      return { ok: true, info, attachmentsSent: attachments.map(a => a.filename) };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }
}

export default GMapsHelper;
