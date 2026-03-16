const { chromium } = require('@playwright/test');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const distDir = path.join(__dirname, 'dist');
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push('PAGEERROR: ' + err.message + '\n' + err.stack.split('\n').slice(0,5).join('\n')));
  await page.route('http://localhost/', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: `<!DOCTYPE html><html><head></head><body><div id="app-config" hidden data-vm-id="test-vm" data-csrf-token="test" data-upload-dir="/tmp" data-upload-action="/sessions/test-vm/upload" data-has-user-rootfs="false"></div><div id="app"></div><script src="/static/app.js" defer></script></body></html>` })
  );
  await page.route('**/static/app.js', route =>
    route.fulfill({ path: path.join(distDir, 'app.js'), contentType: 'application/javascript' })
  );
  await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('http://localhost/');
  await page.waitForTimeout(3000);
  console.log('ERRORS:\n' + errors.join('\n---\n'));
  await browser.close();
})();
