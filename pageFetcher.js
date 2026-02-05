const { chromium } = require('playwright');

/**
 * Fetch page HTML via Playwright (includes JS-rendered content)
 * @param {string} pageUrl - The URL to fetch
 * @returns {Object} { html, statusCode, headers }
 */
async function fetchPage(pageUrl) {
  let browser;

  try {
    console.log(`[PLAYWRIGHT] Fetching page: ${pageUrl}`);

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',    // Don't use /dev/shm (limited on containers)
        '--disable-gpu',               // Disable GPU (not needed)
        '--single-process',            // Use single process (saves memory)
        '--no-zygote',                 // Disable zygote process
        '--disable-extensions',        // Disable extensions
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--safebrowsing-disable-auto-update'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // Use 'load' instead of 'networkidle' - more reliable for page fetching
    // networkidle can timeout on sites with analytics/ads that never stop making requests
    const navTimeout = parseInt(process.env.REQUEST_TIMEOUT, 10) || 180000;
    const response = await page.goto(pageUrl, {
      waitUntil: 'load',
      timeout: navTimeout
    });

    if (!response) {
      throw new Error('No response received from page');
    }

    const statusCode = response.status();
    const headers = response.headers();

    // Wait a bit for dynamic content
    await page.waitForTimeout(2000);

    const html = await page.content();

    await browser.close();

    console.log(`[PLAYWRIGHT] Fetched ${pageUrl} - Status: ${statusCode}, HTML length: ${html.length}`);

    return {
      html,
      statusCode,
      headers: Object.fromEntries(Object.entries(headers))
    };
  } catch (error) {
    console.error(`[PLAYWRIGHT] Error fetching ${pageUrl}:`, error.message);

    if (browser) {
      await browser.close();
    }

    throw error;
  }
}

module.exports = {
  fetchPage
};
