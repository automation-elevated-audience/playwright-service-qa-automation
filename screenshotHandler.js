const { chromium } = require('playwright');
const sharp = require('sharp');

const VIEWPORTS = {
  desktop: { width: 1920, height: 1080 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 667 }
};

// Maximum image dimension for Claude API (8000px limit, using 7500px for safety)
const MAX_IMAGE_DIMENSION = 7500;

/**
 * Resize image if it exceeds the maximum dimension
 * Maintains aspect ratio while scaling down
 * @param {Buffer} imageBuffer - Original image buffer
 * @param {number} quality - JPEG quality 0-100
 * @returns {Promise<Buffer>} Resized image buffer (or original if within limits)
 */
async function resizeIfNeeded(imageBuffer, quality = 70) {
  try {
    // Get image metadata
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;

    console.log(`[SHARP] Image dimensions: ${width}x${height}`);

    // Check if resizing is needed
    if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
      console.log(`[SHARP] Image within limits, no resize needed`);
      return imageBuffer;
    }

    // Calculate new dimensions maintaining aspect ratio
    let newWidth = width;
    let newHeight = height;

    if (height > width && height > MAX_IMAGE_DIMENSION) {
      // Height is the limiting factor
      newHeight = MAX_IMAGE_DIMENSION;
      newWidth = Math.round((width / height) * MAX_IMAGE_DIMENSION);
    } else if (width > MAX_IMAGE_DIMENSION) {
      // Width is the limiting factor
      newWidth = MAX_IMAGE_DIMENSION;
      newHeight = Math.round((height / width) * MAX_IMAGE_DIMENSION);
    }

    console.log(`[SHARP] Resizing from ${width}x${height} to ${newWidth}x${newHeight}`);

    // Resize the image
    const resizedBuffer = await sharp(imageBuffer)
      .resize(newWidth, newHeight, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: Math.min(100, Math.max(0, quality)) })
      .toBuffer();

    console.log(`[SHARP] Resized image: ${resizedBuffer.length} bytes`);

    return resizedBuffer;
  } catch (error) {
    console.error(`[SHARP] Error resizing image:`, error.message);
    // Return original buffer if resize fails
    return imageBuffer;
  }
}

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
  '--no-zygote',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-first-run',
  '--safebrowsing-disable-auto-update'
];

/**
 * Launch browser, navigate to URL, and prepare page (lazy-load handling).
 * Returns { browser, page } — caller is responsible for closing the browser.
 */
async function preparePage(url, dimensions) {
  const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });

  const context = await browser.newContext({
    viewport: dimensions,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  const navTimeout = parseInt(process.env.REQUEST_TIMEOUT, 10) || 180000;
  await page.goto(url, { waitUntil: 'load', timeout: navTimeout });

  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {
    // Some sites never reach networkidle due to analytics/ads
  }

  // Step 1: Remove lazy-load classes (Bricks Builder, WordPress, generic)
  await page.evaluate(() => {
    document.querySelectorAll('.bricks-lazy-hidden').forEach(el => {
      el.classList.remove('bricks-lazy-hidden');
    });
    document.querySelectorAll('.lazyload, .lazy, .wp-image-lazy').forEach(el => {
      el.classList.remove('lazyload', 'lazy', 'wp-image-lazy');
    });
  });

  // Step 2: Remove loading="lazy" from <img> tags
  await page.evaluate(() => {
    document.querySelectorAll('img[loading="lazy"]').forEach(img => {
      img.removeAttribute('loading');
      img.loading = 'eager';
    });
  });

  // Step 3: Swap data-src / data-lazy-src to src for lazy-loaded images
  await page.evaluate(() => {
    document.querySelectorAll('img[data-src], img[data-lazy-src]').forEach(img => {
      const realSrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
      if (realSrc) img.src = realSrc;
    });
    document.querySelectorAll('source[data-srcset]').forEach(source => {
      source.srcset = source.getAttribute('data-srcset');
    });
    document.querySelectorAll('[data-bg]').forEach(el => {
      el.style.backgroundImage = 'url(' + el.getAttribute('data-bg') + ')';
    });
  });

  // Step 4: Scroll through the full page to trigger remaining lazy loaders
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 150);
    });
  });

  // Step 5: Wait for all <img> elements to fully load
  await page.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll('img'));
    await Promise.all(imgs.map(img => {
      if (img.complete && img.naturalHeight > 0) return;
      return new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 10000);
      });
    }));
  });

  // Step 6: Preload all CSS background images
  await page.evaluate(async () => {
    const bgUrls = new Set();
    document.querySelectorAll('*').forEach(el => {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') {
        const matches = bg.match(/url\(["']?([^"')]+)["']?\)/g);
        if (matches) {
          matches.forEach(m => {
            const url = m.replace(/url\(["']?|["']?\)/g, '');
            if (url && !url.startsWith('data:')) bgUrls.add(url);
          });
        }
      }
    });
    if (bgUrls.size > 0) {
      await Promise.all([...bgUrls].map(url =>
        new Promise(resolve => {
          const img = new Image();
          img.onload = resolve;
          img.onerror = resolve;
          img.src = url;
          setTimeout(resolve, 10000);
        })
      ));
    }
  });

  // Step 7: Second networkidle wait for newly triggered downloads
  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 });
  } catch {
    // Fine if it doesn't settle
  }

  await page.waitForTimeout(2000);

  return { browser, page };
}

/**
 * Capture a screenshot with the specified viewport
 * @param {string} url - The URL to capture
 * @param {string} viewport - 'desktop' | 'tablet' | 'mobile'
 * @param {boolean} fullPage - Whether to capture full page (default: true)
 * @param {number} quality - JPEG quality 0-100 (default: 70)
 * @returns {Promise<Buffer>} Raw JPEG image bytes (resized if needed)
 */
async function captureScreenshot(url, viewport = 'desktop', fullPage = true, quality = 70) {
  const dimensions = VIEWPORTS[viewport] || VIEWPORTS.desktop;
  let browser;

  try {
    console.log(`[PLAYWRIGHT] Capturing ${viewport} screenshot: ${url}`);
    const prepared = await preparePage(url, dimensions);
    browser = prepared.browser;

    const rawBuffer = await prepared.page.screenshot({
      type: 'jpeg',
      fullPage: fullPage !== false,
      quality: Math.min(100, Math.max(0, quality))
    });

    await browser.close();
    browser = null;

    console.log(`[PLAYWRIGHT] Raw screenshot captured: ${viewport} - ${rawBuffer.length} bytes`);

    const finalBuffer = await resizeIfNeeded(rawBuffer, quality);
    const buffer = Buffer.isBuffer(finalBuffer) ? finalBuffer : Buffer.from(finalBuffer);

    console.log(`[PLAYWRIGHT] Final screenshot: ${buffer.length} bytes`);
    return buffer;
  } catch (error) {
    console.error(`[PLAYWRIGHT] Error capturing screenshot ${viewport} for ${url}:`, error.message);
    if (browser) await browser.close();
    throw error;
  }
}

/**
 * Capture both a full-page and viewport-only mobile screenshot in a single browser session.
 * The viewport-only shot (375x667) gives Claude a clear view of the header/hamburger icon.
 * @param {string} url - The URL to capture
 * @param {number} quality - JPEG quality 0-100 (default: 70)
 * @returns {Promise<{fullPage: Buffer, viewport: Buffer}>}
 */
async function captureWithViewport(url, quality = 70) {
  const dimensions = VIEWPORTS.mobile;
  let browser;

  try {
    console.log(`[PLAYWRIGHT] Capturing mobile dual screenshot (fullPage + viewport): ${url}`);
    const prepared = await preparePage(url, dimensions);
    browser = prepared.browser;

    const jpegQuality = Math.min(100, Math.max(0, quality));

    // Viewport-only screenshot first (scroll is already at top from preparePage)
    const viewportRaw = await prepared.page.screenshot({
      type: 'jpeg',
      fullPage: false,
      quality: jpegQuality
    });

    // Full-page screenshot
    const fullPageRaw = await prepared.page.screenshot({
      type: 'jpeg',
      fullPage: true,
      quality: jpegQuality
    });

    await browser.close();
    browser = null;

    console.log(`[PLAYWRIGHT] Viewport screenshot: ${viewportRaw.length} bytes, Full-page: ${fullPageRaw.length} bytes`);

    const fullPageBuffer = await resizeIfNeeded(fullPageRaw, quality);
    // Viewport screenshot is always 375x667 so no resize needed, but run it for safety
    const viewportBuffer = await resizeIfNeeded(viewportRaw, quality);

    return {
      fullPage: Buffer.isBuffer(fullPageBuffer) ? fullPageBuffer : Buffer.from(fullPageBuffer),
      viewport: Buffer.isBuffer(viewportBuffer) ? viewportBuffer : Buffer.from(viewportBuffer)
    };
  } catch (error) {
    console.error(`[PLAYWRIGHT] Error capturing dual screenshot for ${url}:`, error.message);
    if (browser) await browser.close();
    throw error;
  }
}

module.exports = {
  captureScreenshot,
  captureWithViewport,
  resizeIfNeeded,
  VIEWPORTS,
  MAX_IMAGE_DIMENSION
};
