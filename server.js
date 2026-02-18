const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { checkMultiplePages } = require('./linkChecker');
const { fetchPage } = require('./pageFetcher');
const { captureScreenshot } = require('./screenshotHandler');
const { checkPageContent } = require('./contentChecker');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';

// Supabase client for checking if n8n is actively processing any project
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

if (supabase) {
  console.log('[INIT] Supabase client initialized — n8n busy-check enabled');
} else {
  console.warn('[INIT] Supabase not configured — n8n busy-check disabled (set SUPABASE_URL and SUPABASE_ANON_KEY)');
}

/**
 * Check if n8n is currently processing any project by querying the database
 * for pages with 'in_progress' or 'processing' status.
 * Returns { busy: true, projectName, count } or { busy: false }.
 */
async function isN8nBusy() {
  if (!supabase) return { busy: false };
  try {
    const { data, error } = await supabase
      .from('pages')
      .select('id, project_id, projects(name)')
      .in('status', ['in_progress', 'processing'])
      .limit(1);
    if (error) {
      console.warn('[isN8nBusy] Supabase query error:', error.message);
      return { busy: false }; // Fail open — don't block if DB query fails
    }
    if (!data || data.length === 0) return { busy: false };
    const projectName = data[0]?.projects?.name || 'Unknown';
    return { busy: true, projectName };
  } catch (err) {
    console.warn('[isN8nBusy] Exception:', err.message);
    return { busy: false }; // Fail open
  }
}

// Track active background jobs to prevent duplicate processing and report progress
// Key: job identifier (e.g. "start-qa:ProjectName" or "rerun:uuid")
// Value: { type, stage, startedAt, totalPages, checkedPages, projectName|projectId }
const activeJobs = new Map();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'playwright-link-checker',
    timestamp: new Date().toISOString()
  });
});

// Main endpoint: Check links for multiple pages
app.post('/check-links', async (req, res) => {
  try {
    const { pages } = req.body;
    
    // Validate input
    if (!pages || !Array.isArray(pages) || pages.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Please provide an array of pages with url and pageName'
      });
    }
    
    console.log(`[SERVER] Received request to check ${pages.length} pages`);
    
    // Validate each page has required fields
    const validPages = pages.filter(page => page.url);
    
    if (validPages.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'No valid pages found. Each page must have a "url" field'
      });
    }
    
    if (validPages.length !== pages.length) {
      console.log(`[SERVER] Warning: ${pages.length - validPages.length} invalid pages filtered out`);
    }
    
    // Get concurrency from request body settings, query params, or env default
    const concurrency = parseInt(req.body.concurrency) || parseInt(req.query.concurrency) || parseInt(process.env.MAX_CONCURRENCY) || 5;
    console.log(`[SERVER] Using concurrency: ${concurrency}`);
    
    // Check links for all pages
    const startTime = Date.now();
    const results = await checkMultiplePages(validPages, concurrency);
    const duration = Date.now() - startTime;
    
    console.log(`[SERVER] Completed checking ${results.length} pages in ${duration}ms`);
    
    // Send response
    res.json({
      success: true,
      results,
      metadata: {
        totalPages: results.length,
        duration: `${duration}ms`,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('[SERVER] Error processing request:', error);
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Fetch page HTML (JS-rendered) for metadata parsing
app.post('/fetch-page', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Please provide a "url" in the request body'
      });
    }

    const result = await fetchPage(url);
    res.json(result);
  } catch (error) {
    console.error('[SERVER] Error fetching page:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Capture screenshot (returns raw image bytes)
app.post('/screenshot', async (req, res) => {
  try {
    const { url, viewport = 'desktop', fullPage = true, quality = 70 } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Please provide a "url" in the request body'
      });
    }

    const validViewports = ['desktop', 'tablet', 'mobile'];
    const viewportType = validViewports.includes(viewport) ? viewport : 'desktop';

    const buffer = await captureScreenshot(url, viewportType, fullPage, quality);
    res.set('Content-Type', 'image/jpeg');
    res.send(buffer);
  } catch (error) {
    console.error('[SERVER] Error capturing screenshot:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Check page content against expected content
// Accepts either direct expectedContent text OR a contentDocLink (Google Docs URL)
app.post('/check-content', async (req, res) => {
  try {
    const { url, expectedContent, contentDocLink } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Please provide a "url" in the request body'
      });
    }

    console.log(`[SERVER] Checking content for: ${url}`);
    if (contentDocLink) {
      console.log(`[SERVER] Using Google Doc link: ${contentDocLink}`);
    }
    
    const result = await checkPageContent(url, expectedContent || '', contentDocLink || null);
    
    res.json({
      success: true,
      url,
      contentCheck: result
    });
  } catch (error) {
    console.error('[SERVER] Error checking content:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// ============================================================
// Server-side start-qa orchestrator
// Responds immediately, then runs link checks + forwards to n8n in the background
// This ensures the process survives browser refresh/navigation/close
// ============================================================
app.post('/start-qa', async (req, res) => {
  const { project_data, pages, settings, n8n_webhook_url } = req.body;

  if (!project_data || !project_data.project_name) {
    return res.status(400).json({
      error: 'Invalid request',
      message: 'project_data with project_name is required'
    });
  }

  const webhookUrl = n8n_webhook_url || N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(400).json({
      error: 'Configuration error',
      message: 'n8n webhook URL is not configured. Set N8N_WEBHOOK_URL in .env or pass n8n_webhook_url in the request body.'
    });
  }

  // Guard 0: Check for duplicate staging URL in the database
  if (supabase && project_data.staging_url) {
    try {
      const { data: existing } = await supabase
        .from('projects')
        .select('id, name')
        .eq('staging_url', project_data.staging_url)
        .limit(1);
      if (existing && existing.length > 0) {
        console.log(`[START-QA] Rejected - duplicate staging URL "${project_data.staging_url}" (project: "${existing[0].name}")`);
        return res.status(409).json({
          error: 'duplicate_project',
          message: `A project with this staging URL already exists ("${existing[0].name}").`,
        });
      }
    } catch (err) {
      console.warn('[START-QA] Duplicate check failed, continuing:', err.message);
    }
  }

  // Guard 1: Check if n8n is still processing any project in the database
  const n8nStatus = await isN8nBusy();
  if (n8nStatus.busy) {
    console.log(`[START-QA] Rejected - n8n is busy processing "${n8nStatus.projectName}"`);
    return res.status(409).json({
      error: 'server_busy',
      message: `Another project is being processed by the QA workflow ("${n8nStatus.projectName}"). Please wait for it to finish.`,
      active_job: { type: 'n8n_processing', stage: 'n8n_workflow', elapsed_seconds: null },
    });
  }

  // Guard 2: Only one job at a time across ALL projects (in-memory lock for Playwright phase)
  const jobKey = `start-qa:${project_data.project_name}`;
  if (activeJobs.size > 0) {
    const [existingKey, existingJob] = [...activeJobs.entries()][0];
    const elapsed = Math.round((Date.now() - existingJob.startedAt) / 1000);
    const jobLabel = existingJob.projectName || existingJob.projectId || existingKey;
    console.log(`[START-QA] Rejected - server busy with "${jobLabel}" (running for ${elapsed}s)`);
    return res.status(409).json({
      error: 'server_busy',
      message: `Another job is currently running ("${jobLabel}"). Please wait for it to finish.`,
      active_job: { type: existingJob.type, stage: existingJob.stage, elapsed_seconds: elapsed },
    });
  }

  // Register this job as active with granular progress tracking
  activeJobs.set(jobKey, {
    type: 'start-qa',
    startedAt: Date.now(),
    stage: 'checking_links',
    totalPages: (pages || []).length,
    checkedPages: 0,
    projectName: project_data.project_name,
  });

  // Respond immediately so the browser can navigate away safely
  res.json({ status: 'processing', project_name: project_data.project_name });

  // Background processing - runs after response is sent
  (async () => {
    try {
      console.log(`[START-QA] Starting server-side QA for "${project_data.project_name}" with ${(pages || []).length} pages`);

      // Step 1: Run Playwright link checks on the provided pages
      let pagesWithLinkChecks = pages || [];
      if (pages && pages.length > 0) {
        try {
          const playwrightPages = pages.map(p => ({
            url: p.page_url || p.pageUrl,
            pageName: p.page_name || p.pageName || 'Page'
          })).filter(p => p.url);

          if (playwrightPages.length > 0) {
            const concurrency = parseInt(settings?.concurrency) || parseInt(process.env.MAX_CONCURRENCY) || 5;
            console.log(`[START-QA] Using concurrency: ${concurrency}`);
            const startTime = Date.now();

            // Progress callback: update activeJobs as each page batch completes
            const onPageComplete = (checked, total) => {
              const job = activeJobs.get(jobKey);
              if (job) {
                job.checkedPages = checked;
                job.totalPages = total;
              }
            };

            const linkResults = await checkMultiplePages(playwrightPages, concurrency, onPageComplete);
            const duration = Date.now() - startTime;
            console.log(`[START-QA] Link checks completed for ${linkResults.length} pages in ${duration}ms (concurrency=${concurrency})`);

            // Enrich pages with link check results
            pagesWithLinkChecks = pages.map(p => {
              const pageUrl = (p.page_url || p.pageUrl || '').replace(/\/+$/, '');
              const lr = linkResults.find(l => (l.url || '').replace(/\/+$/, '') === pageUrl);
              return {
                ...p,
                link_checks: lr?.linkChecks || null
              };
            });
          }
        } catch (linkError) {
          console.warn(`[START-QA] Link check failed, continuing without:`, linkError.message);
        }
      }

      // Step 2: Forward the start request to n8n with enriched pages
      const job = activeJobs.get(jobKey);
      if (job) job.stage = 'forwarding_to_n8n';

      const payload = {
        ...project_data,
        ...(settings || {}),
        pages: pagesWithLinkChecks
      };

      console.log(`[START-QA] Forwarding to n8n: ${webhookUrl}/qa/start with ${pagesWithLinkChecks.length} pages`);

      const n8nResponse = await axios.post(`${webhookUrl}/qa/start`, payload, {
        timeout: 60000,
        headers: { 'Content-Type': 'application/json' }
      });

      console.log(`[START-QA] n8n responded for "${project_data.project_name}":`, n8nResponse.status);

      // Mark as completed briefly before cleanup
      const jobFinal = activeJobs.get(jobKey);
      if (jobFinal) jobFinal.stage = 'completed';
    } catch (error) {
      console.error(`[START-QA] Background processing failed for "${project_data.project_name}":`, error.message);
    } finally {
      activeJobs.delete(jobKey);
      console.log(`[START-QA] Job removed from activeJobs: "${project_data.project_name}"`);
    }
  })();
});

// ============================================================
// Server-side rerun orchestrator
// Responds immediately, then runs link checks + forwards to n8n in the background
// This ensures the process survives browser refresh/navigation/close
// ============================================================
app.post('/rerun', async (req, res) => {
  const { project_id, pages, settings, n8n_webhook_url } = req.body;

  if (!project_id) {
    return res.status(400).json({
      error: 'Invalid request',
      message: 'project_id is required'
    });
  }

  const webhookUrl = n8n_webhook_url || N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(400).json({
      error: 'Configuration error',
      message: 'n8n webhook URL is not configured. Set N8N_WEBHOOK_URL in .env or pass n8n_webhook_url in the request body.'
    });
  }

  // Guard 1: Check if n8n is still processing any project in the database
  const n8nStatus = await isN8nBusy();
  if (n8nStatus.busy) {
    console.log(`[RERUN] Rejected - n8n is busy processing "${n8nStatus.projectName}"`);
    return res.status(409).json({
      error: 'server_busy',
      message: `Another project is being processed by the QA workflow ("${n8nStatus.projectName}"). Please wait for it to finish.`,
      active_job: { type: 'n8n_processing', stage: 'n8n_workflow', elapsed_seconds: null },
    });
  }

  // Guard 2: Only one job at a time across ALL projects (in-memory lock for Playwright phase)
  const jobKey = `rerun:${project_id}`;
  if (activeJobs.size > 0) {
    const [existingKey, existingJob] = [...activeJobs.entries()][0];
    const elapsed = Math.round((Date.now() - existingJob.startedAt) / 1000);
    const jobLabel = existingJob.projectName || existingJob.projectId || existingKey;
    console.log(`[RERUN] Rejected - server busy with "${jobLabel}" (running for ${elapsed}s)`);
    return res.status(409).json({
      error: 'server_busy',
      message: `Another job is currently running ("${jobLabel}"). Please wait for it to finish.`,
      active_job: { type: existingJob.type, stage: existingJob.stage, elapsed_seconds: elapsed },
    });
  }

  // Register this job as active with granular progress tracking
  activeJobs.set(jobKey, {
    type: 'rerun',
    startedAt: Date.now(),
    stage: 'checking_links',
    totalPages: (pages || []).length,
    checkedPages: 0,
    projectId: project_id,
  });

  // Respond immediately so the browser can navigate away safely
  res.json({ status: 'processing', project_id });

  // Background processing - runs after response is sent
  (async () => {
    try {
      console.log(`[RERUN] Starting server-side rerun for project ${project_id} with ${(pages || []).length} pages`);

      // Step 1: Run Playwright link checks on the provided pages
      let pagesWithLinkChecks = [];
      if (pages && pages.length > 0) {
        try {
          const playwrightPages = pages.map(p => ({
            url: p.page_url || p.pageUrl,
            pageName: p.page_name || p.pageName || 'Page'
          })).filter(p => p.url);

          if (playwrightPages.length > 0) {
            const concurrency = parseInt(settings?.concurrency) || parseInt(process.env.MAX_CONCURRENCY) || 5;
            console.log(`[RERUN] Using concurrency: ${concurrency}`);
            const startTime = Date.now();

            // Progress callback: update activeJobs as each page batch completes
            const onPageComplete = (checked, total) => {
              const job = activeJobs.get(jobKey);
              if (job) {
                job.checkedPages = checked;
                job.totalPages = total;
              }
            };

            const linkResults = await checkMultiplePages(playwrightPages, concurrency, onPageComplete);
            const duration = Date.now() - startTime;
            console.log(`[RERUN] Link checks completed for ${linkResults.length} pages in ${duration}ms (concurrency=${concurrency})`);

            // Map link check results back to pages
            pagesWithLinkChecks = pages.map(p => {
              const pageUrl = (p.page_url || p.pageUrl || '').replace(/\/+$/, '');
              const lr = linkResults.find(l => (l.url || '').replace(/\/+$/, '') === pageUrl);
              return {
                page_url: p.page_url || p.pageUrl,
                page_name: p.page_name || p.pageName || 'Page',
                link_checks: lr?.linkChecks || null
              };
            }).filter(p => p.link_checks != null);
          }
        } catch (linkError) {
          console.warn(`[RERUN] Link check failed, continuing without:`, linkError.message);
        }
      }

      // Step 2: Forward the rerun request to n8n with link check results
      const job = activeJobs.get(jobKey);
      if (job) job.stage = 'forwarding_to_n8n';

      const payload = {
        project_id,
        ...(settings || {}),
        pages: pagesWithLinkChecks
      };

      console.log(`[RERUN] Forwarding to n8n: ${webhookUrl}/qa/rerun with ${pagesWithLinkChecks.length} pages with link_checks`);

      const n8nResponse = await axios.post(`${webhookUrl}/qa/rerun`, payload, {
        timeout: 60000,
        headers: { 'Content-Type': 'application/json' }
      });

      console.log(`[RERUN] n8n responded for project ${project_id}:`, n8nResponse.status);

      // Mark as completed briefly before cleanup
      const jobFinal = activeJobs.get(jobKey);
      if (jobFinal) jobFinal.stage = 'completed';
    } catch (error) {
      console.error(`[RERUN] Background processing failed for project ${project_id}:`, error.message);
    } finally {
      activeJobs.delete(jobKey);
      console.log(`[RERUN] Job removed from activeJobs: project ${project_id}`);
    }
  })();
});

// ============================================================
// Job status endpoint for frontend polling
// Returns real-time progress of active background jobs
// ============================================================
app.get('/job-status', async (req, res) => {
  const { project_name, project_id } = req.query;

  if (!project_name && !project_id) {
    return res.status(400).json({
      error: 'Invalid request',
      message: 'Provide project_name or project_id as a query parameter'
    });
  }

  // Look up by start-qa key first, then rerun key
  let jobKey = null;
  let job = null;

  if (project_name) {
    jobKey = `start-qa:${project_name}`;
    job = activeJobs.get(jobKey);
  }

  if (!job && project_id) {
    jobKey = `rerun:${project_id}`;
    job = activeJobs.get(jobKey);
  }

  // Also check the reverse: if project_name was given, maybe there's a rerun for it
  // (unlikely but handle gracefully)
  if (!job && project_name) {
    // Scan activeJobs for a matching projectName in rerun entries
    for (const [key, value] of activeJobs) {
      if (value.projectName === project_name) {
        job = value;
        break;
      }
    }
  }

  if (!job) {
    // No active Playwright job — but check if n8n is processing in the database.
    // This keeps the frontend indicator alive during the n8n workflow phase.
    const n8nStatus = await isN8nBusy();
    if (n8nStatus.busy) {
      return res.json({
        found: true,
        type: 'n8n_processing',
        stage: 'n8n_workflow',
        totalPages: null,
        checkedPages: null,
        startedAt: null,
        elapsed_seconds: null,
        projectName: n8nStatus.projectName,
      });
    }
    return res.json({ found: false });
  }

  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);

  res.json({
    found: true,
    type: job.type,
    stage: job.stage,
    totalPages: job.totalPages,
    checkedPages: job.checkedPages,
    startedAt: job.startedAt,
    elapsed_seconds: elapsed,
    projectName: job.projectName || null,
    projectId: job.projectId || null,
  });
});

// Cancel active job
app.post('/cancel-job', async (req, res) => {
  console.log('[CANCEL-JOB] Request received');
  
  try {
    // Clear all active jobs from memory
    const jobCount = activeJobs.size;
    activeJobs.clear();
    console.log(`[CANCEL-JOB] Cleared ${jobCount} active jobs from memory`);
    
    // Reset any in_progress or processing pages to pending in database
    if (supabase) {
      const { data, error } = await supabase
        .from('pages')
        .update({ status: 'pending' })
        .in('status', ['in_progress', 'processing'])
        .select();
      
      if (error) {
        console.error('[CANCEL-JOB] Database update error:', error);
      } else {
        console.log(`[CANCEL-JOB] Reset ${data?.length || 0} pages to pending`);
      }
    }
    
    res.json({
      success: true,
      message: 'Active jobs cancelled',
      clearedJobs: jobCount
    });
  } catch (error) {
    console.error('[CANCEL-JOB] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel job',
      message: error.message
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[SERVER] Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║   Playwright Link Checker Service                         ║
║                                                           ║
║   Status: Running                                         ║
║   Port: ${PORT}                                             ║
║   Environment: ${process.env.NODE_ENV || 'development'}                              ║
║                                                           ║
║   Endpoints:                                             ║
║   • GET  /health                                         ║
║   • GET  /job-status (real-time progress)                ║
║   • POST /check-links                                    ║
║   • POST /fetch-page                                     ║
║   • POST /screenshot                                     ║
║   • POST /check-content                                  ║
║   • POST /start-qa (server-side orchestrator)             ║
║   • POST /rerun (server-side orchestrator)               ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SERVER] SIGTERM received, shutting down gracefully');
  server && server.close(() => {
    console.log('[SERVER] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[SERVER] SIGINT received, shutting down gracefully');
  process.exit(0);
});
