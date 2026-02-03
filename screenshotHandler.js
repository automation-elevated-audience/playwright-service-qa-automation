const { chromium } = require('playwright');

const VIEWPORTS = {
  desktop: { width: 1920, height: 1080 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 667 }
};

/**
 * Capture a full-page screenshot with the specified viewport
 * @param {string} url - The URL to capture
 * @param {string} viewport - 'desktop' | 'tablet' | 'mobile'
 * @param {boolean} fullPage - Whether to capture full page (default: true)
 * @param {number} quality - JPEG quality 0-100 (default: 70)
 * @returns {Buffer} Raw JPEG image bytes
 */
async function captureScreenshot(url, viewport = 'desktop', fullPage = true, quality = 70) {
  let browser;

  const dimensions = VIEWPORTS[viewport] || VIEWPORTS.desktop;

  try {
    console.log(`[PLAYWRIGHT] Capturing ${viewport} screenshot: ${url}`);

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      viewport: dimensions,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    const navTimeout = parseInt(process.env.REQUEST_TIMEOUT, 10) || 60000;
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: navTimeout
    });

    await page.waitForTimeout(2000);

    const buffer = await page.screenshot({
      type: 'jpeg',
      fullPage: fullPage !== false,
      quality: Math.min(100, Math.max(0, quality))
    });

    await browser.close();

    console.log(`[PLAYWRIGHT] Screenshot captured: ${viewport} - ${buffer.length} bytes`);

    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  } catch (error) {
    console.error(`[PLAYWRIGHT] Error capturing screenshot ${viewport} for ${url}:`, error.message);

    if (browser) {
      await browser.close();
    }

    throw error;
  }
}

module.exports = {
  captureScreenshot,
  VIEWPORTS
};
