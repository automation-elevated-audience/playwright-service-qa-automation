const { chromium } = require('playwright');
const axios = require('axios');

/**
 * Check all links on a given page
 * @param {string} pageUrl - The URL to check
 * @returns {Object} Link check results
 */
async function checkPageLinks(pageUrl) {
  let browser;
  
  try {
    console.log(`[PLAYWRIGHT] Checking links for: ${pageUrl}`);
    
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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    
    const page = await context.newPage();
    
    // Navigate to page with timeout (configurable via REQUEST_TIMEOUT env)
    // Use 'domcontentloaded' instead of 'networkidle' - faster and more reliable
    // networkidle can timeout on sites with analytics/ads that never stop making requests
    const navTimeout = parseInt(process.env.REQUEST_TIMEOUT, 10) || 180000;
    await page.goto(pageUrl, { 
      waitUntil: 'domcontentloaded',
      timeout: navTimeout 
    });
    
    // Wait a bit for dynamic content
    await page.waitForTimeout(2000);
    
    // Get all links on the page
    const links = await page.$$eval('a[href]', (anchors) => 
      anchors.map(a => ({
        href: a.href,
        text: a.textContent?.trim() || '',
        target: a.target || '',
        rel: a.rel || ''
      }))
    );
    
    console.log(`[PLAYWRIGHT] Found ${links.length} links on ${pageUrl}`);
    
    // Parse the base URL
    const baseUrl = new URL(pageUrl);
    
    // Check each link
    const brokenLinks = [];
    const linksWithoutNoopener = [];
    let externalLinks = 0;
    let internalLinks = 0;
    let missingNoopener = 0;
    
    for (const link of links) {
      try {
        const linkUrl = new URL(link.href);
        
        // Determine if external
        const isExternal = linkUrl.origin !== baseUrl.origin;
        
        if (isExternal) {
          externalLinks++;
          
          // Check security attributes for external links
          const hasNoopener = link.rel.includes('noopener');
          const hasNoreferrer = link.rel.includes('noreferrer');
          
          if (!hasNoopener || !hasNoreferrer) {
            missingNoopener++;
            linksWithoutNoopener.push(link.href);
          }
          
          // Check if link is broken (with timeout)
          try {
            const response = await axios.head(link.href, { 
              timeout: 5000,
              maxRedirects: 5,
              validateStatus: (status) => status < 500 // Accept redirects
            });
            
            if (response.status >= 400) {
              brokenLinks.push(link.href);
            }
          } catch (error) {
            // If HEAD fails, try GET
            try {
              await axios.get(link.href, { 
                timeout: 5000,
                maxRedirects: 5,
                validateStatus: (status) => status < 500
              });
            } catch (err) {
              brokenLinks.push(link.href);
            }
          }
        } else {
          internalLinks++;
        }
      } catch (error) {
        // Invalid URL, skip
        console.log(`[PLAYWRIGHT] Invalid URL: ${link.href}`);
      }
    }
    
    await browser.close();
    
    const overall = brokenLinks.length > 0 || missingNoopener > 0 ? 'FAIL' : 'PASS';
    
    let issue = null;
    if (missingNoopener > 0) {
      issue = `${missingNoopener} external link${missingNoopener !== 1 ? 's are' : ' is'} missing noopener/noreferrer attributes, creating security vulnerability`;
    }
    
    console.log(`[PLAYWRIGHT] Results for ${pageUrl}:`, {
      overall,
      externalLinks,
      brokenCount: brokenLinks.length,
      missingNoopener
    });
    
    return {
      overall,
      externalLinks,
      internalLinks,
      totalLinks: links.length,
      brokenLinks: brokenLinks.slice(0, 10), // Limit to 10 URLs
      brokenCount: brokenLinks.length,
      missingNoopener,
      linksWithoutNoopener: linksWithoutNoopener.slice(0, 10), // Limit to 10 URLs
      securityIssue: missingNoopener > 0,
      issue,
      missingNewTab: 0 // Can be implemented later
    };
  } catch (error) {
    console.error(`[PLAYWRIGHT] Error checking ${pageUrl}:`, error.message);
    
    if (browser) {
      await browser.close();
    }
    
    return {
      overall: 'ERROR',
      externalLinks: 0,
      internalLinks: 0,
      totalLinks: 0,
      brokenLinks: [],
      brokenCount: 0,
      missingNoopener: 0,
      linksWithoutNoopener: [],
      securityIssue: false,
      issue: `Error checking page: ${error.message}`,
      missingNewTab: 0
    };
  }
}

/**
 * Check links for multiple pages in parallel
 * @param {Array} pages - Array of page objects with url and pageName
 * @param {number} concurrency - Number of pages to check concurrently
 * @returns {Array} Array of results
 */
async function checkMultiplePages(pages, concurrency = 3) {
  const results = [];
  
  // Process pages in batches
  for (let i = 0; i < pages.length; i += concurrency) {
    const batch = pages.slice(i, i + concurrency);
    
    console.log(`[PLAYWRIGHT] Processing batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(pages.length / concurrency)}`);
    
    const batchResults = await Promise.all(
      batch.map(async (page) => {
        const linkChecks = await checkPageLinks(page.url);
        return {
          url: page.url,
          pageName: page.pageName,
          linkChecks
        };
      })
    );
    
    results.push(...batchResults);
  }
  
  return results;
}

module.exports = {
  checkPageLinks,
  checkMultiplePages
};
