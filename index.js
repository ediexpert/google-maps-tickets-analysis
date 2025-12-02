import 'dotenv/config';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs/promises';
import { GMapsHelper } from './gmaps_helper.js';

puppeteer.use(StealthPlugin());
const helper = new GMapsHelper();

/* ============================================
   ✅ METHOD 1: OPEN GOOGLE MAPS + HANDLE CONSENT
============================================ */
async function openGoogleMapsAndHandleConsent(browser) {
  const page = await browser.newPage();

  await page.goto('https://www.google.com/maps/', {
    waitUntil: 'networkidle2',
  });

  if (page.url().includes('consent.google.com')) {
    const selectors = [
      'button[aria-label="Accept all"]',
      'button[aria-label*="Accept"]',
      'button[jsname="b3VHJd"]',
      'button[jsname*="b3"]',
    ];

    for (const sel of selectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
          break;
        }
      } catch {}
    }
  }

  await page.setViewport({ width: 1080, height: 1024 });
  return page;
}

/* ======================================================
   ✅ METHOD 2: ANALYZE A SINGLE PLACE USING SAME PAGE
====================================================== */
async function analyzePlaceOnMaps(page, PLACE, browser) {
  console.log('🔍 Processing:', PLACE);

  const safe = PLACE.replace(/[^a-zA-Z0-9-_\.]/g, '_').slice(0, 60);

  // ✅ SEARCH
  await page.waitForSelector('#searchboxinput', { visible: true, timeout: 30000 });
  await page.evaluate(() => (document.querySelector('#searchboxinput').value = ''));
  await page.click('#searchboxinput');
  await page.keyboard.type(PLACE, { delay: 60 });
  await page.keyboard.press('Enter');

  await page.waitForSelector('#pane', { timeout: 10000 }).catch(() => {});
  await new Promise(res => setTimeout(res, 3000));

  // ✅ CLICK TICKETS TAB
  const ticketsSelector = 'button[role="tab"][aria-label*="Tickets"]';
  let ticketsClicked = false;

  try {
    await page.waitForSelector(ticketsSelector, { visible: true, timeout: 5000 });
    await page.click(ticketsSelector);
    ticketsClicked = true;
  } catch {
    for (const frame of page.frames()) {
      try {
        const el = await frame.waitForSelector(ticketsSelector, { visible: true, timeout: 2000 });
        if (el) {
          await el.click();
          ticketsClicked = true;
          break;
        }
      } catch {}
    }
  }

  if (!ticketsClicked) {
    console.log('❌ Tickets tab not found for', PLACE);
    return;
  }

  await new Promise(res => setTimeout(res, 1500));

  // ✅ CLICK ADMISSION (LANGUAGE SAFE)
  const admissionSelector =
    'button[role="tab"][data-tab-index="0"][jsaction*="pane.tabs.tabClick"]';

  let admissionClicked = false;

  try {
    await page.waitForSelector(admissionSelector, { visible: true, timeout: 6000 });
    await page.click(admissionSelector);
    admissionClicked = true;
  } catch {
    for (const frame of page.frames()) {
      try {
        const el = await frame.waitForSelector(admissionSelector, { visible: true, timeout: 2000 });
        if (el) {
          await el.click();
          admissionClicked = true;
          break;
        }
      } catch {}
    }
  }

  if (!admissionClicked) {
    console.log('❌ Admission not found for', PLACE);
    return;
  }

  await new Promise(res => setTimeout(res, 1200));
  const admissionShot = `gmap-admission-${safe}.png`;
  await page.screenshot({ path: admissionShot });

  // ✅ EXTRACT LINKS
  let hrefs = [];
  try {
    hrefs = await page.$$eval('#pane a[href]', els => [...new Set(els.map(a => a.href))]);
  } catch {}

  if (!hrefs.length) {
    for (const frame of page.frames()) {
      try {
        const frameLinks = await frame.$$eval('a[href]', els => els.map(a => a.href));
        hrefs.push(...frameLinks);
      } catch {}
    }
  }

  hrefs = [...new Set(hrefs)].filter(h => h.startsWith('http'));
  const firstSeven = hrefs.slice(0, 7);

  // ✅ PRICE EXTRACTION
  const priceRegex = /(€|\$|£|AED|USD|EUR)\s*\d+[\d.,]*/;

  async function findPriceInContext(context, href) {
    try {
      return await context.evaluate((href, priceRegexSrc) => {
        const priceRegex = new RegExp(priceRegexSrc);
        const a = Array.from(document.querySelectorAll('a[href]')).find(x => x.href === href);
        if (!a) return null;

        const directPriceEl = a.querySelector('.drwWxc');
        if (directPriceEl) return directPriceEl.innerText.trim();

        for (const el of a.querySelectorAll('*')) {
          const txt = el.innerText?.trim();
          if (txt && priceRegex.test(txt)) return txt.match(priceRegex)[0];
        }

        return a.innerText?.match(priceRegex)?.[0] || null;
      }, href, priceRegex.source);
    } catch {
      return null;
    }
  }

  const results = [];

  for (const href of firstSeven) {
    let price = await findPriceInContext(page, href);
    if (!price) {
      for (const frame of page.frames()) {
        price = await findPriceInContext(frame, href);
        if (price) break;
      }
    }
    results.push({ url: href, price: price || 'Not found' });
  }

  // ✅ SAVE CSV
  const csvLines = ['url,price', ...results.map(r => `"${r.url}","${r.price}"`)];
  const fileName = `prices-${safe}.csv`;

  await fs.writeFile(fileName, csvLines.join('\n'));
  //await fs.writeFile('admission_links_prices.csv', csvLines.join('\n'));

  // ✅ OPEN EXTERNAL LINKS (OPTIONAL)
  if (process.env.OPEN_EXTERNAL_LINKS === 'true') {
    for (let i = 0; i < Math.min(6, firstSeven.length); i++) {
      const newPage = await browser.newPage();
      await newPage.goto(firstSeven[i], { waitUntil: 'networkidle2' });
      await newPage.screenshot({ path: `tab-${safe}-${i + 1}.png` });
      await newPage.close();
    }
  }

  // ✅ SEND EMAIL
  try {
    const emailResult = await helper.sendResultsEmail({
      sendFlag: process.env.SEND_EMAIL,
      screenshot: admissionShot,
      place_name: PLACE,
      csvPath: fileName
    });
    console.log('📧 Email sent for', PLACE, emailResult);
  } catch (e) {
    console.log('Email failed for', PLACE, e.message);
  }
}

/* ============================================
   ✅ MAIN EXECUTION
============================================ */
const browser = await puppeteer.launch({
  headless: true,
  slowMo: 25,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  defaultViewport: null,
});

// ✅ OPEN MAPS ONCE
const page = await openGoogleMapsAndHandleConsent(browser);

// ✅ LOAD PLACES
const placesEnv = process.env.PLACES;
const places = placesEnv
  ? placesEnv.split(',').map(s => s.trim()).filter(Boolean)
  : [process.env.PLACE || process.argv[2] || 'Img World of Adventure'];

// ✅ PROCESS EACH PLACE ON SAME PAGE
for (const place of places) {
  await analyzePlaceOnMaps(page, place, browser);

  // delay 10 seconds between places
  await new Promise(res => setTimeout(res, 10000)); 
}

// ✅ CLOSE EVERYTHING ONCE
await page.close();
await browser.close();
