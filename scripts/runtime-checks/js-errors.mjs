/* Capture JS console errors and network 404s on every page load. */
import puppeteer from 'puppeteer-core';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

const URLS = [
  '/', '/about/', '/posts/', '/tags/', '/archive/', '/404.html',
  '/posts/the-tiger-style/', '/posts/1b-payments-per-day/',
  '/posts/temporal-under-the-hood/', '/posts/cat-stereogram-dark-mode/',
  '/posts/lost-ssh-access-to-ec2/', '/posts/system-design-tinder/',
  '/posts/running-101/', '/posts/post-query-optimise/',
  '/posts/creating-content/', '/posts/the-best-way-to-learn-backend-web-development/',
  '/posts/the-psychology-of-seeking-help/',
  '/posts/building-blazingly-fast-pre-owned-car-platform-with-valkey-part-1/',
  '/posts/pre-owned-car-platform-with-valkey-part-2/',
  '/tags/postgres/', '/tags/temporal/',
];

const browser = await puppeteer.launch({
  executablePath: '/Applications/Chromium.app/Contents/MacOS/Chromium',
  headless: true, args: ['--no-sandbox']
});

const errors = [];
for (const url of URLS) {
  const page = await browser.newPage();
  const pageErrors = [];
  const network404s = [];
  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning') {
      pageErrors.push({type: m.type(), text: m.text().slice(0, 120)});
    }
  });
  page.on('pageerror', e => pageErrors.push({type: 'pageerror', text: e.message.slice(0, 120)}));
  page.on('response', r => {
    if (r.status() >= 400) {
      network404s.push({status: r.status(), url: r.url().slice(0, 100)});
    }
  });
  try {
    await page.goto(`http://localhost:1313${url}`, { waitUntil: 'networkidle2', timeout: 15000 });
    // Wait for late-loading scripts
    await new Promise(r => setTimeout(r, 500));
  } catch (e) {
    errors.push({url, fatal: e.message.slice(0, 80)});
  }
  if (pageErrors.length > 0 || network404s.length > 0) {
    errors.push({url, pageErrors, network404s});
  }
  await page.close();
}

await browser.close();

console.log(`Pages with JS errors / 404s: ${errors.length}`);
for (const e of errors) {
  console.log(`\n${e.url}`);
  if (e.fatal) console.log(`  FATAL: ${e.fatal}`);
  for (const pe of e.pageErrors || []) console.log(`  [${pe.type}] ${pe.text}`);
  for (const n of e.network404s || []) console.log(`  [${n.status}] ${n.url}`);
}
