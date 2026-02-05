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

/**
 * Capture a full-page screenshot with the specified viewport
 * Images exceeding 7500px in any dimension are automatically resized
 * @param {string} url - The URL to capture
 * @param {string} viewport - 'desktop' | 'tablet' | 'mobile'
 * @param {boolean} fullPage - Whether to capture full page (default: true)
 * @param {number} quality - JPEG quality 0-100 (default: 70)
 * @returns {Promise<Buffer>} Raw JPEG image bytes (resized if needed)
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

    // Use 'load' instead of 'networkidle' for screenshots - more reliable
    // networkidle can timeout on sites with analytics/ads that never stop making requests
    const navTimeout = parseInt(process.env.REQUEST_TIMEOUT, 10) || 60000;
    await page.goto(url, {
      waitUntil: 'load',
      timeout: navTimeout
    });

    await page.waitForTimeout(2000);

    // Capture the full page screenshot
    const rawBuffer = await page.screenshot({
      type: 'jpeg',
      fullPage: fullPage !== false,
      quality: Math.min(100, Math.max(0, quality))
    });

    await browser.close();

    console.log(`[PLAYWRIGHT] Raw screenshot captured: ${viewport} - ${rawBuffer.length} bytes`);

    // Resize if needed to comply with Claude API limits
    const finalBuffer = await resizeIfNeeded(rawBuffer, quality);

    const buffer = Buffer.isBuffer(finalBuffer) ? finalBuffer : Buffer.from(finalBuffer);
    
    console.log(`[PLAYWRIGHT] Final screenshot: ${buffer.length} bytes`);

    return buffer;
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
  resizeIfNeeded,
  VIEWPORTS,
  MAX_IMAGE_DIMENSION
};
