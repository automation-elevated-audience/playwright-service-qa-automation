const { chromium } = require('playwright');

/**
 * Fetch content from a Google Doc link
 * Supports various Google Docs URL formats and extracts the text content
 * @param {string} docLink - Google Docs URL
 * @returns {Promise<string>} The text content of the document
 */
async function fetchGoogleDocContent(docLink) {
  if (!docLink || typeof docLink !== 'string') {
    return '';
  }

  console.log(`[CONTENT] Fetching Google Doc content from: ${docLink}`);

  // Extract document ID from various Google Docs URL formats
  let docId = null;
  
  // Format: https://docs.google.com/document/d/{DOC_ID}/edit
  // Format: https://docs.google.com/document/d/{DOC_ID}/view
  // Format: https://docs.google.com/document/d/{DOC_ID}
  const docIdMatch = docLink.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (docIdMatch) {
    docId = docIdMatch[1];
  }

  if (!docId) {
    console.log(`[CONTENT] Could not extract document ID from: ${docLink}`);
    return '';
  }

  console.log(`[CONTENT] Extracted document ID: ${docId}`);

  // Use the export URL to get plain text (works for publicly shared docs)
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // Try the export URL first (plain text)
    try {
      const response = await page.goto(exportUrl, {
        waitUntil: 'networkidle',
        timeout: 30000
      });

      if (response && response.ok()) {
        const content = await page.content();
        // For text export, the content is in a <pre> tag or raw
        const textContent = await page.evaluate(() => {
          const pre = document.querySelector('pre');
          if (pre) return pre.textContent;
          return document.body.textContent || document.body.innerText || '';
        });

        if (textContent && textContent.trim().length > 10) {
          console.log(`[CONTENT] Successfully fetched doc content (${textContent.length} chars)`);
          await browser.close();
          return textContent.trim();
        }
      }
    } catch (exportError) {
      console.log(`[CONTENT] Export URL failed, trying published view: ${exportError.message}`);
    }

    // Fallback: Try the published web view
    const publishedUrl = `https://docs.google.com/document/d/${docId}/pub`;
    try {
      await page.goto(publishedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      await page.waitForTimeout(2000);

      const publishedContent = await page.evaluate(() => {
        // Remove style and script elements
        const clone = document.body.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, header, footer, nav').forEach(el => el.remove());
        return clone.textContent || '';
      });

      if (publishedContent && publishedContent.trim().length > 10) {
        console.log(`[CONTENT] Successfully fetched from published view (${publishedContent.length} chars)`);
        await browser.close();
        return publishedContent.trim();
      }
    } catch (pubError) {
      console.log(`[CONTENT] Published view failed: ${pubError.message}`);
    }

    // Final fallback: Try the regular edit/view URL (for publicly viewable docs)
    try {
      await page.goto(docLink, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      await page.waitForTimeout(3000);

      const viewContent = await page.evaluate(() => {
        // Google Docs renders content in specific elements
        const contentSelectors = [
          '.kix-page-content-wrapper',
          '.kix-paragraphrenderer',
          '[data-page-content="true"]',
          '.doc-content',
          '#contents'
        ];

        let content = '';
        for (const selector of contentSelectors) {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            content = Array.from(elements).map(el => el.textContent).join('\n');
            break;
          }
        }

        // Fallback to body
        if (!content) {
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll('script, style, noscript, header, nav, [role="navigation"]').forEach(el => el.remove());
          content = clone.textContent || '';
        }

        return content;
      });

      if (viewContent && viewContent.trim().length > 10) {
        console.log(`[CONTENT] Successfully fetched from view URL (${viewContent.length} chars)`);
        await browser.close();
        return viewContent.trim();
      }
    } catch (viewError) {
      console.log(`[CONTENT] View URL failed: ${viewError.message}`);
    }

    await browser.close();
    console.log(`[CONTENT] Could not fetch content from Google Doc`);
    return '';

  } catch (error) {
    console.error(`[CONTENT] Error fetching Google Doc:`, error.message);
    if (browser) await browser.close();
    return '';
  }
}

/**
 * Normalize text for comparison
 * - Converts to lowercase
 * - Removes extra whitespace
 * - Removes common HTML entities
 * - Removes punctuation differences
 */
function normalizeText(text) {
  if (!text) return '';
  
  return text
    .toLowerCase()
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .trim();
}

/**
 * Extract key phrases from text (sentences or bullet points)
 * @param {string} text - Text to extract phrases from
 * @returns {string[]} Array of key phrases
 */
function extractKeyPhrases(text) {
  if (!text) return [];
  
  // Split by common delimiters: periods, newlines, bullet points
  const phrases = text
    .split(/[.\n•\-\*]+/)
    .map(p => p.trim())
    .filter(p => p.length > 10); // Only keep meaningful phrases
  
  return phrases;
}

/**
 * Calculate similarity between two strings using Levenshtein-based approach
 * @param {string} str1 
 * @param {string} str2 
 * @returns {number} Similarity score 0-100
 */
function calculateSimilarity(str1, str2) {
  const s1 = normalizeText(str1);
  const s2 = normalizeText(str2);
  
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 100;
  
  // Word-based comparison for better accuracy on long text
  const words1 = s1.split(' ').filter(w => w.length > 2);
  const words2 = s2.split(' ').filter(w => w.length > 2);
  
  if (words1.length === 0 || words2.length === 0) return 0;
  
  // Count matching words
  const matchingWords = words1.filter(w => words2.includes(w));
  const totalUniqueWords = new Set([...words1, ...words2]).size;
  
  return Math.round((matchingWords.length / totalUniqueWords) * 100);
}

/**
 * Find which expected phrases are missing from actual content
 * @param {string} expectedContent 
 * @param {string} actualContent 
 * @returns {string[]} Array of missing phrases
 */
function findMissingPhrases(expectedContent, actualContent) {
  const expectedPhrases = extractKeyPhrases(expectedContent);
  const normalizedActual = normalizeText(actualContent);
  
  const missing = [];
  
  for (const phrase of expectedPhrases) {
    const normalizedPhrase = normalizeText(phrase);
    
    // Check if phrase exists in actual content (with some fuzzy matching)
    const words = normalizedPhrase.split(' ').filter(w => w.length > 3);
    const matchingWords = words.filter(w => normalizedActual.includes(w));
    
    // If less than 60% of words match, consider phrase missing
    if (words.length > 0 && (matchingWords.length / words.length) < 0.6) {
      missing.push(phrase);
    }
  }
  
  return missing.slice(0, 10); // Limit to 10 missing phrases
}

/**
 * Check page content against expected content
 * @param {string} pageUrl - URL to check
 * @param {string} expectedContent - Expected content from doc (direct text)
 * @param {string} contentDocLink - Optional Google Docs link to fetch expected content from
 * @returns {Object} Content check results
 */
async function checkPageContent(pageUrl, expectedContent, contentDocLink = null) {
  let contentToCompare = expectedContent || '';

  // If no direct content but we have a doc link, fetch from Google Docs
  if ((!contentToCompare || contentToCompare.trim().length === 0) && contentDocLink) {
    console.log(`[CONTENT] No direct content provided, fetching from Google Doc: ${contentDocLink}`);
    contentToCompare = await fetchGoogleDocContent(contentDocLink);
    
    if (contentToCompare && contentToCompare.trim().length > 0) {
      console.log(`[CONTENT] Successfully fetched ${contentToCompare.length} characters from Google Doc`);
    } else {
      console.log(`[CONTENT] Could not fetch content from Google Doc link`);
    }
  }

  // If still no expected content, return skip status
  if (!contentToCompare || contentToCompare.trim().length === 0) {
    return {
      status: 'SKIPPED',
      reason: contentDocLink 
        ? 'Could not fetch content from Google Doc link (may require public sharing)'
        : 'No expected content provided',
      matchPercentage: null,
      missingPhrases: [],
      wordCountExpected: 0,
      wordCountActual: 0,
      contentChecked: false,
      contentDocLink: contentDocLink || null
    };
  }

  // Use the fetched/provided content
  const expectedContentFinal = contentToCompare;

  let browser;
  
  try {
    console.log(`[CONTENT] Checking content for: ${pageUrl}`);
    
    browser = await chromium.launch({
      headless: true,
      args: [
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
      ]
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    
    const page = await context.newPage();
    
    const navTimeout = parseInt(process.env.REQUEST_TIMEOUT, 10) || 180000;
    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: navTimeout
    });
    
    // Wait for content to load
    await page.waitForTimeout(2000);
    
    // Extract main content (excluding navigation, footer, etc.)
    const actualContent = await page.evaluate(() => {
      // Try to find main content area
      const mainSelectors = [
        'main',
        'article',
        '[role="main"]',
        '.content',
        '.main-content',
        '#content',
        '#main'
      ];
      
      let contentElement = null;
      for (const selector of mainSelectors) {
        contentElement = document.querySelector(selector);
        if (contentElement) break;
      }
      
      // Fallback to body if no main content found
      if (!contentElement) {
        contentElement = document.body;
      }
      
      // Clone and remove unwanted elements
      const clone = contentElement.cloneNode(true);
      const removeSelectors = [
        'nav', 'header', 'footer', 'aside',
        '.navigation', '.nav', '.menu',
        '.sidebar', '.footer', '.header',
        'script', 'style', 'noscript'
      ];
      
      removeSelectors.forEach(sel => {
        clone.querySelectorAll(sel).forEach(el => el.remove());
      });
      
      return clone.textContent || '';
    });
    
    await browser.close();
    
    // Calculate metrics
    const matchPercentage = calculateSimilarity(expectedContentFinal, actualContent);
    const missingPhrases = findMissingPhrases(expectedContentFinal, actualContent);
    const wordCountExpected = expectedContentFinal.split(/\s+/).filter(w => w.length > 0).length;
    const wordCountActual = actualContent.split(/\s+/).filter(w => w.length > 0).length;
    
    // Determine status based on match percentage
    let status = 'PASS';
    let issue = null;
    
    if (matchPercentage < 50) {
      status = 'FAIL';
      issue = `Content match is only ${matchPercentage}% - significant content differences detected`;
    } else if (matchPercentage < 75) {
      status = 'WARNING';
      issue = `Content match is ${matchPercentage}% - some expected content may be missing`;
    }
    
    if (missingPhrases.length > 5) {
      status = 'FAIL';
      issue = `${missingPhrases.length} key phrases from expected content not found on page`;
    } else if (missingPhrases.length > 0 && status !== 'FAIL') {
      status = 'WARNING';
      issue = `${missingPhrases.length} key phrase(s) may be missing from page`;
    }
    
    console.log(`[CONTENT] Results for ${pageUrl}:`, {
      status,
      matchPercentage,
      missingPhrasesCount: missingPhrases.length
    });
    
    return {
      status,
      issue,
      matchPercentage,
      missingPhrases,
      wordCountExpected,
      wordCountActual,
      contentChecked: true
    };
    
  } catch (error) {
    console.error(`[CONTENT] Error checking content for ${pageUrl}:`, error.message);
    
    if (browser) {
      await browser.close();
    }
    
    return {
      status: 'ERROR',
      issue: `Failed to check content: ${error.message}`,
      matchPercentage: null,
      missingPhrases: [],
      wordCountExpected: 0,
      wordCountActual: 0,
      contentChecked: false
    };
  }
}

module.exports = {
  checkPageContent,
  fetchGoogleDocContent,
  normalizeText,
  calculateSimilarity,
  findMissingPhrases,
  extractKeyPhrases
};
