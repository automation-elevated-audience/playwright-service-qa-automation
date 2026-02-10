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

  // Check if this is already a published URL (/pub at the end)
  // Published URLs have format: /document/d/e/LONG_ID/pub
  const isPublishedUrl = docLink.includes('/pub') && docLink.includes('/document/d/e/');
  
  // For regular share links, extract document ID FIRST (before launching browser)
  // Format: https://docs.google.com/document/d/{DOC_ID}/edit
  // Format: https://docs.google.com/document/d/{DOC_ID}/view
  // Format: https://docs.google.com/document/d/{DOC_ID}
  let docId = null;
  if (!isPublishedUrl) {
    const docIdMatch = docLink.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    if (docIdMatch) {
      docId = docIdMatch[1];
    }
    
    if (!docId) {
      console.log(`[CONTENT] Could not extract document ID from: ${docLink}`);
      return '';
    }
    
    console.log(`[CONTENT] Extracted document ID: ${docId}`);
    
    // ========================================================================
    // PRIMARY METHOD: Use HTTP fetch for export URL (faster, no browser needed)
    // This works for docs shared as "Anyone with the link can view"
    // ========================================================================
    const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
    console.log(`[CONTENT] Trying HTTP fetch for: ${exportUrl}`);
    
    try {
      const response = await fetch(exportUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      
      if (response.ok) {
        const textContent = await response.text();
        if (textContent && textContent.trim().length > 10) {
          console.log(`[CONTENT] Successfully fetched via HTTP fetch (${textContent.length} chars)`);
          return textContent.trim();
        }
      } else {
        console.log(`[CONTENT] HTTP fetch failed with status: ${response.status}`);
      }
    } catch (fetchError) {
      console.log(`[CONTENT] HTTP fetch failed: ${fetchError.message}`);
    }
    
    console.log(`[CONTENT] HTTP fetch failed, falling back to Playwright methods...`);
  }
  
  // ========================================================================
  // FALLBACK: Use Playwright for published URLs or when HTTP fetch fails
  // ========================================================================
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

    // If it's already a published URL, use it directly (PRIORITY)
    if (isPublishedUrl) {
      console.log(`[CONTENT] Detected published URL, using directly: ${docLink}`);
      try {
        await page.goto(docLink, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });

        await page.waitForTimeout(2000);

        const publishedContent = await page.evaluate(() => {
          // Remove style and script elements
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll('script, style, noscript, header, footer, nav, [role="navigation"]').forEach(el => el.remove());
          return clone.textContent || '';
        });

        if (publishedContent && publishedContent.trim().length > 50) {
          console.log(`[CONTENT] Successfully fetched from published URL (${publishedContent.length} chars)`);
          await browser.close();
          return publishedContent.trim();
        }
      } catch (pubError) {
        console.log(`[CONTENT] Published URL fetch failed: ${pubError.message}`);
      }
      
      await browser.close();
      return '';
    }

    // Playwright fallback for regular share links (when HTTP fetch failed)
    // Try the published web view first
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
 * Calculate similarity between two strings with detailed word breakdown
 * @param {string} str1 - Expected content
 * @param {string} str2 - Actual content
 * @returns {Object} Detailed similarity breakdown
 */
function calculateSimilarity(str1, str2) {
  const s1 = normalizeText(str1);
  const s2 = normalizeText(str2);
  
  const emptyResult = { matchPercentage: 0, matchedWords: [], unmatchedWords: [], extraWords: [], matchedWordCount: 0 };
  
  if (!s1 || !s2) return emptyResult;
  if (s1 === s2) {
    const allWords = [...new Set(s1.split(' ').filter(w => w.length > 2))];
    return { matchPercentage: 100, matchedWords: allWords, unmatchedWords: [], extraWords: [], matchedWordCount: allWords.length };
  }
  
  // Word-based comparison using sets for accurate unique-word matching
  const words1 = s1.split(' ').filter(w => w.length > 2); // expected
  const words2 = s2.split(' ').filter(w => w.length > 2); // actual
  
  const expectedSet = new Set(words1);
  const actualSet = new Set(words2);
  
  if (expectedSet.size === 0 || actualSet.size === 0) return emptyResult;
  
  const matchedWords = [...expectedSet].filter(w => actualSet.has(w));
  const unmatchedWords = [...expectedSet].filter(w => !actualSet.has(w));
  const extraWords = [...actualSet].filter(w => !expectedSet.has(w));
  
  // Percentage = how many expected words were found (capped at 100)
  const matchPercentage = Math.min(Math.round((matchedWords.length / expectedSet.size) * 100), 100);
  
  return {
    matchPercentage,
    matchedWords,
    unmatchedWords,
    extraWords,
    matchedWordCount: matchedWords.length
  };
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
 * Find which expected phrases ARE present in actual content
 * @param {string} expectedContent 
 * @param {string} actualContent 
 * @returns {string[]} Array of matched phrases
 */
function findMatchedPhrases(expectedContent, actualContent) {
  const expectedPhrases = extractKeyPhrases(expectedContent);
  const normalizedActual = normalizeText(actualContent);
  
  const matched = [];
  
  for (const phrase of expectedPhrases) {
    const normalizedPhrase = normalizeText(phrase);
    
    // Check if phrase exists in actual content (with some fuzzy matching)
    const words = normalizedPhrase.split(' ').filter(w => w.length > 3);
    const matchingWords = words.filter(w => normalizedActual.includes(w));
    
    // If 60% or more of words match, consider phrase matched
    if (words.length > 0 && (matchingWords.length / words.length) >= 0.6) {
      matched.push(phrase);
    }
  }
  
  return matched.slice(0, 15); // Limit to 15 matched phrases
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
    const similarity = calculateSimilarity(expectedContentFinal, actualContent);
    const missingPhrases = findMissingPhrases(expectedContentFinal, actualContent);
    const matchedPhrases = findMatchedPhrases(expectedContentFinal, actualContent);
    const wordCountExpected = expectedContentFinal.split(/\s+/).filter(w => w.length > 0).length;
    const wordCountActual = actualContent.split(/\s+/).filter(w => w.length > 0).length;
    
    // Determine status based on match percentage
    let status = 'PASS';
    let issue = null;
    
    if (similarity.matchPercentage < 50) {
      status = 'FAIL';
      issue = `Content match is only ${similarity.matchPercentage}% - significant content differences detected`;
    } else if (similarity.matchPercentage < 75) {
      status = 'WARNING';
      issue = `Content match is ${similarity.matchPercentage}% - some expected content may be missing`;
    }
    
    if (missingPhrases.length > 5) {
      status = 'FAIL';
      issue = `${missingPhrases.length} key phrases from expected content not found on page`;
    } else if (missingPhrases.length > 0 && status !== 'FAIL') {
      status = 'WARNING';
      issue = `${missingPhrases.length} key phrase(s) may be missing from page`;
    }
    
    // Build human-readable summary
    const expectedUniqueCount = new Set(normalizeText(expectedContentFinal).split(' ').filter(w => w.length > 2)).size;
    const summary = `${similarity.matchedWordCount} of ${expectedUniqueCount} expected unique words found on page`;
    
    console.log(`[CONTENT] Results for ${pageUrl}:`, {
      status,
      matchPercentage: similarity.matchPercentage,
      matchedWordCount: similarity.matchedWordCount,
      unmatchedWordCount: similarity.unmatchedWords.length,
      extraWordCount: similarity.extraWords.length,
      matchedPhrasesCount: matchedPhrases.length,
      missingPhrasesCount: missingPhrases.length
    });
    
    return {
      status,
      issue,
      matchPercentage: similarity.matchPercentage,
      matchedWordCount: similarity.matchedWordCount,
      matchedWords: similarity.matchedWords.slice(0, 50),
      unmatchedWords: similarity.unmatchedWords.slice(0, 30),
      extraWords: similarity.extraWords.slice(0, 30),
      matchedPhrases,
      missingPhrases,
      wordCountExpected,
      wordCountActual,
      contentChecked: true,
      summary,
      expectedContentPreview: expectedContentFinal.substring(0, 300),
      actualContentPreview: actualContent.substring(0, 300)
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
  findMatchedPhrases,
  extractKeyPhrases
};
