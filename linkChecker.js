const { chromium } = require('playwright');
const axios = require('axios');

/**
 * Check if a URL is an HTTP/HTTPS link that should be checked
 * Skips tel:, mailto:, javascript:, #anchors, data:, blob:, etc.
 * @param {string} href - The link href
 * @returns {boolean} True if link should be checked
 */
function isCheckableLink(href) {
  if (!href) return false;
  
  // Skip non-HTTP protocols
  const skipProtocols = [
    'tel:',
    'mailto:',
    'javascript:',
    'data:',
    'blob:',
    'file:',
    'ftp:',
    'sms:',
    'whatsapp:',
    'viber:',
    'skype:',
    'facetime:',
    'maps:',
    'geo:'
  ];
  
  const lowerHref = href.toLowerCase();
  
  // Skip if starts with any non-HTTP protocol
  for (const protocol of skipProtocols) {
    if (lowerHref.startsWith(protocol)) {
      return false;
    }
  }
  
  // Skip anchor-only links
  if (href.startsWith('#')) {
    return false;
  }
  
  // Only check http:// and https:// links
  return lowerHref.startsWith('http://') || lowerHref.startsWith('https://');
}

/**
 * Check if a URL is a social media site that should be skipped from broken link checks
 * These sites often block automated requests and return false positives
 * @param {string} href - The link href
 * @returns {boolean} True if link is a social media site to skip
 */
function isSocialMediaLink(href) {
  if (!href) return false;
  
  const socialMediaDomains = [
    'instagram.com',
    'www.instagram.com',
    'facebook.com',
    'www.facebook.com',
    'fb.com',
    'twitter.com',
    'www.twitter.com',
    'x.com',
    'www.x.com',
    'linkedin.com',
    'www.linkedin.com',
    'tiktok.com',
    'www.tiktok.com',
    'pinterest.com',
    'www.pinterest.com',
    'snapchat.com',
    'www.snapchat.com',
    'youtube.com',
    'www.youtube.com',
    'youtu.be',
    'reddit.com',
    'www.reddit.com',
    'tumblr.com',
    'www.tumblr.com',
    'discord.com',
    'discord.gg',
    'threads.net',
    'www.threads.net'
  ];
  
  try {
    const url = new URL(href);
    const hostname = url.hostname.toLowerCase();
    return socialMediaDomains.some(domain => hostname === domain || hostname.endsWith('.' + domain));
  } catch {
    return false;
  }
}

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
    const brokenInternalLinks = [];
    const linksWithoutNoopener = [];
    let externalLinks = 0;
    let internalLinks = 0;
    let missingNoopener = 0;
    
    // De-duplicate links to avoid checking the same URL multiple times
    const checkedUrls = new Set();
    
    for (const link of links) {
      try {
        // Skip non-HTTP links (tel:, mailto:, javascript:, etc.)
        if (!isCheckableLink(link.href)) {
          continue;
        }
        
        // Skip already-checked URLs (de-duplicate)
        if (checkedUrls.has(link.href)) {
          continue;
        }
        checkedUrls.add(link.href);
        
        const linkUrl = new URL(link.href);
        
        // Determine if external
        const isExternal = linkUrl.origin !== baseUrl.origin;
        
        if (isExternal) {
          externalLinks++;
          
          // Check security attributes for external links (only for http/https that open in browser)
          const hasNoopener = link.rel.includes('noopener');
          const hasNoreferrer = link.rel.includes('noreferrer');
          
          if (!hasNoopener || !hasNoreferrer) {
            missingNoopener++;
            linksWithoutNoopener.push(link.href);
          }
          
          // Skip social media sites from broken link check (they block bots and return false positives)
          if (isSocialMediaLink(link.href)) {
            console.log(`[PLAYWRIGHT] Skipping social media link: ${link.href}`);
            continue;
          }
          
          // Check if external link is broken (with timeout)
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
          
          // Check if internal link is broken (with timeout)
          console.log(`[PLAYWRIGHT] Checking internal link: ${link.href}`);
          try {
            const response = await axios.head(link.href, { 
              timeout: 10000,
              maxRedirects: 5,
              validateStatus: (status) => status < 500
            });
            
            if (response.status >= 400) {
              console.log(`[PLAYWRIGHT] Broken internal link (${response.status}): ${link.href}`);
              brokenInternalLinks.push(link.href);
            }
          } catch (error) {
            // If HEAD fails, try GET (some servers don't support HEAD)
            try {
              const response = await axios.get(link.href, { 
                timeout: 10000,
                maxRedirects: 5,
                validateStatus: (status) => status < 500
              });
              
              if (response.status >= 400) {
                console.log(`[PLAYWRIGHT] Broken internal link (${response.status}): ${link.href}`);
                brokenInternalLinks.push(link.href);
              }
            } catch (err) {
              console.log(`[PLAYWRIGHT] Broken internal link (unreachable): ${link.href}`);
              brokenInternalLinks.push(link.href);
            }
          }
        }
      } catch (error) {
        // Invalid URL, skip
        console.log(`[PLAYWRIGHT] Invalid URL: ${link.href}`);
      }
    }
    
    await browser.close();
    
    // Combine all broken links for overall status
    const allBrokenLinks = [...brokenLinks, ...brokenInternalLinks];
    const overall = allBrokenLinks.length > 0 || missingNoopener > 0 ? 'FAIL' : 'PASS';
    
    let issue = null;
    const issues = [];
    if (brokenInternalLinks.length > 0) {
      issues.push(`${brokenInternalLinks.length} broken internal link${brokenInternalLinks.length !== 1 ? 's' : ''} found`);
    }
    if (brokenLinks.length > 0) {
      issues.push(`${brokenLinks.length} broken external link${brokenLinks.length !== 1 ? 's' : ''} found`);
    }
    if (missingNoopener > 0) {
      issues.push(`${missingNoopener} external link${missingNoopener !== 1 ? 's are' : ' is'} missing noopener/noreferrer attributes, creating security vulnerability`);
    }
    if (issues.length > 0) {
      issue = issues.join('; ');
    }
    
    console.log(`[PLAYWRIGHT] Results for ${pageUrl}:`, {
      overall,
      externalLinks,
      internalLinks,
      brokenExternalCount: brokenLinks.length,
      brokenInternalCount: brokenInternalLinks.length,
      missingNoopener
    });
    
    return {
      overall,
      externalLinks,
      internalLinks,
      totalLinks: links.length,
      brokenLinks: allBrokenLinks.slice(0, 10), // Limit to 10 URLs
      brokenCount: allBrokenLinks.length,
      brokenExternalLinks: brokenLinks.slice(0, 10),
      brokenExternalCount: brokenLinks.length,
      brokenInternalLinks: brokenInternalLinks.slice(0, 10),
      brokenInternalCount: brokenInternalLinks.length,
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
      brokenExternalLinks: [],
      brokenExternalCount: 0,
      brokenInternalLinks: [],
      brokenInternalCount: 0,
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
async function checkMultiplePages(pages, concurrency = 1) {
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
