/* Check for horizontal overflow at multiple viewport widths.
   Browser's document scrollWidth > viewport width = potential layout break.
*/
import puppeteer from 'puppeteer-core';

const URLS = [
  '/',
  '/about/',
  '/posts/',
  '/tags/',
  '/archive/',
  '/posts/the-tiger-style/',
  '/posts/1b-payments-per-day/',
  '/posts/temporal-under-the-hood/',
  '/posts/cat-stereogram-dark-mode/',
  '/posts/lost-ssh-access-to-ec2/',
  '/posts/system-design-tinder/',
  '/posts/running-101/',
  '/posts/post-query-optimise/',
  '/posts/creating-content/',
  '/posts/the-best-way-to-learn-backend-web-development/',
  '/posts/the-psychology-of-seeking-help/',
  '/posts/building-blazingly-fast-pre-owned-car-platform-with-valkey-part-1/',
  '/posts/pre-owned-car-platform-with-valkey-part-2/',
  '/tags/postgres/',
  '/tags/temporal/',
];

const VIEWPORTS = [
  { name: 'mobile-narrow', width: 320, height: 568 },
  { name: 'mobile', width: 375, height: 667 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 720 },
];

const browser = await puppeteer.launch({
  executablePath: '/Applications/Chromium.app/Contents/MacOS/Chromium',
  headless: true, args: ['--no-sandbox']
});

const issues = [];
for (const vp of VIEWPORTS) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.width, height: vp.height });
  for (const url of URLS) {
    await page.goto(`http://localhost:1313${url}`, { waitUntil: 'networkidle2', timeout: 15000 });
    const data = await page.evaluate(() => {
      const docW = document.documentElement.scrollWidth;
      const winW = window.innerWidth;
      // Find any element wider than the viewport (causes h-scroll)
      const wide = [];
      for (const el of document.body.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > window.innerWidth + 1) {
          wide.push({
            tag: el.tagName,
            className: el.className?.toString().slice(0, 60) || '',
            width: Math.round(r.width),
            text: el.textContent?.slice(0, 50) || ''
          });
          if (wide.length >= 3) break;
        }
      }
      return { docWidth: docW, winWidth: winW, wide };
    });
    if (data.docWidth > data.winWidth + 1) {
      issues.push({ url, viewport: vp.name, ...data });
    }
  }
  await page.close();
}

await browser.close();

console.log(`Total layout issues across viewports: ${issues.length}`);
for (const iss of issues.slice(0, 20)) {
  console.log(`  ${iss.viewport} ${iss.url}: doc=${iss.docWidth} > win=${iss.winWidth}`);
  for (const w of iss.wide) {
    console.log(`    wide: ${w.tag}.${w.className} ${w.width}px "${w.text.trim()}"`);
  }
}
