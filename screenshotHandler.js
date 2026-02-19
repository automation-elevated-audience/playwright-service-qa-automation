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
 * Run programmatic responsiveness checks on the currently open page.
 * Must be called while the browser is still open at the target viewport.
 * @param {import('playwright').Page} page
 * @returns {Promise<{status: string, issues: string[], details: object}>}
 */
async function runResponsivenessChecks(page) {
  try {
    const result = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const issues = [];

      // 1. Horizontal overflow
      const hasHorizontalScroll = document.body.scrollWidth > vw + 2;
      if (hasHorizontalScroll) {
        issues.push(`Horizontal overflow detected (content ${document.body.scrollWidth}px vs viewport ${vw}px)`);
      }

      // 2. Elements overflowing viewport
      let overflowingElements = 0;
      const skipTags = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD', 'BR', 'HR']);
      document.querySelectorAll('body *').forEach(el => {
        if (skipTags.has(el.tagName)) return;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.right > vw + 5) {
          overflowingElements++;
        }
      });
      if (overflowingElements > 0) {
        issues.push(`${overflowingElements} element(s) overflow the viewport boundary`);
      }

      // 3. Touch targets too small (relevant for all viewports but especially mobile/tablet)
      let smallTouchTargets = 0;
      document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick]').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44)) {
          const style = getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            smallTouchTargets++;
          }
        }
      });
      if (smallTouchTargets > 0) {
        issues.push(`${smallTouchTargets} interactive element(s) smaller than 44x44px minimum touch target`);
      }

      // 4. Body font size check
      const bodyFontSize = parseFloat(getComputedStyle(document.body).fontSize) || 16;

      // 5. Viewport meta tag
      const viewportMeta = document.querySelector('meta[name="viewport"]');
      const hasViewportMeta = !!viewportMeta;
      const viewportContent = viewportMeta?.getAttribute('content') || '';
      if (!hasViewportMeta) {
        issues.push('Missing <meta name="viewport"> tag');
      } else if (!viewportContent.includes('width=device-width')) {
        issues.push('Viewport meta tag missing width=device-width');
      }

      // 6. Oversized images (naturalWidth much larger than displayed, wasting bandwidth)
      let oversizedImages = 0;
      document.querySelectorAll('img').forEach(img => {
        if (img.naturalWidth > 0 && img.clientWidth > 0 && img.naturalWidth > img.clientWidth * 3) {
          oversizedImages++;
        }
      });
      if (oversizedImages > 0) {
        issues.push(`${oversizedImages} image(s) significantly larger than display size (unoptimized)`);
      }

      // 7. Fixed/sticky elements overlapping content
      let fixedOverlap = false;
      const fixedEls = [];
      document.querySelectorAll('*').forEach(el => {
        const style = getComputedStyle(el);
        if ((style.position === 'fixed' || style.position === 'sticky') && el.tagName !== 'SCRIPT') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 50 && rect.top < vh / 2) {
            fixedEls.push(rect);
          }
        }
      });
      if (fixedEls.length > 0) {
        const mainContent = document.querySelector('main, [role="main"], #content, .content, article');
        if (mainContent) {
          const mainRect = mainContent.getBoundingClientRect();
          for (const fixedRect of fixedEls) {
            if (fixedRect.bottom > mainRect.top && fixedRect.bottom - mainRect.top > 20) {
              fixedOverlap = true;
              break;
            }
          }
        }
      }
      if (fixedOverlap) {
        issues.push('Fixed/sticky header appears to overlap page content');
      }

      // 8. Color contrast (WCAG 2.1 AA)
      function parseColor(color) {
        if (!color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return null;
        const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return null;
        return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
      }
      function luminance(r, g, b) {
        const [rs, gs, bs] = [r, g, b].map(c => {
          c = c / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
      }
      function contrastRatio(fg, bg) {
        const l1 = luminance(...fg) + 0.05;
        const l2 = luminance(...bg) + 0.05;
        return l1 > l2 ? l1 / l2 : l2 / l1;
      }
      function getEffectiveBg(el) {
        let current = el;
        while (current && current !== document.documentElement) {
          const bg = getComputedStyle(current).backgroundColor;
          const parsed = parseColor(bg);
          if (parsed && (parsed[0] !== 0 || parsed[1] !== 0 || parsed[2] !== 0 || bg !== 'rgba(0, 0, 0, 0)')) {
            return parsed;
          }
          current = current.parentElement;
        }
        return [255, 255, 255];
      }

      let contrastIssues = 0;
      const contrastSamples = [];
      const textSelectors = 'h1, h2, h3, h4, h5, h6, p, a, button, label, span, li, td, th';
      const textEls = document.querySelectorAll(textSelectors);
      const checked = new Set();
      for (const el of textEls) {
        if (checked.size >= 200) break;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        const text = el.textContent?.trim();
        if (!text || text.length === 0) continue;

        const key = `${el.tagName}-${Math.round(rect.top)}-${Math.round(rect.left)}`;
        if (checked.has(key)) continue;
        checked.add(key);

        const fg = parseColor(style.color);
        if (!fg) continue;
        const bg = getEffectiveBg(el);

        const ratio = contrastRatio(fg, bg);
        const fontSize = parseFloat(style.fontSize) || 16;
        const isBold = parseInt(style.fontWeight) >= 700 || style.fontWeight === 'bold';
        const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && isBold);
        const required = isLargeText ? 3.0 : 4.5;
        const pass = ratio >= required;

        if (!pass) {
          contrastIssues++;
          if (contrastSamples.length < 5) {
            contrastSamples.push({
              element: `${el.tagName.toLowerCase()}`,
              text: text.substring(0, 40),
              ratio: Math.round(ratio * 100) / 100,
              required,
              pass: false
            });
          }
        }
      }
      if (contrastIssues > 0) {
        issues.push(`${contrastIssues} text element(s) have insufficient color contrast (below WCAG AA)`);
      }

      // 9. Focus indicator check
      let focusableElements = 0;
      let focusableWithoutIndicator = 0;
      const focusSelectors = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
      const focusEls = Array.from(document.querySelectorAll(focusSelectors)).slice(0, 30);
      for (const el of focusEls) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        focusableElements++;

        const beforeOutline = style.outlineStyle;
        const beforeBoxShadow = style.boxShadow;
        const beforeBorder = style.border;
        el.focus();
        const afterStyle = getComputedStyle(el);
        const hasOutline = afterStyle.outlineStyle !== 'none' && afterStyle.outlineWidth !== '0px';
        const hasBoxShadow = afterStyle.boxShadow !== 'none' && afterStyle.boxShadow !== beforeBoxShadow;
        const hasBorderChange = afterStyle.border !== beforeBorder;

        if (!hasOutline && !hasBoxShadow && !hasBorderChange) {
          focusableWithoutIndicator++;
        }
        el.blur();
      }
      const focusableWithIndicator = focusableElements - focusableWithoutIndicator;
      if (focusableWithoutIndicator > 0) {
        issues.push(`${focusableWithoutIndicator} of ${focusableElements} focusable element(s) have no visible focus indicator`);
      }

      return {
        status: issues.length === 0 ? 'PASS' : 'FAIL',
        issues,
        details: {
          viewportWidth: vw,
          viewportHeight: vh,
          hasHorizontalScroll,
          overflowingElements,
          smallTouchTargets,
          bodyFontSize,
          hasViewportMeta,
          viewportContent,
          oversizedImages,
          fixedOverlap,
          contrastIssues,
          contrastSamples,
          focusableElements,
          focusableWithIndicator,
          focusableWithoutIndicator,
        }
      };
    });

    console.log(`[RESPONSIVENESS] ${result.status} — ${result.issues.length} issue(s) found`);
    return result;
  } catch (err) {
    console.warn(`[RESPONSIVENESS] Check failed:`, err.message);
    return { status: 'ERROR', issues: [`Check failed: ${err.message}`], details: {} };
  }
}

/**
 * Capture a screenshot with the specified viewport
 * @param {string} url - The URL to capture
 * @param {string} viewport - 'desktop' | 'tablet' | 'mobile'
 * @param {boolean} fullPage - Whether to capture full page (default: true)
 * @param {number} quality - JPEG quality 0-100 (default: 70)
 * @returns {Promise<{buffer: Buffer, responsivenessChecks: object}>}
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

    const responsivenessChecks = await runResponsivenessChecks(prepared.page);

    await browser.close();
    browser = null;

    console.log(`[PLAYWRIGHT] Raw screenshot captured: ${viewport} - ${rawBuffer.length} bytes`);

    const finalBuffer = await resizeIfNeeded(rawBuffer, quality);
    const buffer = Buffer.isBuffer(finalBuffer) ? finalBuffer : Buffer.from(finalBuffer);

    console.log(`[PLAYWRIGHT] Final screenshot: ${buffer.length} bytes`);
    return { buffer, responsivenessChecks };
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
 * @returns {Promise<{fullPage: Buffer, viewport: Buffer, responsivenessChecks: object}>}
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

    const responsivenessChecks = await runResponsivenessChecks(prepared.page);

    await browser.close();
    browser = null;

    console.log(`[PLAYWRIGHT] Viewport screenshot: ${viewportRaw.length} bytes, Full-page: ${fullPageRaw.length} bytes`);

    const fullPageBuffer = await resizeIfNeeded(fullPageRaw, quality);
    const viewportBuffer = await resizeIfNeeded(viewportRaw, quality);

    return {
      fullPage: Buffer.isBuffer(fullPageBuffer) ? fullPageBuffer : Buffer.from(fullPageBuffer),
      viewport: Buffer.isBuffer(viewportBuffer) ? viewportBuffer : Buffer.from(viewportBuffer),
      responsivenessChecks
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
  runResponsivenessChecks,
  resizeIfNeeded,
  VIEWPORTS,
  MAX_IMAGE_DIMENSION
};
